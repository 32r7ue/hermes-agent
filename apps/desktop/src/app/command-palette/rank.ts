import { normalize } from '@/lib/text'

export interface RankableItem {
  /** Added to a matching row's grade — destinations (Settings pages) outrank
   *  the fields on them when both match equally well. Never makes a miss match. */
  boost?: number
  keywords?: string[]
  label: string
  /** Fixed rank for rows the server already matched (message content), which
   *  the label/keyword matcher can't see. */
  score?: number
}

export interface RankableGroup<T extends RankableItem> {
  heading?: string
  items: T[]
}

// "provider" names the "Providers" page, "notification" the Notifications page:
// a trailing plural is the same word, so it grades as an exact/whole-word hit.
const sameWord = (word: string, needle: string): boolean =>
  word === needle || word === `${needle}s` || `${word}s` === needle

/** "providers" still finds a row labelled "Provider". Short words keep their s. */
const singular = (term: string): string => (term.length > 3 && term.endsWith('s') ? term.slice(0, -1) : term)

// Ranking happens in React, not cmdk. We score, sort, and prune the groups
// ourselves and hand cmdk an already-ordered list with `shouldFilter={false}`,
// leaving it as pure keyboard/selection machinery. (cmdk's own group
// re-sorting silently no-ops: its sort() queries groups by an internal id that
// never matches the heading text it writes into `data-value`, so groups always
// keep source order — which put a generic keyword match like "Capabilities" on
// top and the auto-highlight on it while an exact "Tools" row sat below.)
//
// cmdk still auto-selects the first DOM item whenever the search changes, so
// rendering best-match-first is what puts the highlight on the best match.
//
// AND semantics: every typed word must appear in the label or keywords. The
// grade rewards matches on the visible label — exact > prefix > whole word >
// word prefix > substring > scattered terms > keyword-only — so typing "tools"
// selects the row that says Tools, not a row that hides it in keywords.
export const scoreItem = (item: RankableItem, needle: string): number => {
  if (item.score !== undefined) {
    return item.score
  }

  const label = item.label.toLowerCase()
  const keys = (item.keywords ?? []).join(' ').toLowerCase()
  const terms = needle.split(/\s+/).filter(Boolean)

  if (terms.some(term => !label.includes(term) && !keys.includes(term) && !label.includes(singular(term)))) {
    return 0
  }

  return labelGrade(label, needle, terms) + (item.boost ?? 0)
}

function labelGrade(label: string, needle: string, terms: string[]): number {
  if (sameWord(label, needle)) {
    return 1
  }

  if (label.startsWith(needle)) {
    return 0.9
  }

  const words = label.split(/[^\p{L}\p{N}]+/u).filter(Boolean)

  if (words.some(word => sameWord(word, needle))) {
    return 0.85
  }

  if (words.some(word => word.startsWith(needle))) {
    return 0.8
  }

  if (label.includes(needle)) {
    return 0.7
  }

  if (terms.every(term => label.includes(term))) {
    return 0.6
  }

  // Matched only via keywords — the weakest, generic-row signal.
  return 0.4
}

// Order items within each group by score, order groups by their best item, and
// drop everything that doesn't match. Ties keep their original order (stable
// sort), so curated group/item ordering still breaks even scores.
export const rankGroups = <T extends RankableItem, G extends RankableGroup<T>>(groups: G[], search: string): G[] => {
  const needle = normalize(search)

  if (!needle) {
    return groups
  }

  return groups
    .map(group => {
      const scored = group.items
        .map(item => ({ item, score: scoreItem(item, needle) }))
        .filter(entry => entry.score > 0)
        .sort((a, b) => b.score - a.score)

      return { group: { ...group, items: scored.map(entry => entry.item) }, max: scored[0]?.score ?? 0 }
    })
    .filter(entry => entry.max > 0)
    .sort((a, b) => b.max - a.max)
    .map(entry => entry.group)
}
