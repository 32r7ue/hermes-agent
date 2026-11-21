import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ClientSessionState } from '@/app/types'
import type { ChatMessage } from '@/lib/chat-messages'
import { $sessionStates } from '@/store/session-states'

import {
  $limitAutoResume,
  armAutoResume,
  autoResumeDelayMs,
  cancelAutoResume,
  recheckAutoResume,
  registerAutoResumeReload
} from './limit-auto-resume'

const SID = 'rt-limit'

const limitCard = (id: string, resetsAt?: number): ChatMessage =>
  ({
    id,
    role: 'assistant',
    parts: [],
    error: 'HTTP 429',
    errorSurface: { code: 'rate_limit', layer: 'provider', retryable: true, ...(resetsAt ? { resetsAt } : {}) }
  }) as ChatMessage

function setSession(patch: Partial<ClientSessionState>) {
  const current = $sessionStates.get()[SID] ?? ({ messages: [], busy: false, awaitingResponse: false, turnLive: false } as unknown as ClientSessionState)
  $sessionStates.set({ ...$sessionStates.get(), [SID]: { ...current, ...patch } })
}

afterEach(() => {
  cancelAutoResume(SID)
  $sessionStates.set({})
  vi.useRealTimers()
})

describe('limit auto-resume', () => {
  it('waits for the stated reset, else backs off 1m, 2m, 5m … 30m', () => {
    const now = 1_000_000_000_000
    expect(autoResumeDelayMs(now / 1000 + 600, 0, now)).toBe(605_000)
    expect(autoResumeDelayMs(undefined, 0, now)).toBe(60_000)
    expect(autoResumeDelayMs(undefined, 2, now)).toBe(300_000)
    expect(autoResumeDelayMs(undefined, 40, now)).toBe(1_800_000)
    // A reset already past: the backoff, not an instant loop.
    expect(autoResumeDelayMs(now / 1000 - 10, 1, now)).toBe(120_000)
  })

  it('re-arms on another limit, stands down on success', () => {
    vi.useFakeTimers()
    setSession({ messages: [limitCard('a')] })
    const reload = vi.fn(() => setSession({ busy: true }))
    const unregister = registerAutoResumeReload(SID, reload)

    armAutoResume(SID, { messageId: 'a' })
    vi.advanceTimersByTime(60_000)
    expect(reload).toHaveBeenCalledTimes(1)
    expect($limitAutoResume.get()[SID]?.phase).toBe('resuming')

    // The re-run hit the limit again: armed on the new card, next backoff step.
    setSession({ busy: false, messages: [limitCard('b')] })
    expect($limitAutoResume.get()[SID]).toMatchObject({ attempt: 1, messageId: 'b', phase: 'waiting' })

    vi.advanceTimersByTime(120_000)
    expect(reload).toHaveBeenCalledTimes(2)

    // This time it worked: a plain reply, no error.
    setSession({ busy: false, messages: [{ id: 'ok', role: 'assistant', parts: [] } as unknown as ChatMessage] })
    expect($limitAutoResume.get()[SID]).toBeUndefined()
    unregister()
  })

  it('stands down when the user sends something while it waits', () => {
    vi.useFakeTimers()
    setSession({ messages: [limitCard('a')] })
    const reload = vi.fn()
    const unregister = registerAutoResumeReload(SID, reload)

    armAutoResume(SID, { messageId: 'a' })
    setSession({ busy: true })
    recheckAutoResume()
    expect($limitAutoResume.get()[SID]).toBeUndefined()

    vi.advanceTimersByTime(3_600_000)
    expect(reload).not.toHaveBeenCalled()
    unregister()
  })
})
