import { atom } from 'nanostores'

import { Codecs, persistentAtom } from '@/lib/persisted'
import type { RightRailTabId } from '@/store/layout'
import { closeRightRailTab, newBrowserTab } from '@/store/preview'

export type SidePanelEdge = 'bottom' | 'left' | 'right' | 'top'

export type SidePanelTabKind = 'background-tasks' | 'browser' | 'files' | 'review' | 'terminal'

export interface SidePanelTab {
  id: string
  kind: SidePanelTabKind
  previewTabId?: string
}

export interface SidePanelZoneState {
  activeTabId: null | string
  size: number
  tabs: SidePanelTab[]
}

export type SidePanelZones = Record<SidePanelEdge, SidePanelZoneState>

const DEFAULT_ZONES: SidePanelZones = {
  bottom: { activeTabId: null, size: 260, tabs: [] },
  left: { activeTabId: null, size: 380, tabs: [] },
  right: { activeTabId: null, size: 540, tabs: [] },
  top: { activeTabId: null, size: 240, tabs: [] }
}

const VALID_KINDS = new Set<SidePanelTabKind>(['background-tasks', 'browser', 'files', 'review', 'terminal'])

function sanitizeZone(raw: unknown, fallback: SidePanelZoneState): SidePanelZoneState {
  if (!raw || typeof raw !== 'object') {
    return { ...fallback, tabs: [] }
  }

  const obj = raw as Record<string, unknown>
  const size = typeof obj.size === 'number' && Number.isFinite(obj.size) ? obj.size : fallback.size

  // Never restore stale ephemeral browser previewTabIds across cold launches.
  const tabs: SidePanelTab[] = Array.isArray(obj.tabs)
    ? obj.tabs.filter((t): t is SidePanelTab => {
        if (!t || typeof t !== 'object') {
          return false
        }

        const tab = t as Record<string, unknown>

        return (
          typeof tab.id === 'string' &&
          typeof tab.kind === 'string' &&
          VALID_KINDS.has(tab.kind as SidePanelTabKind) &&
          tab.kind !== 'browser'
        )
      })
    : []

  const activeTabId =
    typeof obj.activeTabId === 'string' && tabs.some(t => t.id === obj.activeTabId)
      ? obj.activeTabId
      : (tabs[0]?.id ?? null)

  return { activeTabId, size, tabs }
}

function sanitizeZones(raw: unknown): SidePanelZones {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}

  return {
    bottom: sanitizeZone(obj.bottom, DEFAULT_ZONES.bottom),
    left: sanitizeZone(obj.left, DEFAULT_ZONES.left),
    right: sanitizeZone(obj.right, DEFAULT_ZONES.right),
    top: sanitizeZone(obj.top, DEFAULT_ZONES.top)
  }
}

/** Default closed when launching Hermes; ⌘B or opening a tool opens it. */
export const $sidePanelOpen = atom<boolean>(false)

export const $sidePanelZones = persistentAtom<SidePanelZones>(
  'hermes.desktop.sidePanel.zones.v1',
  DEFAULT_ZONES,
  Codecs.json<SidePanelZones>(sanitizeZones)
)

/** Never persisted: launching the app never traps you in a maximized panel. */
export const $sidePanelMaximized = atom<boolean>(false)

/** Tracks which side-panel / docked zone was last interacted with (for ⌘W). */
export const $sidePanelFocusedEdge = atom<null | SidePanelEdge>(null)

/** File path requested to open inline inside the Files tab's code viewer. */
export const $filesInlineOpenPath = atom<null | string>(null)

/** Incremented by ⇧⌘N to open the right side panel's "+" tool menu. */
export const $sidePanelAddMenuNonce = atom<number>(0)

/** Signals the newly opened/focused tool to focus its primary input (URL bar,
 *  file search box, etc.). */
export const $sidePanelFocusRequest = atom<{ kind: SidePanelTabKind; nonce: number } | null>(null)

