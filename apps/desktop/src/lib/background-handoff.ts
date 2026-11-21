/**
 * A terminal call whose command was handed to a tracked background process
 * instead of finishing in the foreground. Two backend paths produce one:
 *
 * - `status: "yielded_to_background"`: the user steered mid-turn while the
 *   command ran; it kept running (not killed) as `proc_…`.
 * - `promoted_from_foreground`: a foreground timeout above the cap started it
 *   as a background process up front.
 *
 * Either way the tool call has a result, yet the command is still running, so
 * the transcript must not paint it as finished. The process registry
 * (`$backgroundStatusBySession`) says when it actually ends.
 */
export interface BackgroundHandoff {
  kind: 'promoted' | 'yielded'
  /** Process registry id (`proc_…`), the key of the composer's background rows. */
  processId: string
}

export function backgroundHandoff(toolName: string, result: Record<string, unknown>): BackgroundHandoff | null {
  if (toolName !== 'terminal') {
    return null
  }

  const processId = typeof result.session_id === 'string' ? result.session_id.trim() : ''

  if (!processId || result.error) {
    return null
  }

  if (result.status === 'yielded_to_background') {
    return { kind: 'yielded', processId }
  }

  if (typeof result.promoted_from_foreground === 'string' && result.promoted_from_foreground) {
    return { kind: 'promoted', processId }
  }

  return null
}
