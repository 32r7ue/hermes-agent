import { AssistantRuntimeProvider, type ThreadMessage, useExternalStoreRuntime } from '@assistant-ui/react'
import { act, render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { stubThreadEnvironment, stubThreadViewportSize } from '../test-utils'

import { TranscriptWindowProvider } from './transcript-window'

import { Thread } from '.'

stubThreadEnvironment()
stubThreadViewportSize()

const createdAt = new Date('2026-08-01T00:00:00.000Z')

/**
 * The same stored turns as a newest-page read returns them: renderer ids carry
 * the row's position in that page (`<ts>-<index>-<role>`), the durable row id
 * rides metadata.custom.rowId.
 */
function storedTurns(pageOffset: number, turns = 4): ThreadMessage[] {
  return Array.from({ length: turns }, (_, turn) => {
    const userRow = 100 + turn * 2

    return [
      {
        id: `1793025691.78-${turn * 2 + pageOffset}-user`,
        role: 'user',
        content: [{ type: 'text', text: `prompt ${turn}` }],
        attachments: [],
        createdAt,
        metadata: { custom: { rowId: userRow } }
      } as ThreadMessage,
      {
        id: `1793025691.78-${turn * 2 + 1 + pageOffset}-assistant`,
        role: 'assistant',
        content: [{ type: 'text', text: `reply ${turn}` }],
        status: { type: 'complete', reason: 'stop' },
        createdAt,
        metadata: {
          unstable_state: null,
          unstable_annotations: [],
          unstable_data: [],
          steps: [],
          custom: { rowId: userRow + 1 }
        }
      } as ThreadMessage
    ]
  }).flat()
}

function Harness({ messages }: { messages: ThreadMessage[] }) {
  const runtime = useExternalStoreRuntime<ThreadMessage>({ isRunning: false, messages, onNew: async () => {} })

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <TranscriptWindowProvider value={{ olderAvailable: false, expandWindow: () => {} }}>
        <Thread sessionId="s1" sessionKey="s1" />
      </TranscriptWindowProvider>
    </AssistantRuntimeProvider>
  )
}

const turnRows = (container: HTMLElement) => [
  ...container.querySelectorAll<HTMLElement>('[data-slot="aui_message-group"]')
]

describe('transcript row identity', () => {
  it('keeps every stored turn mounted when a slid newest page re-reads it under new renderer ids', async () => {
    // A remounted row is a new element with no remembered size: off screen it
    // drops to the contain-intrinsic-size placeholder, the transcript height
    // jumps, and the clamp reads as a scroll-up that stops the follow.
    const { container, rerender } = render(<Harness messages={storedTurns(0)} />)

    await act(async () => {
      await new Promise<void>(resolve => window.setTimeout(resolve, 0))
    })

    const before = turnRows(container)
    expect(before).toHaveLength(4)

    rerender(<Harness messages={storedTurns(12)} />)

    await act(async () => {
      await new Promise<void>(resolve => window.setTimeout(resolve, 0))
    })

    const after = turnRows(container)
    expect(after).toHaveLength(4)
    expect(after.map((row, index) => row === before[index])).toEqual([true, true, true, true])
    expect(after.map(row => row.textContent?.match(/prompt \d/)?.[0])).toEqual([
      'prompt 0',
      'prompt 1',
      'prompt 2',
      'prompt 3'
    ])
  })

  it('keeps the live turn mounted when the receipt binds the optimistic bubble and the persisted copy replaces it', async () => {
    // Re-keying the turn from `user-<submission>` to `row:N` remounted the user
    // bubble and the reply under it while the send was still gliding in.
    const reply = (rowId?: number) =>
      ({
        id: 'reply-live',
        role: 'assistant',
        content: [{ type: 'text', text: 'working on it' }],
        status: { type: 'running' },
        createdAt,
        metadata: { unstable_state: null, unstable_annotations: [], unstable_data: [], steps: [], custom: rowId ? { rowId } : {} }
      }) as ThreadMessage

    const sent = (id: string, rowId?: number) =>
      ({
        id,
        role: 'user',
        content: [{ type: 'text', text: 'follow-up' }],
        attachments: [],
        createdAt,
        metadata: { custom: rowId ? { rowId } : {} }
      }) as ThreadMessage

    const history = storedTurns(0, 2)
    const { container, rerender } = render(<Harness messages={[...history, sent('user-submission-1'), reply()]} />)
    const settle = () => act(async () => await new Promise<void>(resolve => window.setTimeout(resolve, 0)))
    await settle()

    const liveTurn = () => turnRows(container).at(-1)
    const before = liveTurn()
    expect(before?.textContent).toContain('follow-up')

    rerender(<Harness messages={[...history, sent('user-submission-1', 900), reply()]} />)
    await settle()
    expect(liveTurn()).toBe(before)

    rerender(<Harness messages={[...history, sent('1793025691.78-4-user', 900), reply(901)]} />)
    await settle()
    expect(liveTurn()).toBe(before)
    expect(turnRows(container)).toHaveLength(3)
  })
})