function requestToolInputFocus(kind: SidePanelTabKind) {
  const prev = $sidePanelFocusRequest.get()?.nonce ?? 0
  $sidePanelFocusRequest.set({ kind, nonce: prev + 1 })
}

export function openNewRightSideTab(): void {
  $sidePanelAddMenuNonce.set($sidePanelAddMenuNonce.get() + 1)
}

export function openSidePanel(): void {
  $sidePanelOpen.set(true)
}

export function closeSidePanel(): void {
  $sidePanelOpen.set(false)
  $sidePanelMaximized.set(false)

  if ($sidePanelFocusedEdge.get() === 'right') {
    $sidePanelFocusedEdge.set(null)
  }
}

export function toggleSidePanel(): void {
  if ($sidePanelOpen.get()) {
    closeSidePanel()
  } else {
    openSidePanel()
  }
}

export function toggleSidePanelMaximized(): void {
  if (!$sidePanelOpen.get()) {
    $sidePanelOpen.set(true)
    $sidePanelMaximized.set(true)

    return
  }

  $sidePanelMaximized.set(!$sidePanelMaximized.get())
}

function findTabLocation(
  zones: SidePanelZones,
  predicate: (tab: SidePanelTab) => boolean
): { edge: SidePanelEdge; tab: SidePanelTab } | null {
  for (const edge of ['right', 'bottom', 'left', 'top'] as const) {
    const tab = zones[edge].tabs.find(predicate)

    if (tab) {
      return { edge, tab }
    }
  }

  return null
}

export function openSidePanelTool(
  kind: SidePanelTabKind,
  opts?: { edge?: SidePanelEdge; newInstance?: boolean; previewTabId?: string }
): void {
  const zones = $sidePanelZones.get()
  const targetEdge: SidePanelEdge = opts?.edge ?? 'right'

  if (kind === 'browser') {
    if (opts?.previewTabId) {
      const existing = findTabLocation(zones, t => t.kind === 'browser' && t.previewTabId === opts.previewTabId)

      if (existing) {
        selectSidePanelTab(existing.edge, existing.tab.id)

        if (existing.edge === 'right') {
          $sidePanelOpen.set(true)
        }

        return
      }

      const id = `browser:${opts.previewTabId}`
      const zone = zones[targetEdge]
      $sidePanelZones.set({
        ...zones,
        [targetEdge]: {
          ...zone,
          activeTabId: id,
          tabs: [...zone.tabs, { id, kind: 'browser', previewTabId: opts.previewTabId }]
        }
      })

      if (targetEdge === 'right') {
        $sidePanelOpen.set(true)
      }

      $sidePanelFocusedEdge.set(targetEdge)
      requestToolInputFocus('browser')

      return
    }

    if (!opts?.newInstance) {
      const existing = findTabLocation(zones, t => t.kind === 'browser')

      if (existing) {
        selectSidePanelTab(existing.edge, existing.tab.id)

        if (existing.edge === 'right') {
          $sidePanelOpen.set(true)
        }

        return
      }
    }

    // Mint a real Browser tab in the preview store; the watcher below docks it into `targetEdge`.
    pendingBrowserTargetEdge = targetEdge
    newBrowserTab()

    return
  }

  // Non-browser tools: when `newInstance` is true (+ menu / ⇧⌘N), always mint a
  // fresh tab so multiple Files / Terminal / Changes tabs can be open at once.
  if (!opts?.newInstance) {
    const existing = findTabLocation(zones, t => t.kind === kind)

    if (existing) {
      selectSidePanelTab(existing.edge, existing.tab.id)

      if (existing.edge === 'right') {
        $sidePanelOpen.set(true)
      }

      return
    }
  }

  const zone = zones[targetEdge]
  const id = findTabLocation(zones, t => t.id === kind) ? `${kind}:${Date.now()}-${Math.random().toString(36).slice(2, 6)}` : kind
  const tab: SidePanelTab = { id, kind }
  $sidePanelZones.set({
    ...zones,
    [targetEdge]: {
      ...zone,
      activeTabId: tab.id,
      tabs: [...zone.tabs, tab]
    }
  })

  if (targetEdge === 'right') {
    $sidePanelOpen.set(true)
  }

  $sidePanelFocusedEdge.set(targetEdge)
  requestToolInputFocus(kind)
}

