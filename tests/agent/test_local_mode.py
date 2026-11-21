"""Local model modes: short prompt and tool surface for local endpoints only."""

from types import SimpleNamespace

import pytest

from agent import local_mode
from agent.system_prompt import build_system_prompt_parts
from toolsets import agent_tool_surface

TOOLS = [{"function": {"name": n}} for n in ("read_file", "patch", "terminal", "web_search", "memory")]


def _agent(provider="llamacpp", base_url="http://127.0.0.1:18100/v1"):
    return SimpleNamespace(provider=provider, base_url=base_url, platform="cli", model="bonsai",
                           session_id="s", pass_session_id=False)


@pytest.fixture
def mode(monkeypatch):
    def set_mode(value):
        monkeypatch.setattr(local_mode, "_configured_mode", lambda: value)
    return set_mode


def _names(tools):
    return [t["function"]["name"] for t in tools]


def test_chat_mode_has_no_tools_and_a_few_line_prompt(mode):
    mode("chat")
    agent = _agent()
    assert agent_tool_surface(agent, TOOLS) == []
    parts = build_system_prompt_parts(agent)
    assert parts["context"] == parts["volatile"] == ""
    assert parts["stable"].startswith(local_mode._CHAT_PROMPT)
    assert "Conversation started:" in parts["stable"]
    assert len(parts["stable"]) < 400


def test_lite_mode_keeps_only_core_tools(mode):
    mode("lite")
    agent = _agent(provider="custom", base_url="http://localhost:8080/v1")
    assert _names(agent_tool_surface(agent, TOOLS)) == ["read_file", "patch", "terminal", "web_search"]
    assert "Working directory:" in build_system_prompt_parts(agent)["stable"]


def test_full_mode_and_remote_providers_are_untouched(mode):
    mode("full")
    assert local_mode.local_mode(_agent()) is None
    mode("chat")
    remote = _agent(provider="anthropic", base_url="https://api.anthropic.com")
    assert local_mode.local_mode(remote) is None
    assert _names(local_mode.filter_tools(remote, TOOLS)) == _names(TOOLS)


def test_mode_is_resolved_once_per_agent(mode):
    mode("lite")
    agent = _agent()
    assert local_mode.local_mode(agent) == "lite"
    mode("chat")
    assert local_mode.local_mode(agent) == "lite"


def test_old_edit_setting_reads_as_lite(monkeypatch):
    from hermes_cli import config
    monkeypatch.setattr(config, "load_config", lambda: {"local_runtime": {"prompt_mode": "edit"}})
    assert local_mode._configured_mode() == "lite"


def test_local_web_calls_are_shrunk_and_cloud_calls_untouched():
    local, cloud = _agent(), _agent(provider="anthropic", base_url="https://api.anthropic.com")
    search = local_mode.shape_tool_args(local, "web_search", {"query": "q", "limit": 10})
    assert search == {"query": "q", "limit": local_mode.LOCAL_SEARCH_LIMIT,
                      "_snippet_chars": local_mode.LOCAL_SNIPPET_CHARS}
    assert local_mode.shape_tool_args(local, "web_extract", {"urls": ["u"]})["char_limit"] == local_mode.LOCAL_EXTRACT_CHARS
    assert local_mode.shape_tool_args(local, "web_extract", {"urls": ["u"], "char_limit": 9000})["char_limit"] == 9000
    assert local_mode.shape_tool_args(cloud, "web_search", {"query": "q"}) == {"query": "q"}
    assert local_mode.shape_tool_args(local, "terminal", {"command": "ls"}) == {"command": "ls"}


def test_clip_snippets_caps_descriptions():
    from tools.web_tools import _clip_snippets
    data = {"success": True, "data": {"web": [{"title": "t", "description": "x" * 1000}, {"description": "short"}]}}
    web = _clip_snippets(data, 300)["data"]["web"]
    assert len(web[0]["description"]) == 301 and web[1]["description"] == "short"
    assert len(data["data"]["web"][0]["description"]) == 1000  # input not mutated
