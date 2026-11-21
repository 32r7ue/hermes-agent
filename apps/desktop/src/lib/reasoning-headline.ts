// GPT's reasoning summaries arrive as `**Title**` lines, often with nothing under
// them. The newest title is the block's headline; a body of titles alone has
// nothing more to show than that headline.
const SUMMARY_TITLE = /^\s*\*\*(.+?)\*\*\s*$/gm

// A header longer than this is clipped with an ellipsis and the body keeps the
// whole sentence — a run-on "sentence" (no punctuation at all) would otherwise
// move the entire thought into the header.
const MAX_PREVIEW = 280

// The opening sentence ends at a terminator (plus any closing markdown/quote
// right after it) or at the end of the first paragraph. A line that opens a new
// markdown block (heading, list, quote, fence) also ends it.
const SENTENCE_END = /^[\s\S]*?[.!?…][*_`)\]"'”’]*(?=\s|$)/
const BLOCK_START = /\n(?=\s*(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|>|```))/

function flatten(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function clip(sentence: string): string {
  return sentence.length > MAX_PREVIEW ? `${sentence.slice(0, MAX_PREVIEW - 1).trimEnd()}…` : sentence
}

/**
 * The raw markdown of a thought's opening sentence, exactly as it prefixes the
 * left-trimmed text, or null when the thought opens with something that is not
 * prose (a code fence) and so has no sentence to lift out of the body.
 */
export function reasoningLead(text: string): null | string {
  const body = text.trimStart()

  if (!body || body.startsWith('```')) {
    return null
  }

  const paragraph = body.split(/\n[^\S\n]*\n/)[0]!.split(BLOCK_START)[0]!

  return (paragraph.match(SENTENCE_END)?.[0] ?? paragraph).trimEnd() || null
}

export interface ReasoningPreview {
  /** Raw markdown the body drops because the header already shows it in full;
   *  null when the header is clipped/derived and the body keeps everything. */
  lead: null | string
  text: string
  /** The header is the entire thought: there is nothing left to expand. */
  whole: boolean
}

/**
 * A finished thought with no summary title (Claude, most open models) reads as
 * its own opening sentence rather than a bare "Thought": the line says what
 * the model was thinking about. Markdown is stripped. The body continues after
 * that sentence instead of repeating it.
 */
export function reasoningPreview(text: string): null | ReasoningPreview {
  const lead = reasoningLead(text)
  const sentence = lead ? flatten(lead) : ''

  if (!lead || !sentence || sentence.length > MAX_PREVIEW) {
    // Code-first, markup-only, or run-on opening: the header summarizes and
    // the body stays whole, so nothing is lost.
    const flat = flatten(text)

    if (!flat) {
      return null
    }

    return { lead: null, text: clip(sentence || (flat.match(/^.+?[.!?](?=\s|$)/)?.[0] ?? flat)), whole: false }
  }

  return { lead, text: sentence, whole: !flatten(text.trimStart().slice(lead.length)) }
}

/** A part's body once the header has taken its opening sentence. */
export function reasoningAfterLead(text: string, lead: null | string): string {
  const body = text.trimStart()

  return lead && body.startsWith(lead) ? body.slice(lead.length).trimStart() : body
}

export function reasoningHeadline(text: string): { headline: null | string; titleOnly: boolean } {
  const titles = [...text.matchAll(SUMMARY_TITLE)].map(match => match[1]!.trim()).filter(Boolean)

  return {
    headline: titles.at(-1) ?? null,
    titleOnly: titles.length > 0 && !text.replace(SUMMARY_TITLE, '').trim()
  }
}
