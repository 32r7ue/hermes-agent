// GPT's reasoning summaries arrive as `**Title**` lines, often with nothing under
// them. The newest title is the block's headline; a body of titles alone has
// nothing more to show than that headline.
const SUMMARY_TITLE = /^\s*\*\*(.+?)\*\*\s*$/gm

export function reasoningHeadline(text: string): { headline: null | string; titleOnly: boolean } {
  const titles = [...text.matchAll(SUMMARY_TITLE)].map(match => match[1]!.trim()).filter(Boolean)

  return {
    headline: titles.at(-1) ?? null,
    titleOnly: titles.length > 0 && !text.replace(SUMMARY_TITLE, '').trim()
  }
}
