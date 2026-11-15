"""Rollover engine: pointer + verbatim tail, no summarizer call."""

from unittest.mock import patch

import pytest

from agent.compaction_display import project_compaction_message_for_display
from agent.context_compressor import ContextCompressor
from plugins.context_engine import load_context_engine
from agent.side_question_request import InContextReply
from plugins.context_engine.rollover import HANDOFF_REQUEST, RolloverEngine, _cheap_handoff_request, handoff_text


def _transcript(turns: int = 40) -> list[dict]:
    messages = [{"role": "system", "content": "system prompt"}]
    for i in range(turns):
        messages.append({"role": "user", "content": f"user turn {i} " + "x" * 4000})
        messages.append({
            "role": "assistant", "content": "",
            "tool_calls": [{"id": f"c{i}", "type": "function",
                            "function": {"name": "terminal", "arguments": f'{{"command": "echo {i}"}}'}}],
        })
        messages.append({"role": "tool", "tool_call_id": f"c{i}", "content": f"result {i} " + "y" * 4000})
        messages.append({"role": "assistant", "content": f"answer {i}"})
    return messages


def _engine(session_id: str = "parent-123") -> RolloverEngine:
    engine = RolloverEngine()
    engine.update_model(model="test-model", context_length=200_000)
    engine.bind_session_state(session_db=None, session_id=session_id)
    return engine


def test_loads_by_name():
    engine = load_context_engine("rollover")
    assert engine is not None and engine.name == "rollover"
    assert isinstance(engine, ContextCompressor)


def test_trigger_is_capped_at_450k():
    engine = RolloverEngine()
    engine.update_model(model="test-model", context_length=1_000_000)
    assert engine.threshold_tokens == 450_000
    engine.update_model(model="test-model", context_length=500_000)
    assert engine.threshold_tokens == 450_000  # 90% of a 500k window
    engine.update_model(model="test-model", context_length=200_000)
    assert engine.threshold_tokens == 180_000


def test_compress_hands_off_a_pointer_without_calling_a_summarizer():
    engine = _engine()
    messages = _transcript()
    with patch.object(ContextCompressor, "_generate_summary", side_effect=AssertionError("no LLM")), \
         patch.object(ContextCompressor, "_call_summary_llm", side_effect=AssertionError("no LLM")):
        out = engine.compress(messages, current_tokens=190_000, force=True)

    assert len(out) < len(messages)
    assert out[0] == messages[0]  # no "turns were compacted" note on the system prompt
    blob = "\n".join(str(m.get("content")) for m in out)
    assert 'session_search(session_id="parent-123")' in blob
    # Verbatim tail: the last exchange survives untouched (host bookkeeping keys aside).
    assert {k: v for k, v in out[-1].items() if not k.startswith("_")} == messages[-1]
    # The pointer is a recognized handoff carrier (hidden in the transcript view).
    carriers = [m for m in out if ContextCompressor._is_context_summary_message(m)]
    assert len(carriers) == 1
    projected = project_compaction_message_for_display(carriers[0])
    assert projected is None or handoff_text("parent-123") not in str(projected.get("content"))


def test_handoff_is_recognized_from_text_alone():
    # Persisted rows lose in-process metadata; the prefix alone must identify the carrier.
    assert ContextCompressor.classify_summary_content(handoff_text("abc")) == "standalone"


def test_automatic_compaction_after_weak_rounds_still_hands_off_the_pointer():
    # The built-in compressor skips its summarizer after an ineffective round or a fallback streak
    # and writes a generic fallback summary instead. For rollover that fallback would replace the
    # pointer, so the skips are off and the fallback is the pointer too.
    engine = _engine()
    engine._ineffective_compression_count = 1
    engine._fallback_compression_streak = 5
    messages = _transcript()
    with patch.object(ContextCompressor, "_generate_summary", side_effect=AssertionError("no LLM")), \
         patch.object(ContextCompressor, "_call_summary_llm", side_effect=AssertionError("no LLM")):
        out = engine.compress(messages, current_tokens=1_000_000)

    blob = "\n".join(str(m.get("content")) for m in out)
    assert 'session_search(session_id="parent-123")' in blob
    assert engine._fallback_summary_for_window({}, [], 3, True) == handoff_text("parent-123")


