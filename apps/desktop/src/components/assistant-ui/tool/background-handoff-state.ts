import { useStore } from '@nanostores/react'
import { atom, computed, type ReadableAtom } from 'nanostores'
import { useMemo } from 'react'

import { useSessionView } from '@/app/chat/session-view'
import {
  $backgroundOutcomes,
  $backgroundStatusBySession,
  type BackgroundOutcome,
  backgroundProcessState,
  type ComposerStatusItem
} from '@/store/composer-status'

/** Where handed-off commands stand: still running, how the last one ended, or unknown. */
export interface HandoffView {
  exitCode?: number
  state: 'done' | 'failed' | 'running' | 'unknown'
}

const UNKNOWN: HandoffView = { state: 'unknown' }
const NO_HANDOFF = atom<string>('')

/**
 * Collapses the processes' states to one key: `running` while any of them
 * still runs, else the single process's outcome (`done:0`, `failed:2`). A
 * string, so subscribed rows re-render only when that answer changes, not on
 * every background-stack update.
 */
export function handoffKey(
  items: readonly ComposerStatusItem[] | undefined,
  outcomes: Record<string, BackgroundOutcome>,
  processIds: readonly string[]
): string {
  const states = processIds.map(id => backgroundProcessState(items, outcomes, id))

  if (states.some(state => state?.state === 'running')) {
    return 'running'
  }

  const only = processIds.length === 1 ? states[0] : null

  return only ? `${only.state}:${only.exitCode ?? ''}` : ''
}

export function parseHandoffKey(key: string): HandoffView {
  if (key === 'running') {
    return { state: 'running' }
  }

  const [state, code] = key.split(':')

  if (state !== 'done' && state !== 'failed') {
    return UNKNOWN
  }

  return { exitCode: code ? Number(code) : undefined, state }
}

/** Live state of the background processes these tool calls handed their commands to. */
export function useHandoffView(processIds: readonly string[]): HandoffView {
  const sessionId = useStore(useSessionView().$runtimeId) ?? ''
  const idsKey = processIds.join('\u0000')

  const $key = useMemo<ReadableAtom<string>>(
    () =>
      idsKey
        ? computed([$backgroundStatusBySession, $backgroundOutcomes], (bg, outcomes) =>
            handoffKey(bg[sessionId], outcomes, idsKey.split('\u0000'))
          )
        : NO_HANDOFF,
    [idsKey, sessionId]
  )

  return parseHandoffKey(useStore($key))
}
