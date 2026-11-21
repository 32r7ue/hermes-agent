import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { requestComposerSubmit } from '@/app/chat/composer/focus'
import { registry } from '@/contrib/registry'
import { TRANSCRIPT_DIRECTIVE_AREA, type TranscriptDirectiveContribution } from '@/lib/transcript-directives'
import { $gateway } from '@/store/gateway'
import { $messages, setActiveSessionId } from '@/store/session'
import { requestForOwnedSession } from '@/store/session-states'

import { NextStepAsk } from './next-step-ask'

vi.mock(import('@/store/session-states'), async importOriginal => ({
  ...(await importOriginal()),
  requestForOwnedSession: vi.fn(),
  knownOwnerForSession: () => ({ connectionId: 'local', profile: 'default', mode: 'local' })
}))

vi.mock(import('@/store/connection-registry-state'), async importOriginal => ({
  ...(await importOriginal()),
  registryConnectionKind: () => 'local'
}))

vi.mock(import('@/app/chat/composer/focus'), async importOriginal => ({
  ...(await importOriginal()),
  requestComposerSubmit: vi.fn(() => true)
}))

afterEach(() => {
  cleanup()
  $messages.set([])
  setActiveSessionId(null)
  $gateway.set(null)
  vi.clearAllMocks()
})

function fakeTerminal() {
  const handlers = { data: (_: string) => {}, exit: (_: { code: number }) => {} }

  const terminal = {
    start: vi.fn().mockResolvedValue({ id: 'pty-1' }),
    onData: vi.fn((_id, callback) => {
      handlers.data = callback

      return () => {}
    }),
    onExit: vi.fn((_id, callback) => {
      handlers.exit = callback

      return () => {}
    }),
    attach: vi.fn().mockResolvedValue(true),
    write: vi.fn().mockResolvedValue(true),
    dispose: vi.fn()
  }

  window.hermesDesktop = { ...window.hermesDesktop, terminal } as never

  return { handlers, terminal }
}

async function renderAsk(directive: string) {
  const { stubThreadEnvironment, ThreadRuntime } = await import('@/components/assistant-ui/test-utils')
  const { Thread } = await import('@/components/assistant-ui/thread')
  const { toChatMessages } = await import('@/lib/chat-messages')
  const { toRuntimeMessage } = await import('@/lib/chat-runtime')
  stubThreadEnvironment()
  setActiveSessionId('owner-a')
  $gateway.set({ request: vi.fn() } as never)

  const dispose = registry.register({
    id: 'test:ask',
    area: TRANSCRIPT_DIRECTIVE_AREA,
    data: {
      name: 'ask',
      render: ({ attrs, streaming }) => <NextStepAsk attrs={attrs} streaming={streaming} />
    } satisfies TranscriptDirectiveContribution
  })

  const messages = toChatMessages([{ role: 'assistant', content: `Config is updated.\n${directive}`, timestamp: 1 }])
  $messages.set(messages)
  render(
    <ThreadRuntime messages={messages.map(toRuntimeMessage)}>
      <Thread />
    </ThreadRuntime>
  )

  return dispose
}

it('without cmd, the action is sent as the next message', async () => {
  const dispose = await renderAsk('::ask{q="Commit both changes?" action="Commit"}')

  try {
    fireEvent.click(await screen.findByRole('button', { name: /Commit/ }))
    expect(requestComposerSubmit).toHaveBeenCalledWith('Commit', expect.anything())
  } finally {
    dispose()
  }
})

it('with cmd, looks the same, runs the command once, and resumes the agent only after it exits', async () => {
  const { handlers, terminal } = fakeTerminal()
  vi.mocked(requestForOwnedSession).mockResolvedValueOnce({ stdout: '/tmp' }).mockResolvedValue({ status: 'started' })
  const dispose = await renderAsk('::ask{q="Restart the gateway?" action="Restart" cmd="hermes gateway restart"}')

  try {
    const button = await screen.findByRole('button', { name: /Restart/ })
    // Nothing about the command is shown.
    expect(screen.queryByText(/hermes gateway restart/)).toBeNull()
    expect(screen.getByText('Restart the gateway?')).toBeTruthy()

    fireEvent.click(button)
    await waitFor(() => expect(terminal.attach).toHaveBeenCalledWith('pty-1'))
    expect(terminal.start).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'hermes gateway restart', cwd: '/tmp' })
    )

    // Running: inert and spinning; a second press does not fire again, and no turn has started yet.
    expect((button as HTMLButtonElement).disabled).toBe(true)
    expect(button.getAttribute('aria-busy')).toBe('true')
    fireEvent.click(button)
    expect(terminal.start).toHaveBeenCalledTimes(1)
    expect(requestComposerSubmit).not.toHaveBeenCalled()
    expect(requestForOwnedSession).not.toHaveBeenCalledWith(
      'owner-a',
      expect.anything(),
      'prompt.submit',
      expect.anything()
    )

    act(() => {
      handlers.data('gateway restarted\n')
      handlers.exit({ code: 0 })
    })

    await waitFor(() =>
      expect(requestForOwnedSession).toHaveBeenCalledWith(
        'owner-a',
        expect.any(Function),
        'prompt.submit',
        expect.objectContaining({ display_kind: 'hidden', queued: true, text: expect.stringMatching(/^Restart\n\n/) })
      )
    )

    const submitted = vi.mocked(requestForOwnedSession).mock.calls.find(call => call[2] === 'prompt.submit')![3] as {
      text: string
    }

    expect(submitted.text).toContain('hermes gateway restart')
    expect(submitted.text).toContain('Exit code: 0')
    expect(submitted.text).toContain('gateway restarted')
    expect(requestComposerSubmit).not.toHaveBeenCalled()
  } finally {
    dispose()
  }
})
