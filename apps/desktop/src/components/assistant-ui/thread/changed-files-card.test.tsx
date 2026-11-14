import type { ThreadMessage } from '@assistant-ui/react'
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'

import { assistantMessage, stubThreadEnvironment, stubThreadViewportSize, ThreadRuntime, userMessage } from '../test-utils'
import { Thread } from '../thread'

stubThreadEnvironment()
stubThreadViewportSize()

afterEach(cleanup)

function editingReply(id: string, path: string, text = 'done'): ThreadMessage {
  return {
    ...assistantMessage(),
    id,
    content: [
      {
        type: 'tool-call',
        toolCallId: `patch-${id}`,
        toolName: 'patch',
        args: { path },
        argsText: '{}',
        result: { success: true, path, inline_diff: '--- a\n+++ b\n@@ -1 +1,2 @@\n-old\n+new\n+more' }
      },
      { type: 'text', text }
    ]
  } as ThreadMessage
}

const cards = (container: HTMLElement) => [...container.querySelectorAll('[data-slot="aui_changed-files"]')]

it('keeps a turn’s changed-files card after the next message is sent', async () => {
  const { container } = render(
    <ThreadRuntime
      messages={[
        userMessage('user-1'),
        editingReply('assistant-1', '/repo/a.ts'),
        userMessage('user-2', 'thanks'),
        { ...assistantMessage(), id: 'assistant-2' } as ThreadMessage
      ]}
    >
      <Thread />
    </ThreadRuntime>
  )

  await waitFor(() => expect(cards(container)).toHaveLength(1))
  expect(cards(container)[0]!.textContent).toContain('a.ts')
  expect(cards(container)[0]!.closest('[data-slot="aui_assistant-message-root"]')).toBe(
    container.querySelectorAll('[data-slot="aui_assistant-message-root"]')[0]
  )
})

it('folds a turn split over several bubbles into one card on its last bubble', async () => {
  const { container } = render(
    <ThreadRuntime
      messages={[
        userMessage('user-1'),
        editingReply('assistant-1', '/repo/a.ts', 'first'),
        editingReply('assistant-2', '/repo/b.ts', 'second'),
        editingReply('assistant-3', '/repo/a.ts', 'third')
      ]}
    >
      <Thread />
    </ThreadRuntime>
  )

  await waitFor(() => expect(cards(container)).toHaveLength(1))
  const card = cards(container)[0]!
  expect(card.textContent).toContain('2 files changed')
  // a.ts was edited twice: +2 −1 each time.
  expect(card.textContent).toContain('+4')
  const roots = container.querySelectorAll('[data-slot="aui_assistant-message-root"]')
  expect(card.closest('[data-slot="aui_assistant-message-root"]')).toBe(roots[roots.length - 1])
})
