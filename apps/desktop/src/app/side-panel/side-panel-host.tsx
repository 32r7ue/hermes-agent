import { useStore } from '@nanostores/react'
import { type FC, type MouseEvent, type ReactNode, type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from 'react'

import { requestComposerFocus } from '@/app/chat/composer/focus'
import { browserTabLabel } from '@/app/chat/preview-tile'
import { PreviewTilePane } from '@/app/chat/right-rail/preview'
import { FilesPane, ReviewPaneContent } from '@/app/contrib/panes'
import { WiredPane } from '@/app/contrib/wiring'
import { BackgroundTasksPane } from '@/app/right-sidebar/background-tasks'
import { SessionInfoPane } from '@/app/right-sidebar/session-info'
import { setTerminalTakeover } from '@/app/right-sidebar/store'
import { hiddenPaneProps } from '@/components/pane-shell/pane-visibility'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tip } from '@/components/ui/tooltip'
import { useKeybindHint } from '@/lib/keybinds/use-keybind-hint'
import { cn } from '@/lib/utils'
import type { RightRailTabId } from '@/store/layout'
import { $browserPages, $previewTabs, closeRightRailTab, popOutBrowserTab } from '@/store/preview'
import {
  $sidePanelAddMenuNonce,
  $sidePanelFocusedEdge,
  $sidePanelMaximized,
  $sidePanelOpen,
  $sidePanelZones,
  closeAllSidePanelTabs,
  closeSidePanelTab,
  consumePendingBrowserTargetEdge,
  moveSidePanelTab,
  openFileInSidePanel,
  openSidePanelTool,
  pruneOrphanBrowserTabs,
  selectSidePanelTab,
  setSidePanelZoneSize,
  type SidePanelEdge,
  type SidePanelTab,
  type SidePanelTabKind,
  toggleSidePanelMaximized
} from '@/store/side-panel'
import { $subagentsBySession } from '@/store/subagents'
import { canOpenBrowserWindow } from '@/store/windows'

export interface SidePanelToolDef {
  icon: string
  keybind?: string
  kind: SidePanelTabKind
  label: string
}

export const SIDE_PANEL_TOOL_DEFS: readonly SidePanelToolDef[] = [
  { icon: 'git-compare', keybind: 'view.toggleReview', kind: 'review', label: 'Changes' },
  { icon: 'globe', keybind: 'view.showBrowser', kind: 'browser', label: 'Browser' },
  { icon: 'files', keybind: 'view.showFiles', kind: 'files', label: 'Files' },
  { icon: 'terminal', keybind: 'view.showTerminal', kind: 'terminal', label: 'Terminal' },
  { icon: 'layers', kind: 'background-tasks', label: 'Background tasks' }
]

const EDGE_MOVES: readonly { edge: SidePanelEdge; icon: string; label: string }[] = [
  { edge: 'left', icon: 'layout-sidebar-left', label: 'Move to left' },
  { edge: 'right', icon: 'layout-sidebar-right', label: 'Move to right' },
  { edge: 'top', icon: 'layout-menubar', label: 'Move to top' },
  { edge: 'bottom', icon: 'layout-panel', label: 'Move to bottom' }
]

function useSubagentCounts(): { running: number; total: number } {
  const bySession = useStore($subagentsBySession)
  const all = Object.values(bySession).flat()

  return {
    running: all.filter(item => item.status === 'running' || item.status === 'queued').length,
    total: all.length
  }
}

function ToolShortcut({ actionId }: { actionId?: string }) {
  const hint = useKeybindHint(actionId ?? '')

  return hint ? <DropdownMenuShortcut>{hint}</DropdownMenuShortcut> : null
}

