"""``ask_in_context``: one request at the END of a live mid-turn conversation (the rollover
engine's hybrid handoff). Same fake-provider harness as ``test_side_question_request.py``."""

from __future__ import annotations

from unittest.mock import patch

from agent.side_question_request import ask_in_context
from tests.agent.test_side_question_request import (  # provider is a fixture
    _canon, _make_parent, _response, _run_parent_turn, _tool_call, _usage, provider,
)

NOTE_PROMPT = "Write your handoff note."


def _mid_turn(parent, provider):
    """The conversation as it stood at the parent's last request: it ends with a tool result."""
    result = _run_parent_turn(parent, provider)
    messages = list(result["messages"])
    assert messages.pop()["role"] == "assistant" and messages[-1]["role"] == "tool"
    return messages, provider.requests[-1]


def test_in_context_request_keeps_the_tool_tail_and_extends_the_cached_prefix(provider):
    parent = _make_parent()
    messages, parent_last = _mid_turn(parent, provider)
    provider.replies.append(_response("Goal: 42. Next: report it.", usage=_usage()))

    reply = ask_in_context(parent, messages, NOTE_PROMPT, purpose="test", timeout=10,
                           adjust_kwargs=lambda fork, kwargs: kwargs.update(max_tokens=77))

    assert (reply.text, reply.outcome) == ("Goal: 42. Next: report it.", "ok")
    side = provider.requests[-1]
    assert side["max_tokens"] == 77
    assert _canon(side["tools"]) == _canon(parent_last["tools"])
    # Not trimmed back to the last plain assistant reply: the tool round is in, then the prompt.
    assert _canon(side["messages"])[:-1] == _canon(parent_last["messages"])
    assert side["messages"][-1] == {"role": "user", "content": NOTE_PROMPT}
    # Nothing is appended to the live conversation.
    assert messages[-1]["role"] == "tool"


def test_in_context_reply_that_calls_a_tool_is_a_failure_and_never_runs(provider):
    parent = _make_parent()
    messages, _ = _mid_turn(parent, provider)
    provider.replies.append(_response(
        "", tool_calls=[_tool_call("terminal", arguments='{"command": "ls"}')], finish_reason="tool_calls",
        usage=_usage()))
    with patch("model_tools.handle_function_call") as dispatch:
        reply = ask_in_context(parent, messages, NOTE_PROMPT, purpose="test", timeout=10)
    assert (reply.text, reply.outcome) == (None, "tool_call")
    assert not dispatch.called


def test_in_context_provider_error_returns_no_text(provider):
    parent = _make_parent()
    messages, _ = _mid_turn(parent, provider)
    provider.replies.append(RuntimeError("HTTP 400"))
    reply = ask_in_context(parent, messages, NOTE_PROMPT, purpose="test", timeout=10)
    assert reply.text is None and reply.outcome == "error"
