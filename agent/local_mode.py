"""Local model modes: a short system prompt and a tiny tool surface for models on this machine.

A local model reads every prompt token itself, so the full Hermes prompt (tens of thousands of
tokens) means minutes before the first token. ``local_runtime.prompt_mode`` picks what a local
session (managed llama.cpp provider, or any loopback/LAN endpoint) gets:

* ``chat`` (default): no tools, a few-line prompt.
* ``lite``: Hermes's core capabilities (files, terminal, web, browser, computer use, vision) under a
  short prompt; no personality, memory, skills or guidance blocks. ``edit`` is the old name.
* ``full``: the normal Hermes prompt and toolsets.

Both short modes are byte-stable for the session, so llama-server reuses the whole prefix
turn after turn and only prefills the new message.
"""

from __future__ import annotations

from typing import Any, Optional

MODES = ("chat", "lite", "full")
_ALIASES = {"edit": "lite"}
DEFAULT_MODE = "chat"
LITE_TOOLS = frozenset({
    "read_file", "write_file", "patch", "search_files", "terminal", "process_manage",
    "web_search", "web_extract", "browser_exec", "computer_use", "vision_analyze",
})

_CHAT_PROMPT = "You are Hermes, a local agent running on the user's Mac. Answer directly and concisely."
_LITE_PROMPT = (
    "You are Hermes, an agent running on a local model on the user's Mac. Your tools cover files, "
    "the terminal, the web, a browser, the screen and images.\n"
    "- Do the work with tools, then report the result briefly. Never describe what you would do instead.\n"
    "- Files: read before editing; patch for targeted changes, write_file for new files; search_files, "
    "not grep/find.\n"
    "- Web: web_search to find pages, web_extract to read them, browser_exec for interactive sites. "
    "computer_use drives native Mac apps.\n"
    "- Never invent results. If a tool fails, say so and try another route.\n"
    "- Answer first, plainly, no filler.\n"
    "Working directory: {cwd}"
)


def _configured_mode() -> str:
    try:
        from hermes_cli.config import load_config
        mode = str(((load_config() or {}).get("local_runtime") or {}).get("prompt_mode") or DEFAULT_MODE)
    except Exception:
        mode = DEFAULT_MODE
    mode = _ALIASES.get(mode.strip().lower(), mode.strip().lower())
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
    """``"chat"`` or ``"lite"`` when *agent* runs a local model in a short mode, else None.
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
    if mode == "lite":
        return [t for t in tools if (t.get("function") or {}).get("name") in LITE_TOOLS]
    return tools


def system_prompt(agent: Any, timestamp_line: str) -> Optional[str]:
    """The whole system prompt in a short mode, else None."""
    mode = local_mode(agent)
    if mode == "chat":
        return f"{_CHAT_PROMPT}\n\n{timestamp_line}"
    if mode == "lite":
        from agent.runtime_cwd import resolve_agent_cwd
        return f"{_LITE_PROMPT.format(cwd=resolve_agent_cwd() or '.')}\n\n{timestamp_line}"
    return None
