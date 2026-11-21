import { $connection } from '@/store/session'

import {
  type LiveHistoryMessage,
  type LiveTranscriptFragment,
  type VoiceLiveHandlers
} from './voice-live'

/** Build a gateway WebSocket URL (preserving host + auth token in Electron & web). */
export function gatewayWebSocketUrl(pathname: string): string {
  const raw = $connection.get()?.wsUrl

  if (raw) {
    try {
      const parsed = new URL(raw)
      const target = new URL(pathname, `${parsed.protocol}//${parsed.host}`)
      const token = parsed.searchParams.get('token')

      if (token && !target.searchParams.has('token')) {
        target.searchParams.set('token', token)
      }

      return target.toString()
    } catch {
      // Fall through to window.location
    }
  }

  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'

  return `${proto}//${window.location.host}${pathname}`
}

export interface GeminiLiveHandlers extends VoiceLiveHandlers {
  /** Gemini asked to switch which Hermes bot/profile this call talks to. */
  onSwitchAgent?: (target: string, toolCallId: string) => void
  /** Gemini called `end_call` to hang up cleanly. */
  onEndCall?: (toolCallId: string) => void
}

export interface GeminiLiveSessionOptions {
  wsUrl: string
  history?: LiveHistoryMessage[]
  handlers: GeminiLiveHandlers
}

/** Downsample Float32 [-1, 1] PCM to mono Int16 at targetRate (default 16kHz). */
export function downsampleFloat32ToPcm16(
  input: Float32Array,
  inputRate: number,
  targetRate = 16_000
): Int16Array {
  if (input.length === 0) {
    return new Int16Array(0)
  }

  if (inputRate === targetRate) {
    const out = new Int16Array(input.length)

    for (let i = 0; i < input.length; i += 1) {
      const s = Math.max(-1, Math.min(1, input[i]))
      out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff)
    }

    return out
  }

  const ratio = inputRate / targetRate
  const outLength = Math.max(1, Math.floor(input.length / ratio))
  const out = new Int16Array(outLength)

  for (let i = 0; i < outLength; i += 1) {
    const start = Math.floor(i * ratio)
    const end = Math.min(input.length, Math.floor((i + 1) * ratio))
    let sum = 0
    let count = 0

    for (let j = start; j < end; j += 1) {
      sum += input[j]
      count += 1
    }

    const avg = count > 0 ? sum / count : input[Math.min(start, input.length - 1)]
    const clamped = Math.max(-1, Math.min(1, avg))
    out[i] = clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff)
  }

  return out
}

/** Decode base64 little-endian Int16 PCM to Float32 [-1, 1] for Web Audio playback. */
export function decodePcm16Base64ToFloat32(b64: string): Float32Array {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)

  for (let i = 0; i < bin.length; i += 1) {
    bytes[i] = bin.charCodeAt(i)
  }

  const view = new DataView(bytes.buffer)
  const count = Math.floor(bytes.byteLength / 2)
  const out = new Float32Array(count)

  for (let i = 0; i < count; i += 1) {
    out[i] = view.getInt16(i * 2, true) / 0x8000
  }

  return out
}

/**
 * Full-duplex Gemini 3.8 Live session over the Hermes gateway WebSocket proxy.
 * Implements the same command surface as `VoiceLiveSession` (`start`, `close`,
 * `setMuted`, `appendCommentary`, `finishDelegation`, `cancelDelegation`) plus
 * `sendToolResponse` for NON_BLOCKING Grok-Bot-style voice tools.
 */
export class GeminiLiveSession {
  private readonly wsUrl: string
  private readonly history: LiveHistoryMessage[]
  private readonly handlers: GeminiLiveHandlers
  private ws: null | WebSocket = null
  private stream: null | MediaStream = null
  private captureCtx: null | AudioContext = null
  private playbackCtx: null | AudioContext = null
  private processor: null | ScriptProcessorNode = null
  private activeSources = new Set<AudioBufferSourceNode>()
  private nextPlayTime = 0
  private muted = false
  private closed = false
  private startedAt = 0
  private fragments: LiveTranscriptFragment[] = []
  private pendingCommentary = new Map<string, string[]>()

