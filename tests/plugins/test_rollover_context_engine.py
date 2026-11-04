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
