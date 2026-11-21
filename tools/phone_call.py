"""Grok-Bot-inspired outbound phone call manager, voice-bot session helpers, and `phone_call` tool.

Models the full phone-call lifecycle adapted for Hermes + Gemini 3.8 Live:
- Approval gate: ``pending_approval`` -> ``dialing`` -> ``in_progress`` -> ``ended``
- Mid-call user Q&A (``ask_user`` / ``answer_question``) with live ``toolResponse`` delivery
- Mid-call context injection (``inject_context`` -> ``clientContent``)
- Call controls: ``hang_up``, ``handoff``, live transcript turns, duration tracking
- Transports: ``loopback`` (local Desktop mic/speaker prototype, $0) and ``twilio_media_stream``
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import sqlite3
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

logger = logging.getLogger(__name__)

VALID_STATUSES = frozenset({"pending_approval", "dialing", "in_progress", "ended"})
VALID_OUTCOMES = frozenset({"completed", "voicemail", "no_answer", "failed", "handed_off", "cancelled"})
VALID_CALLEE_KINDS = frozenset({"person", "storefront"})
VALID_TRANSPORTS = frozenset({"loopback", "twilio_media_stream", "sip"})


@dataclass
class PhoneCallTranscriptTurn:
    speaker: str  # "assistant" | "callee" | "system"
    text: str
    timestamp_ms: int = field(default_factory=lambda: int(time.time() * 1000))


@dataclass
class PhoneCallQuestion:
    question_id: str
    tool_call_id: str
    question: str
    options: list[str] = field(default_factory=list)
    answer: Optional[str] = None
    asked_at_ms: int = field(default_factory=lambda: int(time.time() * 1000))
    answered_at_ms: Optional[int] = None


@dataclass
class PhoneCallRecord:
    call_id: str
    callee_name: str
    callee_number: str
    callee_kind: str  # "person" | "storefront"
    goal: str
    instructions: str = ""
    agent_profile: str = "default"
    session_id: str = ""
    voice: str = "Puck"
    model: str = "gemini-3.8-live"
    transport: str = "loopback"
    direction: str = "outbound"  # "outbound" | "inbound"
    twilio_call_sid: Optional[str] = None
    status: str = "pending_approval"
    outcome: Optional[str] = None
    end_reason: Optional[str] = None
    summary: Optional[str] = None
    created_at_ms: int = field(default_factory=lambda: int(time.time() * 1000))
    started_at_ms: Optional[int] = None
    ended_at_ms: Optional[int] = None
    duration_ms: Optional[int] = None
    transcript: list[PhoneCallTranscriptTurn] = field(default_factory=list)
    questions: list[PhoneCallQuestion] = field(default_factory=list)
    injected_context: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class PhoneCallManager:
    """In-process registry & state machine for Hermes bot phone calls."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._calls: dict[str, PhoneCallRecord] = {}
        self._bridges: dict[str, Any] = {}  # call_id -> (loop, GeminiLiveBridge)
        self._subscribers: list[tuple[asyncio.AbstractEventLoop, asyncio.Queue[dict[str, Any]]]] = []

    def subscribe(self) -> asyncio.Queue[dict[str, Any]]:
        loop = asyncio.get_running_loop()
        q: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=256)
        with self._lock:
            self._subscribers.append((loop, q))
        return q

    def unsubscribe(self, q: asyncio.Queue[dict[str, Any]]) -> None:
        with self._lock:
            self._subscribers = [(lp, qq) for lp, qq in self._subscribers if qq is not q]

    def _notify(self, event_type: str, call: PhoneCallRecord, extra: Optional[dict[str, Any]] = None) -> None:
        payload: dict[str, Any] = {"type": event_type, "call": call.to_dict()}
        if extra:
            payload.update(extra)
        with self._lock:
            subs = list(self._subscribers)
        for loop, q in subs:
            if loop.is_closed():
                continue
            try:
                loop.call_soon_threadsafe(q.put_nowait, payload)
            except Exception:
                pass

    def attach_bridge(self, call_id: str, bridge: Any, loop: asyncio.AbstractEventLoop) -> None:
        with self._lock:
            self._bridges[call_id] = (loop, bridge)

    def detach_bridge(self, call_id: str) -> None:
        with self._lock:
            self._bridges.pop(call_id, None)

    def _dispatch_to_bridge(self, call_id: str, coro_factory: Callable[[Any], Any]) -> bool:
        with self._lock:
            entry = self._bridges.get(call_id)
        if not entry:
            return False
        loop, bridge = entry
        if loop.is_closed():
            return False
        try:
            asyncio.run_coroutine_threadsafe(coro_factory(bridge), loop)
            return True
        except Exception as exc:
            logger.debug("phone_call bridge dispatch failed (%s): %s", call_id, exc)
            return False

    def create_call(
        self,
        *,
        callee_number: str,
        goal: str,
        callee_name: str = "",
        callee_kind: str = "person",
        instructions: str = "",
        agent_profile: str = "default",
        session_id: str = "",
        voice: str = "Puck",
        model: str = "gemini-3.8-live",
        transport: str = "loopback",
        direction: str = "outbound",
        auto_approve: bool = False,
    ) -> PhoneCallRecord:
        kind = callee_kind if callee_kind in VALID_CALLEE_KINDS else "person"
        tx = transport if transport in VALID_TRANSPORTS else "loopback"
        dir_ = "inbound" if direction == "inbound" else "outbound"
        call = PhoneCallRecord(
            call_id=f"call_{uuid.uuid4().hex[:12]}",
            callee_name=callee_name.strip(),
            callee_number=callee_number.strip(),
            callee_kind=kind,
            goal=goal.strip(),
            instructions=instructions.strip(),
            agent_profile=agent_profile or "default",
            session_id=session_id or "",
            voice=voice or "Puck",
            model=model or "gemini-3.8-live",
            transport=tx,
            direction=dir_,
            status="dialing" if auto_approve else "pending_approval",
        )
        with self._lock:
            self._calls[call.call_id] = call
        self._notify("call_created", call)
        return call

    def get_call(self, call_id: str) -> Optional[PhoneCallRecord]:
        with self._lock:
            return self._calls.get(call_id)

    def list_calls(self, *, session_id: Optional[str] = None, active_only: bool = False) -> list[PhoneCallRecord]:
        with self._lock:
            items = list(self._calls.values())
        if session_id:
            items = [c for c in items if c.session_id == session_id]
        if active_only:
            items = [c for c in items if c.status != "ended"]
        items.sort(key=lambda c: c.created_at_ms, reverse=True)
        return items

    def approve_call(self, call_id: str) -> PhoneCallRecord:
        with self._lock:
            call = self._require(call_id)
            if call.status != "pending_approval":
                raise ValueError(f"call {call_id} is {call.status}, not pending_approval")
            call.status = "dialing"
        self._notify("call_approved", call)
        return call

    def reject_call(self, call_id: str, reason: str = "rejected_by_user") -> PhoneCallRecord:
        with self._lock:
            call = self._require(call_id)
            if call.status == "ended":
                return call
            call.status = "ended"
            call.outcome = "cancelled"
            call.end_reason = reason
            call.ended_at_ms = int(time.time() * 1000)
            call.duration_ms = 0
        self._notify("call_ended", call)
        return call

    def mark_in_progress(self, call_id: str) -> PhoneCallRecord:
        with self._lock:
            call = self._require(call_id)
            if call.status == "ended":
                return call
            call.status = "in_progress"
            if call.started_at_ms is None:
                call.started_at_ms = int(time.time() * 1000)
        self._notify("call_in_progress", call)
        return call

    def append_transcript(self, call_id: str, speaker: str, text: str) -> Optional[PhoneCallTranscriptTurn]:
        clean = text.strip()
        if not clean:
            return None
        with self._lock:
            call = self._require(call_id)
            if call.transcript and call.transcript[-1].speaker == speaker:
                call.transcript[-1].text = f"{call.transcript[-1].text} {clean}".strip()
                turn = call.transcript[-1]
            else:
                turn = PhoneCallTranscriptTurn(speaker=speaker, text=clean)
                call.transcript.append(turn)
        self._notify("call_transcript", call, {"turn": asdict(turn)})
        return turn

    def ask_user(
        self,
        call_id: str,
        *,
        tool_call_id: str,
        question: str,
        options: Optional[list[str]] = None,
    ) -> PhoneCallQuestion:
        with self._lock:
            call = self._require(call_id)
            q = PhoneCallQuestion(
                question_id=f"q_{uuid.uuid4().hex[:8]}",
                tool_call_id=tool_call_id,
                question=question.strip(),
                options=[str(o) for o in (options or [])],
            )
            call.questions.append(q)
        self._notify("call_question", call, {"question": asdict(q)})
        return q

    def answer_question(self, call_id: str, question_id: str, answer: str) -> PhoneCallQuestion:
        clean = answer.strip()
        if not clean:
            raise ValueError("answer cannot be empty")
        with self._lock:
            call = self._require(call_id)
            target = next((q for q in call.questions if q.question_id == question_id), None)
            if target is None:
                raise KeyError(f"unknown question {question_id}")
            target.answer = clean
            target.answered_at_ms = int(time.time() * 1000)
            tool_call_id = target.tool_call_id
        self._dispatch_to_bridge(
            call_id,
            lambda b: b.send_tool_response(
                tool_call_id,
                "ask_user",
                {"answer": clean},
                scheduling="INTERRUPT",
            ),
        )
        self._notify("call_question_answered", call, {"question": asdict(target)})
        return target

    def inject_context(self, call_id: str, text: str) -> PhoneCallRecord:
        clean = text.strip()
        if not clean:
            raise ValueError("context text cannot be empty")
        with self._lock:
            call = self._require(call_id)
            if call.status == "ended":
                raise ValueError(f"call {call_id} has already ended")
            call.injected_context.append(clean)
        self._dispatch_to_bridge(
            call_id,
            lambda b: b.send_text(
                f"[Live update from the user — incorporate naturally into the call: {clean}]",
                turn_complete=True,
            ),
        )
        self._notify("call_context_injected", call, {"context": clean})
        return call

    def end_call(
        self,
        call_id: str,
        *,
        outcome: str = "completed",
        end_reason: str = "hang_up",
        summary: Optional[str] = None,
    ) -> PhoneCallRecord:
        resolved_outcome = outcome if outcome in VALID_OUTCOMES else "completed"
        with self._lock:
            call = self._require(call_id)
            if call.status != "ended":
                now = int(time.time() * 1000)
                call.status = "ended"
                call.outcome = resolved_outcome
                call.end_reason = end_reason
                if summary:
                    call.summary = summary.strip()
                call.ended_at_ms = now
                call.duration_ms = max(0, now - call.started_at_ms) if call.started_at_ms else 0
        self._dispatch_to_bridge(call_id, lambda b: b.close())
        self.detach_bridge(call_id)
        self._notify("call_ended", call)
        return call

    def _require(self, call_id: str) -> PhoneCallRecord:
        call = self._calls.get(call_id)
        if call is None:
            raise KeyError(f"unknown phone call: {call_id}")
        return call


