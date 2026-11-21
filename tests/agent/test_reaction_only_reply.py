"""A reaction can BE the reply: an empty follow-up after a reaction-only round ends the turn
silently instead of nudging the model to write text (agent/turn_empty_response.py)."""

from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

from agent.turn_empty_response import _REACTION_ONLY_PLACEHOLDER, reaction_was_the_reply, recover_empty_response
from tests.agent.test_setup_beat_card_round import _agent

_OK = json.dumps({"success": True, "row_id": 7, "reactions": []})


def _round(*names, result=_OK):
    calls = [{"id": f"c{i}", "type": "function", "function": {"name": n, "arguments": "{}"}} for i, n in enumerate(names)]
    return [
        {"role": "user", "content": "keep it"},
        {"role": "assistant", "content": "", "tool_calls": calls},
        *({"role": "tool", "tool_call_id": f"c{i}", "content": result} for i in range(len(names))),
    ]


@pytest.mark.parametrize(("messages", "expected"), [
    (_round("react_to_message"), True),
    (_round("react_to_message", "terminal"), False),
    (_round("terminal"), False),
    (_round("react_to_message", result='{"error": "no session"}'), False),
    ([{"role": "user", "content": "hi"}], False),
])
def test_reaction_was_the_reply(messages, expected):
    assert reaction_was_the_reply(messages) is expected


def _recover(agent, messages):
    return recover_empty_response(
        agent, SimpleNamespace(content="", tool_calls=None, reasoning=None), None, "stop", final_response="",
        messages=messages, api_messages=[], conversation_history=[], active_system_prompt="",
        api_call_count=2, turn_exit_reason=None, preflight_compression_blocked=False)


def test_empty_after_reaction_ends_the_turn_silently():
    agent = _agent()
    agent._empty_content_retries = 0
    agent._last_content_with_tools = None
    agent._clear_status_buffer = lambda: None
    messages = _round("react_to_message")

    verdict = _recover(agent, messages)

    assert verdict.action == "break" and verdict.final_response == ""
    assert verdict.turn_exit_reason.startswith("text_response")
    closing = messages[-1]
    assert closing["role"] == "assistant" and closing["display_kind"] == "hidden"
    assert closing["api_content"] == _REACTION_ONLY_PLACEHOLDER
    assert not any("empty response" in str(m.get("content")) for m in messages)


def test_empty_after_substantive_tool_still_nudges():
    agent = _agent()
    agent._last_content_with_tools = None
    agent._buffer_diagnostic_status = lambda *_: None
    agent._build_assistant_message = lambda msg, fr: {"role": "assistant", "content": ""}
    messages = _round("terminal")

    verdict = _recover(agent, messages)

    assert verdict.action == "continue"
    assert messages[-1]["role"] == "user"


def test_gateway_keeps_a_reaction_only_turn_silent():
    from agent.turn_empty_response import REACTION_ONLY_EXIT_REASON
    from gateway.run import _normalize_empty_agent_response

    result = {"final_response": "", "api_calls": 2, "turn_exit_reason": REACTION_ONLY_EXIT_REASON}
    assert _normalize_empty_agent_response(result, "", history_len=4) == ""
    # Any other empty turn still surfaces the warning.
    assert _normalize_empty_agent_response({**result, "turn_exit_reason": None}, "", history_len=4)
