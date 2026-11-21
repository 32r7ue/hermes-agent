"""Tests for Gemini 3.8 Live voice engine and Grok-Bot-style outbound phone calls."""

from __future__ import annotations

import asyncio
import base64
import json
import struct

from tools.gemini_live import (
    DEFAULT_GEMINI_LIVE_MODEL,
    DEFAULT_GEMINI_LIVE_VOICE,
    TOOL_ASK_USER,
    TOOL_END_PHONE_CALL,
    TOOL_SEND_TASK,
    build_audio_input_message,
    build_gemini_setup_payload,
    build_outbound_call_persona,
    build_tool_response_message,
    direct_call_tool_declarations,
    mulaw_to_pcm16,
    outbound_call_tool_declarations,
    parse_gemini_server_event,
    pcm16_to_mulaw,
    resample_pcm16,
    resolve_gemini_live_status,
)
from tools.phone_call import PhoneCallManager, _handle_phone_call
from tools.voice_live import GEMINI_LIVE_MODE, resolve_gpt_live_status, voice_chat_mode


def test_voice_chat_mode_supports_gemini_live():
    assert voice_chat_mode({"voice_chat_mode": "gemini-live"}) == GEMINI_LIVE_MODE
    assert voice_chat_mode({"voice_chat_mode": "gemini_live"}) == GEMINI_LIVE_MODE
    assert voice_chat_mode({"voice_chat_mode": "gpt-live"}) == "gpt-live"
    assert voice_chat_mode({"voice_chat_mode": "chained"}) == "chained"


def test_gemini_setup_payload_has_non_blocking_tools_and_audio_modality():
    payload = build_gemini_setup_payload(model="gemini-3.8-live", voice="Puck")
    setup = payload["setup"]
    assert setup["model"] == f"models/{DEFAULT_GEMINI_LIVE_MODEL}"
    assert setup["generationConfig"]["responseModalities"] == ["AUDIO"]
    assert setup["generationConfig"]["speechConfig"]["voiceConfig"]["prebuiltVoiceConfig"]["voiceName"] == DEFAULT_GEMINI_LIVE_VOICE
    assert "inputAudioTranscription" in setup
    assert "outputAudioTranscription" in setup
    decls = setup["tools"][0]["functionDeclarations"]
    names = {d["name"] for d in decls}
    assert TOOL_SEND_TASK in names
    assert all(d["behavior"] == "NON_BLOCKING" for d in decls)


def test_outbound_call_persona_and_tools():
    persona = build_outbound_call_persona(
        user_name="Benny",
        callee_name="Acme Dental",
        callee_kind="storefront",
        goal="Reschedule Tuesday's appointment to Thursday afternoon",
        instructions="Prefer 2pm or 3pm",
    )
    assert "Benny" in persona
    assert "Acme Dental" in persona
    assert "ask_user" in persona
    decls = outbound_call_tool_declarations()
    assert {d["name"] for d in decls} == {TOOL_ASK_USER, TOOL_END_PHONE_CALL}
    assert all(d["behavior"] == "NON_BLOCKING" for d in decls)


def test_tool_response_scheduling_and_audio_input():
    msg = build_tool_response_message("call_1", TOOL_SEND_TASK, {"answer": "42"}, scheduling="INTERRUPT")
    fr = msg["toolResponse"]["functionResponses"][0]
    assert fr["id"] == "call_1"
    assert fr["name"] == TOOL_SEND_TASK
    assert fr["response"]["scheduling"] == "INTERRUPT"
    assert fr["response"]["answer"] == "42"

    pcm = struct.pack("<4h", 0, 1000, -1000, 16000)
    audio_msg = build_audio_input_message(pcm, sample_rate=16000)
    assert audio_msg["realtimeInput"]["audio"]["mimeType"] == "audio/pcm;rate=16000"
    assert base64.b64decode(audio_msg["realtimeInput"]["audio"]["data"]) == pcm


def test_mulaw_and_resampler_roundtrip():
    pcm = struct.pack("<8h", 0, 500, -500, 4000, -4000, 12000, -12000, 20000)
    ulaw = pcm16_to_mulaw(pcm)
    assert len(ulaw) == 8
    decoded = mulaw_to_pcm16(ulaw)
    assert len(decoded) == 16
    orig = struct.unpack("<8h", pcm)
    back = struct.unpack("<8h", decoded)
    for a, b in zip(orig, back):
        assert abs(a - b) < max(200, abs(a) * 0.15)

    up = resample_pcm16(pcm, 8000, 16000)
    assert len(up) == 32
    down = resample_pcm16(up, 16000, 8000)
    assert len(down) == 16


