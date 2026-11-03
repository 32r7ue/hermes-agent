import type { ThreadMessage } from '@assistant-ui/react'
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { toChatMessages } from '@/lib/chat-messages'
import { toRuntimeMessage } from '@/lib/chat-runtime'
import type { SessionMessage } from '@/types/hermes'

import { stubThreadEnvironment, ThreadRuntime } from '../test-utils'

import { Thread } from '.'

beforeEach(stubThreadEnvironment)
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

it('keeps background continuations in one response with one action bar and the original message identities', async () => {
  const content = '[IMPORTANT: Background process proc_example completed normally (exit code 0).\nOutput:\nVerified.]'
  const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) }
  vi.stubGlobal('navigator', { ...navigator, clipboard })
  const branch = vi.fn()

  for (const display of [
    {},
    { display_kind: 'process_complete', display_metadata: { display_text: 'Background Process Finished: verify' } },
    { display_kind: 'async_delegation_complete', display_metadata: { display_text: 'Background agent finished' } }
  ]) {
    const stored = [
      { role: 'user', content: 'Verify it.', timestamp: 1 },
      { role: 'assistant', content: 'Checking the deployment.', timestamp: 2 },
      { role: 'user', content, timestamp: 3, ...display },
      { role: 'assistant', content: 'The deployment is verified.', timestamp: 4 }
    ] as SessionMessage[]

    const messages = toChatMessages(stored).map(toRuntimeMessage)

    const { container, rerender, unmount } = render(
      <ThreadRuntime messages={messages.slice(0, 2)}>
        <Thread onBranchInNewChat={branch} />
      </ThreadRuntime>
    )

    const original = container.querySelector('[data-role="assistant"]')

    rerender(
      <ThreadRuntime messages={messages}>
        <Thread onBranchInNewChat={branch} />
      </ThreadRuntime>
    )
    await waitFor(() => expect(container.textContent).toContain('The deployment is verified.'))
    expect(container.querySelectorAll('[data-slot="aui_turn-pair"]')).toHaveLength(1)
    expect(container.querySelectorAll('[data-slot="aui_response-group"]')).toHaveLength(1)
    expect(container.querySelectorAll('[data-slot="aui_msg-actions"]')).toHaveLength(1)
    expect(container.querySelector('[data-role="assistant"]')).toBe(original)
    expect(
      [...container.querySelectorAll('[data-role="assistant"]')].map(e => e.getAttribute('data-message-id'))
    ).toEqual([messages[1]!.id, messages[3]!.id])
    const actions = container.querySelector('[data-slot="aui_msg-actions"]') as HTMLElement
    // Default Copy reads only the tail reply; the full-response scope is a
    // separate explicit action (#118864).
    fireEvent.click(within(actions).getByRole('button', { name: /^copy$/i }))
    await waitFor(() => expect(clipboard.writeText).toHaveBeenLastCalledWith('The deployment is verified.'))
    fireEvent.click(within(actions).getByRole('button', { name: /copy full response/i }))
    await waitFor(() =>
      expect(clipboard.writeText).toHaveBeenLastCalledWith('Checking the deployment.\n\nThe deployment is verified.')
    )
    fireEvent.click(within(actions).getByRole('button', { name: /branch/i }))
    expect(branch).toHaveBeenLastCalledWith(messages[3]!.id)

    const pending: ThreadMessage[] = [
      ...messages,
      { ...messages[3]!, role: 'assistant', id: 'next', content: [], status: { type: 'running' } } as ThreadMessage
    ]

    rerender(
      <ThreadRuntime messages={pending}>
        <Thread onBranchInNewChat={branch} />
      </ThreadRuntime>
    )
    await waitFor(() => expect(container.querySelectorAll('[data-role="assistant"]')).toHaveLength(3))
    expect(container.querySelectorAll('[data-slot="aui_msg-actions"]')).toHaveLength(1)

    unmount()

    const reloaded = render(
      <ThreadRuntime messages={messages}>
        <Thread />
      </ThreadRuntime>
    )

    expect(reloaded.container.querySelectorAll('[data-slot="aui_msg-actions"]')).toHaveLength(1)
    reloaded.unmount()
  }
})

it('ends the response at a real user prompt or unrelated system event', () => {
  const messages = toChatMessages([
    { role: 'user', content: 'First question', timestamp: 1 },
    { role: 'assistant', content: 'First answer', timestamp: 2 },
    { role: 'system', content: 'slash:/model\nmodel changed', timestamp: 3 },
    { role: 'assistant', content: 'Separate answer', timestamp: 4 },
    { role: 'user', content: 'Second question', timestamp: 5 },
    { role: 'assistant', content: 'Second answer', timestamp: 6 }
  ]).map(toRuntimeMessage)

  const { container } = render(
    <ThreadRuntime messages={messages}>
      <Thread />
    </ThreadRuntime>
  )

  expect(container.querySelectorAll('[data-slot="aui_turn-pair"]')).toHaveLength(2)
  expect(container.querySelectorAll('[data-slot="aui_msg-actions"]')).toHaveLength(3)
})

it('collapses a hydrated tool turn to one work disclosure and keeps its final answer visible', async () => {
  const messages = toChatMessages([
    { role: 'user', content: 'Check the project', timestamp: 1 },
    { role: 'assistant', content: 'Checking the files.', timestamp: 2, tool_calls: [{ id: 'cmd', type: 'function', function: { name: 'terminal', arguments: '{"command":"pwd"}' } }] },
    { role: 'tool', tool_call_id: 'cmd', content: '{"output":"project","exit_code":0}', timestamp: 3 },
    { role: 'assistant', content: 'Everything is ready.', timestamp: 4 }
  ] as SessionMessage[]).map(toRuntimeMessage)

  const { container } = render(<ThreadRuntime messages={messages}><Thread /></ThreadRuntime>)
  expect(within(container).getAllByRole('button', { name: 'Work details' })).toHaveLength(1)
  const parts = container.querySelector('[data-slot="aui_message-parts"]')!
  expect(parts.hasAttribute('data-activity-collapsed')).toBe(true)
  expect(parts.querySelector('[data-response-final]')?.textContent).toBe('Everything is ready.')
  fireEvent.click(within(container).getByRole('button', { name: 'Work details' }))
  expect(parts.hasAttribute('data-activity-collapsed')).toBe(false)
})
