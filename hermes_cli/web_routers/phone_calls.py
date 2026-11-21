"""FastAPI routes & WebSockets for Gemini 3.8 Live voice calls and bot-placed outbound phone calls."""

from __future__ import annotations

import asyncio
import base64
import json
import logging
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Request, Response, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

from tools.gemini_live import (
    GeminiLiveBridge,
    TOOL_ASK_USER,
    TOOL_END_CALL,
    TOOL_END_PHONE_CALL,
    TOOL_PEEK_AGENTS,
    TOOL_PEEK_RUNS,
    TOOL_RECALL_TEXTS,
    TOOL_SEARCH_CONVERSATIONS,
    TOOL_SEND_TASK,
    TOOL_STAY_SILENT,
    TOOL_SWITCH_AGENT,
    build_gemini_setup_payload,
    build_history_seed_message,
    build_outbound_call_persona,
    direct_call_tool_declarations,
    mulaw_to_pcm16,
    outbound_call_tool_declarations,
    pcm16_to_mulaw,
    resample_pcm16,
    resolve_gemini_api_key,
)
from tools.phone_call import (
    dial_via_twilio,
    get_phone_call_manager,
    peek_hermes_agents,
    peek_hermes_runs,
    recall_session_texts,
    search_hermes_conversations,
)

logger = logging.getLogger(__name__)
router = APIRouter()


class CreatePhoneCallBody(BaseModel):
    callee_number: str
    goal: str
    callee_name: str = ""
    callee_kind: str = "person"
    instructions: str = ""
    agent_profile: str = "default"
    session_id: str = ""
    voice: str = "Puck"
    model: str = "gemini-3.8-live"
    transport: str = "loopback"
    auto_approve: bool = False


class ContextBody(BaseModel):
    text: str


class AnswerBody(BaseModel):
    answer: str


class HangupBody(BaseModel):
    outcome: str = "completed"
    end_reason: str = "hang_up"
    summary: Optional[str] = None


# ── Outbound phone call REST endpoints

@router.get("/api/phone-calls")
async def list_phone_calls(session_id: Optional[str] = None, active_only: bool = False):
    mgr = get_phone_call_manager()
    return {"ok": True, "calls": [c.to_dict() for c in mgr.list_calls(session_id=session_id, active_only=active_only)]}


@router.post("/api/phone-calls")
async def create_phone_call(body: CreatePhoneCallBody):
    if not body.callee_number.strip() or not body.goal.strip():
        raise HTTPException(status_code=400, detail="callee_number and goal are required")
    mgr = get_phone_call_manager()
    call = mgr.create_call(
        callee_number=body.callee_number,
        goal=body.goal,
        callee_name=body.callee_name,
        callee_kind=body.callee_kind,
        instructions=body.instructions,
        agent_profile=body.agent_profile,
        session_id=body.session_id,
        voice=body.voice,
        model=body.model,
        transport=body.transport,
        auto_approve=body.auto_approve,
    )
    return {"ok": True, "call": call.to_dict()}


@router.get("/api/phone-calls/{call_id}")
async def get_phone_call(call_id: str):
    call = get_phone_call_manager().get_call(call_id)
    if call is None:
        raise HTTPException(status_code=404, detail="call not found")
    return {"ok": True, "call": call.to_dict()}


@router.post("/api/phone-calls/{call_id}/approve")
async def approve_phone_call(call_id: str, request: Request):
    try:
        call = get_phone_call_manager().approve_call(call_id)
        if call.transport == "twilio_media_stream":
            try:
                base = str(request.base_url).rstrip("/")
                await asyncio.to_thread(dial_via_twilio, call, base if base.startswith("https://") else "")
            except Exception as exc:
                logger.warning("Twilio outbound dial failed for %s: %s", call_id, exc)
        return {"ok": True, "call": call.to_dict()}
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))


def _twiml_connect_stream(request: Request, call_id: str) -> Response:
    host = request.headers.get("x-forwarded-host") or request.headers.get("host") or request.url.netloc
    ws_url = f"wss://{host}/api/phone-calls/{call_id}/twilio-media"
    xml = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        f'<Response><Connect><Stream url="{ws_url}" /></Connect></Response>'
    )
    return Response(content=xml, media_type="application/xml")