def test_parse_gemini_server_event():
    raw = {
        "setupComplete": {},
        "serverContent": {
            "interrupted": True,
            "inputTranscription": {"text": "Hey Hermes"},
            "outputTranscription": {"text": "On it"},
            "modelTurn": {
                "parts": [{"inlineData": {"mimeType": "audio/pcm;rate=24000", "data": "AAAA"}}]
            },
            "turnComplete": True,
        },
        "toolCall": {
            "functionCalls": [{"id": "tc1", "name": TOOL_SEND_TASK, "args": {"request": "check disk"}}]
        },
    }
    events = parse_gemini_server_event(raw)
    kinds = [e["type"] for e in events]
    assert kinds == ["setup_complete", "interrupted", "transcript", "transcript", "audio", "turn_complete", "tool_call"]
    assert events[-1]["name"] == TOOL_SEND_TASK
    assert events[-1]["args"]["request"] == "check disk"


def test_gemini_status_resolution_with_env_key(monkeypatch):
    monkeypatch.setenv("GOOGLE_API_KEY", "test-key-123")
    st = resolve_gemini_live_status({})
    assert st["available"] is True
    assert st["model"] == DEFAULT_GEMINI_LIVE_MODEL
    assert st["voice"] == DEFAULT_GEMINI_LIVE_VOICE
    assert st["reason"] is None

    combined = resolve_gpt_live_status()
    assert combined["gemini_available"] is True
    assert combined["gemini_model"] == DEFAULT_GEMINI_LIVE_MODEL


def test_phone_call_manager_full_lifecycle():
    mgr = PhoneCallManager()
    call = mgr.create_call(
        callee_number="+15551234567",
        callee_name="Pizza Place",
        callee_kind="storefront",
        goal="Order a large margherita pizza for pickup",
    )
    assert call.status == "pending_approval"

    mgr.approve_call(call.call_id)
    assert mgr.get_call(call.call_id).status == "dialing"

    mgr.mark_in_progress(call.call_id)
    assert mgr.get_call(call.call_id).status == "in_progress"

    # Simulate attached bridge receiving mid-call question answer & context injection
    sent: list[tuple[str, Any]] = []

    class FakeBridge:
        async def send_tool_response(self, cid, name, res, scheduling="WHEN_IDLE"):
            sent.append(("tool_response", cid, name, res, scheduling))

        async def send_text(self, text, turn_complete=True):
            sent.append(("text", text, turn_complete))

        async def close(self):
            sent.append(("close",))

    async def _run():
        loop = asyncio.get_running_loop()
        mgr.attach_bridge(call.call_id, FakeBridge(), loop)
        q = mgr.ask_user(call.call_id, tool_call_id="tc_ask_1", question="Thin crust or regular?", options=["Thin", "Regular"])
        mgr.answer_question(call.call_id, q.question_id, "Thin")
        mgr.inject_context(call.call_id, "Also add garlic knots")
        mgr.append_transcript(call.call_id, "assistant", "Hi, I'd like to order a pizza.")
        mgr.append_transcript(call.call_id, "callee", "Sure, ready in 20 minutes.")
        mgr.end_call(call.call_id, outcome="completed", summary="Ordered pizza + garlic knots, ready in 20m")
        await asyncio.sleep(0.02)

    asyncio.run(_run())

    final = mgr.get_call(call.call_id)
    assert final.status == "ended"
    assert final.outcome == "completed"
    assert final.summary == "Ordered pizza + garlic knots, ready in 20m"
    assert len(final.transcript) == 2
    assert final.questions[0].answer == "Thin"
    assert final.injected_context == ["Also add garlic knots"]
    assert any(s[0] == "tool_response" and s[4] == "INTERRUPT" for s in sent)
    assert any(s[0] == "text" and "garlic knots" in s[1] for s in sent)
    assert any(s[0] == "close" for s in sent)


def test_phone_call_tool_handler():
    res = json.loads(
        _handle_phone_call(
            {
                "action": "place_call",
                "callee_number": "+15559990000",
                "callee_name": "Dr. Smith",
                "goal": "Confirm appointment",
            }
        )
    )
    assert res["ok"] is True
    cid = res["call"]["call_id"]
    assert res["call"]["status"] == "pending_approval"

    res2 = json.loads(_handle_phone_call({"action": "approve", "call_id": cid}))
    assert res2["ok"] is True
    assert res2["call"]["status"] == "dialing"

    res3 = json.loads(_handle_phone_call({"action": "hang_up", "call_id": cid}))
    assert res3["ok"] is True
    assert res3["call"]["status"] == "ended"
