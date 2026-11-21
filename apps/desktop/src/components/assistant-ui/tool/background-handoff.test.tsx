import type { GatewayEvent } from '@hermes/shared'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { renderMessageStream } from '@/app/session/hooks/use-message-stream/test-harness'
import { stubThreadEnvironment, stubThreadViewportSize, ThreadRuntime } from '@/components/assistant-ui/test-utils'
import { Thread } from '@/components/assistant-ui/thread'
import { backgroundHandoff } from '@/lib/background-handoff'
import { toRuntimeMessage } from '@/lib/chat-runtime'
import {
  $backgroundOutcomes,
  $backgroundStatusBySession,
  reconcileBackgroundProcesses,
  seedBackgroundProcess
} from '@/store/composer-status'
import { clearAllPrompts } from '@/store/prompts'
import { $activeSessionId } from '@/store/session'

import { handoffKey, parseHandoffKey } from './background-handoff-state'

stubThreadEnvironment()
stubThreadViewportSize()

const SID = 'sess-bg-handoff'

const YIELDED = {
  output: 'building…',
  exit_code: null,
  error: null,
  status: 'yielded_to_background',
  session_id: 'proc_yield1',
  pid: 4242,
  notify_on_complete: true,
  note: 'The user sent a message while this command was running, so it was moved to the background WITHOUT being killed.'
}

function resetBackground() {
  $backgroundStatusBySession.set({})
  $backgroundOutcomes.set({})
}

beforeEach(() => {
  clearAllPrompts()
  resetBackground()
  $activeSessionId.set(SID)
})

afterEach(() => {
  cleanup()
  resetBackground()
  $activeSessionId.set(null)
})

describe('backgroundHandoff', () => {
  it('recognises a yielded and a promoted terminal result, nothing else', () => {
    expect(backgroundHandoff('terminal', YIELDED)).toEqual({ kind: 'yielded', processId: 'proc_yield1' })
    expect(
      backgroundHandoff('terminal', {
        output: 'Background process started',
        session_id: 'proc_p',
        promoted_from_foreground: 'Requested foreground timeout 9999s exceeds the 600s cap…'
      })
    ).toEqual({ kind: 'promoted', processId: 'proc_p' })
    // A plain background spawn already shows as a background row; its call did what it said.
    expect(backgroundHandoff('terminal', { output: 'Background process started', session_id: 'proc_b' })).toBeNull()
    expect(backgroundHandoff('terminal', { exit_code: 0, output: 'ok' })).toBeNull()
    expect(backgroundHandoff('process', YIELDED)).toBeNull()
  })
})

describe('handoff state', () => {
  it('reads running from the stack, then the recorded exit after the row self-clears', () => {
    seedBackgroundProcess(SID, 'proc_yield1', 'npm run build\n--verbose')

    const items = $backgroundStatusBySession.get()[SID]
    expect(items).toEqual([{ id: 'proc_yield1', state: 'running', title: 'npm run build', type: 'background' }])
    expect(parseHandoffKey(handoffKey(items, $backgroundOutcomes.get(), ['proc_yield1']))).toEqual({ state: 'running' })

    reconcileBackgroundProcesses(SID, [
      { command: 'npm run build', exit_code: 2, session_id: 'proc_yield1', status: 'exited' }
    ])
    // Dropped from the stack (dismiss / auto-clear), the outcome survives for the transcript row.
    $backgroundStatusBySession.set({})
    expect(parseHandoffKey(handoffKey(undefined, $backgroundOutcomes.get(), ['proc_yield1']))).toEqual({
      exitCode: 2,
      state: 'failed'
    })
  })

  it('keeps a just-seeded row through a snapshot that predates it', () => {
    seedBackgroundProcess(SID, 'proc_yield1', 'sleep 60')
    reconcileBackgroundProcesses(SID, [])
    expect($backgroundStatusBySession.get()[SID]?.map(item => item.id)).toEqual(['proc_yield1'])

    reconcileBackgroundProcesses(SID, [{ command: 'sleep 60', session_id: 'proc_yield1', status: 'running' }])
    reconcileBackgroundProcesses(SID, [])
    // Once the registry has confirmed it, a later absence is real.
    expect($backgroundStatusBySession.get()[SID]).toBeUndefined()
  })
})

describe('yielded terminal row', () => {
  function yieldedHarness() {
    const stream = renderMessageStream(SID)

    const send = (type: GatewayEvent['type'], body: Record<string, unknown> = {}) =>
      act(() => stream.handleEvent({ payload: body, session_id: SID, type }))

    send('message.start')
    send('tool.complete', { args: { command: 'npm run build' }, name: 'terminal', result: YIELDED, tool_id: 't-1' })
    send('message.complete', { text: 'Started the build.' })

    return (
      <ThreadRuntime messages={stream.state(SID).messages.map(toRuntimeMessage)}>
        <Thread />
      </ThreadRuntime>
    )
  }

  it('shows the command as still running, then its exit once the process ends', async () => {
    const { container } = render(yieldedHarness())

    // The completion seeded the stack row without waiting for a poll.
    expect($backgroundStatusBySession.get()[SID]?.map(item => item.state)).toEqual(['running'])

    expect(await screen.findAllByText('Continues in background')).not.toHaveLength(0)
    expect(container.querySelector('[data-slot="tool-run-background"]')).not.toBeNull()

    fireEvent.click(container.querySelector('[data-tool-summary] [aria-expanded]') ?? screen.getByText(/command/i))
    expect(container.querySelector('[data-slot="tool-background-handoff"]')).not.toBeNull()

    act(() =>
      reconcileBackgroundProcesses(SID, [
        { command: 'npm run build', exit_code: 0, session_id: 'proc_yield1', status: 'exited' }
      ])
    )

    expect(container.querySelector('[data-slot="tool-run-background"]')).toBeNull()
    expect(container.querySelector('[data-slot="tool-background-handoff"]')).toBeNull()
    expect(container.querySelector('[data-slot="tool-background-exit"]')?.textContent).toBe('exit 0')
  })
})