function AddToolMenu({ edge }: { edge: SidePanelEdge }) {
  const [open, setOpen] = useState(false)
  const { running, total } = useSubagentCounts()
  const visibleTools = SIDE_PANEL_TOOL_DEFS.filter(tool => tool.kind !== 'background-tasks' || total > 0)

  return (
    <DropdownMenu modal={false} onOpenChange={setOpen} open={open}>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label="Open tool"
          className="size-6 shrink-0 text-(--ui-text-tertiary) hover:bg-(--ui-control-hover-background) hover:text-foreground"
          size="icon-xs"
          title="Open tool"
          type="button"
          variant="ghost"
        >
          <Codicon name="add" size="0.875rem" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-52">
        {visibleTools.map((tool, index) => (
          <div key={tool.kind}>
            {tool.kind === 'background-tasks' && index > 0 && <DropdownMenuSeparator />}
            <DropdownMenuItem
              data-side-panel-add-tool={tool.kind}
              onSelect={() =>
                openSidePanelTool(tool.kind, {
                  edge,
                  newInstance: true
                })
              }
            >
              <Codicon name={tool.icon} size="0.875rem" />
              <span>{tool.label}</span>
              {tool.kind === 'background-tasks' && running > 0 && (
                <span className="ml-auto rounded-full bg-(--ui-blue)/15 px-1.5 py-0.5 text-[0.65rem] font-medium text-(--ui-blue) tabular-nums">
                  {running}
                </span>
              )}
              <ToolShortcut actionId={tool.keybind} />
            </DropdownMenuItem>
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function MoveTabPopover({ edge, tab }: { edge: SidePanelEdge; tab: SidePanelTab }) {
  const [open, setOpen] = useState(false)
  const canPopOut = tab.kind === 'browser' && Boolean(tab.previewTabId) && canOpenBrowserWindow()

  return (
    <DropdownMenu modal={false} onOpenChange={setOpen} open={open}>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label="Move or arrange tab"
          className="size-6 shrink-0 text-(--ui-text-tertiary) hover:bg-(--ui-control-hover-background) hover:text-foreground"
          data-side-panel-move-trigger={edge}
          size="icon-xs"
          title="Move or arrange tab"
          type="button"
          variant="ghost"
        >
          <Codicon name="layout-panel-off" size="0.8125rem" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44 p-1.5">
        <DropdownMenuLabel className="px-1.5 py-1 text-[0.7rem] font-medium text-(--ui-text-tertiary)">
          Move
        </DropdownMenuLabel>
        <div className="flex items-center gap-1 px-1 pb-1">
          {EDGE_MOVES.map(item => (
            <Tip key={item.edge} label={item.label}>
              <Button
                aria-label={item.label}
                className={cn(
                  'size-7 text-(--ui-text-secondary) hover:bg-(--ui-control-hover-background) hover:text-foreground',
                  item.edge === edge && 'bg-(--ui-row-active-background) text-foreground'
                )}
                data-side-panel-move-to={item.edge}
                onClick={() => {
                  moveSidePanelTab(edge, tab.id, item.edge)
                  setOpen(false)
                }}
                size="icon-xs"
                type="button"
                variant="ghost"
              >
                <Codicon name={item.icon} size="0.9375rem" />
              </Button>
            </Tip>
          ))}
        </div>
        {canPopOut && tab.previewTabId && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => {
                setOpen(false)
                popOutBrowserTab(tab.previewTabId!)
              }}
            >
              <Codicon name="multiple-windows" size="0.875rem" />
              <span>Open in new window</span>
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function TabChip({
  active,
  edge,
  tab
}: {
  active: boolean
  edge: SidePanelEdge
  tab: SidePanelTab
}) {
  const previewTabs = useStore($previewTabs)
  const browserPages = useStore($browserPages)

  let icon = 'file'
  let label = 'Tab'

  switch (tab.kind) {
    case 'files':
      icon = 'files'
      label = 'Files'

      break

    case 'review':
      icon = 'git-compare'
      label = 'Changes'

      break

    case 'terminal':
      icon = 'terminal'
      label = 'Terminal'

      break

    case 'background-tasks':
      icon = 'layers'
      label = 'Background tasks'

      break
    case 'browser': {
      icon = 'globe'
      const previewTab = previewTabs.find(t => t.id === tab.previewTabId)
      const page = tab.previewTabId ? browserPages[tab.previewTabId] : undefined
      label = previewTab ? browserTabLabel(previewTab.target, page) : 'Browser'

      break
    }
  }

  const handleMouseDown = (event: MouseEvent) => {
    if (event.button === 1) {
      event.preventDefault()
      closeSidePanelTab(edge, tab.id)
    }
  }

  return (
    <div
      aria-selected={active}
      className={cn(
        'group/tab flex h-7 max-w-44 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 text-xs select-none transition-colors',
        active
          ? 'bg-(--ui-control-hover-background) font-medium text-(--ui-text-primary)'
          : 'text-(--ui-text-tertiary) hover:bg-(--ui-control-hover-background)/50 hover:text-(--ui-text-secondary)'
      )}
      data-side-panel-tab={tab.id}
      onClick={() => selectSidePanelTab(edge, tab.id)}
      onMouseDown={handleMouseDown}
      role="tab"
    >
      <Codicon className="shrink-0 opacity-80" name={icon} size="0.8125rem" />
      <span className="min-w-0 truncate">{label}</span>
      <button
        aria-label={`Close ${label}`}
        className="ml-0.5 grid size-4 shrink-0 place-items-center rounded text-(--ui-text-tertiary) opacity-0 transition-opacity group-hover/tab:opacity-100 hover:bg-(--ui-bg-tertiary) hover:text-foreground"
        data-side-panel-tab-close={tab.id}
        onClick={e => {
          e.stopPropagation()
          closeSidePanelTab(edge, tab.id)
        }}
        type="button"
      >
        <Codicon name="close" size="0.7rem" />
      </button>
    </div>
  )
}

function TabBody({ edge, tab }: { edge: SidePanelEdge; tab: SidePanelTab }) {
  switch (tab.kind) {
    case 'files':
      return <FilesPane />

    case 'review':
      return <ReviewPaneContent />

    case 'terminal':
      return <WiredPane part="terminal" />

    case 'background-tasks':
      return <BackgroundTasksPane />

    case 'browser':
      return tab.previewTabId ? (
        <PreviewTilePane onClose={() => closeSidePanelTab(edge, tab.id)} tabId={tab.previewTabId} />
      ) : null
  }
}

function ResizeSash({
  edge,
  size
}: {
  edge: SidePanelEdge
  size: number
}) {
  const horizontal = edge === 'left' || edge === 'right'

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    const startPos = horizontal ? event.clientX : event.clientY
    const startSize = size

    const onMove = (moveEvent: PointerEvent) => {
      const current = horizontal ? moveEvent.clientX : moveEvent.clientY
      const delta = current - startPos
      const next = edge === 'right' || edge === 'bottom' ? startSize - delta : startSize + delta
      setSidePanelZoneSize(edge, next)
    }

    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  return (
    <div
      className={cn(
        'relative z-20 shrink-0 bg-(--ui-stroke-tertiary) transition-colors hover:bg-(--ui-accent)/70',
        horizontal ? 'w-px cursor-col-resize' : 'h-px cursor-row-resize'
      )}
      onPointerDown={onPointerDown}
    >
      <div
        className={cn(
          'absolute',
          horizontal ? 'inset-y-0 -left-1.5 w-3 cursor-col-resize' : 'inset-x-0 -top-1.5 h-3 cursor-row-resize'
        )}
      />
    </div>
  )
}

function DockedPanel({
  edge,
  maximized = false,
  topClearance = false
}: {
  edge: SidePanelEdge
  maximized?: boolean
  topClearance?: boolean
}) {
  const zones = useStore($sidePanelZones)
  const zone = zones[edge]
  const activeTab = zone.tabs.find(t => t.id === zone.activeTabId) ?? zone.tabs[0] ?? null
  const isEmpty = zone.tabs.length === 0
  const horizontal = edge === 'left' || edge === 'right'

  return (
    <div
      className={cn(
        'flex min-h-0 min-w-0 flex-col bg-(--ui-sidebar-surface-background) text-(--ui-text-primary)',
        maximized ? 'flex-1' : 'shrink-0'
      )}
      data-side-panel-edge={edge}
      onPointerDownCapture={() => $sidePanelFocusedEdge.set(edge)}
      style={
        maximized
          ? undefined
          : horizontal
            ? { width: `${zone.size}px` }
            : { height: `${zone.size}px` }
      }
    >
      {/* Panel header bar: sits IN the top menu bar row on the right edge (leaving
          room on the far right for Settings + the single right-sidebar toggle).
          Keep -webkit-app-region:drag strictly on the empty middle spacer so it
          never steals clicks from the fixed top-right Settings / Sidebar buttons. */}
      <div
        className={cn(
          'flex h-9 shrink-0 items-center gap-1 border-b border-(--ui-stroke-tertiary) px-2',
          edge === 'right' && topClearance && 'pr-16',
          topClearance && (maximized || edge === 'top' || edge === 'left') && 'pl-28'
        )}
        data-side-panel-header={edge}
      >
        <div
          className="flex min-w-0 items-center gap-1 overflow-x-auto [-webkit-app-region:no-drag] [scrollbar-width:none]"
          role="tablist"
        >
          {zone.tabs.map(tab => (
            <TabChip active={tab.id === activeTab?.id} edge={edge} key={tab.id} tab={tab} />
          ))}
          <AddToolMenu edge={edge} />
        </div>

        <div className={cn('h-full min-w-4 flex-1', topClearance && '[-webkit-app-region:drag]')} />

        <div className="flex shrink-0 items-center gap-0.5 [-webkit-app-region:no-drag]">
          {activeTab && <MoveTabPopover edge={edge} tab={activeTab} />}

          {edge === 'right' && !isEmpty && (
            <Tip label={maximized ? 'Restore panel size' : 'Expand panel'}>
              <Button
                aria-label={maximized ? 'Restore panel size' : 'Expand panel'}
                className="size-6 shrink-0 text-(--ui-text-tertiary) hover:bg-(--ui-control-hover-background) hover:text-foreground"
                data-side-panel-maximize=""
                onClick={toggleSidePanelMaximized}
                size="icon-xs"
                type="button"
                variant="ghost"
              >
                <Codicon name={maximized ? 'screen-normal' : 'screen-full'} size="0.8125rem" />
              </Button>
            </Tip>
          )}

          {edge !== 'right' && (
            <Tip label="Close panel">
              <Button
                aria-label="Close panel"
                className="size-6 shrink-0 text-(--ui-text-tertiary) hover:bg-(--ui-control-hover-background) hover:text-foreground"
                data-side-panel-close={edge}
                onClick={() => closeAllSidePanelTabs(edge)}
                size="icon-xs"
                type="button"
                variant="ghost"
              >
                <Codicon name="close" size="0.8125rem" />
              </Button>
            </Tip>
          )}
        </div>
      </div>

      {/* Body: Launcher when empty (right side panel only), otherwise keep-alive tab layers */}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {isEmpty ? (
          <SessionInfoPane />
        ) : (
          zone.tabs.map(tab => {
            const isActive = tab.id === activeTab?.id

            return (
              <div
                aria-hidden={!isActive || undefined}
                className={cn(
                  'absolute inset-0 flex min-h-0 flex-col overflow-hidden',
                  !isActive && 'pointer-events-none invisible opacity-0'
                )}
                data-side-panel-body={tab.id}
                key={tab.id}
                {...hiddenPaneProps(!isActive)}
              >
                <TabBody edge={edge} tab={tab} />
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

/** Syncs `$previewTabs` into the new side panel:
 *  - URL tabs open as Browser tabs in the side panel
 *  - Local file targets open inline inside the Files tab's code viewer */
function useSidePanelPreviewSync() {
  const previewTabs = useStore($previewTabs)
  const seenIdsRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    const liveIds = new Set<string>(previewTabs.map(t => t.id))

    for (const tab of previewTabs) {
      if (seenIdsRef.current.has(tab.id)) {
        continue
      }

      seenIdsRef.current.add(tab.id)

      if (tab.target.kind === 'url') {
        const edge = consumePendingBrowserTargetEdge()
        openSidePanelTool('browser', { edge, previewTabId: tab.id })
      } else if (tab.target.kind === 'file' && tab.target.source) {
        openFileInSidePanel(tab.target.source)
        closeRightRailTab(tab.id as RightRailTabId)
      }
    }

    for (const id of [...seenIdsRef.current]) {
      if (!liveIds.has(id)) {
        seenIdsRef.current.delete(id)
      }
    }

    pruneOrphanBrowserTabs(liveIds)
  }, [previewTabs])
}

/** ⇧⌘N quick side-tab picker: simple type-to-filter menu to open/focus a tab
 *  on the right side panel without a heavy search bar. */
function QuickSideTabMenu() {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [selectedIdx, setSelectedIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const { running, total } = useSubagentCounts()

  useEffect(() => {
    return $sidePanelAddMenuNonce.listen(() => {
      setQuery('')
      setSelectedIdx(0)
      setOpen(true)
      window.setTimeout(() => inputRef.current?.focus(), 20)
    })
  }, [])

  useEffect(() => {
    if (!open) {
      return
    }

    inputRef.current?.focus()
    const id = window.setTimeout(() => inputRef.current?.focus(), 20)

    return () => window.clearTimeout(id)
  }, [open])

  const allTools = SIDE_PANEL_TOOL_DEFS.filter(tool => tool.kind !== 'background-tasks' || total > 0)
  const needle = query.trim().toLowerCase()
  const matches = needle ? allTools.filter(tool => tool.label.toLowerCase().includes(needle)) : allTools

  useEffect(() => {
    setSelectedIdx(0)
  }, [needle])

  if (!open) {
    return null
  }

  const pick = (tool: SidePanelToolDef) => {
    setOpen(false)
    openSidePanelTool(tool.kind, {
      edge: 'right',
      newInstance: true
    })
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/25 pt-20"
      data-side-panel-quick-menu=""
      onMouseDown={e => {
        if (e.target === e.currentTarget) {
          setOpen(false)
        }
      }}
    >
      <div className="w-72 overflow-hidden rounded-lg border border-(--ui-stroke-secondary) bg-(--ui-sidebar-surface-background) shadow-2xl">
        <div className="flex items-center gap-2 border-b border-(--ui-stroke-tertiary) px-3 py-2">
          <Codicon className="shrink-0 text-(--ui-text-tertiary)" name="search" size="0.8125rem" />
          <input
            aria-label="Open side tab"
            autoFocus
            className="min-w-0 flex-1 bg-transparent text-xs text-(--ui-text-primary) placeholder:text-(--ui-text-quaternary) focus:outline-none"
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Escape') {
                e.preventDefault()
                setOpen(false)
                requestComposerFocus('active')
              } else if (e.key === 'ArrowDown' && matches.length > 0) {
                e.preventDefault()
                setSelectedIdx(i => (i + 1) % matches.length)
              } else if (e.key === 'ArrowUp' && matches.length > 0) {
                e.preventDefault()
                setSelectedIdx(i => (i - 1 + matches.length) % matches.length)
              } else if (e.key === 'Enter' && matches.length > 0) {
                e.preventDefault()
                const hit = matches[selectedIdx] ?? matches[0]

                if (hit) {
                  pick(hit)
                }
              }
            }}
            placeholder="Open side tab…"
            ref={inputRef}
            type="text"
            value={query}
          />
        </div>

        <div className="p-1">
          {matches.length === 0 ? (
            <div className="px-2.5 py-3 text-center text-xs text-(--ui-text-quaternary)">No matching tab</div>
          ) : (
            matches.map((tool, idx) => (
              <button
                className={cn(
                  'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs text-(--ui-text-secondary) hover:bg-(--ui-control-hover-background) hover:text-foreground',
                  idx === selectedIdx && 'bg-(--ui-control-hover-background) text-foreground'
                )}
                key={tool.kind}
                onClick={() => pick(tool)}
                onMouseEnter={() => setSelectedIdx(idx)}
                type="button"
              >
                <Codicon name={tool.icon} size="0.875rem" />
                <span className="min-w-0 flex-1 truncate">{tool.label}</span>
                {tool.kind === 'background-tasks' && running > 0 && (
                  <span className="rounded-full bg-(--ui-blue)/15 px-1.5 py-0.5 text-[0.65rem] font-medium text-(--ui-blue) tabular-nums">
                    {running}
                  </span>
                )}
                <ToolShortcut actionId={tool.keybind} />
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  )
}

export const SidePanelShell: FC<{ children: ReactNode }> = ({ children }) => {
  const rightOpen = useStore($sidePanelOpen)
  const maximized = useStore($sidePanelMaximized)
  const zones = useStore($sidePanelZones)

  useSidePanelPreviewSync()

  const showTop = zones.top.tabs.length > 0 && !maximized
  const showBottom = zones.bottom.tabs.length > 0 && !maximized
  const showLeft = zones.left.tabs.length > 0 && !maximized
  const showRight = rightOpen

  const activeKindOf = (edge: SidePanelEdge) => {
    const z = zones[edge]

    return z.tabs.find(t => t.id === z.activeTabId)?.kind ?? null
  }

  const terminalVisible =
    (showRight && activeKindOf('right') === 'terminal') ||
    (showBottom && activeKindOf('bottom') === 'terminal') ||
    (showLeft && activeKindOf('left') === 'terminal') ||
    (showTop && activeKindOf('top') === 'terminal')

  // Keep PersistentTerminal mounted & PTY spawned whenever the Terminal tab is active.
  useEffect(() => {
    setTerminalTakeover(terminalVisible)
  }, [terminalVisible])

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" data-side-panel-shell="">
      {/* Neutralize legacy aside edge borders/inset highlights inside side-panel tabs (Files, Changes, etc.). */}
      <style>{`
        [data-side-panel-edge] aside {
          border-left-width: 0 !important;
          border-right-width: 0 !important;
          box-shadow: none !important;
          padding-top: 0 !important;
        }
      `}</style>
      {showTop && (
        <>
          <DockedPanel edge="top" topClearance />
          <ResizeSash edge="top" size={zones.top.size} />
        </>
      )}

      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        {showLeft && (
          <>
            <DockedPanel edge="left" topClearance={!showTop} />
            <ResizeSash edge="left" size={zones.left.size} />
          </>
        )}

        <div
          className={cn('flex min-h-0 min-w-0 flex-1 overflow-hidden', maximized && showRight && 'hidden')}
          onPointerDownCapture={() => $sidePanelFocusedEdge.set(null)}
        >
          {children}
        </div>

        {showRight && (
          <>
            {!maximized && <ResizeSash edge="right" size={zones.right.size} />}
            <DockedPanel edge="right" maximized={maximized} topClearance={!showTop} />
          </>
        )}
      </div>

      {showBottom && (
        <>
          <ResizeSash edge="bottom" size={zones.bottom.size} />
          <DockedPanel edge="bottom" />
        </>
      )}

      <QuickSideTabMenu />
    </div>
  )
}
