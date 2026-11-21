import { codiconIcon } from '@/components/ui/codicon'
import type { Translations } from '@/i18n'
import {
  Archive,
  BarChart3,
  Bell,
  Cpu,
  Globe,
  type IconComponent,
  Info,
  Keyboard,
  KeyRound,
  Network,
  Settings2,
  ShieldLock,
  Wrench,
  Zap
} from '@/lib/icons'

import { SECTIONS } from './constants'
import type { SettingsSearchEntry, SettingsSearchTarget } from './settings-search'
import type { SettingsView } from './types'

/**
 * Every Settings PAGE as a search destination — the top-level nav rows and the
 * sub-views that are not `?page=` sub-pages (Providers' Accounts / API keys /
 * Custom Endpoints / Local Models, Tools & Keys' two lists). ⌘K and the
 * Settings-scoped palette both rank these above individual fields, so typing a
 * page's name (or a word people use for it — "api key", "sound", "theme")
 * jumps to the page.
 *
 * `?page=` sub-pages (Notifications ▸ Sounds, Capabilities ▸ Skills, …) are
 * indexed from the nav's own subpage tables in `use-settings-search`; their
 * synonyms live in `SUBPAGE_KEYWORDS` below.
 */

/** Words people type for a config section that its label does not contain. */
const SECTION_KEYWORDS: Record<string, readonly string[]> = {
  model: [
    'model',
    'llm',
    'default model',
    'fallback',
    'auxiliary',
    'reasoning effort',
    'context length',
    'delegation',
    'subagents'
  ],
  chat: ['personality', 'timezone', 'show reasoning', 'conversation', 'attachments', 'images'],
  appearance: [
    'theme',
    'look',
    'color',
    'colour',
    'dark mode',
    'light mode',
    'font',
    'typography',
    'zoom',
    'scale',
    'layout',
    'display',
    'language',
    'pet',
    'ui'
  ],
  workspace: ['projects', 'folders', 'shell', 'terminal', 'files', 'cwd', 'working directory', 'worktree'],
  safety: ['approvals', 'permissions', 'yolo', 'privacy', 'checkpoints', 'security', 'redaction', 'sandbox'],
  browser: ['chrome', 'chromium', 'web', 'cdp', 'browser profile', 'private urls'],
  memory: ['memories', 'context', 'compression', 'rollover', 'context window', 'honcho', 'mem0'],
  voice: ['speech', 'tts', 'stt', 'microphone', 'mic', 'dictation', 'transcription', 'talk', 'audio'],
  advanced: [
    'runtime',
    'tools',
    'terminal',
    'output',
    'desktop',
    'devtools',
    'quick entry',
    'keep awake',
    'experimental'
  ]
}

/** Synonyms for `?page=` sub-pages, keyed by the subpage's `labelKey`. */
export const SUBPAGE_KEYWORDS: Record<string, readonly string[]> = {
  appearanceTheme: ['theme', 'color', 'colour', 'dark', 'light', 'skin', 'palette'],
  appearanceTypography: ['font', 'text size', 'zoom', 'scale'],
  notificationAlerts: ['notifications', 'alerts', 'banner', 'toast', 'do not disturb'],
  notificationSounds: ['sound', 'sounds', 'audio', 'chime', 'ding', 'mute', 'volume'],
  keyboardShortcuts: ['keybindings', 'hotkeys', 'shortcuts', 'keys'],
  archivedSessions: ['archive', 'archived chats', 'history', 'restore'],
  appUpdates: ['update', 'version', 'release', 'upgrade'],
  capabilitiesSkills: ['skills', 'skill hub', 'catalog', 'install skill', 'capabilities'],
  capabilitiesPlugins: ['plugins', 'extensions', 'add-ons', 'addons', 'install plugin', 'capabilities'],
  capabilitiesConnectors: [
    'connectors',
    'mcp',
    'mcp servers',
    'model context protocol',
    'apps',
    'integrations',
    'accounts',
    'capabilities'
  ],
  capabilitiesToolsets: ['tools', 'toolsets', 'enable tools', 'disable tools', 'capabilities']
}

