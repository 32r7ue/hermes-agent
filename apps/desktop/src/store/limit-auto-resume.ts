import { atom } from 'nanostores'

import type { ClientSessionState } from '@/app/types'
import type { ChatMessage } from '@/lib/chat-messages'
import { isUsageLimitSurface } from '@/lib/error-surface'
import { $sessionStates } from '@/store/session-states'

/**
 * "Auto-resume" on a usage-limit error card: re-run the refused turn by itself once the
 * provider's limit lifts, at `resets_at` when the provider named it, else on a widening backoff.
 *
 * App-run state, keyed by the runtime session id, so it survives switching sessions (the card
 * unmounts, the entry and its timer do not). It never outlives the app: nothing is persisted.
 *
 * The re-run is the card's own Retry (`aui.message().reload()`), registered while the card is on
 * screen. A timer that comes due while the session is off screen waits (`due`) and fires the
 * moment the card mounts again — a slash `/retry` cannot stand in, it skips hidden prompts
 * (inline-command results) and would re-run an older turn.
 *
 * Ends on: success (the re-run settles without a limit error), a different error, the user
 * sending anything (a turn this did not start), or the user unticking the box. A re-run that
 * hits the limit again re-arms with the new card's reset time.
 */
export interface AutoResumeEntry {
  /** The failure card this is armed on (the latest limit card of the session). */
  messageId: string
  /** Epoch seconds the provider said the limit lifts, if it said. */
  resetsAt?: number
  /** Re-runs fired so far; widens the no-reset backoff. */
  attempt: number
  /** Wall-clock ms the next re-run is due. */
  fireAt: number
  /** waiting → due (timer fired, card off screen) → resuming (re-run started, awaiting its end). */
  phase: 'due' | 'resuming' | 'waiting'
}

export const $limitAutoResume = atom<Record<string, AutoResumeEntry>>({})

/** No reset time: retry after 1m, 2m, 5m, 10m, 15m, then every 30m. */
const BACKOFF_MS = [60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000]
/** Fire a little after the stated reset: provider clocks and our clock disagree by seconds. */
const RESET_GRACE_MS = 5_000
/** Browsers fire a `setTimeout` beyond 2^31-1 ms at once; longer waits re-check on wake. */
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1
/** A re-run that never started a turn (refused before admission) counts as failed after this. */
const START_TIMEOUT_MS = 30_000

export function autoResumeDelayMs(resetsAt: number | undefined, attempt: number, now: number = Date.now()): number {
  if (typeof resetsAt === 'number' && Number.isFinite(resetsAt) && resetsAt * 1000 > now) {
    return resetsAt * 1000 - now + RESET_GRACE_MS
  }

  return BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]
}

const timers = new Map<string, ReturnType<typeof setTimeout>>()
const reloaders = new Map<string, () => void>()
const resumeStarted = new Map<string, { at: number; sawBusy: boolean }>()
let unsubscribeStates: (() => void) | null = null

function entries(): Record<string, AutoResumeEntry> {
  return $limitAutoResume.get()
}

function setEntry(sessionId: string, entry: AutoResumeEntry | null): void {
  const next = { ...entries() }

  if (entry) {
    next[sessionId] = entry
  } else {
    delete next[sessionId]
  }

  $limitAutoResume.set(next)
  syncWatch()
}

function clearTimer(sessionId: string): void {
  const timer = timers.get(sessionId)

  if (timer !== undefined) {
    clearTimeout(timer)
    timers.delete(sessionId)
  }
}

function schedule(sessionId: string, fireAt: number): void {
  clearTimer(sessionId)
  const delay = Math.min(Math.max(0, fireAt - Date.now()), MAX_TIMER_DELAY_MS)
  timers.set(
    sessionId,
    setTimeout(() => onTimer(sessionId), delay)
  )
}

function onTimer(sessionId: string): void {
  timers.delete(sessionId)
  const entry = entries()[sessionId]

  if (!entry || entry.phase !== 'waiting') {
    return
  }

  // A clamped (very long) wait wakes early: sleep again until the real moment.
  if (Date.now() < entry.fireAt - 1_000) {
    return schedule(sessionId, entry.fireAt)
  }

  fire(sessionId, entry)
}

