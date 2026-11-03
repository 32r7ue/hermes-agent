import type { ModelOptionProvider } from '@hermes/shared'
import { useStore } from '@nanostores/react'

import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Loader } from '@/components/ui/loader'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import { $usagePanel, closeUsagePanel } from '@/store/usage-panel'

interface UsageWindow {
  label: string
  percent: number
  reset?: string | number | null
}

export function providerUsageSections(
  provider: ModelOptionProvider
): { id: string; label: string; windows: UsageWindow[]; state?: string; reset?: string | null }[] {
  const windowRows = (windows: NonNullable<ModelOptionProvider['usage']>['windows']) =>
    (windows ?? [])
      .filter(window => Number.isFinite(window.used_percent))
      .map(window => ({ label: window.label, percent: window.used_percent, reset: window.resets_at }))

  if (provider.usage?.accounts?.length) {
    return provider.usage.accounts.map(account => ({
      id: account.id,
      label: account.label || '',
      reset: account.resets_at,
      state: account.state,
      windows: windowRows(account.windows)
    }))
  }

  const windows: UsageWindow[] = windowRows(provider.usage?.windows)

  if (!windows.length) {
    for (const gauge of provider.plan_usage?.gauges ?? []) {
      if (Number.isFinite(gauge.left_fraction)) {
        windows.push({
          label: gauge.title || gauge.label,
          percent: (1 - gauge.left_fraction) * 100,
          reset: gauge.resets_at_ms
        })
      }
    }
  }

  return [
    {
      id: provider.slug,
      label: provider.name,
      windows,
      state: provider.limit?.scope === 'account' ? 'limited' : undefined,
      reset: provider.limit?.resets_at
    }
  ]
}

export function UsageBar({ label, percent, reset }: UsageWindow) {
  const { t, locale } = useI18n()
  const value = Math.round(Math.max(0, Math.min(100, percent)))
  const date = reset ? new Date(reset) : null

  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-sm">
        <span>{label}</span>
        <span className="ml-auto text-(--ui-text-secondary)">
          {date && Number.isFinite(date.getTime())
            ? `${t.conversationUi.resets} ${date.toLocaleString(locale, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`
            : ''}
        </span>
        <span className={cn('tabular-nums', value >= 95 && 'text-destructive')}>{value}%</span>
      </div>
      <div
        aria-label={label}
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={value}
        className="h-2 overflow-hidden rounded-full bg-(--ui-bg-tertiary)"
        role="progressbar"
      >
        <div
          className={cn('h-full rounded-full', value >= 95 ? 'bg-destructive' : 'bg-primary')}
          style={{ width: `${value}%` }}
        />
      </div>
    </div>
  )
}

export function UsagePanel() {
  const state = useStore($usagePanel)
  const { t, locale } = useI18n()
  const copy = t.conversationUi
  const usage = state?.usage
  const number = (value: number) => value.toLocaleString(locale)

  return (
    <Dialog
      onOpenChange={open => {
        if (!open) {
          closeUsagePanel()
        }
      }}
      open={!!state}
    >
      <DialogContent aria-describedby={undefined} className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{copy.usage}</DialogTitle>
        </DialogHeader>
        {state?.loading ? (
          <Loader />
        ) : (
          <div className="grid gap-7" data-slot="usage-card">
            {state?.error && (
              <p className="text-sm text-destructive" role="alert">
                {copy.loadError}: {state.error}
              </p>
            )}
            {state?.providers.map(provider => (
              <section className="grid gap-4" key={provider.slug}>
                <h3 className="text-sm font-medium">{provider.name}</h3>
                {providerUsageSections(provider).map((section, index) => (
                  <div className="grid gap-4" key={section.id}>
                    {section.label !== provider.name && (
                      <p className="text-xs text-(--ui-text-secondary)">
                        {section.label || t.shell.modelMenu.poolAccount(index + 1)}
                      </p>
                    )}
                    {section.windows.length ? (
                      section.windows.map((window, i) => <UsageBar key={`${window.label}:${i}`} {...window} />)
                    ) : (
                      <p className="text-sm text-(--ui-text-secondary)">
                        {section.state === 'unavailable'
                          ? t.shell.modelMenu.poolUnavailable
                          : section.state === 'unknown'
                            ? t.shell.modelMenu.poolUnknown
                            : section.state === 'limited'
                              ? t.shell.modelMenu.limited
                              : copy.noQuota}
                      </p>
                    )}
                  </div>
                ))}
              </section>
            ))}
            {usage && (
              <section className="grid gap-3">
                <h3 className="text-sm font-medium">{copy.session}</h3>
                <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm tabular-nums">
                  {(
                    [
                      [copy.input, usage.input],
                      [copy.output, usage.output],
                      [copy.calls, usage.calls],
                      [
                        copy.cost,
                        usage.cost_usd === undefined
                          ? undefined
                          : new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD' }).format(usage.cost_usd)
                      ]
                    ] as const
                  ).map(
                    ([label, value]) =>
                      value !== undefined && (
                        <div className="flex justify-between gap-2" key={label}>
                          <dt className="text-(--ui-text-secondary)">{label}</dt>
                          <dd>{typeof value === 'number' ? number(value) : value}</dd>
                        </div>
                      )
                  )}
                </dl>
              </section>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
