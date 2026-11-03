import { type ModelOptionProvider, type ModelOptionsResult, usageFromTick, type UsageTickPayload } from '@hermes/shared'
import { atom } from 'nanostores'

import { isMissingRpcMethod } from '@/lib/gateway-rpc'
import type { UsageStats } from '@/types/hermes'

interface UsagePanelState {
  sessionId: string
  loading: boolean
  providers: ModelOptionProvider[]
  usage: Partial<UsageStats> | null
  error: string | null
}

export const $usagePanel = atom<UsagePanelState | null>(null)
export const closeUsagePanel = () => $usagePanel.set(null)

async function readSessionUsage(
  sessionId: string,
  request: <T>(method: string, params: Record<string, unknown>) => Promise<T>
): Promise<Partial<UsageStats>> {
  try {
    const stats = await request<UsageTickPayload>('session.stats', { session_id: sessionId })
    const usage = usageFromTick<Partial<UsageStats>>(stats)

    return { input: usage?.input, output: usage?.output, calls: usage?.calls, total: usage?.total }
  } catch (error) {
    if (!isMissingRpcMethod(error)) {throw error}

    return request<Partial<UsageStats>>('session.usage', { session_id: sessionId })
  }
}

/** The caller captures the session's owning gateway before opening the card. */
export async function openUsagePanel(
  sessionId: string,
  request: <T>(method: string, params: Record<string, unknown>) => Promise<T>
) {
  const pending: UsagePanelState = { sessionId, loading: true, providers: [], usage: null, error: null }
  $usagePanel.set(pending)

  const [session, models] = await Promise.allSettled([
    readSessionUsage(sessionId, request),
    request<ModelOptionsResult>('model.options', { session_id: sessionId, explicit_only: true, refresh: true })
  ])

  if ($usagePanel.get() !== pending) {
    return
  }

  const failures = [session, models].filter(result => result.status === 'rejected') as PromiseRejectedResult[]
  $usagePanel.set({
    ...pending,
    loading: false,
    usage: session.status === 'fulfilled' ? session.value : null,
    providers: models.status === 'fulfilled' ? (models.value.providers ?? []) : [],
    error: failures.length
      ? failures
          .map(result => (result.reason instanceof Error ? result.reason.message : String(result.reason)))
          .join('\n')
      : null
  })
}
