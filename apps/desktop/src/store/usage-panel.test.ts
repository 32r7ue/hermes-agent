import { afterEach, expect, it, vi } from 'vitest'

import { $usagePanel, closeUsagePanel, openUsagePanel } from './usage-panel'

afterEach(closeUsagePanel)

it('reads provider limits and session counters through the captured session request', async () => {
  const request = vi.fn(async (method: string) =>
    method === 'session.stats'
      ? { input_tokens: 5, output_tokens: 12, api_calls: 2 }
      : { providers: [{ slug: 'codex', name: 'Codex', usage: { windows: [{ label: 'Weekly', used_percent: 95 }] } }] }
  )

  await openUsagePanel('owner-session', request as never)
  expect(request).toHaveBeenCalledWith('session.stats', { session_id: 'owner-session' })
  expect(request).toHaveBeenCalledWith('model.options', {
    session_id: 'owner-session',
    explicit_only: true,
    refresh: true
  })
  expect($usagePanel.get()).toMatchObject({ loading: false, usage: { output: 12 }, providers: [{ slug: 'codex' }] })
})

it('does not reopen a dismissed card after a delayed response', async () => {
  let finish!: (value: unknown) => void

  const response = new Promise(resolve => {
    finish = resolve
  })

  const pending = openUsagePanel('old', (() => response) as never)
  closeUsagePanel()
  finish({ providers: [] })
  await pending
  expect($usagePanel.get()).toBeNull()
})

it('uses the embedded usage RPC only when the canonical stats method is missing', async () => {
  const request = vi.fn(async (method: string) => {
    if (method === 'session.stats') {throw new Error('unknown method: session.stats')}

    return method === 'session.usage' ? { input: 8, output: 13 } : { providers: [] }
  })

  await openUsagePanel('legacy', request as never)
  expect($usagePanel.get()?.usage).toEqual({ input: 8, output: 13 })
  expect($usagePanel.get()?.error).toBeNull()
})
