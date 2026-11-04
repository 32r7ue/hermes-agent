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

from agent.context_compressor import LEGACY_SUMMARY_PREFIX, ContextCompressor

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
            "adding around_message_id to scroll"
        )
    else:
        where = (
            "an earlier session in this lineage. Its full record is stored verbatim; "
            "find exact lines with session_search"
        )
    return (
        f"{LEGACY_SUMMARY_PREFIX} You are continuing {where}. Retrieve key context from it as you go. "
        "The messages after this note are its latest part, verbatim. "
        "Carry on seamlessly; do not mention this note."
    )


def _rollover_config() -> dict[str, Any]:
    try:
        from hermes_cli.config import load_config_readonly

        section = ((load_config_readonly() or {}).get("context") or {}).get("rollover") or {}
        return section if isinstance(section, dict) else {}
    except Exception:
        logger.debug("rollover: config unreadable, using defaults", exc_info=True)
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
        return handoff_text(getattr(self, "_session_id", "") or "")

    def _take_prepared_summary(self, *args: Any, **kwargs: Any) -> Optional[Any]:
        # Prepared (background LLM) summaries have no place here.
        return None

    def get_automatic_compaction_status_message(self, *, phase: str, default_message: str, **context: Any):
        return "Compacting"


def register(ctx) -> None:
    ctx.register_context_engine(RolloverEngine())
