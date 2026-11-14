// GPT's reasoning summaries arrive as `**Title**` lines, often with nothing under
// them. The newest title is the block's headline; a body of titles alone has
// nothing more to show than that headline.
const SUMMARY_TITLE = /^\s*\*\*(.+?)\*\*\s*$/gm

/**
 * A finished thought with no summary title (Claude, most open models) reads as
 * its own opening sentence rather than a bare "Thought": the line says what
 * the model was thinking about. Markdown is stripped; the row truncates it.
 */
export function reasoningPreview(text: string): null | { text: string; whole: boolean } {
  const flat = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[*_`#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()

  if (!flat) {
    return null
  }

  const sentence = flat.match(/^.+?[.!?](?=\s|$)/)?.[0] ?? flat

  return sentence.length > 160
    ? { text: `${sentence.slice(0, 157).trimEnd()}…`, whole: false }
    : { text: sentence, whole: sentence === flat }
}

export function reasoningHeadline(text: string): { headline: null | string; titleOnly: boolean } {
  const titles = [...text.matchAll(SUMMARY_TITLE)].map(match => match[1]!.trim()).filter(Boolean)

  return {
    headline: titles.at(-1) ?? null,
    titleOnly: titles.length > 0 && !text.replace(SUMMARY_TITLE, '').trim()
  }
}