@router.post("/api/phone-calls/twilio/twiml/{call_id}")
async def twilio_outbound_twiml(call_id: str, request: Request):
    """TwiML webhook Twilio fetches when an outbound call connects."""
    call = get_phone_call_manager().get_call(call_id)
    if call is None:
        return Response(content='<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>', media_type="application/xml")
    return _twiml_connect_stream(request, call_id)


@router.post("/api/phone-calls/twilio/inbound")
async def twilio_inbound_webhook(request: Request):
    """TwiML webhook for inbound phone calls to your Twilio number -> answered by your Hermes bot."""
    form = await request.form()
    caller = str(form.get("From") or "Unknown caller")
    call_sid = str(form.get("CallSid") or "")
    call = get_phone_call_manager().create_call(
        callee_number=caller,
        callee_name=caller,
        callee_kind="person",
        goal="Answer this incoming phone call as the user's personal assistant, take a message or help the caller, and ask the user if you need a decision.",
        transport="twilio_media_stream",
        direction="inbound",
        auto_approve=True,
    )
    if call_sid:
        call.twilio_call_sid = call_sid
    return _twiml_connect_stream(request, call.call_id)


@router.post("/api/phone-calls/{call_id}/reject")
async def reject_phone_call(call_id: str):
    try:
        call = get_phone_call_manager().reject_call(call_id)
        return {"ok": True, "call": call.to_dict()}
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.post("/api/phone-calls/{call_id}/context")
async def inject_phone_call_context(call_id: str, body: ContextBody):
    try:
        call = get_phone_call_manager().inject_context(call_id, body.text)
        return {"ok": True, "call": call.to_dict()}
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/api/phone-calls/{call_id}/questions/{question_id}/answer")
async def answer_phone_call_question(call_id: str, question_id: str, body: AnswerBody):
    try:
        q = get_phone_call_manager().answer_question(call_id, question_id, body.answer)
        return {"ok": True, "question": q.__dict__}
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/api/phone-calls/{call_id}/hangup")
async def hangup_phone_call(call_id: str, body: Optional[HangupBody] = None):
    b = body or HangupBody()
    try:
        call = get_phone_call_manager().end_call(
            call_id, outcome=b.outcome, end_reason=b.end_reason, summary=b.summary
        )
        return {"ok": True, "call": call.to_dict()}
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


# ── Live event stream for PhoneCallCards UI

@router.websocket("/api/phone-calls/events")
async def phone_calls_events_ws(ws: WebSocket):
    await ws.accept()
    mgr = get_phone_call_manager()
    q = mgr.subscribe()
    try:
        await ws.send_json({"type": "snapshot", "calls": [c.to_dict() for c in mgr.list_calls()]})
        while True:
            ev = await q.get()
            await ws.send_json(ev)
    except (WebSocketDisconnect, asyncio.CancelledError):
        pass
    finally:
        mgr.unsubscribe(q)


# ── Direct user <-> Hermes bot voice call over Gemini 3.8 Live

