import { atom } from 'nanostores'

import { Codecs, persistentAtom } from '@/lib/persisted'
import type { SessionInfo } from '@/types/hermes'

import { completeFlow } from './desktop-metrics'
import { $selectedStoredSessionId, $sessions } from './session'
import { $sessionDotStateById, type SessionDotState } from './session-dot-state'

// Mac-style session switcher (^Tab). Quick tap jumps on keydown; the HUD opens
// only when Tab is held past REVEAL_MS or tapped again while Ctrl is down.

export const SWITCHER_REVEAL_MS = 220

/** The HUD is a short "what's live today" list, not a second sidebar. */
export const SWITCHER_LIMIT = 7

// Sessions that want the user jump the queue; everything else is most recently opened first.
const ATTENTION_RANK: Partial<Record<SessionDotState, number>> = { 'needs-input': 0, unread: 1 }

const OPENED_KEEP = 200

/** Session id → when this window last showed it (epoch seconds). Persisted so
 *  the ⌃Tab order survives a relaunch, like the macOS app switcher. */
export const $sessionOpenedAt = persistentAtom<Record<string, number>>(
  'hermes.desktop.sessionSwitcher.openedAt',
  {},
  Codecs.json<Record<string, number>>()
)

export function noteSessionOpened(sessionId: null | string, at: number = Date.now() / 1000): void {
  if (!sessionId) {
    return
  }

  const entries = Object.entries({ ...$sessionOpenedAt.get(), [sessionId]: at })
    .sort((a, b) => b[1] - a[1])
    .slice(0, OPENED_KEEP)

  $sessionOpenedAt.set(Object.fromEntries(entries))
}

$selectedStoredSessionId.subscribe(id => noteSessionOpened(id))

const touchedAt = (session: SessionInfo): number => Math.max(session.last_active ?? 0, session.started_at ?? 0)

/**
 * Today's sessions (started, resumed or opened since local midnight). The
 * current one comes first so the first ⌃Tab lands on the next chat; then
 * needs-input, then unread, then most recently opened (never-opened ones by
 * their own activity). Capped at {@link SWITCHER_LIMIT}.
 */
export function switcherCandidates(
  sessions: readonly SessionInfo[],
  states: Readonly<Record<string, SessionDotState>>,
  currentId: null | string,
  openedAt: Readonly<Record<string, number>> = {},
  now: Date = new Date()
): SessionInfo[] {
  const midnight = new Date(now).setHours(0, 0, 0, 0) / 1000
  const current = sessions.find(session => session.id === currentId)
  const recency = (session: SessionInfo) => Math.max(openedAt[session.id] ?? 0, touchedAt(session))
  const opened = (session: SessionInfo) => openedAt[session.id] ?? touchedAt(session)
  const rank = (session: SessionInfo) => ATTENTION_RANK[states[session.id]] ?? 2

  const rest = sessions
    .filter(session => session !== current && recency(session) >= midnight)
    .sort((a, b) => rank(a) - rank(b) || opened(b) - opened(a))

  return (current ? [current, ...rest] : rest).slice(0, SWITCHER_LIMIT)
}

export const $switcherOpen = atom(false)
export const $switcherSessions = atom<SessionInfo[]>([])
export const $switcherIndex = atom(0)

const wrap = (index: number, length: number): number => ((index % length) + length) % length

let pendingBrowse = false
let revealTimer: ReturnType<typeof setTimeout> | null = null
let tabHeld = false
let closedAt = 0
// The physical key (`code`) of the keydown being dispatched, and of the one that
// stepped the switcher: only the step key's keyup ends the hold, so another key
// lifting mid-hold can't hide the HUD. A missing code on either side releases on
// any key, as before.
let keyDown = ''
let stepKey = ''

function clearRevealTimer(): void {
  if (revealTimer) {
    clearTimeout(revealTimer)
    revealTimer = null
  }
}

function revealOverlay(): void {
  pendingBrowse = false
  $switcherOpen.set(true)
}

function scheduleReveal(): void {
  clearRevealTimer()
  revealTimer = setTimeout(() => {
    revealTimer = null

    if (pendingBrowse && tabHeld) {
      revealOverlay()
    }
  }, SWITCHER_REVEAL_MS)
}

export function noteSwitcherKeyDown(code: string): void {
  keyDown = code
}

export function onSwitcherTabDown(): void {
  tabHeld = true
  stepKey = keyDown
}

export function onSwitcherTabUp(code = ''): void {
  if (code && stepKey && code !== stepKey) {
    return
  }

  tabHeld = false

  if (!$switcherOpen.get()) {
    clearRevealTimer()
  }
}

// First Tab returns a session id to jump to immediately; later Tabs move the
// highlight (Ctrl↑ commits when the HUD is open).
export function openOrAdvanceSwitcher(direction: 1 | -1): string | null {
  const sessions = switcherCandidates(
    $sessions.get(),
    $sessionDotStateById.get(),
    $selectedStoredSessionId.get(),
    $sessionOpenedAt.get()
  )

  if (sessions.length < 2) {
    return null
  }

  if ($switcherOpen.get()) {
    const { length } = $switcherSessions.get()

    if (length) {
      $switcherIndex.set(wrap($switcherIndex.get() + direction, length))
    }

    return null
  }

  const current = sessions.findIndex(session => session.id === $selectedStoredSessionId.get())
  const start = current === -1 ? (direction === 1 ? -1 : 0) : current
  const nextIndex = wrap(start + direction, sessions.length)

  $switcherSessions.set(sessions)
  $switcherIndex.set(nextIndex)

  if (pendingBrowse) {
    clearRevealTimer()
    $switcherIndex.set(wrap($switcherIndex.get() + direction, sessions.length))
    revealOverlay()

    return null
  }

  pendingBrowse = true
  scheduleReveal()

  return sessions[nextIndex]?.id ?? null
}

export const highlightedSessionId = (): string | null => $switcherSessions.get()[$switcherIndex.get()]?.id ?? null

export const slotSessionId = (slot: number): string | null =>
  ($switcherOpen.get() || pendingBrowse ? $switcherSessions.get() : $sessions.get())[slot - 1]?.id ?? null

export function closeSwitcher(): void {
  closedAt = Date.now()
  clearRevealTimer()
  pendingBrowse = false
  tabHeld = false
  $switcherOpen.set(false)
}

export function commitOnCtrlUp(): string | null {
  clearRevealTimer()
  pendingBrowse = false

  if (!$switcherOpen.get()) {
    return null
  }

  const target = highlightedSessionId()

  if (target) {
    completeFlow('session_switcher')
  }

  closeSwitcher()

  return target
}

export const switcherJustClosed = (): boolean => Date.now() - closedAt < 400

export const switcherActive = (): boolean => $switcherOpen.get() || pendingBrowse
