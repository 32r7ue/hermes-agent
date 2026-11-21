import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { $gateway } from '@/store/gateway'
import { $messages, setActiveSessionId } from '@/store/session'
import { requestForOwnedSession } from '@/store/session-states'

import { InlineCommand, isExecutableFence, submitCommandResult, terminalQuestion, yesNoDefault } from './inline-command'

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
  vi.mocked(requestForOwnedSession).mockResolvedValueOnce({ stdout: '/tmp' }).mockResolvedValue({ status: 'started' })
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

it('answers a y/N terminal question with Yes/No buttons, the default one filled', async () => {
  setActiveSessionId('owner-a')
  $messages.set([{ id: 'message-a', role: 'assistant', content: '' }] as never)
  $gateway.set({ request: vi.fn() } as never)

  let onData: (data: string) => void = () => {}

  const terminal = {
    start: vi.fn().mockResolvedValue({ id: 'pty-1' }),
    onData: vi.fn((_id, callback) => {
      onData = callback

      return () => {}
    }),
    onExit: vi.fn(() => () => {}),
    attach: vi.fn().mockResolvedValue(true),
    write: vi.fn().mockResolvedValue(true),
    dispose: vi.fn()
  }

  window.hermesDesktop = { ...window.hermesDesktop, terminal } as never
  vi.mocked(requestForOwnedSession).mockResolvedValueOnce({ stdout: '/tmp' }).mockResolvedValue({ status: 'started' })
  render(<InlineCommand command="hermes gateway restart" owner={{ sessionId: 'owner-a', messageId: 'message-a' }} />)
  fireEvent.click(screen.getByRole('button', { name: 'Run command' }))
  await waitFor(() => expect(terminal.attach).toHaveBeenCalledWith('pty-1'))
  const { act } = await import('@testing-library/react')
  act(() => onData('Interrupt them and restart the gateway? (y/N): '))
  // No text field for a yes/no question; the marker is dropped from the visible prompt.
  expect(screen.queryByLabelText('Input')).toBeNull()
  expect(screen.getByText('Interrupt them and restart the gateway?')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Yes' }))
  expect(terminal.write).toHaveBeenCalledWith('pty-1', 'y\r')
})

it('reads the default answer from the capitalised letter', () => {
  expect(yesNoDefault('Continue? (y/N): ')).toBe('n')
  expect(yesNoDefault('Continue? [Y/n] ')).toBe('y')
  expect(yesNoDefault('Overwrite? yes/no ')).toBe('y')
  expect(yesNoDefault('Password: ')).toBeNull()
})

it('treats a foreground server\'s stop hint as output, not a question', () => {
  expect(terminalQuestion('│  Press Ctrl+C to stop                                   │')).toBeNull()
  expect(terminalQuestion('Press CTRL-C to quit')).toBeNull()
  expect(terminalQuestion('Serving on :8000 (^C to exit):')).toBeNull()
  expect(terminalQuestion('Password: ')).toBe('Password:')
  expect(terminalQuestion('Press Enter to continue')).toBe('Press Enter to continue')
  expect(terminalQuestion('Interrupt them and restart the gateway? (y/N): ')).toBe(
    'Interrupt them and restart the gateway? (y/N):'
  )
  expect(terminalQuestion('Build complete.')).toBeNull()
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

it('waits out a gateway restart the command caused and submits the result once', async () => {
  const notConnected = new Error('Hermes gateway is not connected')
  $gateway.set({ request: vi.fn() } as never)
  vi.mocked(requestForOwnedSession)
    .mockRejectedValueOnce(notConnected)
    .mockRejectedValueOnce(notConnected)
    .mockResolvedValueOnce({ status: 'queued' })

  const params = { session_id: 'owner-a', submission_id: 'sub-1', text: 'result' }

  await expect(
    submitCommandResult({ fallbackGateway: { request: vi.fn() } as never, ownerSessionId: 'owner-a', params, retryMs: 1 })
  ).resolves.toEqual({ status: 'queued' })

  const calls = vi.mocked(requestForOwnedSession).mock.calls
  expect(calls).toHaveLength(3)
  expect(calls.every(call => call[2] === 'prompt.submit' && (call[3] as typeof params).submission_id === 'sub-1')).toBe(
    true
  )
})

it('resumes a session the restart dropped, then submits to it', async () => {
  $gateway.set({ request: vi.fn() } as never)
  vi.mocked(requestForOwnedSession)
    .mockRejectedValueOnce(new Error('Hermes gateway is not connected'))
    .mockRejectedValueOnce(new Error('session not found'))
    .mockResolvedValueOnce({ session_id: 'runtime-b' })
    .mockResolvedValueOnce({ status: 'queued' })

  await submitCommandResult({
    fallbackGateway: { request: vi.fn() } as never,
    ownerSessionId: 'owner-a',
    params: { session_id: 'runtime-a', submission_id: 'sub-1' },
    retryMs: 1
  })

  const calls = vi.mocked(requestForOwnedSession).mock.calls
  expect(calls[2][2]).toBe('session.resume')
  expect(calls[3][2]).toBe('prompt.submit')
  expect((calls[3][3] as { session_id: string }).session_id).toBe('runtime-b')
})

it('reports an error that has nothing to do with the restart right away', async () => {
  $gateway.set({ request: vi.fn() } as never)
  vi.mocked(requestForOwnedSession).mockRejectedValueOnce(new Error('bad request'))

  await expect(
    submitCommandResult({
      fallbackGateway: { request: vi.fn() } as never,
      ownerSessionId: 'owner-a',
      params: { session_id: 'owner-a' },
      retryMs: 1
    })
  ).rejects.toThrow('bad request')
  expect(requestForOwnedSession).toHaveBeenCalledTimes(1)
})
