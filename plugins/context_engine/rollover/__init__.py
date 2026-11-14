"""Rollover context engine: no separate summarizer.

When the context reaches its trigger, the session rolls over the same way the built-in
compressor rotates sessions (the parent ends with ``end_reason='compression'``, a child
continues the lineage, nothing is deleted). The difference is the handoff: instead of a
summarizer's text, the child gets a pointer to the parent session, the user's messages
verbatim, the cut tool calls (one line each) and the verbatim recent tail. The agent can read
anything else from the parent with ``session_search`` (exact stored messages, tool calls and
results included).

Select it with ``context.engine: rollover`` in config.yaml. Optional knobs::

    context:
      engine: rollover
      rollover:
        threshold_tokens: 450000   # absolute trigger cap
        threshold_percent: 0.90    # trigger for windows below the cap
        handoff: user_messages     # user_messages | hybrid (see below)

Handoff modes:
- ``user_messages`` ("Rollover"): the pointer, one line per cut tool call, and every real user
  message cut away so far, verbatim and in order (each capped). No model call at the cut.
- ``hybrid``: the same plus a handoff note the session's own model writes at the cut, inside its
  own conversation (one extra request on the warm prompt cache). Any failure of that request
  falls back to ``user_messages`` for that cut.

The trigger is checked between model calls, so a rollover always lands on a finished
step (a complete model action plus its tool results). The model is never told about the
limit beforehand.
"""

from __future__ import annotations

import logging
import re
from typing import Any, Optional

from agent.context_compressor import (
    LEGACY_SUMMARY_PREFIX, ContextCompressor, _content_text_for_contains, _restated_request_text,
    _synthetic_user_row, _typed_user_text,
)

logger = logging.getLogger(__name__)

DEFAULT_THRESHOLD_TOKENS = 450_000
DEFAULT_THRESHOLD_PERCENT = 0.90
HANDOFF_MODES = ("user_messages", "hybrid")
DEFAULT_HANDOFF = "user_messages"


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


# --- handoff: user_messages ---------------------------------------------------------------------
# 2000 chars: every typed part of a real user message in state.db fits (max 1987, p90 183 on
# 2026-11-14); only pasted attachments run longer, and their rest stays in the stored session.
USER_MESSAGE_MAX_CHARS = 2000
_USER_BLOCK_HEAD = "The user's messages so far, verbatim and in order (the latest request follows below):"
_USER_OPEN, _USER_CLOSE = "<user_message>", "</user_message>"
_USER_CUT = "[cut: the rest of this message is in the stored session]"
_USER_RE = re.compile(re.escape(_USER_OPEN) + r"\n(.*?)\n" + re.escape(_USER_CLOSE), re.DOTALL)


def _real_user_text(message: Any) -> str:
    """The user's own words in *message*, or "" for handoffs, hidden rows and runtime scaffolding."""
    from agent.conversation_compression import _is_real_user_message

    if (not isinstance(message, dict) or message.get("display_kind")
            or ContextCompressor._is_context_summary_message(message) or not _is_real_user_message(message)):
        return ""
    text = _typed_user_text(_restated_request_text(message.get("content")))
    return "" if _synthetic_user_row(text) else text.strip()


def user_messages_block(engine: ContextCompressor, messages: list, turns: list, summary_indices) -> str:
    """Prior handoff's carried messages + the real user messages cut now, minus the in-flight request
    (restated after the handoff anyway). The tail is outside *turns*, so nothing in it repeats."""
    carried: list[str] = []
    if summary_indices:  # the newest earlier handoff already carries everything before it
        carried = _USER_RE.findall(_content_text_for_contains(messages[max(summary_indices)].get("content")))
    inflight = engine._find_inflight_user_task(messages)
    skip = _restated_request_text(inflight.get("content")) if inflight else None
    for msg in turns:
        text = _real_user_text(msg)
        if text and text != skip:
            carried.append(text if len(text) <= USER_MESSAGE_MAX_CHARS
                           else text[:USER_MESSAGE_MAX_CHARS] + "\n" + _USER_CUT)
    if not carried:
        return ""
    return "\n\n" + _USER_BLOCK_HEAD + "".join(f"\n{_USER_OPEN}\n{t}\n{_USER_CLOSE}" for t in carried)


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
        self.handoff = str(cfg.get("handoff") or DEFAULT_HANDOFF).strip().lower()
        if self.handoff not in HANDOFF_MODES:
            logger.warning("rollover: unknown handoff %r, using %s", self.handoff, DEFAULT_HANDOFF)
            self.handoff = DEFAULT_HANDOFF

    # No "turns were compacted" note on the system prompt: the pointer is the whole handoff.
    _COMPRESSION_NOTE = ""

    @property
    def name(self) -> str:
        return "rollover"

    def _summarize_window(self, messages, turns_to_summarize, scan, focus_topic, memory_context, bypass_cooldown):
        self._previous_summary = None
        return (handoff_text(getattr(self, "_session_id", "") or "")
                + actions_block(messages, turns_to_summarize, scan.summary_indices)
                + user_messages_block(self, messages, turns_to_summarize, scan.summary_indices))

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