_MANAGER = PhoneCallManager()


def get_phone_call_manager() -> PhoneCallManager:
    return _MANAGER


def resolve_twilio_config() -> dict[str, str]:
    """Read Twilio credentials & public webhook base URL from env / ~/.hermes/.env."""
    keys = ("TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_PHONE_NUMBER", "HERMES_PUBLIC_URL")
    out: dict[str, str] = {}
    env_map: dict[str, str] = {}
    try:
        from hermes_cli.config import load_env
        env_map = load_env()
    except Exception:
        pass
    for k in keys:
        out[k] = (os.environ.get(k) or str(env_map.get(k) or "")).strip()
    return out


def dial_via_twilio(call: PhoneCallRecord, public_base_url: str = "") -> Optional[str]:
    """Place a real outbound PSTN call via Twilio REST API pointing at our TwiML stream webhook."""
    cfg = resolve_twilio_config()
    sid = cfg["TWILIO_ACCOUNT_SID"]
    token = cfg["TWILIO_AUTH_TOKEN"]
    from_num = cfg["TWILIO_PHONE_NUMBER"]
    base = (public_base_url or cfg["HERMES_PUBLIC_URL"]).rstrip("/")
    if not (sid and token and from_num and base):
        return None
    twiml_url = f"{base}/api/phone-calls/twilio/twiml/{call.call_id}"
    form = urllib.parse.urlencode(
        {"To": call.callee_number, "From": from_num, "Url": twiml_url}
    ).encode("utf-8")
    auth = base64.b64encode(f"{sid}:{token}".encode("utf-8")).decode("ascii")
    req = urllib.request.Request(
        f"https://api.twilio.com/2010-04-01/Accounts/{sid}/Calls.json",
        data=form,
        method="POST",
        headers={
            "Authorization": f"Basic {auth}",
            "Content-Type": "application/x-www-form-urlencoded",
        },
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    call.twilio_call_sid = str(data.get("sid") or "")
    return call.twilio_call_sid


# ── Hermes workspace helpers for Gemini Live direct-call VoiceCallSessionTools

def _hermes_home() -> Path:
    return Path(os.environ.get("HERMES_HOME") or (Path.home() / ".hermes"))


def recall_session_texts(session_id: str = "", limit: int = 10) -> dict[str, Any]:
    """Read recent text messages from Hermes ``state.db`` for the live voice layer."""
    db_path = _hermes_home() / "state.db"
    if not db_path.exists():
        return {"messages": [], "note": "no state.db found"}
    limit = max(1, min(int(limit or 10), 40))
    try:
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        cur = conn.cursor()
        if session_id:
            cur.execute(
                "SELECT role, content FROM messages WHERE session_id=? AND role IN ('user','assistant') "
                "AND content IS NOT NULL AND content != '' ORDER BY id DESC LIMIT ?",
                (session_id, limit),
            )
        else:
            cur.execute(
                "SELECT role, content FROM messages WHERE role IN ('user','assistant') "
                "AND content IS NOT NULL AND content != '' ORDER BY id DESC LIMIT ?",
                (limit,),
            )
        rows = list(reversed(cur.fetchall()))
        conn.close()
        return {
            "messages": [{"role": r, "text": str(c)[:600]} for r, c in rows],
        }
    except Exception as exc:
        return {"messages": [], "error": str(exc)}


def search_hermes_conversations(query: str, limit: int = 5) -> dict[str, Any]:
    """Search past Hermes sessions/messages by keyword."""
    db_path = _hermes_home() / "state.db"
    q = (query or "").strip()
    if not q or not db_path.exists():
        return {"matches": []}
    limit = max(1, min(int(limit or 5), 20))
    try:
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        cur = conn.cursor()
        cur.execute(
            "SELECT s.id, s.title, m.role, substr(m.content, 1, 300) "
            "FROM messages m JOIN sessions s ON s.id = m.session_id "
            "WHERE m.content LIKE ? ORDER BY m.id DESC LIMIT ?",
            (f"%{q}%", limit),
        )
        rows = cur.fetchall()
        conn.close()
        return {
            "matches": [
                {"session_id": sid, "title": title or "", "role": role, "snippet": snip or ""}
                for sid, title, role, snip in rows
            ]
        }
    except Exception as exc:
        return {"matches": [], "error": str(exc)}


def peek_hermes_agents(agent_filter: str = "") -> dict[str, Any]:
    """List local Hermes bot profiles and any synced remote bot_relay roster entries."""
    home = _hermes_home()
    filt = (agent_filter or "").strip().lower()
    agents: list[dict[str, Any]] = [{"profile": "default", "handle": "hermes", "location": "local"}]
    profiles_dir = home / "profiles"
    if profiles_dir.is_dir():
        for child in sorted(profiles_dir.iterdir()):
            if child.is_dir() and not child.name.startswith("."):
                agents.append({"profile": child.name, "handle": child.name, "location": "local"})
    roster_file = home / "bot_relay" / "roster.json"
    if roster_file.exists():
        try:
            data = json.loads(roster_file.read_text(encoding="utf-8"))
            rows = data if isinstance(data, list) else data.get("agents", [])
            for row in rows:
                if isinstance(row, dict) and row.get("profile"):
                    agents.append(
                        {
                            "profile": str(row.get("profile")),
                            "handle": str(row.get("handle") or row.get("profile")),
                            "title": str(row.get("title") or ""),
                            "location": str(row.get("connection_id") or "remote"),
                        }
                    )
        except Exception:
            pass
    if filt:
        agents = [
            a
            for a in agents
            if filt in a["profile"].lower() or filt in a.get("handle", "").lower()
        ]
    return {"agents": agents}


def peek_hermes_runs(query: str = "") -> dict[str, Any]:
    """Inspect active phone calls and any running background processes in ``processes.json``."""
    mgr = get_phone_call_manager()
    active_calls = [
        {
            "call_id": c.call_id,
            "callee": c.callee_name or c.callee_number,
            "status": c.status,
            "pending_questions": sum(1 for q in c.questions if q.answer is None),
        }
        for c in mgr.list_calls(active_only=True)
    ]
    procs: list[dict[str, Any]] = []
    proc_file = _hermes_home() / "processes.json"
    if proc_file.exists():
        try:
            raw = json.loads(proc_file.read_text(encoding="utf-8"))
            items = raw.values() if isinstance(raw, dict) else (raw if isinstance(raw, list) else [])
            q = (query or "").strip().lower()
            for p in items:
                if not isinstance(p, dict):
                    continue
                if q and q not in json.dumps(p).lower():
                    continue
                procs.append(
                    {
                        "id": p.get("id") or p.get("pid"),
                        "status": p.get("status", "unknown"),
                        "command": str(p.get("command") or "")[:120],
                    }
                )
        except Exception:
            pass
    return {"active_phone_calls": active_calls, "processes": procs[:15]}


# ── Hermes agent tool: `phone_call`

PHONE_CALL_SCHEMA = {
    "name": "phone_call",
    "description": (
        "Place and manage outbound AI voice phone calls on behalf of the user (powered by "
        "Gemini 3.8 Live). Supports approval gating before dialing, mid-call context injection, "
        "answering mid-call questions from the voice bot, hanging up, and checking call status."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": [
                    "place_call",
                    "approve",
                    "send_context",
                    "answer_question",
                    "hang_up",
                    "get_status",
                    "list_calls",
                ],
                "description": "Operation to perform.",
            },
            "call_id": {"type": "string", "description": "Target call ID for existing calls."},
            "callee_number": {"type": "string", "description": "place_call: phone number (E.164 or local)."},
            "callee_name": {"type": "string", "description": "place_call: person or business name."},
            "callee_kind": {
                "type": "string",
                "enum": ["person", "storefront"],
                "description": "place_call: whether calling a person or a business.",
            },
            "goal": {"type": "string", "description": "place_call: what the bot should accomplish on the call."},
            "instructions": {"type": "string", "description": "place_call: extra instructions or constraints."},
            "transport": {
                "type": "string",
                "enum": ["loopback", "twilio_media_stream", "sip"],
                "description": "place_call: audio transport (default: loopback for local desktop testing).",
            },
            "context": {"type": "string", "description": "send_context: live update to inject into the active call."},
            "question_id": {"type": "string", "description": "answer_question: ID of the pending mid-call question."},
            "answer": {"type": "string", "description": "answer_question: answer to relay to the live call."},
        },
        "required": ["action"],
    },
}