interface PageDef {
  icon: IconComponent
  id: string
  keywords: readonly string[]
  label: (t: Translations) => string
  /** Sub-view rows (not `?page=` sub-pages) listed under this page. */
  children?: readonly PageDef[]
  target: SettingsSearchTarget
  available?: (options: SettingsPageOptions) => boolean
}

export interface SettingsPageOptions {
  localModelsEnabled: boolean
  webAccessAvailable: boolean
}

const view = (id: SettingsView): SettingsSearchTarget => ({ view: id })

const STANDALONE_PAGES: readonly PageDef[] = [
  {
    icon: Zap,
    id: 'providers',
    keywords: [
      'provider',
      'api key',
      'api keys',
      'accounts',
      'sign in',
      'login',
      'oauth',
      'subscription',
      'openai',
      'anthropic',
      'openrouter',
      'models',
      'llm',
      'custom endpoint',
      'local models'
    ],
    label: t => t.settings.nav.providers,
    target: view('providers'),
    children: [
      {
        icon: codiconIcon('account'),
        id: 'providers:accounts',
        keywords: ['provider accounts', 'sign in', 'login', 'oauth', 'subscription', 'anthropic', 'openai'],
        label: t => t.settings.nav.providerAccounts,
        target: { providerView: 'accounts', view: 'providers' }
      },
      {
        icon: KeyRound,
        id: 'providers:keys',
        keywords: ['providers', 'api key', 'keys', 'secrets', 'tokens', 'egress', 'iron proxy', 'sandbox proxy'],
        label: t => t.settings.nav.providerApiKeys,
        target: { providerView: 'keys', view: 'providers' }
      },
      {
        icon: Globe,
        id: 'providers:custom-endpoints',
        keywords: ['providers', 'base url', 'openai compatible', 'self-hosted', 'proxy', 'vllm', 'lm studio'],
        label: t => t.settings.nav.providerCustomEndpoints,
        target: { providerView: 'custom-endpoints', view: 'providers' }
      },
      {
        available: options => options.localModelsEnabled,
        icon: Cpu,
        id: 'providers:local',
        keywords: ['providers', 'ollama', 'llama.cpp', 'gguf', 'offline', 'on device'],
        label: t => t.settings.nav.providerLocalModels,
        target: { providerView: 'local', view: 'providers' }
      }
    ]
  },
  {
    icon: Globe,
    id: 'gateway',
    keywords: [
      'gateway',
      'connection',
      'connections',
      'remote',
      'ssh',
      'cloud',
      'server',
      'host',
      'devices',
      'add gateway',
      'registry',
      'messaging'
    ],
    label: t => t.settings.nav.gateway,
    target: view('gateway')
  },
  {
    available: options => options.webAccessAvailable,
    icon: Network,
    id: 'web-access',
    keywords: ['webapp', 'web app', 'browser access', 'serve', 'remote access', 'lan', 'tailscale', 'phone'],
    label: t => t.settings.gateway.webAccess.title,
    target: view('web-access')
  },
  {
    icon: ShieldLock,
    id: 'vault',
    keywords: ['vault', 'passwords', 'logins', 'credentials', 'autofill', '1password', 'bitwarden', 'secrets'],
    label: t => t.settings.nav.vault,
    target: view('vault')
  },
  {
    icon: Bell,
    id: 'notifications',
    keywords: ['notification', 'alerts', 'sound', 'sounds', 'audio', 'chime', 'mute', 'banner', 'do not disturb'],
    label: t => t.settings.nav.notifications,
    target: view('notifications')
  },
  {
    icon: BarChart3,
    id: 'billing',
    keywords: ['plan', 'subscription', 'credits', 'payment', 'usage', 'invoice', 'upgrade', 'pricing'],
    label: t => t.settings.nav.billing,
    target: view('billing')
  },
  {
    icon: Keyboard,
    id: 'keybinds',
    keywords: ['keyboard', 'shortcuts', 'hotkeys', 'keybindings', 'bindings', 'keys', 'hud', 'screenshot'],
    label: t => t.settings.nav.keybinds,
    target: view('keybinds')
  },
  {
    icon: KeyRound,
    id: 'keys',
    keywords: ['api key', 'api keys', 'secrets', 'tokens', 'env', 'environment variables', 'credentials', '.env'],
    label: t => t.settings.nav.apiKeys,
    target: view('keys'),
    children: [
      {
        icon: Wrench,
        id: 'keys:tools',
        keywords: ['tool keys', 'api', 'secrets', 'tokens', 'credentials', 'browser', 'search'],
        label: t => t.settings.nav.keysTools,
        target: { keysView: 'tools', view: 'keys' }
      },
      {
        icon: Settings2,
        id: 'keys:settings',
        keywords: ['gateway', 'proxy', 'server', 'webhook', 'env', 'egress proxy', 'iron proxy'],
        label: t => t.settings.nav.keysSettings,
        target: { keysView: 'settings', view: 'keys' }
      }
    ]
  },
  {
    icon: Archive,
    id: 'sessions',
    keywords: ['sessions', 'chats', 'history', 'archived', 'archive', 'default directory', 'archived chats'],
    label: t => t.settings.nav.sessions,
    target: view('sessions')
  },
  {
    icon: codiconIcon('symbol-misc'),
    id: 'capabilities',
    keywords: [
      'skills',
      'tools',
      'toolsets',
      'mcp',
      'connectors',
      'plugins',
      'extensions',
      'integrations',
      'apps',
      'servers'
    ],
    label: t => t.settings.nav.capabilities,
    target: view('capabilities')
  },
  {
    icon: codiconIcon('extensions'),
    id: 'plugins',
    keywords: ['plugin settings', 'plugin options', 'addons', 'add-ons', 'extensions'],
    label: t => t.settings.nav.plugins,
    target: view('plugins')
  },
  {
    icon: Info,
    id: 'about',
    keywords: ['version', 'updates', 'update', 'uninstall', 'release', 'changelog'],
    label: t => t.settings.nav.about,
    target: view('about')
  }
]

