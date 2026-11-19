"""Local model modes: a short system prompt and a tiny tool surface for models on this machine.

A local model reads every prompt token itself, so the full Hermes prompt (tens of thousands of
tokens) means minutes before the first token. ``local_runtime.prompt_mode`` picks what a local
session (managed llama.cpp provider, or any loopback/LAN endpoint) gets:

* ``chat`` (default): no tools, a few-line prompt.
* ``edit``: file tools plus terminal, a short coding prompt.
* ``full``: the normal Hermes prompt and toolsets.

Both short modes are byte-stable for the session, so llama-server reuses the whole prefix
turn after turn and only prefills the new message.
"""

from __future__ import annotations

from typing import Any, Optional

MODES = ("chat", "edit", "full")
DEFAULT_MODE = "chat"
EDIT_TOOLS = frozenset({"read_file", "write_file", "patch", "search_files", "terminal"})

_CHAT_PROMPT = "You are a helpful assistant running locally on the user's Mac. Answer directly and concisely."
_EDIT_PROMPT = (
    "You are a coding assistant running locally on the user's Mac, with tools to read, search, "
    "write and patch files and run terminal commands.\n"
    "- Read a file before editing it; use patch for targeted changes, write_file for new files.\n"
    "- Use search_files instead of grep/find, read_file instead of cat.\n"
    "- Do the work with tools rather than describing it. Keep replies short.\n"
    "Working directory: {cwd}"
)


def _configured_mode() -> str:
    try:
        from hermes_cli.config import load_config
        mode = str(((load_config() or {}).get("local_runtime") or {}).get("prompt_mode") or DEFAULT_MODE)
    except Exception:
        mode = DEFAULT_MODE
    mode = mode.strip().lower()
    return mode if mode in MODES else DEFAULT_MODE


def _is_local(agent: Any) -> bool:
    from hermes_cli.local_runtime.endpoint import LLAMACPP_ALIASES
    if (getattr(agent, "provider", "") or "").lower() in LLAMACPP_ALIASES:
        return True
    base_url = getattr(agent, "base_url", "") or ""
    if not base_url:
        return False
    from agent.model_metadata import is_local_endpoint
    return is_local_endpoint(base_url)


def local_mode(agent: Any) -> Optional[str]:
    """``"chat"`` or ``"edit"`` when *agent* runs a local model in a short mode, else None.
    Resolved once per agent and cached, so tools and prompt never disagree mid-session."""
    if hasattr(agent, "_local_mode"):
        return agent._local_mode
    mode: Optional[str] = None
    try:
        if _is_local(agent):
            m = _configured_mode()
            mode = None if m == "full" else m
    except Exception:
        mode = None
    try:
        agent._local_mode = mode
    except Exception:
        pass
    return mode


def filter_tools(agent: Any, tools: list[dict[str, Any]]) -> list[dict[str, Any]]:
    mode = local_mode(agent)
    if mode == "chat":
        return []
    if mode == "edit":
        return [t for t in tools if (t.get("function") or {}).get("name") in EDIT_TOOLS]
    return tools


def system_prompt(agent: Any, timestamp_line: str) -> Optional[str]:
    """The whole system prompt in a short mode, else None."""
    mode = local_mode(agent)
    if mode == "chat":
        return f"{_CHAT_PROMPT}\n\n{timestamp_line}"
    if mode == "edit":
        from agent.runtime_cwd import resolve_agent_cwd
        return f"{_EDIT_PROMPT.format(cwd=resolve_agent_cwd() or '.')}\n\n{timestamp_line}"
    return None
