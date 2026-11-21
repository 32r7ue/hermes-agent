import { useEffect, useState } from 'react'

import {
  answerPhoneCallQuestion,
  approvePhoneCall,
  hangupPhoneCall,
  injectPhoneCallContext,
  type PhoneCallRecord,
  rejectPhoneCall
} from '@/lib/phone-calls'

function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60

  return `${m}:${String(s).padStart(2, '0')}`
}

export interface PhoneCallCardProps {
  call: PhoneCallRecord
  onUpdated?: (call: PhoneCallRecord) => void
  onStartLoopbackAudio?: (callId: string) => void
}

export function PhoneCallCard({ call, onUpdated, onStartLoopbackAudio }: PhoneCallCardProps) {
  const [contextDraft, setContextDraft] = useState('')
  const [answerDrafts, setAnswerDrafts] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [showTranscript, setShowTranscript] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (call.status !== 'in_progress') {
      return
    }

    const id = window.setInterval(() => setNow(Date.now()), 1000)

    return () => window.clearInterval(id)
  }, [call.status])

  const label = call.callee_name.trim() || call.callee_number

  const liveDuration =
    call.status === 'in_progress' && call.started_at_ms
      ? formatDuration(now - call.started_at_ms)
      : call.duration_ms != null
        ? formatDuration(call.duration_ms)
        : null

  const statusText =
    call.status === 'pending_approval'
      ? 'Approval required'
      : call.status === 'dialing'
        ? 'Dialing…'
        : call.status === 'in_progress'
          ? liveDuration
            ? `Live · ${liveDuration}`
            : 'Live'
          : call.outcome === 'no_answer'
            ? 'No answer'
            : call.outcome === 'failed'
              ? "Didn't go through"
              : call.end_reason === 'handed_off'
                ? 'Transferred'
                : liveDuration
                  ? `${liveDuration} · Ended`
                  : 'Ended'

  const pendingQuestions = call.questions.filter(q => q.answer === null)

  const run = async (fn: () => Promise<PhoneCallRecord>) => {
    setBusy(true)

    try {
      const updated = await fn()
      onUpdated?.(updated)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="bg-card text-card-foreground border-border flex flex-col gap-3 rounded-xl border p-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 font-medium">
            <span className="truncate">{label}</span>
            <span className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 text-xs">
              {call.callee_kind === 'storefront' ? 'Business' : 'Person'}
            </span>
          </div>
          {call.callee_name ? (
            <div className="text-muted-foreground text-xs">{call.callee_number}</div>
          ) : null}
        </div>
        <span className="text-muted-foreground shrink-0 text-xs font-medium">{statusText}</span>
      </div>

      <div className="text-muted-foreground text-xs">{call.goal}</div>

      {call.status === 'pending_approval' ? (
        <div className="flex items-center gap-2">
          <button
            className="bg-primary text-primary-foreground rounded-md px-3 py-1.5 text-xs font-medium disabled:opacity-50"
            disabled={busy}
            onClick={() => void run(() => approvePhoneCall(call.call_id))}
            type="button"
          >
            Approve &amp; Dial
          </button>
          <button
            className="bg-secondary text-secondary-foreground rounded-md px-3 py-1.5 text-xs font-medium disabled:opacity-50"
            disabled={busy}
            onClick={() => void run(() => rejectPhoneCall(call.call_id))}
            type="button"
          >
            Decline
          </button>
        </div>
      ) : null}

      {call.status === 'dialing' && call.transport === 'loopback' && onStartLoopbackAudio ? (
        <div className="flex items-center gap-2">
          <button
            className="bg-primary text-primary-foreground rounded-md px-3 py-1.5 text-xs font-medium"
            onClick={() => onStartLoopbackAudio(call.call_id)}
            type="button"
          >
            Answer (Local Loopback)
          </button>
          <button
            className="bg-destructive text-destructive-foreground rounded-md px-3 py-1.5 text-xs font-medium disabled:opacity-50"
            disabled={busy}
            onClick={() => void run(() => hangupPhoneCall(call.call_id))}
            type="button"
          >
            Cancel
          </button>
        </div>
      ) : null}

      {pendingQuestions.map(q => (
        <div className="bg-muted/60 flex flex-col gap-2 rounded-lg p-2.5" key={q.question_id}>
          <div className="text-xs font-medium">Question from call: {q.question}</div>
          {q.options.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {q.options.map(opt => (
                <button
                  className="bg-secondary text-secondary-foreground rounded px-2 py-1 text-xs"
                  disabled={busy}
                  key={opt}
                  onClick={() => {
                    setBusy(true)
                    void answerPhoneCallQuestion(call.call_id, q.question_id, opt).finally(() => setBusy(false))
                  }}
                  type="button"
                >
                  {opt}
                </button>
              ))}
            </div>
          ) : null}
          <div className="flex gap-1.5">
            <input
              className="bg-background border-border flex-1 rounded-md border px-2 py-1 text-xs"
              onChange={e => setAnswerDrafts(prev => ({ ...prev, [q.question_id]: e.target.value }))}
              placeholder="Reply to your bot on the call…"
              value={answerDrafts[q.question_id] ?? ''}
            />
            <button
              className="bg-primary text-primary-foreground rounded-md px-2.5 py-1 text-xs font-medium disabled:opacity-50"
              disabled={busy || !(answerDrafts[q.question_id] ?? '').trim()}
              onClick={() => {
                const ans = (answerDrafts[q.question_id] ?? '').trim()

                if (!ans) {
                  return
                }

                setBusy(true)
                void answerPhoneCallQuestion(call.call_id, q.question_id, ans)
                  .then(() => setAnswerDrafts(prev => ({ ...prev, [q.question_id]: '' })))
                  .finally(() => setBusy(false))
              }}
              type="button"
            >
              Send
            </button>
          </div>
        </div>
      ))}

      {call.status === 'in_progress' ? (
        <div className="flex flex-col gap-2">
          <div className="flex gap-1.5">
            <input
              className="bg-background border-border flex-1 rounded-md border px-2 py-1 text-xs"
              onChange={e => setContextDraft(e.target.value)}
              placeholder="Send this to your call…"
              value={contextDraft}
            />
            <button
              className="bg-secondary text-secondary-foreground rounded-md px-2.5 py-1 text-xs font-medium disabled:opacity-50"
              disabled={busy || !contextDraft.trim()}
              onClick={() => {
                const text = contextDraft.trim()

                if (!text) {
                  return
                }

                setContextDraft('')
                void run(() => injectPhoneCallContext(call.call_id, text))
              }}
              type="button"
            >
              Inject
            </button>
            <button
              className="bg-destructive text-destructive-foreground rounded-md px-2.5 py-1 text-xs font-medium disabled:opacity-50"
              disabled={busy}
              onClick={() => void run(() => hangupPhoneCall(call.call_id))}
              type="button"
            >
              Hang up
            </button>
          </div>
        </div>
      ) : null}

      {call.summary ? <div className="text-xs">Summary: {call.summary}</div> : null}

      {call.transcript.length > 0 ? (
        <div>
          <button
            className="text-muted-foreground hover:text-foreground text-xs underline"
            onClick={() => setShowTranscript(v => !v)}
            type="button"
          >
            {showTranscript ? 'Hide transcript' : `Transcript (${call.transcript.length})`}
          </button>
          {showTranscript ? (
            <div className="mt-1.5 flex max-h-40 flex-col gap-1 overflow-y-auto text-xs">
              {call.transcript.map((turn, idx) => (
                <div key={`${turn.timestamp_ms}-${idx}`}>
                  <span className="font-medium">{turn.speaker === 'assistant' ? 'Bot' : 'Callee'}:</span>{' '}
                  <span>{turn.text}</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