@router.websocket("/api/audio/voice-live/gemini/ws")
async def gemini_direct_voice_ws(ws: WebSocket):
    await ws.accept()
    api_key = resolve_gemini_api_key()
    if not api_key:
        await ws.send_json({"type": "error", "fatal": True, "message": "No GOOGLE_API_KEY or GEMINI_API_KEY configured"})
        await ws.close(code=1011)
        return

    session_id = ws.query_params.get("session_id", "")
    voice = ws.query_params.get("voice") or None
    model = ws.query_params.get("model") or None

    bridge_ref: dict[str, Optional[GeminiLiveBridge]] = {"bridge": None}

    async def _on_gemini_event(ev: dict[str, Any]) -> None:
        ev_type = ev.get("type")
        bridge = bridge_ref["bridge"]
        if ev_type == "tool_call" and bridge is not None:
            cid = ev.get("id", "")
            name = ev.get("name", "")
            args = ev.get("args") or {}
            if name == TOOL_RECALL_TEXTS:
                res = recall_session_texts(session_id=session_id, limit=int(args.get("limit") or 10))
                await bridge.send_tool_response(cid, name, res, scheduling="WHEN_IDLE")
                return
            if name == TOOL_SEARCH_CONVERSATIONS:
                res = search_hermes_conversations(str(args.get("query") or ""), limit=int(args.get("limit") or 5))
                await bridge.send_tool_response(cid, name, res, scheduling="WHEN_IDLE")
                return
            if name == TOOL_PEEK_AGENTS:
                res = peek_hermes_agents(str(args.get("agent") or ""))
                await bridge.send_tool_response(cid, name, res, scheduling="WHEN_IDLE")
                return
            if name == TOOL_PEEK_RUNS:
                res = peek_hermes_runs(str(args.get("query") or ""))
                await bridge.send_tool_response(cid, name, res, scheduling="WHEN_IDLE")
                return
            if name == TOOL_STAY_SILENT:
                await bridge.send_tool_response(cid, name, {"ok": True}, scheduling="SILENT")
                return
            if name in (TOOL_SEND_TASK, TOOL_SWITCH_AGENT, TOOL_END_CALL):
                await ws.send_json(ev)
                return
        await ws.send_json(ev)

    setup = build_gemini_setup_payload(
        model=model,
        voice=voice,
        tools=direct_call_tool_declarations(),
    )
    bridge = GeminiLiveBridge(api_key=api_key, setup_payload=setup, on_event=_on_gemini_event)
    bridge_ref["bridge"] = bridge

    try:
        await bridge.connect()
        while True:
            msg = await ws.receive()
            if msg["type"] == "websocket.disconnect":
                break
            if msg.get("bytes"):
                await bridge.send_audio(msg["bytes"], sample_rate=16000)
                continue
            raw_text = msg.get("text")
            if not raw_text:
                continue
            try:
                data = json.loads(raw_text)
            except json.JSONDecodeError:
                continue
            kind = data.get("type")
            if kind == "audio" and data.get("data"):
                await bridge.send_audio(base64.b64decode(data["data"]), sample_rate=int(data.get("sampleRate") or 16000))
            elif kind == "history" and isinstance(data.get("history"), list):
                seed = build_history_seed_message(data["history"])
                if seed:
                    await bridge.send_json(seed)
            elif kind == "text" and data.get("text"):
                await bridge.send_text(str(data["text"]), turn_complete=bool(data.get("turnComplete", True)))
            elif kind == "tool_response":
                await bridge.send_tool_response(
                    str(data.get("id") or ""),
                    str(data.get("name") or ""),
                    data.get("response"),
                    scheduling=str(data.get("scheduling") or "WHEN_IDLE"),
                )
            elif kind == "close":
                break
    except (WebSocketDisconnect, asyncio.CancelledError):
        pass
    except Exception as exc:
        logger.warning("gemini_direct_voice_ws error: %s", exc)
        try:
            await ws.send_json({"type": "error", "fatal": True, "message": str(exc)})
        except Exception:
            pass
    finally:
        await bridge.close()


# ── Outbound phone call audio bridges (Desktop loopback + Twilio Media Streams)

def _resolve_user_name() -> str:
    try:
        from hermes_cli.config import load_config
        name = str((load_config().get("agent") or {}).get("user_name") or "").strip()
        if name:
            return name
    except Exception:
        pass
    return "the user"