const toEntry = (page: PageDef, t: Translations, context: string): SettingsSearchEntry => ({
  context,
  icon: page.icon,
  id: `settings-view:${page.id}`,
  keywords: ['settings', ...page.keywords],
  label: page.label(t),
  target: page.target
})

/** Top-level Settings pages (config sections + standalone views), in nav order. */
export function settingsPageEntries(t: Translations, options: SettingsPageOptions): SettingsSearchEntry[] {
  const settings = t.commandCenter.settings

  const sections = SECTIONS.map(section => ({
    context: settings,
    icon: section.icon,
    id: `settings-view:config:${section.id}`,
    keywords: ['settings', section.label, ...(SECTION_KEYWORDS[section.id] ?? [])],
    label: t.settings.sections[section.id] ?? section.label,
    target: { view: `config:${section.id}` as SettingsView }
  }))

  return [
    ...sections,
    ...STANDALONE_PAGES.filter(page => page.available?.(options) ?? true).map(page => toEntry(page, t, settings))
  ]
}

/** Sub-view rows of the standalone pages (Providers ▸ API keys, …). */
export function settingsSubviewEntries(t: Translations, options: SettingsPageOptions): SettingsSearchEntry[] {
  return STANDALONE_PAGES.filter(page => page.available?.(options) ?? true).flatMap(page =>
    (page.children ?? [])
      .filter(child => child.available?.(options) ?? true)
      .map(child => toEntry(child, t, page.label(t)))
  )
}
