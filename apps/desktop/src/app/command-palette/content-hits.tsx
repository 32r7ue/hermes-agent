import type { SessionSearchResult } from '@/hermes'

// FTS5 `snippet()` wraps each matched token in these markers
// (hermes_state_search.py). Everything else is plain message text.
const HIT_RE = />>>(.*?)<<</g

export interface SnippetPart {
  hit: boolean
  text: string
}

export function snippetParts(snippet: string): SnippetPart[] {
  const parts: SnippetPart[] = []
  let last = 0

  for (const match of snippet.matchAll(HIT_RE)) {
    if (match.index > last) {
      parts.push({ hit: false, text: snippet.slice(last, match.index) })
    }

    parts.push({ hit: true, text: match[1] })
    last = match.index + match[0].length
  }

  if (last < snippet.length) {
    parts.push({ hit: false, text: snippet.slice(last) })
  }

  return parts.map(part => ({ ...part, text: part.text.replace(/[*`#]+/g, '').replace(/\s+/g, ' ') }))
}

// Context kept before the first match, so a one-line row always shows the hit.
const LEAD_CHARS = 32

/** Parts with the text before the first hit cut to its last {@link LEAD_CHARS}. */
export function leadingSnippetParts(snippet: string): SnippetPart[] {
  const parts = snippetParts(snippet)
  const first = parts[0]

  if (!first || first.hit || parts.length === 1 || first.text.length <= LEAD_CHARS) {
    return parts
  }

  const tail = first.text.slice(-LEAD_CHARS)
  const cut = tail.indexOf(' ')

  return [{ hit: false, text: `…${cut >= 0 ? tail.slice(cut) : tail}` }, ...parts.slice(1)]
}

export const snippetText = (snippet: string): string =>
  snippetParts(snippet)
    .map(part => part.text)
    .join('')
    .trim()

/** A content hit's row label: the session's real title, else the matched text. */
export const contentHitLabel = (hit: SessionSearchResult): string => hit.title?.trim() || snippetText(hit.snippet)

/** The matched message line under a content-hit row, match terms emphasized. */
export function SnippetLine({ snippet }: { snippet: string }) {
  return (
    <span className="block truncate text-[0.6875rem] leading-snug text-muted-foreground">
      {leadingSnippetParts(snippet).map((part, index) =>
        part.hit ? (
          <span className="font-medium text-foreground" key={index}>
            {part.text}
          </span>
        ) : (
          part.text
        )
      )}
    </span>
  )
}
