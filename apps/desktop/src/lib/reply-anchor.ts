/**
 * Where the thread stops following when a held reply lands whole: at the reply's top,
 * so reading starts there instead of at its last line. The thread's scroll owner
 * (use-stick-to-bottom) caps its target with this until the reader scrolls or a new
 * run starts.
 */
let anchor: HTMLElement | null = null

// Room above the reply for the summary line that led into it.
const ANCHOR_OFFSET_PX = 72

export function setReplyAnchor(element: HTMLElement | null): void {
  anchor = element
}

export function clearReplyAnchor(): void {
  anchor = null
}

/** The highest scrollTop the view may follow to, or null when nothing holds it. Never above where it is. */
export function replyAnchorCap(scrollElement: HTMLElement): null | number {
  if (!anchor?.isConnected || !scrollElement.contains(anchor)) {
    return null
  }

  const top =
    anchor.getBoundingClientRect().top - scrollElement.getBoundingClientRect().top + scrollElement.scrollTop

  return Math.max(scrollElement.scrollTop, top - ANCHOR_OFFSET_PX)
}

// When a turn last finished. The finished reply is swapped for its stored copy (new id, fresh mount)
// around the end of the run, so "this reply just landed" has to outlive any one mount.
let runEndedAt = 0

export function markRunEnded(): void {
  runEndedAt = Date.now()
}

export function runEndedRecently(windowMs = 2_500): boolean {
  return Date.now() - runEndedAt < windowMs
}
