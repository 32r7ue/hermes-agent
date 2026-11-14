"""Rollover context engine: no summaries, ever.

When the context reaches its trigger, the session rolls over the same way the built-in
compressor rotates sessions (the parent ends with ``end_reason='compression'``, a child
continues the lineage, nothing is deleted). The difference is the handoff: instead of an
LLM-written summary, the child gets one short pointer to the parent session plus the
verbatim recent tail. The agent pulls whatever else it needs from the parent with
``session_search`` (exact stored messages, tool calls and results included), when it
needs it. No summarizer call, so the rollover is instant and nothing is paraphrased.

Select it with ``context.engine: rollover`` in config.yaml. Optional knobs::

    context:
      engine: rollover
      rollover:
        threshold_tokens: 450000   # absolute trigger cap
        threshold_percent: 0.90    # trigger for windows below the cap

The trigger is checked between model calls, so a rollover always lands on a finished
step (a complete model action plus its tool results). The model is never told about the
limit beforehand.
"""

from __future__ import annotations

import logging
from typing import Any, Optional

from agent.context_compressor import LEGACY_SUMMARY_PREFIX, ContextCompressor, _content_text_for_contains

logger = logging.getLogger(__name__)

DEFAULT_THRESHOLD_TOKENS = 450_000
DEFAULT_THRESHOLD_PERCENT = 0.90


def handoff_text(session_id: str) -> str:
    """The whole handoff. The built-in ``[CONTEXT SUMMARY]:`` prefix keeps it recognized as a
    handoff carrier everywhere, also after a restart: hidden from the transcript view, never
    counted as a user turn, excluded from session_search bookends and titles."""
    if session_id:
        where = (
            f'session {session_id}. Its full record (every message, tool call and tool result) '
            f'is stored verbatim; read exact lines from it with session_search(session_id="{session_id}"), '
            "which lists its message ids; scroll from one with around_message_id"
        )
    else:
        where = (
            "an earlier session in this lineage. Its full record is stored verbatim; "
            "find exact lines with session_search"
        )
    return (
        f"{LEGACY_SUMMARY_PREFIX} You are continuing {where}. Look things up in it when you need them. "
        "The messages after this note are its latest part, verbatim. "
        "Carry on seamlessly; do not mention this note."
    )


# Progress survives the cut: one line per earlier tool call (name + arguments, no result). Without it
# the model could not tell which steps of a list were done and re-ran them (2026-11-14: one run
# re-read two 100K-char files three times and took 31 calls where 13 sufficed).
_ACTIONS_HEAD = "Your tool calls before this point, in order (results are in the stored session):"
_ACTION_ARGS_MAX_CHARS = 160
_ACTIONS_MAX = 60


def _action_lines(message: Any) -> list[str]:
    lines = []
    for call in (message.get("tool_calls") or []) if isinstance(message, dict) else []:
        fn = (call.get("function") or {}) if isinstance(call, dict) else {}
        args = " ".join(str(fn.get("arguments") or "").split())
        if len(args) > _ACTION_ARGS_MAX_CHARS:
            args = args[:_ACTION_ARGS_MAX_CHARS] + "…"
        lines.append(f"- {fn.get('name') or '?'} {args}".rstrip())
    return lines


def actions_block(messages: list, turns: list, summary_indices) -> str:
    """Prior handoff's action lines + the tool calls cut now; the newest ``_ACTIONS_MAX`` are kept."""
    lines: list[str] = []
    if summary_indices:
        text = _content_text_for_contains(messages[max(summary_indices)].get("content"))
        if _ACTIONS_HEAD in text:
            lines = [ln for ln in text.split(_ACTIONS_HEAD, 1)[1].lstrip("\n").split("\n\n", 1)[0].splitlines()
                     if ln.startswith("- ")]
    for msg in turns:
        lines += _action_lines(msg)
    if not lines:
        return ""
    omitted = int(lines.pop(0).split()[2]) if lines[0].startswith("- … ") else 0
    if len(lines) > _ACTIONS_MAX - 1:
        omitted += len(lines) - (_ACTIONS_MAX - 1)
        lines = lines[-(_ACTIONS_MAX - 1):]
    if omitted:
        lines.insert(0, f"- … {omitted} earlier calls")
    return "\n\n" + _ACTIONS_HEAD + "\n" + "\n".join(lines)


def _rollover_config() -> dict[str, Any]:
    try:
        from hermes_cli.config import load_config_readonly

        section = ((load_config_readonly() or {}).get("context") or {}).get("rollover") or {}
        return section if isinstance(section, dict) else {}
    except Exception:
        logger.warning("rollover: config unreadable, using defaults", exc_info=True)
        return {}


class RolloverEngine(ContextCompressor):
    """ContextCompressor with the summarizer replaced by a pointer to the parent session.

    Everything else (token tracking, trigger, verbatim tail selection, tool-pair repair,
    session rotation, persistence) is the built-in machinery, unchanged.
    """

    def __init__(self) -> None:
        cfg = _rollover_config()
        super().__init__(
            model="",
            threshold_percent=float(cfg.get("threshold_percent") or DEFAULT_THRESHOLD_PERCENT),
            threshold_tokens_cap=int(cfg.get("threshold_tokens") or DEFAULT_THRESHOLD_TOKENS),
            # Only the system prompt is kept from the head; the session's first messages
            # stay retrievable in the parent instead of being pinned forever.
            protect_first_n=0,
            quiet_mode=True,
        )

    # No "turns were compacted" note on the system prompt: the pointer is the whole handoff.
    _COMPRESSION_NOTE = ""

    @property
    def name(self) -> str:
        return "rollover"

    def _summarize_window(self, messages, turns_to_summarize, scan, focus_topic, memory_context, bypass_cooldown):
        self._previous_summary = None
        return handoff_text(getattr(self, "_session_id", "") or "") + actions_block(
            messages, turns_to_summarize, scan.summary_indices)

    # The built-in compressor skips the summarizer after weak or failed rounds to save model calls,
    # then writes a generic fallback summary. Rollover makes no model call, so a skip saves nothing and
    # the fallback would replace the pointer: the agent would lose the way back to its full record.
    def _fallback_streak_skip(self, telemetry: dict[str, Any]) -> bool:
        return False

    def _feasibility_skip(self, telemetry, turns_to_summarize, compress_start, compress_end) -> bool:
        return False

    def _fallback_summary_for_window(self, telemetry, turns_to_summarize, n_dropped, feasibility_skip) -> str:
        return handoff_text(getattr(self, "_session_id", "") or "")

    def _take_prepared_summary(self, *args: Any, **kwargs: Any) -> Optional[Any]:
        # Prepared (background LLM) summaries have no place here.
        return None

    def get_automatic_compaction_status_message(self, *, phase: str, default_message: str, **context: Any):
        return "Compacting"


def register(ctx) -> None:
    ctx.register_context_engine(RolloverEngine())
