import type { ModelOptionProvider, ModelOptionsResult } from '@hermes/shared'
import { useQuery } from '@tanstack/react-query'

import { providerUsageSections, UsageBar } from '@/app/shell/usage-panel'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useI18n } from '@/i18n'
import { findCatalogProvider } from '@/lib/model-options'
import { requestForOwnedSession } from '@/store/session-states'

// The 5-hour window: Codex labels it "Session", Anthropic "Current session" (agent/account_usage.py).
const FIVE_HOUR_WINDOW = /\bsession\b/i

/** The ring is the 5h limit when the provider reports one, else the fullest window.
 *  Never combine different credential accounts into an invented quota. */
export function providerRingPercent(provider: ModelOptionProvider | undefined): number | null {
  if (!provider) {return null}
  const sections = providerUsageSections(provider)

  if (sections.length !== 1) {return null}
  const windows = sections[0]!.windows.filter(window => Number.isFinite(window.percent))
  const fiveHour = windows.find(window => FIVE_HOUR_WINDOW.test(window.label))
  const values = (fiveHour ? [fiveHour] : windows).map(window => window.percent)

  return values.length ? Math.max(0, Math.min(100, Math.max(...values))) : null
}

interface ProviderUsageIndicatorProps {
  sessionId: string | null
  provider: string
  request: <T>(method: string, params?: Record<string, unknown>) => Promise<T>
}

export function ProviderUsageIndicator({ sessionId, provider, request }: ProviderUsageIndicatorProps) {
  const { t } = useI18n()
  const copy = t.conversationUi

  const query = useQuery({
    queryKey: ['provider-usage', sessionId, provider],
    // No session yet (a fresh draft): ask the gateway directly. The provider
    // picked in the composer selects the row below.
    queryFn: () => sessionId
      ? requestForOwnedSession<ModelOptionsResult>(sessionId, request, 'model.options', {
        session_id: sessionId, explicit_only: true, refresh: true
      })
      : request<ModelOptionsResult>('model.options', { explicit_only: true, refresh: true }),
    staleTime: 60_000,
    refetchInterval: 60_000,
    retry: false
  })

  const current = findCatalogProvider(query.data?.providers ?? [], provider)
    ?? query.data?.providers?.find(row => row.is_current)

  const percent = providerRingPercent(current)
  const color = percent === null ? 'var(--ui-text-tertiary)' : percent >= 95 ? 'var(--ui-red)' : 'var(--ui-blue)'

  return (
    <Popover onOpenChange={open => {if (open) {void query.refetch()}}}>
      <PopoverTrigger asChild>
        <button
          aria-label={`${copy.usage}${current ? ` · ${current.name}` : ''}${percent === null ? '' : ` · ${Math.round(percent)}%`}`}
          className="grid h-full w-7 place-items-center rounded-sm hover:bg-accent"
          type="button"
        >
          <svg aria-hidden height="15" viewBox="0 0 20 20" width="15">
            <circle cx="10" cy="10" fill="none" r="7" stroke="var(--ui-stroke-secondary)" strokeWidth="3" />
            <circle cx="10" cy="10" fill="none" pathLength="100" r="7" stroke={color}
              strokeDasharray={`${percent ?? 0} 100`} strokeLinecap="round" strokeWidth="3" transform="rotate(-90 10 10)" />
            {percent === null && <text fill={color} fontSize="9" textAnchor="middle" x="10" y="13">?</text>}
          </svg>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-88 max-w-[calc(100vw-2rem)] bg-(--ui-bg-elevated) p-4" side="top">
        <div className="grid gap-4" data-slot="provider-usage-popover">
          <h3 className="text-sm font-medium">{copy.usage}{current ? ` · ${current.name}` : ''}</h3>
          {query.isPending ? <p className="text-xs text-muted-foreground">{t.skills.loading}</p>
            : query.error ? <p className="text-xs text-(--ui-red)" role="alert">{copy.loadError}: {query.error.message}</p>
              : !current ? <p className="text-xs text-muted-foreground">{copy.noQuota}</p>
                : providerUsageSections(current).map((section, index) => (
                  <section className="grid gap-3" key={section.id}>
                    {section.label !== current.name && <p className="text-xs text-muted-foreground">{section.label || t.shell.modelMenu.poolAccount(index + 1)}</p>}
                    {section.windows.length ? section.windows.map((window, i) => <UsageBar {...window} key={`${window.label}:${i}`} />)
                      : <p className="text-xs text-muted-foreground">{section.state === 'unavailable' ? t.shell.modelMenu.poolUnavailable : section.state === 'unknown' ? t.shell.modelMenu.poolUnknown : copy.noQuota}</p>}
                  </section>
                ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
