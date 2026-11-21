import { useStore } from '@nanostores/react'
import { useQuery } from '@tanstack/react-query'
import { useCallback, useEffect } from 'react'

import { useGatewayRequest } from '@/app/gateway/hooks/use-gateway-request'
import { $pluginRecords } from '@/contrib/plugins-store'
import { getEnvVars, getHermesConfigSchema, getSkills, getToolsets } from '@/hermes'
import { useI18n } from '@/i18n'
import { hostHas } from '@/lib/host-capabilities'
import { Book, Layers3, Monitor, Package, Settings2, SlidersHorizontal, Wrench } from '@/lib/icons'
import { getServers } from '@/lib/mcp-servers'
import { $agentPlugins, isDesktopRelevantPlugin, loadAgentPlugins } from '@/store/agent-plugins'
import { $localModelsEnabled } from '@/store/local-models-flag'
import { $connection, $gatewayState } from '@/store/session'

import { useHermesConfigRecord } from '../hooks/use-config-record'
import { useOnProfileSwitch } from '../hooks/use-on-profile-switch'

import { SECTIONS } from './constants'
import { toolNames, toolsetDisplayLabel } from './helpers'
import { OTHER_SUBPAGES } from './other-subpages'
import { settingSearchTargets } from './settings-manifest'
import { settingsPageEntries, settingsSubviewEntries, SUBPAGE_KEYWORDS } from './settings-pages'
import { buildConfigSearchEntries, buildCredentialSearchEntries, type SettingsSearchEntry } from './settings-search'
import { settingsSubpageLabel, settingsSubpages } from './subpages'
import type { SettingsView } from './types'

const CATALOG_STALE_MS = 5 * 60 * 1000

/**
 * The settings-search catalog shared by ⌘K and the Settings-scoped palette:
 * every Settings page and sub-page (`pageEntries`, `subpageEntries`), the
 * hand-built rows (`settingEntries`), schema-driven config fields, credentials,
 * and the contents of Settings ▸ Capabilities (installed skills, toolsets, MCP
 * servers, plugins) — each entry a Settings deep link.
 */