async def _run_outbound_call_bridge(
    *,
    ws: WebSocket,
    call_id: str,
    mode: str,  # "loopback" | "twilio"
) -> None:
    mgr = get_phone_call_manager()
    call = mgr.get_call(call_id)
    if call is None:
        await ws.close(code=1008)
        return
    if call.status == "pending_approval":
        await ws.send_json({"type": "error", "fatal": True, "message": "Call has not been approved yet"})
        await ws.close(code=1008)
        return
    api_key = resolve_gemini_api_key()
    if not api_key:
        await ws.send_json({"type": "error", "fatal": True, "message": "No GOOGLE_API_KEY or GEMINI_API_KEY configured"})
        await ws.close(code=1011)
        return

    stream_sid: dict[str, str] = {"sid": ""}
    persona = build_outbound_call_persona(
        user_name=_resolve_user_name(),
        callee_name=call.callee_name,
        callee_kind=call.callee_kind,
        goal=call.goal,
        instructions=call.instructions,
    )
    setup = build_gemini_setup_payload(
        model=call.model,
        voice=call.voice,
        system_instruction=persona,
        tools=outbound_call_tool_declarations(),
    )

    bridge_ref: dict[str, Optional[GeminiLiveBridge]] = {"bridge": None}

    async def _on_event(ev: dict[str, Any]) -> None:
        ev_type = ev.get("type")
        if ev_type == "transcript":
            speaker = "callee" if ev.get("speaker") == "user" else "assistant"
            mgr.append_transcript(call_id, speaker, str(ev.get("text") or ""))
            if mode == "loopback":
                await ws.send_json({"type": "transcript", "speaker": speaker, "text": ev.get("text")})
            return
        if ev_type == "tool_call":
            name = ev.get("name")
            cid = str(ev.get("id") or "")
            args = ev.get("args") or {}
            if name == TOOL_ASK_USER:
                q = mgr.ask_user(
                    call_id,
                    tool_call_id=cid,
                    question=str(args.get("question") or ""),
                    options=args.get("options") if isinstance(args.get("options"), list) else [],
                )
                if mode == "loopback":
                    await ws.send_json({"type": "question", "question": q.__dict__})
                return
            if name == TOOL_END_PHONE_CALL:
                mgr.end_call(
                    call_id,
                    outcome=str(args.get("outcome") or "completed"),
                    end_reason="agent_hangup",
                    summary=str(args.get("summary") or ""),
                )
                if mode == "loopback":
                    await ws.send_json({"type": "ended"})
                return
        if ev_type == "audio" and ev.get("data"):
            if mode == "twilio":
                pcm24 = base64.b64decode(ev["data"])
                pcm8 = resample_pcm16(pcm24, 24000, 8000)
                ulaw = pcm16_to_mulaw(pcm8)
                await ws.send_json(
                    {
                        "event": "media",
                        "streamSid": stream_sid["sid"],
                        "media": {"payload": base64.b64encode(ulaw).decode("ascii")},
                    }
                )
            else:
                await ws.send_json(ev)
            return
        if ev_type == "interrupted":
            if mode == "twilio" and stream_sid["sid"]:
                await ws.send_json({"event": "clear", "streamSid": stream_sid["sid"]})
            elif mode == "loopback":
                await ws.send_json(ev)
            return
        if mode == "loopback":
            await ws.send_json(ev)

    bridge = GeminiLiveBridge(api_key=api_key, setup_payload=setup, on_event=_on_event)
    bridge_ref["bridge"] = bridge
    mgr.attach_bridge(call_id, bridge, asyncio.get_running_loop())
    mgr.mark_in_progress(call_id)

    try:
        await bridge.connect()
        await asyncio.wait_for(bridge.setup_complete.wait(), timeout=15.0)
        # Prompt Gemini to open the call once connected
        await bridge.send_text(
            "The recipient has just answered the phone. Greet them politely and state why you are calling.",
            turn_complete=True,
        )
        while True:
            msg = await ws.receive()
            if msg["type"] == "websocket.disconnect":
                break
            if mode == "loopback":
                if msg.get("bytes"):
                    await bridge.send_audio(msg["bytes"], sample_rate=16000)
                    continue
                if msg.get("text"):
                    data = json.loads(msg["text"])
                    if data.get("type") == "audio" and data.get("data"):
                        await bridge.send_audio(base64.b64decode(data["data"]), sample_rate=16000)
                    elif data.get("type") == "hangup":
                        break
            else:
                if not msg.get("text"):
                    continue
                data = json.loads(msg["text"])
                ev_name = data.get("event")
                if ev_name == "start":
                    stream_sid["sid"] = str((data.get("start") or {}).get("streamSid") or "")
                elif ev_name == "media":
                    payload = (data.get("media") or {}).get("payload")
                    if payload:
                        ulaw = base64.b64decode(payload)
                        pcm8 = mulaw_to_pcm16(ulaw)
                        pcm16 = resample_pcm16(pcm8, 8000, 16000)
                        await bridge.send_audio(pcm16, sample_rate=16000)
                elif ev_name == "stop":
                    break
    except (WebSocketDisconnect, asyncio.CancelledError):
        pass
    except Exception as exc:
        logger.warning("outbound call bridge (%s) error: %s", call_id, exc)
    finally:
        await bridge.close()
        mgr.detach_bridge(call_id)
        cur = mgr.get_call(call_id)
        if cur and cur.status != "ended":
            mgr.end_call(call_id, outcome="completed", end_reason="disconnected")


@router.websocket("/api/phone-calls/{call_id}/audio")
async def phone_call_loopback_ws(ws: WebSocket, call_id: str):
    await ws.accept()
    await _run_outbound_call_bridge(ws=ws, call_id=call_id, mode="loopback")


@router.websocket("/api/phone-calls/{call_id}/twilio-media")
async def phone_call_twilio_media_ws(ws: WebSocket, call_id: str):
    await ws.accept()
    await _run_outbound_call_bridge(ws=ws, call_id=call_id, mode="twilio")