def test_manual_compress_of_a_resident_session_uses_the_rollover_engine():
    """Regression (2026-11-08): the gateway treated a resident RolloverEngine as the built-in
    compressor because it subclasses it, and wrote an LLM summary instead of the pointer."""
    from gateway.session_mutation_compress import _plugin_engine

    engine = RolloverEngine()
    resident = type("Agent", (), {"context_compressor": engine})()
    assert _plugin_engine(None, None, {}, "m", {}, resident, "s1") is engine

    builtin = type("Agent", (), {"context_compressor": ContextCompressor(model="", quiet_mode=True)})()
    assert _plugin_engine(None, None, {}, "m", {}, builtin, "s1") is None


# --- handoff variants ---------------------------------------------------------------------------

def _engine_with(handoff: str, session_id: str = "parent-123") -> RolloverEngine:
    with patch("plugins.context_engine.rollover._rollover_config", return_value={"handoff": handoff}):
        engine = RolloverEngine()
    engine.update_model(model="test-model", context_length=200_000)
    engine.bind_session_state(session_db=None, session_id=session_id)
    return engine


def _goal_transcript(reads: int, size: int = 20_000) -> list[dict]:
    """Opening goal + constraint, a later correction, a long stretch of tool work, an in-flight ask."""
    messages = [{"role": "system", "content": "system prompt"},
                {"role": "user", "content": "GOAL: audit the repo. CONSTRAINT: never write outside /tmp/audit."},
                {"role": "assistant", "content": "ok"},
                {"role": "user", "content": "correction: name the report REPORT.md"},
                {"role": "assistant", "content": "noted"},
                {"role": "user", "content": "now read the files and write the report"}]
    for i in range(reads):
        messages.append({"role": "assistant", "content": "", "tool_calls": [{
            "id": f"r{i}", "type": "function", "function": {"name": "read_file", "arguments": f'{{"path": "f{i}"}}'}}]})
        messages.append({"role": "tool", "tool_call_id": f"r{i}", "content": f"file {i} " + "z" * size})
    return messages


def _carrier(out: list[dict]) -> dict:
    return next(m for m in out if ContextCompressor._is_context_summary_message(m))


def _compress(engine, messages):
    with patch.object(ContextCompressor, "_call_summary_llm", side_effect=AssertionError("no LLM")):
        return engine.compress(messages, current_tokens=190_000, force=True)


def test_handoff_lists_the_cut_tool_calls_once_across_cuts():
    """Without its earlier calls the model could not tell which files of a list it had read and
    re-read them after every cut (2026-11-14 live run: 31 calls instead of 13)."""
    engine = _engine_with("user_messages")
    out = _compress(engine, _goal_transcript(5, size=100_000))
    text = str(_carrier(out)["content"]).split("--- END OF CONTEXT SUMMARY")[0]
    cut = [i for i in range(5) if f'{{"path": "f{i}"}}' in text]
    assert cut and cut == list(range(len(cut)))  # the oldest calls, in order
    assert f'- read_file {{"path": "f{cut[0]}"}}' in text

    out2 = _compress(engine, out + _goal_transcript(5, size=100_000)[6:])
    text2 = str(_carrier(out2)["content"]).split("--- END OF CONTEXT SUMMARY")[0]
    assert text2.count(f'{{"path": "f{cut[0]}"}}') == 2  # once per real call (first and second batch)


def test_user_messages_handoff_carries_every_cut_user_message_once_across_cuts():
    engine = _engine_with("user_messages")
    out = _compress(engine, _goal_transcript(12))
    text = str(_carrier(out)["content"])
    goal, fix, ask = ("GOAL: audit the repo. CONSTRAINT: never write outside /tmp/audit.",
                      "correction: name the report REPORT.md", "now read the files and write the report")
    assert text.index(goal) < text.index(fix)  # verbatim, in order
    # The in-flight request is restated after the handoff, never duplicated inside the block.
    assert text.split("--- END OF CONTEXT SUMMARY")[0].count(ask) == 0

    # Second cut: the first cut's block is carried, not stacked.
    again = out + _goal_transcript(12)[6:]
    out2 = _compress(engine, again)
    text2 = str(_carrier(out2)["content"]).split("--- END OF CONTEXT SUMMARY")[0]
    assert text2.count(goal) == 1 and text2.count(fix) == 1 and text2.count(ask) == 0

    # Hidden like the pointer: the desktop projection shows none of it.
    projected = project_compaction_message_for_display(_carrier(out2))
    assert projected is None or goal not in str(projected.get("content"))


