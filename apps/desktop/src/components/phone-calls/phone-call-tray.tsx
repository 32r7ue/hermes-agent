import { useCallback, useEffect, useRef, useState } from 'react'

import { gatewayWebSocketUrl, GeminiLiveSession } from '@/lib/gemini-live'
import { listPhoneCalls, type PhoneCallRecord } from '@/lib/phone-calls'
import { notifyError } from '@/store/notifications'

import { PhoneCallCard } from './phone-call-card'

/**
 * Floating tray above the chat composer that surfaces active/pending outbound
 * and inbound Hermes bot phone calls, subscribing to live gateway events and
 * letting the user answer local loopback test calls directly with their mic.
 */
export function PhoneCallTray() {
  const [calls, setCalls] = useState<PhoneCallRecord[]>([])
  const loopbackRef = useRef<Map<string, GeminiLiveSession>>(new Map())

  const upsert = useCallback((incoming: PhoneCallRecord) => {
    setCalls(prev => {
      const idx = prev.findIndex(c => c.call_id === incoming.call_id)

      if (idx === -1) {
        return [incoming, ...prev]
      }

      const next = [...prev]
      next[idx] = incoming

      return next
    })
  }, [])

  useEffect(() => {
    let alive = true
    let ws: null | WebSocket = null
    let retryTimer: null | number = null

    void listPhoneCalls()
      .then(items => {
        if (alive) {
          setCalls(items)
        }
      })
      .catch(() => undefined)

    const connect = () => {
      if (!alive) {
        return
      }

      try {
        ws = new WebSocket(gatewayWebSocketUrl('/api/phone-calls/events'))
      } catch {
        return
      }

      ws.onmessage = event => {
        if (typeof event.data !== 'string') {
          return
        }

        try {
          const msg = JSON.parse(event.data) as {
            type?: string
            calls?: PhoneCallRecord[]
            call?: PhoneCallRecord
          }

          if (msg.type === 'snapshot' && Array.isArray(msg.calls)) {
            setCalls(msg.calls)
          } else if (msg.call) {
            upsert(msg.call)

            if (msg.call.status === 'ended') {
              const active = loopbackRef.current.get(msg.call.call_id)

              if (active) {
                loopbackRef.current.delete(msg.call.call_id)
                void active.close()
              }
            }
          }
        } catch {
          // Ignore malformed event
        }
      }

      ws.onclose = () => {
        if (alive) {
          retryTimer = window.setTimeout(connect, 4000)
        }
      }
    }

    connect()

    return () => {
      alive = false

      if (retryTimer !== null) {
        window.clearTimeout(retryTimer)
      }

      ws?.close()

      for (const s of loopbackRef.current.values()) {
        void s.close()
      }

      loopbackRef.current.clear()
    }
  }, [upsert])

  const startLoopback = useCallback((callId: string) => {
    if (loopbackRef.current.has(callId)) {
      return
    }

    const session = new GeminiLiveSession({
      handlers: {
        onClosed: () => {
          loopbackRef.current.delete(callId)
        },
        onDelegation: () => undefined,
        onError: message => notifyError(new Error(message), 'Phone call audio error')
      },
      wsUrl: gatewayWebSocketUrl(`/api/phone-calls/${encodeURIComponent(callId)}/audio`)
    })

    loopbackRef.current.set(callId, session)
    void session.start().catch(err => {
      loopbackRef.current.delete(callId)
      notifyError(err, 'Could not start local loopback call audio')
    })
  }, [])

  // Show active/pending calls, plus recently ended calls from the last 2 minutes
  const cutoff = Date.now() - 120_000
  const visible = calls.filter(c => c.status !== 'ended' || (c.ended_at_ms ?? 0) > cutoff)

  if (visible.length === 0) {
    return null
  }

  return (
    <div className="mb-2 flex w-full flex-col gap-2">
      {visible.map(call => (
        <PhoneCallCard
          call={call}
          key={call.call_id}
          onStartLoopbackAudio={startLoopback}
          onUpdated={upsert}
        />
      ))}
    </div>
  )
}