  constructor(options: GeminiLiveSessionOptions) {
    this.wsUrl = options.wsUrl
    this.history = options.history ?? []
    this.handlers = options.handlers
  }

  async start(historyOverride?: LiveHistoryMessage[]): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Microphone capture is not supported in this environment')
    }

    const seed = historyOverride ?? this.history
    this.startedAt = Date.now()
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        autoGainControl: true,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true
      }
    })

    const ws = new WebSocket(this.wsUrl)
    ws.binaryType = 'arraybuffer'
    this.ws = ws

    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        ws.removeEventListener('error', onErr)
        resolve()
      }

      const onErr = () => {
        ws.removeEventListener('open', onOpen)
        reject(new Error('Failed to connect to Gemini Live WebSocket'))
      }

      ws.addEventListener('open', onOpen, { once: true })
      ws.addEventListener('error', onErr, { once: true })
    })

    if (seed.length > 0) {
      ws.send(JSON.stringify({ history: seed, type: 'history' }))
    }

    ws.addEventListener('message', event => {
      if (typeof event.data !== 'string') {
        return
      }

      try {
        this.handleServerMessage(JSON.parse(event.data))
      } catch {
        // Ignore malformed frame
      }
    })

    ws.addEventListener('close', () => {
      if (!this.closed) {
        this.closed = true
        this.teardownAudio()
        const secs = this.startedAt > 0 ? (Date.now() - this.startedAt) / 1000 : null
        this.handlers.onClosed('connection_lost', secs)
      }
    })

    this.startAudioCapture()
  }

  setMuted(muted: boolean): void {
    this.muted = muted
  }

  /** Convenience matching `VoiceLiveSession.speak`: deliver a complete reply to a delegation. */
  speak(delegationId: string, text: string): void {
    this.appendCommentary(delegationId, text)
    this.finishDelegation(delegationId, 'WHEN_IDLE')
  }

  /** Quiet progress hint matching `VoiceLiveSession.think`. */
  think(delegationId: string, text: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return
    }

    this.ws.send(
      JSON.stringify({
        text: `[Background update for ${delegationId}: ${text}]`,
        turnComplete: false,
        type: 'text'
      })
    )
  }

  /** Out-of-band instruction matching `VoiceLiveSession.instruct`. */
  instruct(text: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return
    }

    this.ws.send(JSON.stringify({ text, turnComplete: true, type: 'text' }))
  }

  appendCommentary(delegationId: string, text: string): void {
    const clean = text.trim()

    if (!clean) {
      return
    }

    const buf = this.pendingCommentary.get(delegationId) ?? []
    buf.push(clean)
    this.pendingCommentary.set(delegationId, buf)
  }

  finishDelegation(delegationId: string, scheduling: 'INTERRUPT' | 'SILENT' | 'WHEN_IDLE' = 'WHEN_IDLE'): void {
    const parts = this.pendingCommentary.get(delegationId) ?? []
    this.pendingCommentary.delete(delegationId)
    const combined = parts.join(' ').trim() || 'Done.'
    this.sendToolResponse(delegationId, 'send_task', { result: combined }, scheduling)
  }

  cancelDelegation(delegationId: string): void {
    this.pendingCommentary.delete(delegationId)
    this.sendToolResponse(delegationId, 'send_task', { cancelled: true }, 'SILENT')
  }

  sendToolResponse(
    id: string,
    name: string,
    response: unknown,
    scheduling: 'INTERRUPT' | 'SILENT' | 'WHEN_IDLE' = 'WHEN_IDLE'
  ): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return
    }

    this.ws.send(
      JSON.stringify({
        id,
        name,
        response,
        scheduling,
        type: 'tool_response'
      })
    )
  }

  async close(): Promise<void> {
    if (this.closed) {
      return
    }

    this.closed = true
    const secs = this.startedAt > 0 ? (Date.now() - this.startedAt) / 1000 : null

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({ type: 'close' }))
      } catch {
        // Ignore
      }
    }

    this.ws?.close()
    this.ws = null
    this.teardownAudio()
    this.handlers.onClosed('closed', secs)
  }

  /** Flush all queued assistant playback immediately (barge-in). */
  flushPlayback(): void {
    for (const src of this.activeSources) {
      try {
        src.stop()
      } catch {
        // Ignore already-stopped nodes
      }
    }

    this.activeSources.clear()
    this.nextPlayTime = 0
    this.handlers.onSpeakingChange?.(false)
  }

  private handleServerMessage(msg: Record<string, unknown>): void {
    const type = String(msg.type ?? '')

    if (type === 'audio' && typeof msg.data === 'string') {
      this.enqueuePlayback(msg.data)

      return
    }

    if (type === 'interrupted') {
      this.flushPlayback()

      return
    }

    if (type === 'transcript' && typeof msg.text === 'string') {
      const speaker = msg.speaker === 'assistant' ? 'assistant' : 'user'
      const now = Date.now()
      const frag: LiveTranscriptFragment = { endMs: now, speaker, startMs: now, text: msg.text }
      this.fragments.push(frag)

      if (this.fragments.length > 80) {
        this.fragments = this.fragments.slice(-80)
      }

      this.handlers.onTranscript?.(frag)

      return
    }

    if (type === 'tool_call') {
      const id = String(msg.id ?? '')
      const name = String(msg.name ?? '')
      const args = (msg.args && typeof msg.args === 'object' ? msg.args : {}) as Record<string, unknown>

      if (name === 'send_task') {
        const request = typeof args.request === 'string' ? args.request.trim() : ''
        const ctx = [...this.fragments]

        if (request) {
          const now = Date.now()
          ctx.push({ endMs: now, speaker: 'user', startMs: now, text: request })
        }

        this.handlers.onDelegation(id, ctx)

        return
      }

      if (name === 'switch_agent') {
        this.handlers.onSwitchAgent?.(String(args.target ?? ''), id)

        return
      }

      if (name === 'end_call') {
        this.sendToolResponse(id, 'end_call', { ok: true }, 'SILENT')
        this.handlers.onEndCall?.(id)

        return
      }
    }

    if (type === 'error') {
      this.handlers.onError(String(msg.message ?? 'Gemini Live error'), Boolean(msg.fatal))
    }
  }

  private startAudioCapture(): void {
    if (!this.stream) {
      return
    }

    const ctx = new AudioContext()
    this.captureCtx = ctx
    const source = ctx.createMediaStreamSource(this.stream)
    const processor = ctx.createScriptProcessor(2048, 1, 1)
    this.processor = processor

    processor.onaudioprocess = event => {
      if (this.muted || this.closed || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return
      }

      const channel = event.inputBuffer.getChannelData(0)
      const pcm16 = downsampleFloat32ToPcm16(channel, ctx.sampleRate, 16_000)
      this.ws.send(pcm16.buffer as ArrayBuffer)
    }

    source.connect(processor)
    processor.connect(ctx.destination)
  }

  private enqueuePlayback(b64: string): void {
    if (this.closed) {
      return
    }

    if (!this.playbackCtx) {
      this.playbackCtx = new AudioContext({ sampleRate: 24_000 })
    }

    const ctx = this.playbackCtx
    const samples = decodePcm16Base64ToFloat32(b64)

    if (samples.length === 0) {
      return
    }

    const buffer = ctx.createBuffer(1, samples.length, 24_000)
    buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0)
    const src = ctx.createBufferSource()
    src.buffer = buffer
    src.connect(ctx.destination)

    const startAt = Math.max(ctx.currentTime, this.nextPlayTime)
    this.nextPlayTime = startAt + buffer.duration
    this.activeSources.add(src)
    this.handlers.onSpeakingChange?.(true)

    src.onended = () => {
      this.activeSources.delete(src)

      if (this.activeSources.size === 0) {
        this.handlers.onSpeakingChange?.(false)
      }
    }

    src.start(startAt)
  }

  private teardownAudio(): void {
    this.flushPlayback()
    this.processor?.disconnect()
    this.processor = null
    void this.captureCtx?.close()
    this.captureCtx = null
    void this.playbackCtx?.close()
    this.playbackCtx = null

    for (const track of this.stream?.getTracks() ?? []) {
      track.stop()
    }

    this.stream = null
  }
}