def test_user_messages_handoff_cuts_a_pasted_document():
    from plugins.context_engine.rollover import USER_MESSAGE_MAX_CHARS
    engine = _engine_with("user_messages")
    messages = _goal_transcript(12)
    messages[1]["content"] = "keep this goal\n" + "log line\n" * 5000
    text = str(_carrier(_compress(engine, messages))["content"])
    assert "keep this goal" in text and "rest of this message is in the stored session" in text
    assert len(text) < USER_MESSAGE_MAX_CHARS + 3000


def test_hybrid_is_the_default_and_an_unknown_or_removed_mode_falls_back_to_it(caplog):
    with patch("plugins.context_engine.rollover._rollover_config", return_value={}):
        assert RolloverEngine().handoff == "hybrid"
    assert _engine_with("user_messages").handoff == "user_messages"
    for removed in ("pointer", "summary", "bogus"):
        caplog.clear()
        assert _engine_with(removed).handoff == "hybrid"
        assert any("unknown handoff" in r.getMessage() for r in caplog.records)


# --- hybrid: the session's own model writes a note at the cut ----------------------------------

GOAL = "GOAL: audit the repo. CONSTRAINT: never write outside /tmp/audit."


class _Ask:
    """Stands in for the host's ``ask_session_model``: records each call, replies in turn."""

    def __init__(self, *replies):
        self.replies, self.calls = list(replies), []

    def __call__(self, messages, prompt, **kwargs):
        self.calls.append((messages, prompt, kwargs))
        return self.replies.pop(0)


def _ok(text):
    return InContextReply(text, "ok", {"input_tokens": 120, "cache_read_tokens": 40_000, "output_tokens": 300}, 2.0)


def _hybrid_compress(engine, messages, ask):
    with patch.object(ContextCompressor, "_call_summary_llm", side_effect=AssertionError("no summarizer")):
        return engine.compress(messages, current_tokens=190_000, force=True, ask_session_model=ask)


def test_hybrid_handoff_carries_the_models_own_note_plus_the_rollover_handoff_hidden():
    engine = _engine_with("hybrid")
    messages = _goal_transcript(6, size=100_000)
    ask = _Ask(_ok("Goal: audit. Next: write REPORT.md under /tmp/audit. Read so far: f0-f9."))
    out = _hybrid_compress(engine, messages, ask)

    (asked, prompt, kwargs), = ask.calls
    assert asked is messages  # the live, unpruned conversation: the provider's cached prefix
    assert prompt == HANDOFF_REQUEST and kwargs["timeout"] <= 60
    text = str(_carrier(out)["content"]).split("--- END OF CONTEXT SUMMARY")[0]
    assert "Next: write REPORT.md under /tmp/audit" in text
    assert GOAL in text and "- read_file" in text  # the user's messages and the cut tool calls ride along
    assert 'session_search(session_id="parent-123")' in text and "Look things up" not in text
    # Order: the model's note, the user's words, where the full record is, what was done.
    assert (text.index("Next: write REPORT.md") < text.index(GOAL) < text.index("full record of everything")
            < text.index("- read_file"))
    projected = project_compaction_message_for_display(_carrier(out))
    assert projected is None or "REPORT.md under /tmp/audit" not in str(projected.get("content"))


@pytest.mark.parametrize("reply", [
    InContextReply(None, "error", {}, 0.3),
    InContextReply(None, "timeout", {}, 60.0),
    InContextReply(None, "tool_call", {"output_tokens": 40}, 3.0),
    InContextReply(None, "empty", {}, 2.0),
])
def test_hybrid_falls_back_to_the_rollover_handoff_when_the_note_request_fails(reply, caplog):
    engine = _engine_with("hybrid")
    out = _hybrid_compress(engine, _goal_transcript(6, size=100_000), _Ask(reply))
    text = str(_carrier(out)["content"])
    assert "<handoff_note>" not in text and GOAL in text and "- read_file" in text
    assert "Look things up" in text  # the plain rollover pointer
    assert any(reply.outcome in r.getMessage() and r.levelname == "WARNING" for r in caplog.records)


