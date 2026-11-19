import { useEffect, useState } from 'react'

import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  dropdownMenuRow,
  dropdownMenuSectionLabel,
  DropdownMenuSeparator
} from '@/components/ui/dropdown-menu'
import { ejectLocalModel, getLocalModelsStatus, loadLocalModel, setLocalPromptMode } from '@/hermes'
import { useI18n } from '@/i18n'
import { notifyError } from '@/store/notifications'
import type { LocalModelsStatus, LocalPromptMode } from '@/types/hermes'

export const LOCAL_PROVIDER_SLUG = 'llamacpp'

const MODES: readonly LocalPromptMode[] = ['chat', 'edit', 'full']
const POLL_MS = 1500

/** Managed llama.cpp model: residency (loaded / loading / not) with load + unload, and the
 *  prompt mode Hermes uses for local models. Polls status only while the menu is open. */
export function LocalModelOptions({ model }: { model: string }) {
  const { t } = useI18n()
  const copy = t.shell.modelOptions
  const [status, setStatus] = useState<LocalModelsStatus | null>(null)

  useEffect(() => {
    let alive = true

    const read = () =>
      getLocalModelsStatus()
        .then(next => alive && setStatus(next))
        .catch(() => undefined)

    void read()
    const timer = window.setInterval(read, POLL_MS)

    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [])

  const residency = status?.loaded_models[model]
  const progress = status?.loading?.[model]
  const loaded = residency === 'loaded' || residency === 'ready'
  const loading = residency === 'loading' || Boolean(progress)
  const mode = status?.prompt_mode ?? 'chat'

  const stateLabel = loaded
    ? copy.localLoaded
    : loading
      ? progress?.percent != null
        ? `${copy.localLoading.replace('…', '')} ${Math.round(progress.percent)}%`
        : copy.localLoading
      : copy.localNotLoaded

  const run = (action: () => Promise<unknown>) =>
    void action()
      .then(() => getLocalModelsStatus().then(setStatus))
      .catch(error => notifyError(error, copy.localFailed))

  const modeLabel: Record<LocalPromptMode, string> = {
    chat: copy.localModeChat,
    edit: copy.localModeEdit,
    full: copy.localModeFull
  }

  return (
    <>
      <DropdownMenuSeparator className="mx-0" />
      <DropdownMenuLabel className={dropdownMenuSectionLabel} data-slot="local-model-options">
        {copy.localModel}
        <span
          className="ml-auto flex items-center gap-1.5 font-normal normal-case text-(--ui-text-tertiary)"
          data-slot="local-model-residency"
        >
          <span
            className={
              loaded
                ? 'size-1.5 rounded-full bg-emerald-500'
                : loading
                  ? 'size-1.5 animate-pulse rounded-full bg-amber-500'
                  : 'size-1.5 rounded-full bg-(--ui-text-tertiary) opacity-50'
            }
          />
          {status ? stateLabel : ''}
        </span>
      </DropdownMenuLabel>
      {status && !loading ? (
        <DropdownMenuItem
          className={dropdownMenuRow}
          onSelect={event => {
            event.preventDefault()
            run(() => (loaded ? ejectLocalModel(model) : loadLocalModel(model)))
          }}
        >
          {loaded ? copy.localUnload : copy.localLoad}
        </DropdownMenuItem>
      ) : null}
      <DropdownMenuSeparator className="mx-0" />
      <DropdownMenuLabel className={dropdownMenuSectionLabel} title={copy.localModeHint}>
        {copy.localMode}
      </DropdownMenuLabel>
      <DropdownMenuRadioGroup
        onValueChange={value => {
          setStatus(prev => (prev ? { ...prev, prompt_mode: value as LocalPromptMode } : prev))
          run(() => setLocalPromptMode(value as LocalPromptMode))
        }}
        value={mode}
      >
        {MODES.map(value => (
          <DropdownMenuRadioItem
            className={dropdownMenuRow}
            key={value}
            onSelect={event => event.preventDefault()}
            value={value}
          >
            {modeLabel[value]}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
      <div className="px-2.5 pt-0.5 pb-2 text-[0.6875rem] text-(--ui-text-tertiary)">{copy.localModeHint}</div>
    </>
  )
}