export function useSettingsSearchCatalog(enabled: boolean) {
  const { t } = useI18n()
  const configQuery = useHermesConfigRecord()

  const schemaQuery = useQuery({
    queryKey: ['hermes-config-schema'],
    queryFn: () => getHermesConfigSchema(),
    enabled,
    staleTime: CATALOG_STALE_MS
  })

  const {
    data: envVars,
    isError: envVarsError,
    isFetching: envVarsFetching,
    refetch: refetchEnvVars
  } = useQuery({
    queryKey: ['desktop-settings-search-env-vars'],
    queryFn: () => getEnvVars(),
    enabled,
    staleTime: CATALOG_STALE_MS
  })

  // Settings ▸ Capabilities contents for the active profile. Own keys (not
  // the Capabilities page's scoped ones): this is always the ambient profile.
  const { data: skills, refetch: refetchSkills } = useQuery({
    queryKey: ['desktop-settings-search-skills'],
    queryFn: () => getSkills(),
    enabled,
    staleTime: CATALOG_STALE_MS
  })

  const { data: toolsets, refetch: refetchToolsets } = useQuery({
    queryKey: ['desktop-settings-search-toolsets'],
    queryFn: () => getToolsets(),
    enabled,
    staleTime: CATALOG_STALE_MS
  })

  const refreshCatalog = useCallback(() => {
    void refetchEnvVars()
    void refetchSkills()
    void refetchToolsets()
  }, [refetchEnvVars, refetchSkills, refetchToolsets])

  useOnProfileSwitch(refreshCatalog)

  // Plugin rows: desktop plugins are already in their store (discovered at
  // boot); agent plugins ride the gateway, so load them the first time the
  // catalog is wanted — same RPC the Plugins page fires on mount, deduped by
  // the store's own inflight guard.
  const { requestGateway } = useGatewayRequest()
  const gatewayState = useStore($gatewayState)
  const desktopPluginRecords = useStore($pluginRecords)
  const agentPlugins = useStore($agentPlugins)

  useEffect(() => {
    if (enabled && gatewayState === 'open') {
      void loadAgentPlugins(requestGateway)
    }
  }, [enabled, gatewayState, requestGateway])

  const capabilitiesLabel = t.settings.nav.capabilities
  const capabilityContext = (tab: string) => `${capabilitiesLabel} › ${tab}`

  // Installed plugin rows (both halves) — they live on Settings ▸ Capabilities
  // ▸ Plugins, so each entry carries the `?plugin=` row selector for that page.
  const pluginEntries: SettingsSearchEntry[] = [
    ...Object.values(desktopPluginRecords).map(record => ({
      context: capabilityContext(t.skills.tabPlugins),
      description: record.description,
      icon: Monitor,
      id: `plugin:desktop:${record.id}`,
      keywords: ['plugin', 'extension', 'desktop', record.id],
      label: record.name,
      target: { params: { plugin: record.id }, subpage: 'plugins', view: 'capabilities' as const }
    })),
    ...agentPlugins.filter(isDesktopRelevantPlugin).map(row => ({
      context: capabilityContext(t.skills.tabPlugins),
      description: row.description || undefined,
      icon: Package,
      id: `plugin:agent:${row.key ?? row.name}`,
      keywords: ['plugin', 'extension', 'agent', ...(row.key ? [row.key] : [])],
      label: row.name,
      target: { params: { plugin: row.key ?? row.name }, subpage: 'plugins', view: 'capabilities' as const }
    }))
  ]

  // Installed skills and toolsets land on their Capabilities sub-page; MCP
  // servers open their own connector card (`?server=`).
  const skillEntries: SettingsSearchEntry[] = (skills ?? []).map(skill => ({
    context: capabilityContext(t.skills.tabSkills),
    description: skill.description || undefined,
    icon: Book,
    id: `skill:${skill.name}`,
    keywords: ['skill', skill.category ?? ''],
    label: skill.name,
    target: { subpage: 'skills', view: 'capabilities' }
  }))

  const toolsetEntries: SettingsSearchEntry[] = (toolsets ?? []).map(toolset => ({
    context: capabilityContext(t.skills.tabToolsets),
    description: toolset.description || undefined,
    icon: SlidersHorizontal,
    id: `toolset:${toolset.name}`,
    keywords: ['tool', 'toolset', toolset.name, ...toolNames(toolset)],
    label: toolsetDisplayLabel(toolset),
    target: { subpage: 'toolsets', view: 'capabilities' }
  }))

  const mcpServerEntries: SettingsSearchEntry[] = Object.keys(getServers(configQuery.data ?? null))
    .sort()
    .map(name => ({
      context: capabilityContext(t.connectorsPage.title),
      icon: Layers3,
      id: `mcp-server:${name}`,
      keywords: ['mcp', 'server', 'connector', 'tool'],
      label: name,
      target: { params: { server: name }, subpage: 'connectors', view: 'capabilities' }
    }))

  const capabilityEntries = [...skillEntries, ...toolsetEntries, ...mcpServerEntries]

  // Never expose stale profile-scoped targets while a catalog is refreshing.
  // Field/key results wait for the current profile's data rather than briefly
  // pointing into the previous one.
  const configEntries =
    configQuery.isFetching || schemaQuery.isFetching || configQuery.isError || schemaQuery.isError
      ? []
      : buildConfigSearchEntries(schemaQuery.data?.fields, configQuery.data, {
          fieldDescriptions: t.settings.fieldDescriptions,
          fieldLabels: t.settings.fieldLabels,
          sections: t.settings.sections
        })

  const credentialEntries = buildCredentialSearchEntries(
    envVarsFetching || envVarsError ? null : envVars,
    {
      settings: t.settings.nav.keysSettings,
      tools: t.settings.nav.keysTools
    },
    { settings: Settings2, tools: Wrench }
  )

  // Standalone views name their nav row by view id.
  const pageLabels: Record<string, string> = t.settings.nav

  // The pages that own rows: config sections and the standalone views.
  const parents = [
    ...SECTIONS.map(section => ({
      view: `config:${section.id}` as SettingsView,
      label: t.settings.sections[section.id] ?? section.label,
      icon: section.icon
    })),
    ...Object.keys(OTHER_SUBPAGES).map(view => ({
      view: view as SettingsView,
      label: pageLabels[view] ?? view,
      icon: view === 'capabilities' ? Wrench : Settings2
    }))
  ]

  const parentOf = (view: SettingsView) => parents.find(parent => parent.view === view)

  // Every hand-built settings row, straight from the manifest that also
  // routes and ids them — the palette cannot drift from the pages.
  const settingEntries: SettingsSearchEntry[] = settingSearchTargets(t).map(({ id, view, ...entry }) => {
    const parent = parentOf(view)

    return {
      ...entry,
      context: parent?.label ?? view,
      icon: parent?.icon ?? Settings2,
      id: `setting:${id}`,
      target: { setting: id, view }
    }
  })

  // A page named after its one setting (Appearance › Theme) would show up as
  // two identical rows; the setting wins because it lands on the row itself.
  const settingLabels = new Set(settingEntries.map(entry => `${entry.context}\u0000${entry.label}`))

  const subpageEntries: SettingsSearchEntry[] = parents
    .flatMap(parent =>
      settingsSubpages(parent.view).map(page => ({
        context: parent.label,
        icon: parent.icon,
        id: `settings-page:${parent.view}:${page.id}`,
        keywords: [parent.label, page.id, ...(SUBPAGE_KEYWORDS[page.labelKey] ?? [])],
        label: settingsSubpageLabel(page, t),
        target: { view: parent.view, subpage: page.id }
      }))
    )
    .filter(entry => !settingLabels.has(`${entry.context}\u0000${entry.label}`))

  // Page rows. Gated like the nav: Web Access only where this machine serves
  // the Webapp, Local Models only behind its launch flag.
  const connection = useStore($connection)
  const localModelsEnabled = useStore($localModelsEnabled)

  const pageOptions = {
    localModelsEnabled,
    webAccessAvailable: hostHas('webAccessHost') && connection?.mode !== 'remote'
  }

  const pageEntries = settingsPageEntries(t, pageOptions)

  return {
    pageEntries,
    subpageEntries: [...settingsSubviewEntries(t, pageOptions), ...subpageEntries],
    capabilityEntries,
    settingEntries,
    configEntries,
    credentialEntries,
    pluginEntries
  }
}
