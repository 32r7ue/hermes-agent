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

# Ultra-minimal web schemas for local ``chat`` mode (~84 tokens total vs ~465 full).
# Static for the session so llama-server's KV prompt cache stays warm turn after turn.
_CHAT_TOOL_SCHEMAS: dict[str, dict[str, Any]] = {
    "web_search": {
        "type": "function",
        "function": {
            "name": "web_search",
            "description": "Search the web.",
            "parameters": {
                "type": "object",
                "properties": {"query": {"type": "string"}},
                "required": ["query"],
            },
        },
    },
    "web_extract": {
        "type": "function",
        "function": {
            "name": "web_extract",
            "description": "Read text from web URLs.",
            "parameters": {
                "type": "object",
                "properties": {"urls": {"type": "array", "items": {"type": "string"}}},
                "required": ["urls"],
            },
        },
    },
}

_CHAT_PROMPT = (
    "You are Hermes, a local agent running on Benny's Mac in his own harness. "
    "Don't just agree or apologize—deliver what Benny asked for."
)
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


def _web_search_enabled() -> bool:
    """Whether local-model sessions expose web_search / web_extract (default True)."""
    try:
        from hermes_cli.config import load_config
        raw = ((load_config() or {}).get("local_runtime") or {}).get("web_search")
        if raw is None:
            return True
        if isinstance(raw, bool):
            return raw
        return str(raw).strip().lower() not in ("0", "false", "no", "off")
    except Exception:
        return True


def _is_local_target(provider: str, base_url: str) -> bool:
    from hermes_cli.local_runtime.endpoint import LLAMACPP_ALIASES
    if (provider or "").lower() in LLAMACPP_ALIASES:
        return True
    if not base_url:
        return False
    from agent.model_metadata import is_local_endpoint
    return is_local_endpoint(base_url)


def _is_local(agent: Any) -> bool:
    return _is_local_target(getattr(agent, "provider", "") or "", getattr(agent, "base_url", "") or "")


# Local prompt processing runs ~20-50 tok/s (llama-server log, Bonsai on M3 Pro), so a full search
# batch (~2k tokens) cost about a minute before the first answer token. Local sessions get fewer,
# shorter results; web_extract still stores the full page on disk and reports where.
LOCAL_SEARCH_LIMIT = 3
LOCAL_SNIPPET_CHARS = 300
LOCAL_EXTRACT_CHARS = 4000


def shape_tool_args(agent: Any, name: str, args: dict[str, Any]) -> dict[str, Any]:
    """Shrink web tool payloads for local-model sessions; other calls pass through untouched."""
    if name not in _WEB_TOOL_NAMES or not isinstance(args, dict) or not _is_local(agent):
        return args
    args = dict(args)
    if name == "web_search":
        try:
            asked = int(args.get("limit") or LOCAL_SEARCH_LIMIT)
        except (TypeError, ValueError):
            asked = LOCAL_SEARCH_LIMIT
        args["limit"] = max(1, min(asked, LOCAL_SEARCH_LIMIT))
        args["_snippet_chars"] = LOCAL_SNIPPET_CHARS
    elif args.get("char_limit") is None:
        args["char_limit"] = LOCAL_EXTRACT_CHARS
    return args


def is_local_chat_mode(provider: str, base_url: str = "") -> bool:
    """True when *provider*/*base_url* targets a local model and config is in ``chat`` mode."""
    try:
        return _configured_mode() == "chat" and _is_local_target(provider, base_url)
    except Exception:
        return False


def is_local_session_row(row: Optional[dict[str, Any]]) -> bool:
    """True when a SessionDB row belongs to a local-model session (loopback/LAN/llamacpp)."""
    if not row or not isinstance(row, dict):
        return False
    try:
        provider = str(row.get("billing_provider") or row.get("provider") or "")
        base_url = str(row.get("billing_base_url") or row.get("base_url") or "")
        return _is_local_target(provider, base_url)
    except Exception:
        return False


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


_WEB_TOOL_NAMES = frozenset({"web_search", "web_extract"})


def filter_tools(agent: Any, tools: list[dict[str, Any]]) -> list[dict[str, Any]]:
    mode = local_mode(agent)
    web_ok = _web_search_enabled()
    if mode == "chat":
        if not web_ok:
            return []
        available = {(t.get("function") or {}).get("name") for t in tools}
        return [_CHAT_TOOL_SCHEMAS[name] for name in ("web_search", "web_extract") if name in available]
    if mode == "lite":
        allowed = LITE_TOOLS if web_ok else (LITE_TOOLS - _WEB_TOOL_NAMES)
        return [t for t in tools if (t.get("function") or {}).get("name") in allowed]
    if not web_ok and _is_local(agent):
        return [t for t in tools if (t.get("function") or {}).get("name") not in _WEB_TOOL_NAMES]
    return tools


def _consume_next_local_date_override(agent: Any) -> Optional[str]:
    """One-shot date override from ``~/.hermes/cache/scratch/next_local_date.txt``, cached on *agent*."""
    if hasattr(agent, "_local_date_override"):
        return agent._local_date_override
    override: Optional[str] = None
    try:
        from pathlib import Path
        from hermes_constants import get_hermes_home
        marker = Path(get_hermes_home()) / "cache" / "scratch" / "next_local_date.txt"
        if marker.is_file():
            raw = marker.read_text(encoding="utf-8").strip()
            marker.unlink(missing_ok=True)
            if raw:
                override = raw
    except Exception:
        override = None
    try:
        agent._local_date_override = override
    except Exception:
        pass
    return override


def _chat_timestamp_line(agent: Any, timestamp_line: str) -> str:
    """Keep Conversation started and Model; drop Provider/Platform clutter in chat mode."""
    date_override = _consume_next_local_date_override(agent)
    lines = []
    for line in timestamp_line.splitlines():
        if line.startswith(("Provider:", "Platform:")):
            continue
        if date_override and line.startswith("Conversation started:"):
            lines.append(f"Conversation started: {date_override}")
        else:
            lines.append(line)
    return "\n".join(lines)


def _chat_web_line(agent: Any) -> str:
    """Only name web tools that are actually enabled in this session."""
    active = getattr(agent, "valid_tool_names", None) or ()
    web_tools = [name for name in ("web_search", "web_extract") if name in active]
    if not web_tools:
        return ""
    joined = " and ".join(web_tools)
    return f" Use {joined} when you need current info."


def system_prompt(agent: Any, timestamp_line: str) -> Optional[str]:
    """The whole system prompt in a short mode, else None."""
    mode = local_mode(agent)
    if mode == "chat":
        return f"{_CHAT_PROMPT}{_chat_web_line(agent)}\n\n{_chat_timestamp_line(agent, timestamp_line)}"
    if mode == "lite":
        from agent.runtime_cwd import resolve_agent_cwd
        return f"{_LITE_PROMPT.format(cwd=resolve_agent_cwd() or '.')}\n\n{timestamp_line}"
    return None
