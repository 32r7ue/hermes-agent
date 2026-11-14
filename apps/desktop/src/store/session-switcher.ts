import { atom } from 'nanostores'

import { Codecs, persistentAtom } from '@/lib/persisted'
import type { SessionInfo } from '@/types/hermes'

import { completeFlow } from './desktop-metrics'
import { $selectedStoredSessionId, $sessions } from './session'
import { $sessionDotStateById, type SessionDotState } from './session-dot-state'

// Mac-style session switcher (^Tab). Keydown only moves the highlight;
// releasing Ctrl commits. A held chord reveals the HUD after a short delay.

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
let closedAt = 0

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

    if (pendingBrowse) {
      revealOverlay()
    }
  }, SWITCHER_REVEAL_MS)
}

// Freeze candidates for the whole chord; incoming activity must not reorder
// the selection under a held modifier. Navigation happens only on release.
export function openOrAdvanceSwitcher(direction: 1 | -1): string | null {
  if (switcherActive()) {
    const length = $switcherSessions.get().length

    if (length) {
      $switcherIndex.set(wrap($switcherIndex.get() + direction, length))
    }

    return null
  }

  const sessions = switcherCandidates(
    $sessions.get(),
    $sessionDotStateById.get(),
    $selectedStoredSessionId.get(),
    $sessionOpenedAt.get()
  )

  if (sessions.length < 2) {
    return null
  }

  const current = sessions.findIndex(session => session.id === $selectedStoredSessionId.get())
  const start = current === -1 ? (direction === 1 ? -1 : 0) : current
  const nextIndex = wrap(start + direction, sessions.length)

  $switcherSessions.set(sessions)
  $switcherIndex.set(nextIndex)

  pendingBrowse = true
  scheduleReveal()

  return null
}

export const highlightedSessionId = (): string | null => $switcherSessions.get()[$switcherIndex.get()]?.id ?? null

export const slotSessionId = (slot: number): string | null =>
  ($switcherOpen.get() || pendingBrowse ? $switcherSessions.get() : $sessions.get())[slot - 1]?.id ?? null

export function closeSwitcher(): void {
  closedAt = Date.now()
  clearRevealTimer()
  pendingBrowse = false
  $switcherOpen.set(false)
}

export function commitOnCtrlUp(): string | null {
  if (!switcherActive()) {
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
