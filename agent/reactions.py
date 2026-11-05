"""Token-free (regex) detection of user *reactions* to the agent.

The only kind today is ``vibe`` — affection/gratitude aimed at the agent (``ily``, ``<3``,
``good bot``, a heart emoji), NOT general positive sentiment ("this is great" does not fire).
Single source of truth for the CLI pet, TUI heart and desktop hearts via
``AIAgent.reaction_callback``; :func:`detect_reaction` returns a *kind* string so new kinds
can be added without touching callers.
"""

from __future__ import annotations

import re

#: The affection/gratitude reaction — the only kind today.
VIBE = "vibe"

# Narrow lexicon: gratitude + love aimed at the agent, hearts, ``<3`` (not ``</3``).
_VIBE_RE = re.compile(
    "|".join(
        (
            r"\bgood\s*bot\b",
            r"\bi\s*(?:love|luv)\s*(?:you|u|ya)\b",
            r"\b(?:love|luv)\s*(?:you|u|ya)\b",
            r"\bily(?:sm)?\b",
            r"\bthank\s*(?:you|u)\b",
            r"\b(?:thanks|thx|tysm|ty)\b",
            r"<3+",  # <3, <33 … but not </3
            # Hearts + affection faces (❤ ♥ 🥰 😍 😘 💕 💖 💗 💞 💛 💜 💚 💙 💓 💘 💝 🩷).
            r"[\u2764\u2665"
            r"\U0001F970\U0001F60D\U0001F618"
            r"\U0001F495\U0001F496\U0001F497\U0001F49E"
            r"\U0001F49B\U0001F49C\U0001F49A\U0001F499"
            r"\U0001F493\U0001F498\U0001F49D\U0001FA77]",
        )
    ),
    re.IGNORECASE,
)


def detect_reaction(text: str | None) -> str | None:
    """Return the reaction kind for *text* (currently :data:`VIBE`), or ``None``."""
    return VIBE if text and _VIBE_RE.search(text) else None


def pending_reaction_note(db, session_id: str) -> str:
    """Model-bound note for the user's message reactions since the last turn, or "".

    Announced once (rows are stamped ``seen`` on read) on the NEXT user turn, never by rewriting
    the reacted message. Gated on ``display.message_reactions``. Shared by every submit path
    (TUI sidecar and gateway), so a reaction reaches the model whichever process runs the turn.
    """
    if db is None or not session_id:
        return ""
    try:
        from hermes_cli.config import load_config_readonly
        display = (load_config_readonly() or {}).get("display")
        if not (isinstance(display, dict) and bool(display.get("message_reactions", False))):
            return ""
        pending = db.take_unseen_reactions(session_id, author="user")
    except Exception:
        import logging
        logging.getLogger(__name__).debug("Failed to read pending reactions", exc_info=True)
        return ""
    notes = []
    for entry in pending or ():
        snippet = (entry.get("text") or "").strip().replace("\n", " ")
        if len(snippet) > 120:
            snippet = snippet[:120] + "…"
        emoji = entry.get("emoji") or ""
        whose = "their own" if entry.get("role") == "user" else "your"
        if snippet:
            notes.append(f'[The user reacted {emoji} to {whose} message: "{snippet}"]')
        else:
            # Attachment-only / tool-call-only rows: no quote beats an empty quote.
            notes.append(f"[The user reacted {emoji} to {whose} earlier message]")
    return "\n".join(notes)
