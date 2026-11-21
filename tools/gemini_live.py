"""Gemini Live (gemini-3.8-live) full-duplex voice engine & Grok-Bot-style voice session tools.

Provides:
- Credential & config resolution for ``voice.gemini_live`` (uses ``GOOGLE_API_KEY`` / ``GEMINI_API_KEY``)
- BidiGenerateContent setup payload builder with ``NON_BLOCKING`` function declarations adapted
  from the Grok Bot VoiceCallSessionTools architecture (``send_task``, ``recall_texts``,
  ``search_conversations``, ``peek_runs``, ``peek_agents``, ``switch_agent``, ``stay_silent``,
  ``end_call``) plus outbound-call tools (``ask_user``, ``end_phone_call``)
- Pure-Python G.711 μ-law ↔ PCM16 8kHz/16kHz/24kHz audio transcoding (Python 3.12–3.14 safe)
- Async ``GeminiLiveBridge`` WebSocket client for both Desktop direct calls and outbound phone calls
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import struct
from typing import Any, Awaitable, Callable, Dict, List, Optional
from urllib.parse import urlencode

logger = logging.getLogger(__name__)

GEMINI_LIVE_MODE = "gemini-live"
DEFAULT_GEMINI_LIVE_MODEL = "gemini-3.8-live"
DEFAULT_GEMINI_LIVE_VOICE = "Puck"
DEFAULT_GEMINI_LIVE_WS_URL = (
    "wss://generativelanguage.googleapis.com/ws/"
    "google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent"
)

GEMINI_LIVE_VOICES = (
    "Puck",
    "Charon",
    "Kore",
    "Fenrir",
    "Aoede",
    "Zephyr",
    "Leda",
    "Orus",
)

# Tool names (Grok-Bot VoiceCallSessionTools adapted for Hermes)
TOOL_SEND_TASK = "send_task"
TOOL_RECALL_TEXTS = "recall_texts"
TOOL_SEARCH_CONVERSATIONS = "search_conversations"
TOOL_PEEK_RUNS = "peek_runs"
TOOL_PEEK_AGENTS = "peek_agents"
TOOL_SWITCH_AGENT = "switch_agent"
TOOL_STAY_SILENT = "stay_silent"
TOOL_END_CALL = "end_call"

# Outbound phone-call voice tools
TOOL_ASK_USER = "ask_user"
TOOL_END_PHONE_CALL = "end_phone_call"

GEMINI_DIRECT_CALL_PERSONA = (
    "You are Hermes, a calm, natural, full-duplex voice assistant connected to the user's "
    "Hermes bot workspace. Speak concisely in plain conversational sentences — no markdown, "
    "no bullet lists, no code blocks.\n\n"
    "Interruption policy: Stop speaking immediately when the user interrupts.\n\n"
    "Delegation & tool policy (all tools are NON_BLOCKING — you can keep talking naturally "
    "while they run in the background):\n"
    "- Call `send_task` whenever the user asks you to do, check, run, edit, search, or remember "
    "anything that requires the main Hermes agent and its tools. Briefly acknowledge you're on it "
    "and keep chatting if they want.\n"
    "- Call `recall_texts` or `search_conversations` when the user refers to prior chat history.\n"
    "- Call `peek_runs` to check on running tasks or background work.\n"
    "- Call `peek_agents` to see available Hermes bot profiles, and `switch_agent` if the user "
    "asks to talk to a different bot.\n"
    "- Call `stay_silent` if the user is just thinking out loud or talking to someone else.\n"
    "- Call `end_call` when the user says goodbye or asks to hang up."
)


def build_outbound_call_persona(
    *,
    user_name: str,
    callee_name: str,
    callee_kind: str,
    goal: str,
    instructions: str = "",
) -> str:
    target = callee_name or ("the business" if callee_kind == "storefront" else "the recipient")
    parts = [
        f"You are an AI assistant placing an outbound phone call on behalf of {user_name}.",
        f"You are calling {target}.",
        f"Goal of this call: {goal}",
        "Rules:",
        "- Be polite, concise, natural, and transparent that you are an AI assistant calling on "
        f"behalf of {user_name}.",
        "- Speak in short, natural phone-call turns. Stop immediately if the other person interrupts.",
        "- If the other person asks a question you don't know the answer to (like preferred times, "
        "account details, or a decision), call `ask_user` (NON_BLOCKING) and tell the other person "
        "'One moment, let me check with them.' When the answer arrives, relay it naturally.",
        "- When the goal is complete, the call goes to voicemail, or the other person ends the call, "
        "say goodbye politely and call `end_phone_call` with the outcome and a brief summary.",
    ]
    if instructions.strip():
        parts.append(f"Additional instructions: {instructions.strip()}")
    return "\n".join(parts)


def direct_call_tool_declarations() -> list[dict[str, Any]]:
    """NON_BLOCKING function declarations for direct user <-> Hermes bot calls."""
    return [
        {
            "name": TOOL_SEND_TASK,
            "description": (
                "Delegate a task or question to the main Hermes bot asynchronously while you "
                "continue talking with the user."
            ),
            "behavior": "NON_BLOCKING",
            "parameters": {
                "type": "OBJECT",
                "properties": {
                    "request": {
                        "type": "STRING",
                        "description": "Clear description of what the main Hermes bot should do or answer.",
                    },
                    "already_announced": {
                        "type": "BOOLEAN",
                        "description": "True if you already told the user you are checking or working on it.",
                    },
                },
                "required": ["request"],
            },
        },
        {
            "name": TOOL_RECALL_TEXTS,
            "description": "Read recent text messages from the active Hermes chat session.",
            "behavior": "NON_BLOCKING",
            "parameters": {
                "type": "OBJECT",
                "properties": {
                    "limit": {
                        "type": "INTEGER",
                        "description": "Maximum number of recent messages to fetch (default 10).",
                    },
                },
            },
        },
        {
            "name": TOOL_SEARCH_CONVERSATIONS,
            "description": "Search past Hermes sessions and messages for a topic or detail.",
            "behavior": "NON_BLOCKING",
            "parameters": {
                "type": "OBJECT",
                "properties": {
                    "query": {"type": "STRING", "description": "Search query."},
                    "limit": {"type": "INTEGER", "description": "Max results (default 5)."},
                },
                "required": ["query"],
            },
        },
        {
            "name": TOOL_PEEK_RUNS,
            "description": "Check currently running background tasks, active turns, or recent tool runs.",
            "behavior": "NON_BLOCKING",
            "parameters": {
                "type": "OBJECT",
                "properties": {
                    "query": {"type": "STRING", "description": "Optional filter."},
                },
            },
        },
        {
            "name": TOOL_PEEK_AGENTS,
            "description": "List available Hermes bot profiles and their current status.",
            "behavior": "NON_BLOCKING",
            "parameters": {
                "type": "OBJECT",
                "properties": {
                    "agent": {"type": "STRING", "description": "Optional specific bot/profile name."},
                },
            },
        },
        {
            "name": TOOL_SWITCH_AGENT,
            "description": "Switch which Hermes bot profile this voice call is connected to.",
            "behavior": "NON_BLOCKING",
            "parameters": {
                "type": "OBJECT",
                "properties": {
                    "target": {"type": "STRING", "description": "Target bot/profile name or handle."},
                },
                "required": ["target"],
            },
        },
        {
            "name": TOOL_STAY_SILENT,
            "description": "Remain silent without speaking a reply for this turn.",
            "behavior": "NON_BLOCKING",
            "parameters": {"type": "OBJECT", "properties": {}},
        },
        {
            "name": TOOL_END_CALL,
            "description": "End the current voice call cleanly.",
            "behavior": "NON_BLOCKING",
            "parameters": {"type": "OBJECT", "properties": {}},
        },
    ]


def outbound_call_tool_declarations() -> list[dict[str, Any]]:
    """NON_BLOCKING function declarations for bot-placed outbound phone calls."""
    return [
        {
            "name": TOOL_ASK_USER,
            "description": (
                "Ask the human user a quick question in Hermes chat while keeping the phone "
                "call alive. Use when the callee asks for information or a decision you do not have."
            ),
            "behavior": "NON_BLOCKING",
            "parameters": {
                "type": "OBJECT",
                "properties": {
                    "question": {
                        "type": "STRING",
                        "description": "Short question for the user to answer.",
                    },
                    "options": {
                        "type": "ARRAY",
                        "items": {"type": "STRING"},
                        "description": "Optional quick-reply choices.",
                    },
                },
                "required": ["question"],
            },
        },
        {
            "name": TOOL_END_PHONE_CALL,
            "description": "Hang up the outbound phone call and record its outcome and summary.",
            "behavior": "NON_BLOCKING",
            "parameters": {
                "type": "OBJECT",
                "properties": {
                    "outcome": {
                        "type": "STRING",
                        "enum": ["completed", "voicemail", "no_answer", "failed", "handed_off"],
                        "description": "Call outcome.",
                    },
                    "summary": {
                        "type": "STRING",
                        "description": "Brief summary of what happened on the call.",
                    },
                },
                "required": ["outcome", "summary"],
            },
        },
    ]


def _voice_section() -> dict[str, Any]:
    try:
        from hermes_cli.config import load_config
        voice = load_config().get("voice")
    except Exception:
        return {}
    return voice if isinstance(voice, dict) else {}


def _gemini_live_section(voice: Optional[dict[str, Any]] = None) -> dict[str, Any]:
    section = (voice if voice is not None else _voice_section()).get("gemini_live")
    return section if isinstance(section, dict) else {}


def resolve_gemini_api_key(live: Optional[dict[str, Any]] = None) -> str:
    """Resolve Gemini API key: ``voice.gemini_live.api_key`` → ``GEMINI_API_KEY`` → ``GOOGLE_API_KEY``."""
    cfg = live if live is not None else _gemini_live_section()
    direct = str(cfg.get("api_key") or "").strip()
    if direct:
        return direct
    for env_name in ("GEMINI_API_KEY", "GOOGLE_API_KEY"):
        val = (os.environ.get(env_name) or "").strip()
        if val:
            return val
    try:
        from hermes_cli.config import load_env
        env_map = load_env()
        for env_name in ("GEMINI_API_KEY", "GOOGLE_API_KEY"):
            val = str(env_map.get(env_name) or "").strip()
            if val:
                return val
    except Exception:
        pass
    return ""


def resolve_gemini_live_status(voice: Optional[dict[str, Any]] = None) -> dict[str, Any]:
    """Non-secret readiness verdict for Gemini 3.8 Live."""
    v = voice if voice is not None else _voice_section()
    live = _gemini_live_section(v)
    api_key = resolve_gemini_api_key(live)
    return {
        "available": bool(api_key),
        "reason": None if api_key else "no Google/Gemini API key (set GOOGLE_API_KEY or GEMINI_API_KEY)",
        "model": str(live.get("model") or DEFAULT_GEMINI_LIVE_MODEL),
        "voice": str(live.get("voice") or DEFAULT_GEMINI_LIVE_VOICE),
    }


def gemini_ws_url(api_key: str, base_url: Optional[str] = None) -> str:
    base = (base_url or DEFAULT_GEMINI_LIVE_WS_URL).strip()
    sep = "&" if "?" in base else "?"
    return f"{base}{sep}{urlencode({'key': api_key})}"


def build_gemini_setup_payload(
    *,
    model: Optional[str] = None,
    voice: Optional[str] = None,
    system_instruction: Optional[str] = None,
    tools: Optional[list[dict[str, Any]]] = None,
    enable_transcription: bool = True,
) -> dict[str, Any]:
    """Build the initial ``setup`` message for Gemini Live ``BidiGenerateContent``."""
    cfg = _gemini_live_section()
    resolved_model = str(model or cfg.get("model") or DEFAULT_GEMINI_LIVE_MODEL).strip()
    if not resolved_model.startswith("models/"):
        resolved_model = f"models/{resolved_model}"
    resolved_voice = str(voice or cfg.get("voice") or DEFAULT_GEMINI_LIVE_VOICE).strip()
    extra = str(cfg.get("instructions") or "").strip()
    base_inst = system_instruction if system_instruction is not None else GEMINI_DIRECT_CALL_PERSONA
    full_inst = f"{base_inst}\n\n{extra}" if (extra and system_instruction is None) else base_inst

    setup: dict[str, Any] = {
        "model": resolved_model,
        "generationConfig": {
            "responseModalities": ["AUDIO"],
            "speechConfig": {
                "voiceConfig": {
                    "prebuiltVoiceConfig": {"voiceName": resolved_voice},
                },
            },
        },
        "systemInstruction": {"parts": [{"text": full_inst}]},
    }
    if enable_transcription:
        setup["inputAudioTranscription"] = {}
        setup["outputAudioTranscription"] = {}
    decls = tools if tools is not None else direct_call_tool_declarations()
    if decls:
        setup["tools"] = [{"functionDeclarations": decls}]
    return {"setup": setup}


def build_audio_input_message(pcm16_bytes: bytes, sample_rate: int = 16000) -> dict[str, Any]:
    return {
        "realtimeInput": {
            "audio": {
                "mimeType": f"audio/pcm;rate={sample_rate}",
                "data": base64.b64encode(pcm16_bytes).decode("ascii"),
            }
        }
    }


def build_client_content_message(
    text: str,
    *,
    role: str = "user",
    turn_complete: bool = True,
) -> dict[str, Any]:
    return {
        "clientContent": {
            "turns": [{"role": role, "parts": [{"text": text}]}],
            "turnComplete": turn_complete,
        }
    }


def build_history_seed_message(history: list[dict[str, Any]]) -> Optional[dict[str, Any]]:
    turns: list[dict[str, Any]] = []
    for item in history:
        if not isinstance(item, dict):
            continue
        role = "model" if item.get("role") in ("assistant", "model") else "user"
        text = ""
        content = item.get("content")
        if isinstance(content, str):
            text = content.strip()
        elif isinstance(content, list):
            text = " ".join(
                str(p.get("text") or "").strip() for p in content if isinstance(p, dict)
            ).strip()
        if text:
            turns.append({"role": role, "parts": [{"text": text}]})
    if not turns:
        return None
    return {"clientContent": {"turns": turns, "turnComplete": False}}


def build_tool_response_message(
    call_id: str,
    name: str,
    result: Any,
    *,
    scheduling: str = "WHEN_IDLE",
) -> dict[str, Any]:
    """Build a Gemini Live ``toolResponse`` with ``NON_BLOCKING`` scheduling."""
    payload: dict[str, Any] = result if isinstance(result, dict) else {"result": result}
    if scheduling in ("WHEN_IDLE", "INTERRUPT", "SILENT"):
        payload = {**payload, "scheduling": scheduling}
    return {
        "toolResponse": {
            "functionResponses": [
                {
                    "id": call_id,
                    "name": name,
                    "response": payload,
                }
            ]
        }
    }


# ── Pure-Python G.711 μ-law ↔ PCM16 codec & linear resampler (Twilio 8kHz <-> Gemini 16k/24kHz)

_MULAW_BIAS = 0x84
_MULAW_CLIP = 32635


def _mulaw_byte_to_pcm16(uval: int) -> int:
    uval = (~uval) & 0xFF
    sign = uval & 0x80
    exponent = (uval >> 4) & 0x07
    mantissa = uval & 0x0F
    sample = ((mantissa << 3) + _MULAW_BIAS) << exponent
    sample -= _MULAW_BIAS
    return -sample if sign else sample


_MULAW_DECODE_TABLE = tuple(_mulaw_byte_to_pcm16(i) for i in range(256))


def _pcm16_to_mulaw_byte(sample: int) -> int:
    sign = 0x80 if sample < 0 else 0
    if sample < 0:
        sample = -sample
    if sample > _MULAW_CLIP:
        sample = _MULAW_CLIP
    sample += _MULAW_BIAS
    exponent = 7
    mask = 0x4000
    while exponent > 0 and not (sample & mask):
        exponent -= 1
        mask >>= 1
    mantissa = (sample >> (exponent + 3)) & 0x0F
    return (~(sign | (exponent << 4) | mantissa)) & 0xFF


def mulaw_to_pcm16(data: bytes) -> bytes:
    """Decode G.711 μ-law bytes to little-endian signed 16-bit PCM."""
    if not data:
        return b""
    samples = [_MULAW_DECODE_TABLE[b] for b in data]
    return struct.pack(f"<{len(samples)}h", *samples)


def pcm16_to_mulaw(data: bytes) -> bytes:
    """Encode little-endian signed 16-bit PCM to G.711 μ-law bytes."""
    count = len(data) // 2
    if count <= 0:
        return b""
    samples = struct.unpack(f"<{count}h", data[: count * 2])
    return bytes(_pcm16_to_mulaw_byte(s) for s in samples)


def resample_pcm16(data: bytes, src_rate: int, dst_rate: int) -> bytes:
    """Linear resampler for mono signed 16-bit PCM (e.g. 8kHz <-> 16kHz / 24kHz)."""
    if src_rate == dst_rate or len(data) < 2:
        return data
    n_in = len(data) // 2
    samples = struct.unpack(f"<{n_in}h", data[: n_in * 2])
    n_out = max(1, int(round(n_in * dst_rate / src_rate)))
    ratio = (n_in - 1) / max(1, n_out - 1) if n_out > 1 else 0.0
    out: list[int] = []
    for i in range(n_out):
        pos = i * ratio
        idx = int(pos)
        frac = pos - idx
        s0 = samples[idx]
        s1 = samples[min(idx + 1, n_in - 1)]
        val = int(round(s0 + (s1 - s0) * frac))
        if val > 32767:
            val = 32767
        elif val < -32768:
            val = -32768
        out.append(val)
    return struct.pack(f"<{n_out}h", *out)


def parse_gemini_server_event(raw: dict[str, Any]) -> list[dict[str, Any]]:
    """Normalize one raw Gemini Live server JSON message into typed internal events."""
    events: list[dict[str, Any]] = []
    if "setupComplete" in raw:
        events.append({"type": "setup_complete"})
    sc = raw.get("serverContent")
    if isinstance(sc, dict):
        if sc.get("interrupted"):
            events.append({"type": "interrupted"})
        inp = sc.get("inputTranscription")
        if isinstance(inp, dict) and inp.get("text"):
            events.append({"type": "transcript", "speaker": "user", "text": str(inp["text"])})
        out = sc.get("outputTranscription")
        if isinstance(out, dict) and out.get("text"):
            events.append({"type": "transcript", "speaker": "assistant", "text": str(out["text"])})
        mt = sc.get("modelTurn")
        if isinstance(mt, dict):
            for part in mt.get("parts") or []:
                if not isinstance(part, dict):
                    continue
                inline = part.get("inlineData")
                if isinstance(inline, dict) and inline.get("data"):
                    events.append(
                        {
                            "type": "audio",
                            "mimeType": str(inline.get("mimeType") or "audio/pcm;rate=24000"),
                            "data": str(inline["data"]),
                        }
                    )
                elif part.get("text"):
                    events.append({"type": "text", "text": str(part["text"])})
        if sc.get("turnComplete"):
            events.append({"type": "turn_complete"})
    tc = raw.get("toolCall")
    if isinstance(tc, dict):
        for fc in tc.get("functionCalls") or []:
            if isinstance(fc, dict):
                events.append(
                    {
                        "type": "tool_call",
                        "id": str(fc.get("id") or ""),
                        "name": str(fc.get("name") or ""),
                        "args": fc.get("args") if isinstance(fc.get("args"), dict) else {},
                    }
                )
    cancel = raw.get("toolCallCancellation")
    if isinstance(cancel, dict) and cancel.get("ids"):
        events.append({"type": "tool_cancel", "ids": [str(x) for x in cancel["ids"]]})
    return events


class GeminiLiveBridge:
    """Async WebSocket client for a single Gemini 3.8 Live session."""

    def __init__(
        self,
        *,
        api_key: str,
        setup_payload: dict[str, Any],
        ws_url: Optional[str] = None,
        on_event: Optional[Callable[[dict[str, Any]], Awaitable[None]]] = None,
    ) -> None:
        self.api_key = api_key
        self.setup_payload = setup_payload
        self.ws_url = ws_url
        self.on_event = on_event
        self._ws: Any = None
        self._recv_task: Optional[asyncio.Task[Any]] = None
        self._closed = False
        self.setup_complete = asyncio.Event()

    async def connect(self) -> None:
        import websockets

        url = gemini_ws_url(self.api_key, self.ws_url)
        self._ws = await websockets.connect(url, max_size=16 * 1024 * 1024)
        await self._ws.send(json.dumps(self.setup_payload))
        self._recv_task = asyncio.create_task(self._recv_loop())

    async def _recv_loop(self) -> None:
        try:
            async for message in self._ws:
                if isinstance(message, bytes):
                    text = message.decode("utf-8", errors="replace")
                else:
                    text = str(message)
                try:
                    raw = json.loads(text)
                except json.JSONDecodeError:
                    continue
                for ev in parse_gemini_server_event(raw):
                    if ev["type"] == "setup_complete":
                        self.setup_complete.set()
                    if self.on_event is not None:
                        await self.on_event(ev)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.debug("GeminiLiveBridge recv loop ended: %s", exc)
            if self.on_event is not None and not self._closed:
                await self.on_event({"type": "closed", "reason": str(exc)})
        finally:
            self.setup_complete.set()

    async def send_json(self, payload: dict[str, Any]) -> None:
        if self._ws is None or self._closed:
            return
        await self._ws.send(json.dumps(payload))

    async def send_audio(self, pcm16_bytes: bytes, sample_rate: int = 16000) -> None:
        await self.send_json(build_audio_input_message(pcm16_bytes, sample_rate))

    async def send_text(self, text: str, *, turn_complete: bool = True) -> None:
        await self.send_json(build_client_content_message(text, turn_complete=turn_complete))

    async def send_tool_response(
        self,
        call_id: str,
        name: str,
        result: Any,
        *,
        scheduling: str = "WHEN_IDLE",
    ) -> None:
        await self.send_json(
            build_tool_response_message(call_id, name, result, scheduling=scheduling)
        )

    async def close(self) -> None:
        self._closed = True
        if self._recv_task is not None:
            self._recv_task.cancel()
            self._recv_task = None
        if self._ws is not None:
            try:
                await self._ws.close()
            except Exception:
                pass
            self._ws = None
