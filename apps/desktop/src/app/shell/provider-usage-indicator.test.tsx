import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { requestForOwnedSession } from '@/store/session-states'

import { providerRingPercent, ProviderUsageIndicator } from './provider-usage-indicator'

vi.mock(import('@/store/session-states'), async importOriginal => ({
  ...await importOriginal(), requestForOwnedSession: vi.fn()
}))
afterEach(() => {cleanup(); vi.clearAllMocks()})

it('keeps different accounts separate and never turns unknown into zero percent', () => {
  expect(providerRingPercent({ name: 'Provider', slug: 'test' })).toBeNull()
  expect(providerRingPercent({ name: 'Provider', slug: 'test', usage: { accounts: [
    { id: 'a', state: 'ready', windows: [{ label: 'Weekly', used_percent: 90 }] },
    { id: 'b', state: 'ready', windows: [{ label: 'Weekly', used_percent: 20 }] }
  ] } })).toBeNull()
  expect(providerRingPercent({ name: 'Provider', slug: 'test', usage: { windows: [{ label: 'Weekly', used_percent: 95 }] } })).toBe(95)
})

it('shows the 5-hour window, not the fullest one', () => {
  expect(providerRingPercent({ name: 'Claude', slug: 'anthropic', usage: { windows: [
    { label: 'Current session', used_percent: 30 }, { label: 'Current week', used_percent: 80 }
  ] } })).toBe(30)
})

it('loads the focused provider through its owner and opens a compact limit view', async () => {
  vi.mocked(requestForOwnedSession).mockResolvedValue({ providers: [{ slug: 'codex', name: 'Codex', usage: {
    windows: [{ label: 'Weekly limit', used_percent: 95 }]
  } }] })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}><ProviderUsageIndicator provider="codex" request={vi.fn()} sessionId="owned" /></QueryClientProvider>)
  const button = await screen.findByRole('button', { name: 'Usage · Codex · 95%' })
  expect(requestForOwnedSession).toHaveBeenCalledWith('owned', expect.any(Function), 'model.options', {
    session_id: 'owned', explicit_only: true, refresh: true
  })
  fireEvent.click(button)
  await waitFor(() => expect(screen.getByRole('progressbar', { name: 'Weekly limit' }).getAttribute('aria-valuenow')).toBe('95'))
  client.clear()
})