let pendingBrowserTargetEdge: SidePanelEdge = 'right'

export function consumePendingBrowserTargetEdge(): SidePanelEdge {
  const edge = pendingBrowserTargetEdge
  pendingBrowserTargetEdge = 'right'

  return edge
}

export function openFileInSidePanel(path: string): void {
  $filesInlineOpenPath.set(path)
  openSidePanelTool('files')
}

export function toggleSidePanelTool(kind: Exclude<SidePanelTabKind, 'browser'>): void {
  const zones = $sidePanelZones.get()
  const existing = findTabLocation(zones, t => t.kind === kind)

  if (existing) {
    const zone = zones[existing.edge]
    const isVisible = (existing.edge !== 'right' || $sidePanelOpen.get()) && zone.activeTabId === existing.tab.id

    if (isVisible) {
      closeSidePanelTab(existing.edge, existing.tab.id)

      return
    }
  }

  openSidePanelTool(kind)
}

export function selectSidePanelTab(edge: SidePanelEdge, tabId: string): void {
  const zones = $sidePanelZones.get()
  const zone = zones[edge]

  const tab = zone.tabs.find(t => t.id === tabId)

  if (!tab) {
    return
  }

  $sidePanelZones.set({
    ...zones,
    [edge]: { ...zone, activeTabId: tabId }
  })
  $sidePanelFocusedEdge.set(edge)
  requestToolInputFocus(tab.kind)
}

export function closeSidePanelTab(edge: SidePanelEdge, tabId: string): void {
  const zones = $sidePanelZones.get()
  const zone = zones[edge]
  const idx = zone.tabs.findIndex(t => t.id === tabId)

  if (idx < 0) {
    return
  }

  const removed = zone.tabs[idx]!
  const nextTabs = zone.tabs.filter(t => t.id !== tabId)

  const nextActive =
    zone.activeTabId === tabId
      ? (nextTabs[Math.min(idx, nextTabs.length - 1)]?.id ?? null)
      : zone.activeTabId

  $sidePanelZones.set({
    ...zones,
    [edge]: { ...zone, activeTabId: nextActive, tabs: nextTabs }
  })

  if (edge === 'right' && nextTabs.length === 0) {
    $sidePanelMaximized.set(false)
  }

  if (nextTabs.length === 0 && $sidePanelFocusedEdge.get() === edge) {
    $sidePanelFocusedEdge.set(null)
  }

  if (removed.kind === 'browser' && removed.previewTabId) {
    closeRightRailTab(removed.previewTabId as RightRailTabId)
  }
}

export function closeAllSidePanelTabs(edge: SidePanelEdge): void {
  const zones = $sidePanelZones.get()
  const zone = zones[edge]
  const browserIds = zone.tabs.map(t => t.previewTabId).filter((id): id is string => Boolean(id))

  $sidePanelZones.set({
    ...zones,
    [edge]: { ...zone, activeTabId: null, tabs: [] }
  })

  if (edge === 'right') {
    $sidePanelMaximized.set(false)
  }

  if ($sidePanelFocusedEdge.get() === edge) {
    $sidePanelFocusedEdge.set(null)
  }

  for (const id of browserIds) {
    closeRightRailTab(id as RightRailTabId)
  }
}