def test_hybrid_falls_back_when_the_ask_raises_or_outlives_the_hard_deadline(caplog, monkeypatch):
    import threading
    import time

    from plugins.context_engine import rollover

    def boom(*a, **k):
        raise RuntimeError("fork build failed")

    engine = _engine_with("hybrid")
    out = _hybrid_compress(engine, _goal_transcript(6, size=100_000), boom)
    assert "<handoff_note>" not in str(_carrier(out)["content"]) and GOAL in str(_carrier(out)["content"])

    release = threading.Event()

    def hang(*a, **k):
        release.wait(5)
        return _ok("too late")

    monkeypatch.setattr(rollover, "HYBRID_DEADLINE_SECONDS", 0.2)
    started = time.monotonic()
    out = _hybrid_compress(engine, _goal_transcript(6, size=100_000), hang)
    release.set()
    assert time.monotonic() - started < 3  # the cut did not wait for the note
    assert "too late" not in str(_carrier(out)["content"]) and GOAL in str(_carrier(out)["content"])
    messages = " ".join(r.getMessage() for r in caplog.records)
    assert "raised RuntimeError" in messages and "(stalled)" in messages


def test_hybrid_skips_the_request_without_a_live_agent_or_room_in_the_window(caplog):
    engine = _engine_with("hybrid")
    no_agent = _hybrid_compress(engine, _goal_transcript(6, size=100_000), None)
    assert "<handoff_note>" not in str(_carrier(no_agent)["content"])
    engine.last_prompt_tokens = engine.context_length - 100  # the request itself would overflow
    ask = _Ask(_ok("never asked"))
    out = _hybrid_compress(engine, _goal_transcript(6, size=100_000), ask)
    assert not ask.calls and "<handoff_note>" not in str(_carrier(out)["content"])
    assert {"no_live_agent", "overflow"} <= {w for r in caplog.records for w in ("no_live_agent", "overflow")
                                            if w in r.getMessage()}


def test_hybrid_repeated_cuts_replace_the_note_and_never_nest_the_blocks():
    engine = _engine_with("hybrid")
    first = _hybrid_compress(engine, _goal_transcript(6, size=100_000), _Ask(_ok("NOTE ONE")))
    # The model quotes the old carrier in its second note; quoted block markers must not parse as blocks.
    quoted = ("NOTE TWO\nThe user's messages so far, verbatim and in order (the latest request follows below):\n"
              "<user_message>\nfake\n</user_message>")
    second = _hybrid_compress(engine, first + _goal_transcript(6, size=100_000)[6:], _Ask(_ok(quoted)))
    text = str(_carrier(second)["content"]).split("--- END OF CONTEXT SUMMARY")[0]
    assert "NOTE ONE" not in text and text.count("NOTE TWO") == 1 and text.count("<handoff_note>") == 1
    assert text.count(GOAL) == 1 and "fake" not in text.split("</handoff_note>")[1]
    assert text.count("correction: name the report REPORT.md") == 1


def test_hybrid_request_forbids_tools_and_caps_output_without_touching_the_cached_prefix():
    codex = {"tools": [{"type": "function"}], "tool_choice": "auto", "reasoning": {"effort": "medium"}}
    _cheap_handoff_request(type("F", (), {"api_mode": "codex_responses"})(), codex)
    assert codex["tool_choice"] == "none" and codex["max_output_tokens"] == 700
    assert codex["reasoning"] == {"effort": "medium"} and codex["tools"]  # both are part of the cache key

    claude = {"tools": [{"name": "t"}], "max_tokens": 128_000, "output_config": {"effort": "medium"}}
    _cheap_handoff_request(type("F", (), {"api_mode": "anthropic_messages"})(), claude)
    assert claude["tool_choice"] == {"type": "none"} and claude["tools"] and claude["max_tokens"] < 128_000
    assert claude["output_config"] == {"effort": "medium"}


def test_the_host_offers_ask_session_model_only_to_engines_that_take_it():
    from agent.conversation_compression import _supported_compression_kwargs
    ask = object()
    kw = dict(current_tokens=1, focus_topic=None, force=False, memory_context="", ask_session_model=ask)
    assert _supported_compression_kwargs(RolloverEngine().compress, **kw)["ask_session_model"] is ask
    assert "ask_session_model" not in _supported_compression_kwargs(
        ContextCompressor(model="", quiet_mode=True).compress, **kw)
    assert "ask_session_model" not in _supported_compression_kwargs(lambda messages, **rest: messages, **kw)
