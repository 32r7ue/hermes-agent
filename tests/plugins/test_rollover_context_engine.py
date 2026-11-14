"""Rollover engine: pointer + verbatim tail, no summarizer call."""

from unittest.mock import patch

from agent.compaction_display import project_compaction_message_for_display
from agent.context_compressor import ContextCompressor
from plugins.context_engine import load_context_engine
from plugins.context_engine.rollover import RolloverEngine, handoff_text


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
    engine = _engine_with("pointer")
    out = _compress(engine, _goal_transcript(5, size=100_000))
    text = str(_carrier(out)["content"]).split("--- END OF CONTEXT SUMMARY")[0]
    cut = [i for i in range(5) if f'{{"path": "f{i}"}}' in text]
    assert cut and cut == list(range(len(cut)))  # the oldest calls, in order
    assert f'- read_file {{"path": "f{cut[0]}"}}' in text

    out2 = _compress(engine, out + _goal_transcript(5, size=100_000)[6:])
    text2 = str(_carrier(out2)["content"]).split("--- END OF CONTEXT SUMMARY")[0]
    assert text2.count(f'{{"path": "f{cut[0]}"}}') == 2  # once per real call (first and second batch)