export function moveSidePanelTab(fromEdge: SidePanelEdge, tabId: string, toEdge: SidePanelEdge): void {
  if (fromEdge === toEdge) {
    return
  }

  const zones = $sidePanelZones.get()
  const source = zones[fromEdge]
  const idx = source.tabs.findIndex(t => t.id === tabId)

  if (idx < 0) {
    return
  }

  const moving = source.tabs[idx]!
  const nextSourceTabs = source.tabs.filter(t => t.id !== tabId)

  const nextSourceActive =
    source.activeTabId === tabId
      ? (nextSourceTabs[Math.min(idx, nextSourceTabs.length - 1)]?.id ?? null)
      : source.activeTabId

  const dest = zones[toEdge]
  const nextDestTabs = dest.tabs.some(t => t.id === tabId) ? dest.tabs : [...dest.tabs, moving]

  $sidePanelZones.set({
    ...zones,
    [fromEdge]: { ...source, activeTabId: nextSourceActive, tabs: nextSourceTabs },
    [toEdge]: { ...dest, activeTabId: moving.id, tabs: nextDestTabs }
  })

  if (toEdge === 'right') {
    $sidePanelOpen.set(true)
  }

  // If the user moved the ONLY tab out of the right side panel to bottom/top/left,
  // close the now-empty right panel so the moved panel shines cleanly beside chat.
  if (fromEdge === 'right' && nextSourceTabs.length === 0) {
    $sidePanelOpen.set(false)
    $sidePanelMaximized.set(false)
  }

  $sidePanelFocusedEdge.set(toEdge)
}

export function setSidePanelZoneSize(edge: SidePanelEdge, size: number): void {
  const min = edge === 'left' || edge === 'right' ? 280 : 140
  const max = edge === 'left' || edge === 'right' ? 1200 : 700
  const clamped = Math.round(Math.max(min, Math.min(max, size)))
  const zones = $sidePanelZones.get()

  if (zones[edge].size === clamped) {
    return
  }

  $sidePanelZones.set({
    ...zones,
    [edge]: { ...zones[edge], size: clamped }
  })
}

/** Called by ⌘W: closes the active tab in the focused side-panel / docked zone,
 *  or falls back to the open right side panel (or any open docked zone). Never
 *  closes the Hermes window or wipes the chat. */
export function closeFocusedSidePanelTab(): boolean {
  const zones = $sidePanelZones.get()
  const activeEl = typeof document !== 'undefined' ? document.activeElement : null

  const domEdge = activeEl?.closest?.('[data-side-panel-edge]')?.getAttribute('data-side-panel-edge') as
    | null
    | SidePanelEdge
    | undefined

  const preferredEdge = domEdge ?? $sidePanelFocusedEdge.get()

  if (preferredEdge) {
    const allowed = preferredEdge !== 'right' || $sidePanelOpen.get()

    if (allowed && zones[preferredEdge].activeTabId) {
      closeSidePanelTab(preferredEdge, zones[preferredEdge].activeTabId!)

      return true
    }
  }

  // Fallback: if the right side panel is open with tabs, close its active tab.
  if ($sidePanelOpen.get() && zones.right.activeTabId) {
    closeSidePanelTab('right', zones.right.activeTabId)

    return true
  }

  // Fallback: any open moved docked panel (bottom / left / top).
  for (const edge of ['bottom', 'left', 'top'] as const) {
    if (zones[edge].activeTabId) {
      closeSidePanelTab(edge, zones[edge].activeTabId!)

      return true
    }
  }

  return false
}

/** Remove any browser side-panel tab whose previewTabId no longer exists in $previewTabs. */
export function pruneOrphanBrowserTabs(livePreviewTabIds: ReadonlySet<string>): void {
  const zones = $sidePanelZones.get()
  let changed = false
  const next: SidePanelZones = { ...zones }

  for (const edge of ['right', 'bottom', 'left', 'top'] as const) {
    const zone = zones[edge]
    const kept = zone.tabs.filter(t => t.kind !== 'browser' || (t.previewTabId && livePreviewTabIds.has(t.previewTabId)))

    if (kept.length !== zone.tabs.length) {
      changed = true
      next[edge] = {
        ...zone,
        activeTabId: kept.some(t => t.id === zone.activeTabId) ? zone.activeTabId : (kept[0]?.id ?? null),
        tabs: kept
      }
    }
  }

  if (changed) {
    $sidePanelZones.set(next)
  }
}
