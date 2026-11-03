import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'

import { $usagePanel, closeUsagePanel } from '@/store/usage-panel'

import { UsagePanel } from './usage-panel'

afterEach(() => { cleanup(); closeUsagePanel() })

it('shows provider windows separately for each account and keeps unknown limits empty', () => {
  $usagePanel.set({ sessionId: 's', loading: false, error: null, usage: { input: 10, output: 25 }, providers: [
    { slug: 'codex', name: 'Codex', usage: { accounts: [
      { id: 'one', label: 'Personal', state: 'ready', windows: [{ label: 'Weekly', used_percent: 95, resets_at: '2026-11-06T15:13:00Z' }] },
      { id: 'two', label: 'Second', state: 'ready', windows: [{ label: 'Weekly', used_percent: 20 }] },
      { id: 'three', label: 'Unknown account', state: 'unknown', windows: [] }
    ] } },
    { slug: 'api', name: 'API provider' }
  ] })
  render(<UsagePanel />)
  expect(screen.getAllByRole('progressbar').map(bar => bar.getAttribute('aria-valuenow'))).toEqual(['95', '20'])
  expect(screen.getByText('Personal')).toBeTruthy()
  expect(screen.getByText('API provider')).toBeTruthy()
  expect(screen.getByText('This provider does not report account limits.')).toBeTruthy()
  expect(screen.getByText('This session')).toBeTruthy()
})