function fire(sessionId: string, entry: AutoResumeEntry): void {
  const reload = reloaders.get(sessionId)

  if (!reload) {
    setEntry(sessionId, { ...entry, phase: 'due' })

    return
  }

  resumeStarted.set(sessionId, { at: Date.now(), sawBusy: false })
  setEntry(sessionId, { ...entry, attempt: entry.attempt + 1, phase: 'resuming' })
  reload()
}

/** Tick the box: arm auto-resume for this session's limit card. */
export function armAutoResume(sessionId: string, card: { messageId: string; resetsAt?: number }, attempt = 0): void {
  const fireAt = Date.now() + autoResumeDelayMs(card.resetsAt, attempt)
  resumeStarted.delete(sessionId)
  setEntry(sessionId, { attempt, fireAt, messageId: card.messageId, phase: 'waiting', resetsAt: card.resetsAt })
  schedule(sessionId, fireAt)
}

/** Untick, success, a different error, or the user sent something. */
export function cancelAutoResume(sessionId: string): void {
  clearTimer(sessionId)
  resumeStarted.delete(sessionId)

  if (entries()[sessionId]) {
    setEntry(sessionId, null)
  }
}

/**
 * The on-screen card's Retry for this session. Returns the unregister. A due re-run fires now.
 */
export function registerAutoResumeReload(sessionId: string, reload: () => void): () => void {
  reloaders.set(sessionId, reload)
  const entry = entries()[sessionId]

  if (entry?.phase === 'due') {
    fire(sessionId, entry)
  }

  return () => {
    if (reloaders.get(sessionId) === reload) {
      reloaders.delete(sessionId)
    }
  }
}

/** The tail turn's failure card: the last message carrying an error after the last visible user message. */
function tailFailure(messages: ChatMessage[]): ChatMessage | undefined {
  const lastUser = messages.findLastIndex(message => message.role === 'user' && !message.hidden)

  return messages.slice(lastUser + 1).findLast(message => message.role === 'assistant' && Boolean(message.error))
}

function onSessionState(sessionId: string, entry: AutoResumeEntry, state: ClientSessionState | undefined): void {
  if (!state) {
    return
  }

  const busy = Boolean(state.busy || state.turnLive || state.awaitingResponse)

  if (entry.phase !== 'resuming') {
    // A turn this did not start: the user sent something, so stand down.
    if (busy) {
      cancelAutoResume(sessionId)
    }

    return
  }

  const started = resumeStarted.get(sessionId) ?? { at: Date.now(), sawBusy: false }

  if (busy) {
    resumeStarted.set(sessionId, { ...started, sawBusy: true })

    return
  }

  if (!started.sawBusy && Date.now() - started.at < START_TIMEOUT_MS) {
    return
  }

  const failure = tailFailure(state.messages)

  if (failure && isUsageLimitSurface(failure.errorSurface)) {
    // Still limited: wait for this card's reset (or the next backoff step).
    armAutoResume(sessionId, { messageId: failure.id, resetsAt: failure.errorSurface?.resetsAt }, entry.attempt)

    return
  }

  if (!started.sawBusy && !failure) {
    // Never started and nothing new on screen: try again on the backoff.
    armAutoResume(sessionId, { messageId: entry.messageId, resetsAt: undefined }, entry.attempt)

    return
  }

  cancelAutoResume(sessionId)
}

function checkStates(states: Record<string, ClientSessionState>): void {
  for (const [sessionId, entry] of Object.entries(entries())) {
    onSessionState(sessionId, entry, states[sessionId])
  }
}

function syncWatch(): void {
  const armed = Object.keys(entries()).length > 0

  if (armed && !unsubscribeStates) {
    unsubscribeStates = $sessionStates.listen(checkStates)
  } else if (!armed && unsubscribeStates) {
    unsubscribeStates()
    unsubscribeStates = null
  }
}

/** Test seam: re-evaluate every armed session against the current session states. */
export function recheckAutoResume(): void {
  checkStates($sessionStates.get())
}
