import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SessionInfo } from '@/types/hermes'

import { $selectedStoredSessionId, $sessions } from './session'
import {
  $sessionOpenedAt,
  $switcherIndex,
  $switcherOpen,
  $switcherSessions,
  closeSwitcher,
  commitOnCtrlUp,
  openOrAdvanceSwitcher,
  slotSessionId,
  SWITCHER_LIMIT,
  SWITCHER_REVEAL_MS,
  switcherCandidates
} from './session-switcher'

const session = (id: string, lastActive = Date.now() / 1000): SessionInfo =>
  ({ id, last_active: lastActive, started_at: lastActive }) as SessionInfo

// Most recent first, one second apart, so recency order is the listed order.
const seed = (ids: string[], selected: null | string) => {
  const now = Date.now() / 1000

  $sessions.set(ids.map((id, i) => session(id, now - i)))
  $selectedStoredSessionId.set(selected)
  $sessionOpenedAt.set({})
}

const tabTap = (direction: 1 | -1 = 1) => {
  const target = openOrAdvanceSwitcher(direction)

  return target
}

beforeEach(() => {
  vi.useRealTimers()
  closeSwitcher()
  $switcherSessions.set([])
  $switcherIndex.set(0)
})

afterEach(() => {
  seed([], null)
})

describe('openOrAdvanceSwitcher', () => {
  it('does nothing with fewer than two sessions', () => {
    seed(['a'], 'a')

    expect(openOrAdvanceSwitcher(1)).toBeNull()
  })

  it('arms a quick tap without navigating and commits only on Ctrl release', () => {
    seed(['a', 'b', 'c'], 'a')
    expect(tabTap()).toBeNull()
    expect($switcherOpen.get()).toBe(false)
    expect($selectedStoredSessionId.get()).toBe('a')
    expect(commitOnCtrlUp()).toBe('b')
    expect($switcherOpen.get()).toBe(false)
  })

  it('reveals while Ctrl stays held even after Tab is released', () => {
    vi.useFakeTimers()
    seed(['a', 'b', 'c'], 'a')

    tabTap()
    vi.advanceTimersByTime(SWITCHER_REVEAL_MS)

    expect($switcherOpen.get()).toBe(true)
    expect($selectedStoredSessionId.get()).toBe('a')
    expect(commitOnCtrlUp()).toBe('b')
  })

  it('opens the HUD when Tab stays held past the reveal delay', () => {
    vi.useFakeTimers()
    seed(['a', 'b', 'c'], 'a')

    openOrAdvanceSwitcher(1)
    vi.advanceTimersByTime(SWITCHER_REVEAL_MS)

    expect($switcherOpen.get()).toBe(true)
  })

  it('steps without navigating or flashing the HUD on a second quick Tab', () => {
    seed(['a', 'b', 'c'], 'a')

    expect(tabTap()).toBeNull()
    openOrAdvanceSwitcher(1)

    expect($switcherOpen.get()).toBe(false)
    expect($switcherIndex.get()).toBe(2)
  })

  it('commits the HUD highlight on Ctrl up', () => {
    seed(['a', 'b', 'c'], 'a')

    expect(tabTap()).toBeNull()
    openOrAdvanceSwitcher(1)

    expect(commitOnCtrlUp()).toBe('c')
  })
})

describe('slotSessionId', () => {
  it('reads the armed snapshot while browsing is pending', () => {
    seed(['a', 'b', 'c'], 'a')
    tabTap()
    $sessions.set([session('x')])

    expect(slotSessionId(2)).toBe('b')
  })
})

describe('switcherCandidates', () => {
  const now = new Date(2026, 10, 8, 15, 0, 0)
  const today = (hour: number) => new Date(2026, 10, 8, hour).getTime() / 1000
  const yesterday = new Date(2026, 10, 7, 23, 0).getTime() / 1000

  it("keeps only today's sessions, the current one first even when older", () => {
    const rows = [session('cur', yesterday), session('old', yesterday), session('a', today(9)), session('b', today(14))]

    expect(switcherCandidates(rows, {}, 'cur', {}, now).map(s => s.id)).toEqual(['cur', 'b', 'a'])
  })

  it('puts needs-input, then unread, ahead of recency and caps the list', () => {
    const rows = Array.from({ length: 10 }, (_, i) => session(`s${i}`, today(1 + i)))
    const ids = switcherCandidates(rows, { s1: 'unread', s2: 'needs-input' }, 's9', {}, now).map(s => s.id)

    expect(ids).toHaveLength(SWITCHER_LIMIT)
    expect(ids.slice(0, 4)).toEqual(['s9', 's2', 's1', 's8'])
  })
  it('orders the rest by when they were last opened, not by activity', () => {
    const rows = [session('a', today(14)), session('b', today(13)), session('c', today(12))]
    const opened = { a: today(8), b: today(10), c: today(9) }

    expect(switcherCandidates(rows, {}, null, opened, now).map(s => s.id)).toEqual(['b', 'c', 'a'])
  })

  it('counts a session opened today even if its last activity was earlier', () => {
    const rows = [session('old', yesterday)]

    expect(switcherCandidates(rows, {}, null, { old: today(10) }, now).map(s => s.id)).toEqual(['old'])
  })
})
