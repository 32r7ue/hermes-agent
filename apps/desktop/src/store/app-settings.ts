/** App-local preferences exposed through the existing session-scoped set_theme bridge. */
import { $backdrop, setBackdrop } from './backdrop'
import { $chatTextScale, CHAT_TEXT_SCALE_PRESETS, setChatTextScale } from './chat-text-scale'
import { $interfaceMode, setInterfaceMode } from './interface-mode'
import { $reasoningCollapsedByDefault, setReasoningCollapsedByDefault } from './reasoning-disclosure'
import { $statusbarVisible } from './statusbar-prefs'
import {
  $translucency, GLASS_MATERIALS, GLASS_SCOPES, setTranslucency, setTranslucencyFade,
  setTranslucencyMaterial, setTranslucencyMode, setTranslucencyScope
} from './translucency'

interface Setting {
  read: () => unknown
  valid: (value: unknown) => boolean
  write: (value: never) => void
}

const boolean = (value: unknown) => typeof value === 'boolean'
const percent = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
const choice = (values: readonly unknown[]) => (value: unknown) => values.includes(value)

const SETTINGS: Record<string, Setting> = {
  backdrop: { read: () => $backdrop.get(), valid: boolean, write: setBackdrop },
  text_scale: { read: () => $chatTextScale.get(), valid: choice(CHAT_TEXT_SCALE_PRESETS), write: setChatTextScale },
  interface_mode: { read: () => $interfaceMode.get(), valid: choice(['simple', 'advanced']), write: setInterfaceMode },
  reasoning_collapsed: { read: () => $reasoningCollapsedByDefault.get(), valid: boolean, write: setReasoningCollapsedByDefault },
  statusbar_visible: { read: () => $statusbarVisible.get(), valid: boolean, write: value => $statusbarVisible.set(value) },
  translucency: { read: () => $translucency.get().intensity, valid: percent, write: setTranslucency },
  translucency_fade: { read: () => $translucency.get().fade, valid: percent, write: setTranslucencyFade },
  translucency_mode: { read: () => $translucency.get().mode, valid: choice(['clear', 'glass']), write: setTranslucencyMode },
  glass_material: { read: () => $translucency.get().material, valid: choice(GLASS_MATERIALS), write: setTranslucencyMaterial },
  glass_scope: { read: () => $translucency.get().scope, valid: choice(GLASS_SCOPES), write: setTranslucencyScope }
}

export function inspectAppSettings(): Record<string, unknown> {
  return Object.fromEntries(Object.entries(SETTINGS).map(([key, setting]) => [key, setting.read()]))
}

/** Validate the entire patch before any setter runs. */
export function validateAppSettings(settings: Record<string, unknown>): string | null {
  for (const [key, value] of Object.entries(settings)) {
    const setting = SETTINGS[key]

    if (!Object.hasOwn(SETTINGS, key) || !setting.valid(value)) {return `Invalid app setting: ${key}`}
  }

  return null
}

export function applyAppSettings(settings: Record<string, unknown>): Record<string, unknown> {
  for (const [key, value] of Object.entries(settings)) {SETTINGS[key]!.write(value as never)}

  return Object.fromEntries(Object.keys(settings).map(key => [key, SETTINGS[key]!.read()]))
}
