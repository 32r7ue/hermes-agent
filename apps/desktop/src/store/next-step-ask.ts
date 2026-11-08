/**
 * The open `::ask{...}` panel per chat surface, so the composer's ⌘↩ can take it. A panel registers
 * while it is live (last reply, idle) and unregisters when anything moves past it.
 */

const pending = new Map<string, () => void>()

export function registerNextStepAsk(surfaceId: string, run: () => void): () => void {
  pending.set(surfaceId, run)

  return () => {
    if (pending.get(surfaceId) === run) {
      pending.delete(surfaceId)
    }
  }
}

/** Runs the surface's open ask, if any. True when one ran. */
export function takeNextStepAsk(surfaceId: null | string): boolean {
  const run = surfaceId ? pending.get(surfaceId) : undefined

  if (!run) {
    return false
  }

  pending.delete(surfaceId!)
  run()

  return true
}
