import { type SidebarSessionEntry } from '@/lib/session-branch-tree'
import { recencySection, SECOND, type SessionBucket } from '@/lib/time'

// A flat list row is either a divider or a session entry. Interleaving these
// lets the flat list (and the virtualizer) render separators inline without a
// second layer of nesting. A divider either names a calendar bucket (resolved
// against the locale's labels at render time) or carries its own label.
export type SidebarListRow =
  | { bucket: SessionBucket; key: string; kind: 'divider' }
  | { entry: SidebarSessionEntry; kind: 'session' }
  | { key: string; kind: 'divider'; label: string }

// The row's own age label reads from `last_active || started_at`; bucket off the
// same value so a section lines up with what the row actually shows.
const recencyMs = (entry: SidebarSessionEntry): number =>
  (entry.session.last_active || entry.session.started_at || 0) * SECOND

// Cursor-style date sections: Today → Last 7 Days → Last 30 Days → Older. Every
// section is labelled, the first one included, so the list always reads as a
// stack of named sections. `maxGroups` stops before opening the next section
// (complete sections only, never a partial one). Branch children inherit their
// parent cluster's section and never open one, so a parent→branches block
// never splits; a non-monotonic order (possible in a project lane) can't
// re-label a section it already emitted.
export function groupEntriesByRecency(
  entries: readonly SidebarSessionEntry[],
  nowMs = Date.now(),
  maxGroups = Number.POSITIVE_INFINITY
): SidebarListRow[] {
  const rows: SidebarListRow[] = []
  const emitted = new Set<string>()
  let lastKey: null | string = null

  for (const entry of entries) {
    if (entry.branchStem) {
      rows.push({ entry, kind: 'session' })

      continue
    }

    const bucket = recencySection(recencyMs(entry) / SECOND, nowMs)

    if (bucket.key !== lastKey) {
      lastKey = bucket.key

      if (!emitted.has(bucket.key)) {
        if (emitted.size >= maxGroups) {
          break
        }

        emitted.add(bucket.key)
        rows.push({ bucket, key: bucket.key, kind: 'divider' })
      }
    }

    rows.push({ entry, kind: 'session' })
  }

  return rows
}

// Split into two runs — still busy, and everything else — under the same
// dividers the date grouping uses. Branch children ride with their parent, as
// they do there. Entries arrive already ordered, so each run is contiguous.
export function groupEntriesByStatus(
  entries: readonly SidebarSessionEntry[],
  isWorking: (entry: SidebarSessionEntry) => boolean,
  labels: { done: string; working: string }
): SidebarListRow[] {
  const working: SidebarSessionEntry[] = []
  const done: SidebarSessionEntry[] = []
  let cluster = done

  for (const entry of entries) {
    if (!entry.branchStem) {
      cluster = isWorking(entry) ? working : done
    }

    cluster.push(entry)
  }

  return [
    ...(working.length ? [{ key: 'status:working', kind: 'divider' as const, label: labels.working }] : []),
    ...toSessionRows(working),
    ...(done.length ? [{ key: 'status:done', kind: 'divider' as const, label: labels.done }] : []),
    ...toSessionRows(done)
  ]
}

// Wrap entries as plain session rows (no dividers) so the ungrouped path shares
// the same `SidebarListRow[]` shape as the grouped one.
export function toSessionRows(entries: readonly SidebarSessionEntry[]): SidebarListRow[] {
  return entries.map(entry => ({ entry, kind: 'session' }))
}

/** Drop session rows that sit under a closed divider. The divider itself stays
 *  so the group can be opened again. Sessions above the first divider (the
 *  unlabelled head) are never gated. Returns the input array when nothing is
 *  hidden so callers keep a stable reference. */
export function hideCollapsedGroupRows(
  rows: readonly SidebarListRow[],
  isOpen: (key: string) => boolean
): SidebarListRow[] {
  const out: SidebarListRow[] = []
  let hiding = false

  for (const row of rows) {
    if (row.kind === 'divider') {
      hiding = !isOpen(row.key)
      out.push(row)

      continue
    }

    if (!hiding) {
      out.push(row)
    }
  }

  return out.length === rows.length ? (rows as SidebarListRow[]) : out
}

/** A rendered list row: a list row, or the "More" row that ends a capped section. */
export type SidebarDisplayRow = SidebarListRow | { groupKey: string; hidden: number; key: string; kind: 'more' }

/** Sections longer than this show their first rows plus a "More" row. */
export const SECTION_ROW_CAP = 10

/** Cap each divider-headed section at `cap` root sessions (branch children ride
 *  with their parent), ending it with a "More" row that counts what's hidden.
 *  Rows above the first divider and expanded sections are never capped.
 *  Returns the input array when nothing is capped. */
export function capSectionRows(
  rows: readonly SidebarListRow[],
  isExpanded: (key: string) => boolean,
  cap = SECTION_ROW_CAP
): SidebarDisplayRow[] {
  const out: SidebarDisplayRow[] = []
  let section: null | string = null
  let roots = 0
  let hidden = 0
  let capped = false

  const flush = () => {
    if (section && hidden > 0) {
      out.push({ groupKey: section, hidden, key: `more:${section}`, kind: 'more' })
      capped = true
    }

    hidden = 0
  }

  for (const row of rows) {
    if (row.kind === 'divider') {
      flush()
      section = isExpanded(row.key) ? null : row.key
      roots = 0
      out.push(row)

      continue
    }

    if (section === null) {
      out.push(row)

      continue
    }

    if (!row.entry.branchStem) {
      roots++
    }

    if (roots > cap) {
      if (!row.entry.branchStem) {
        hidden++
      }

      continue
    }

    out.push(row)
  }

  flush()

  return capped ? out : (rows as SidebarDisplayRow[])
}
