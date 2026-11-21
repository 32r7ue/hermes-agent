import { describe, expect, it } from 'vitest'

import type { SessionInfo } from '@/types/hermes'

import { makeSessionInfo } from '../test/session-info'

import type { SidebarSessionEntry } from './session-branch-tree'
import { capSectionRows, groupEntriesByRecency, hideCollapsedGroupRows, toSessionRows } from './session-date-groups'

const session = (id: string, overrides: Partial<SessionInfo> = {}): SessionInfo =>
  makeSessionInfo({ id, message_count: 1, source: 'cli', title: id, ...overrides })

const entry = (s: SessionInfo, branchStem?: string): SidebarSessionEntry =>
  branchStem ? { branchStem, session: s } : { session: s }

// Fixed "now": Thursday 18 Jun 2026, local noon.
const NOW = new Date(2026, 5, 18, 12, 0, 0).getTime()

const at = (year: number, month: number, day: number, hour = 10, minute = 0): number =>
  Math.floor(new Date(year, month, day, hour, minute, 0).getTime() / 1000)

const group = (entries: SidebarSessionEntry[], nowMs = NOW) => groupEntriesByRecency(entries, nowMs)

const dividerKeys = (rows: ReturnType<typeof groupEntriesByRecency>): string[] =>
  rows.flatMap(row => (row.kind === 'divider' ? [row.key] : []))

describe('groupEntriesByRecency', () => {
  it('labels every section, the first one included: Today / Last 7 Days / Last 30 Days / Older', () => {
    const rows = group([
      entry(session('a', { last_active: at(2026, 5, 18, 11) })),
      entry(session('b', { last_active: at(2026, 5, 18, 6) })),
      entry(session('c', { last_active: at(2026, 5, 17, 15) })),
      entry(session('d', { last_active: at(2026, 5, 12) })),
      entry(session('e', { last_active: at(2026, 5, 3) })),
      entry(session('f', { last_active: at(2026, 4, 25) })),
      entry(session('g', { last_active: at(2025, 11, 3) }))
    ])

    expect(rows[0]).toMatchObject({ key: 'today', kind: 'divider' })
    expect(dividerKeys(rows)).toEqual(['today', 'last-7-days', 'last-30-days', 'older'])
    expect(rows.map(row => (row.kind === 'session' ? row.entry.session.id : row.key))).toEqual([
      'today',
      'a',
      'b',
      'last-7-days',
      'c',
      'd',
      'last-30-days',
      'e',
      'f',
      'older',
      'g'
    ])
  })

  it('keeps the whole of today in one Today section (no "Earlier today")', () => {
    const rows = group([
      entry(session('a', { last_active: at(2026, 5, 18, 11) })),
      entry(session('b', { last_active: at(2026, 5, 18, 7) })),
      entry(session('c', { last_active: at(2026, 5, 18, 4, 30) }))
    ])

    expect(dividerKeys(rows)).toEqual(['today'])
  })

  it('limits complete sections without splitting branch clusters', () => {
    const entries = [
      entry(session('t1', { last_active: at(2026, 5, 18, 11) })),
      entry(session('y1', { last_active: at(2026, 5, 17, 15) })),
      entry(session('branch', { last_active: at(2026, 4, 1) }), '└'),
      entry(session('old', { last_active: at(2026, 3, 1) }))
    ]

    const limited = groupEntriesByRecency(entries, NOW, 2)

    expect(dividerKeys(limited)).toEqual(['today', 'last-7-days'])
    expect(limited.at(-1)).toMatchObject({ entry: { session: { id: 'branch' } } })
    expect(groupEntriesByRecency([], NOW, 2)).toEqual([])
  })

  it('keeps branch children in their parent cluster without opening a section', () => {
    const parent = session('parent', { last_active: at(2026, 5, 18, 11) })
    const child = session('child', { last_active: at(2024, 0, 1), parent_session_id: 'parent' })

    expect(group([entry(parent), entry(child, '└─ ')])).toEqual([
      expect.objectContaining({ key: 'today', kind: 'divider' }),
      { entry: entry(parent), kind: 'session' },
      { entry: entry(child, '└─ '), kind: 'session' }
    ])
  })

  it('never emits a section twice under a non-monotonic order', () => {
    const rows = group([
      entry(session('a', { last_active: at(2026, 5, 16) })),
      entry(session('b', { last_active: at(2026, 4, 25) })),
      entry(session('c', { last_active: at(2026, 5, 16) }))
    ])

    expect(dividerKeys(rows)).toEqual(['last-7-days', 'last-30-days'])
  })

  it('falls back to started_at when last_active is missing', () => {
    const rows = group([entry(session('s', { last_active: 0, started_at: at(2026, 5, 10) }))])

    expect(dividerKeys(rows)).toEqual(['last-30-days'])
  })
})