def _handle_phone_call(args: dict[str, Any], **kwargs: Any) -> str:
    mgr = get_phone_call_manager()
    action = str(args.get("action") or "").strip()
    try:
        if action == "place_call":
            number = str(args.get("callee_number") or "").strip()
            goal = str(args.get("goal") or "").strip()
            if not number or not goal:
                return json.dumps({"ok": False, "error": "place_call requires callee_number and goal"})
            call = mgr.create_call(
                callee_number=number,
                callee_name=str(args.get("callee_name") or ""),
                callee_kind=str(args.get("callee_kind") or "person"),
                goal=goal,
                instructions=str(args.get("instructions") or ""),
                transport=str(args.get("transport") or "loopback"),
                session_id=str(kwargs.get("session_id") or ""),
                agent_profile=str(kwargs.get("profile") or "default"),
            )
            return json.dumps({"ok": True, "call": call.to_dict()})

        if action == "approve":
            call = mgr.approve_call(str(args.get("call_id") or ""))
            return json.dumps({"ok": True, "call": call.to_dict()})

        if action == "send_context":
            call = mgr.inject_context(str(args.get("call_id") or ""), str(args.get("context") or ""))
            return json.dumps({"ok": True, "call": call.to_dict()})

        if action == "answer_question":
            q = mgr.answer_question(
                str(args.get("call_id") or ""),
                str(args.get("question_id") or ""),
                str(args.get("answer") or ""),
            )
            return json.dumps({"ok": True, "question": asdict(q)})

        if action == "hang_up":
            call = mgr.end_call(str(args.get("call_id") or ""), outcome="completed", end_reason="hang_up")
            return json.dumps({"ok": True, "call": call.to_dict()})

        if action == "get_status":
            call = mgr.get_call(str(args.get("call_id") or ""))
            if call is None:
                return json.dumps({"ok": False, "error": "call not found"})
            return json.dumps({"ok": True, "call": call.to_dict()})

        if action == "list_calls":
            calls = [c.to_dict() for c in mgr.list_calls()]
            return json.dumps({"ok": True, "calls": calls})

        return json.dumps({"ok": False, "error": f"unknown action: {action}"})
    except Exception as exc:
        return json.dumps({"ok": False, "error": str(exc)})


try:
    from tools.registry import registry

    registry.register(
        name="phone_call",
        toolset="tts",
        schema=PHONE_CALL_SCHEMA,
        handler=_handle_phone_call,
        emoji="📞",
    )
except Exception:
    pass
