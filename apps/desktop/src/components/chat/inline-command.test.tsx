import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { $gateway } from '@/store/gateway'
import { $messages, setActiveSessionId } from '@/store/session'
import { requestForOwnedSession } from '@/store/session-states'

import { InlineCommand, isExecutableFence } from './inline-command'

vi.mock(import('@/store/session-states'), async importOriginal => ({
  ...(await importOriginal()),
  requestForOwnedSession: vi.fn(),
  knownOwnerForSession: () => ({ connectionId: 'local', profile: 'default', mode: 'local' })
}))

vi.mock(import('@/store/connection-registry-state'), async importOriginal => ({
  ...(await importOriginal()),
  registryConnectionKind: () => 'local'
}))

afterEach(() => {
  cleanup()
  $messages.set([])
  setActiveSessionId(null)
  $gateway.set(null)
  vi.clearAllMocks()
})

it('runs on a click, accepts inline input, and continues the agent without printing output', async () => {
  setActiveSessionId('owner-a')
  $messages.set([{ id: 'message-a', role: 'assistant', content: '' }] as never)
  $gateway.set({ request: vi.fn() } as never)

  let onData: (data: string) => void = () => {}

  let onExit: (exit: { code: number }) => void = () => {}

  const terminal = {
    start: vi.fn().mockResolvedValue({ id: 'pty-1' }),
    onData: vi.fn((_id, callback) => {
      onData = callback

      return () => {}
    }),
    onExit: vi.fn((_id, callback) => {
      onExit = callback

      return () => {}
    }),
    attach: vi.fn().mockResolvedValue(true),
    write: vi.fn().mockResolvedValue(true),
    dispose: vi.fn()
  }

  window.hermesDesktop = { ...window.hermesDesktop, terminal } as never
  vi.mocked(requestForOwnedSession).mockResolvedValueOnce({stdout: '/tmp'}).mockResolvedValue({ status: 'started' })
  render(<InlineCommand command="read answer; echo done" owner={{ sessionId: 'owner-a', messageId: 'message-a' }} />)
  expect(terminal.start).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Run command' }))
  await waitFor(() => expect(terminal.attach).toHaveBeenCalledWith('pty-1'))
  const { act } = await import('@testing-library/react')
  act(() => onData('Password: '))
  expect(screen.getByLabelText('Input').getAttribute('type')).toBe('password')
  fireEvent.change(screen.getByLabelText('Input'), { target: { value: 'secret' } })
  fireEvent.submit(screen.getByLabelText('Input').closest('form')!)
  expect(terminal.write).toHaveBeenCalledWith('pty-1', 'secret\r')
  act(() => {
    onData('hidden result')
    onExit({ code: 0 })
  })
  await waitFor(() =>
    expect(requestForOwnedSession).toHaveBeenCalledWith(
      'owner-a',
      expect.any(Function),
      'prompt.submit',
      expect.objectContaining({
        session_id: 'owner-a',
        display_kind: 'hidden',
        queued: true,
        text: expect.stringContaining('hidden result')
      })
    )
  )
  expect(screen.queryByText('hidden result')).toBeNull()
  expect(screen.queryByLabelText('Input')).toBeNull()
})

it('offers execution only for command fences', () => {
  for (const language of ['bash', 'sh', 'zsh', 'console']) {
    expect(isExecutableFence(language)).toBe(true)
  }

  for (const language of ['python', 'json', 'html', undefined]) {
    expect(isExecutableFence(language)).toBe(false)
  }
})

it('offers Run on a completed assistant shell fence through the real Markdown pipeline', async () => {
  const { stubThreadEnvironment, ThreadRuntime } = await import('@/components/assistant-ui/test-utils')
  const { Thread } = await import('@/components/assistant-ui/thread')
  const { toChatMessages } = await import('@/lib/chat-messages')
  const { toRuntimeMessage } = await import('@/lib/chat-runtime')
  stubThreadEnvironment()
  setActiveSessionId('owner-a')

  const messages = toChatMessages([
    { role: 'assistant', content: 'Run this:\n\n```bash\nprintf ok\n```', timestamp: 1 }
  ])

  $messages.set(messages)
  render(
    <ThreadRuntime messages={messages.map(toRuntimeMessage)}>
      <Thread />
    </ThreadRuntime>
  )
  expect(await screen.findByRole('button', { name: 'Run command' })).toBeTruthy()
})