describe('capSectionRows', () => {
  const sectionRows = (key: string, count: number, withBranch = false) => [
    { key, kind: 'divider' as const, label: key },
    ...Array.from({ length: count }, (_, i) => ({ entry: entry(session(`${key}-${i}`)), kind: 'session' as const })),
    ...(withBranch ? [{ entry: entry(session(`${key}-branch`), '└─ '), kind: 'session' as const }] : [])
  ]

  it('returns the same array when no section exceeds the cap', () => {
    const rows = sectionRows('today', 3)

    expect(capSectionRows(rows, () => false, 3)).toBe(rows)
  })

  it('caps long sections with a More row counting the hidden root sessions', () => {
    const rows = [...sectionRows('today', 5, true), ...sectionRows('older', 2)]
    const capped = capSectionRows(rows, () => false, 3)

    expect(capped.map(row => (row.kind === 'session' ? row.entry.session.id : row.key))).toEqual([
      'today',
      'today-0',
      'today-1',
      'today-2',
      'more:today',
      'older',
      'older-0',
      'older-1'
    ])
    expect(capped[4]).toMatchObject({ groupKey: 'today', hidden: 2, kind: 'more' })
  })

  it('leaves an expanded section whole', () => {
    const rows = sectionRows('today', 5)

    expect(capSectionRows(rows, key => key === 'today', 3)).toBe(rows)
  })
})

describe('hideCollapsedGroupRows', () => {
  it('returns the same array when every group is open', () => {
    const rows = [
      { entry: entry(session('a')), kind: 'session' as const },
      { key: 'yesterday', kind: 'divider' as const, label: 'Yesterday' },
      { entry: entry(session('b')), kind: 'session' as const }
    ]

    expect(hideCollapsedGroupRows(rows, () => true)).toBe(rows)
  })

  it('keeps the divider and drops sessions under a closed group', () => {
    const rows = [
      { entry: entry(session('head')), kind: 'session' as const },
      { key: 'yesterday', kind: 'divider' as const, label: 'Yesterday' },
      { entry: entry(session('y1')), kind: 'session' as const },
      { entry: entry(session('y2'), '└─ '), kind: 'session' as const },
      { key: 'last-week', kind: 'divider' as const, label: 'Last week' },
      { entry: entry(session('lw')), kind: 'session' as const }
    ]

    const visible = hideCollapsedGroupRows(rows, key => key !== 'yesterday')

    expect(visible).toEqual([rows[0], rows[1], rows[4], rows[5]])
  })

  it('never hides the unlabelled head above the first divider', () => {
    const rows = [
      { entry: entry(session('a')), kind: 'session' as const },
      { entry: entry(session('b')), kind: 'session' as const },
      { key: 'yesterday', kind: 'divider' as const, label: 'Yesterday' },
      { entry: entry(session('c')), kind: 'session' as const }
    ]

    const visible = hideCollapsedGroupRows(rows, () => false)

    expect(visible.map(row => (row.kind === 'session' ? row.entry.session.id : row.key))).toEqual([
      'a',
      'b',
      'yesterday'
    ])
  })
})

describe('toSessionRows', () => {
  it('wraps entries as session rows with no dividers', () => {
    const entries = [entry(session('a')), entry(session('b'), '└─ ')]

    expect(toSessionRows(entries)).toEqual([
      { entry: entries[0], kind: 'session' },
      { entry: entries[1], kind: 'session' }
    ])
  })
})
