"""A stop during a provider-limit wait ends the turn as that limit's failure (Desktop: the red
usage-limit card with Try again / Auto-resume), and the failed-turn boundary the model replays is a
Hermes note, never the user-facing sentence in its own voice."""

import json
import time
from types import SimpleNamespace

from agent.error_classifier import FailoverReason
from agent.error_surface import build_error_surface_from_result
from agent.turn_failure_copy import FAILED_TURN_NOTICE, PARTIAL_FAILED_TURN_NOTICE, failed_turn_model_content
from agent.turn_recovery import limit_wait_stopped_result

_429 = "HTTP 429: This request would exceed your account's rate limit. Please try again later."


def _agent(reset_at=None):
    return SimpleNamespace(
        _summarize_api_error=lambda error: _429,
        _extract_api_error_context=lambda error: {"reset_at": reset_at} if reset_at else {},
    )


def _interrupted():
    return {
        "final_response": "Operation interrupted: retrying API call after error (retry 1/2).",
        "messages": [{"role": "user", "content": "hi"}], "api_calls": 1, "completed": False, "interrupted": True,
    }


def test_stop_during_rate_limit_wait_is_the_limit_failure_with_its_reset():
    resets_at = time.time() + 4 * 3600
    result = limit_wait_stopped_result(
        _agent(resets_at), _interrupted(), RuntimeError("429"),
        SimpleNamespace(reason=FailoverReason.rate_limit), "anthropic",
    )

    assert result["failed"] is True and result["interrupted"] is False and result["completed"] is False
    assert result["error"] == _429
    assert result["failure_reason"] == "rate_limit" and result["failure_retryable"] is True
    assert abs(result["failure_resets_at"] - resets_at) < 1
    assert "rate limit" in result["final_response"] and "Limit resets at" in result["final_response"]
    assert "Operation interrupted" not in result["final_response"]

    surface = build_error_surface_from_result(result, provider="anthropic", model="claude")
    assert surface is not None
    assert surface["code"] == "rate_limit" and surface["retryable"] is True
    assert abs(surface["resets_at"] - resets_at) < 1


def test_stop_during_any_other_wait_stays_a_plain_interrupt():
    interrupted = _interrupted()
    result = limit_wait_stopped_result(
        _agent(), interrupted, RuntimeError("503"), SimpleNamespace(reason=FailoverReason.server_error), "anthropic",
    )
    assert result is interrupted


def test_failed_turn_boundary_reads_to_the_model_as_a_hermes_note():
    limit_row = {
        "role": "assistant", "content": FAILED_TURN_NOTICE, "display_kind": "failed_turn",
        "display_metadata": json.dumps({"error": _429, "error_surface": {"code": "rate_limit", "layer": "provider"}}),
    }
    note = failed_turn_model_content(limit_row) or ""
    assert note.startswith("[Hermes note, not written by you:") and "rate limit" in note
    assert FAILED_TURN_NOTICE not in note

    stopped = {"role": "assistant", "content": PARTIAL_FAILED_TURN_NOTICE, "display_kind": "failed_turn",
               "display_metadata": {"interrupted": True}}
    stopped_note = failed_turn_model_content(stopped) or ""
    assert "stopped" in stopped_note and "may already have run" in stopped_note

    assert failed_turn_model_content({"role": "assistant", "content": "Real reply."}) is None
    assert failed_turn_model_content({"role": "user", "content": FAILED_TURN_NOTICE}) is None
