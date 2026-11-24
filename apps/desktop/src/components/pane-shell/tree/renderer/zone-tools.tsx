/**
 * The side panel's tool chrome (Claude Code's desktop side-panel model):
 *
 * - `ZoneAddMenu`  — the strip's "+": every tool (Changes, Files, Terminal,
 *   Browser…) with its shortcut; picking one opens it as a tab in THIS zone.
 * - `ZoneToolList` — the same rows as an empty zone's body.
 * - `ZoneMoveMenu` — send the active tab to an edge as its own zone, or pop it
 *   into its own window when it has one.
 *
 * Tools are registered by the app (`registerZoneTool`); the shell only lists
 * and opens them.
 */

import { useStore } from '@nanostores/react'
import type { ReactNode } from 'react'

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
import { useI18n } from '@/i18n'
import { useKeybindHint } from '@/lib/keybinds/use-keybind-hint'
import { cn } from '@/lib/utils'

import { $zoneTools, moveTreePaneToEdge, noteActiveTreeGroup, openZoneTool, type ZoneTool } from '../store'

const GLYPH_CLASS = 'self-center bg-transparent opacity-60 select-none hover:opacity-100 [-webkit-app-region:no-drag]'

function ToolShortcut({ actionId }: { actionId?: string }) {
  const hint = useKeybindHint(actionId ?? '')

  return hint ? <DropdownMenuShortcut>{hint}</DropdownMenuShortcut> : null
}

function StripGlyphTrigger({ icon, label }: { icon: string; label: string }) {
  return (
    <DropdownMenuTrigger asChild>
      <Button
        aria-label={label}
        className={GLYPH_CLASS}
        onPointerDown={event => event.stopPropagation()}
        size="icon-xs"
        title={label}
        type="button"
        variant="ghost"
      >
        <Codicon name={icon} size="0.8125rem" />
      </Button>
    </DropdownMenuTrigger>
  )
}

/** "+": the current pane's own "new tab" first (another Browser, another
 *  session), then every tool. */
export function ZoneAddMenu({
  groupId,
  newTab
}: {
  groupId: string
  newTab: { label: string; onSelect: () => void } | null
}) {
  const { t } = useI18n()
  const tools = useStore($zoneTools)

  return (
    <span
      className="flex shrink-0 items-center [-webkit-app-region:no-drag]"
      data-zone-add={groupId}
      onPointerDownCapture={() => noteActiveTreeGroup(groupId)}
    >
      <DropdownMenu modal={false}>
        <StripGlyphTrigger icon="add" label={t.zones.openTool} />
        <DropdownMenuContent align="start" className="min-w-52">
          {newTab && (
            <>
              <DropdownMenuItem onSelect={newTab.onSelect}>
                <Codicon name="add" size="0.875rem" />
                <span>{newTab.label}</span>
              </DropdownMenuItem>
              {tools.length > 0 && <DropdownMenuSeparator />}
            </>
          )}
          {tools.map(tool => {
            const badge = tool.badge?.()

            return (
              <DropdownMenuItem data-zone-tool={tool.id} key={tool.id} onSelect={() => openZoneTool(tool, groupId)}>
                <Codicon name={tool.icon} size="0.875rem" />
                <span>{tool.label()}</span>
                {badge && (
                  <span className="ml-auto rounded-full bg-(--ui-blue)/15 px-1.5 py-0.5 text-[0.65rem] font-medium text-(--ui-blue) tabular-nums">
                    {badge}
                  </span>
                )}
                <ToolShortcut actionId={tool.keybind} />
              </DropdownMenuItem>
            )
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  )
}

function ToolRow({ groupId, tool }: { groupId: string; tool: ZoneTool }) {
  const hint = useKeybindHint(tool.keybind ?? '')

  return (
    <button
      className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm text-(--ui-text-secondary) hover:bg-(--ui-control-hover-background) hover:text-foreground focus-visible:outline-2 focus-visible:outline-(--ui-accent)"
      data-zone-tool={tool.id}
      onClick={() => openZoneTool(tool, groupId)}
      type="button"
    >
      <Codicon name={tool.icon} size="0.9375rem" />
      <span className="min-w-0 flex-1 truncate">{tool.label()}</span>
      {hint && <span className="shrink-0 text-xs text-(--ui-text-quaternary)">{hint}</span>}
    </button>
  )
}

/** An empty zone's body: the launcher, centered. */
export function ZoneToolList({ fallback, groupId }: { fallback: ReactNode; groupId: string }) {
  const tools = useStore($zoneTools)

  if (tools.length === 0) {
    return <>{fallback}</>
  }

  return (
    <div className="grid h-full place-items-center p-4" data-zone-launcher={groupId}>
      <div className="flex w-full max-w-64 flex-col gap-0.5">
        {tools.map(tool => (
          <ToolRow groupId={groupId} key={tool.id} tool={tool} />
        ))}
      </div>
    </div>
  )
}

const EDGES = [
  { edge: 'left', icon: 'layout-sidebar-left' },
  { edge: 'right', icon: 'layout-sidebar-right' },
  { edge: 'top', icon: 'layout-menubar' },
  { edge: 'bottom', icon: 'layout-panel' }
] as const

/** Move the active tab to an edge · open it in its own window. */
export function ZoneMoveMenu({
  className,
  groupId,
  paneId,
  popOut
}: {
  className?: string
  groupId: string
  paneId: string
  popOut?: () => void
}) {
  const { t } = useI18n()

  const label = {
    bottom: t.zones.moveBottom,
    left: t.zones.moveLeft,
    right: t.zones.moveRight,
    top: t.zones.moveTop
  }

  return (
    <span className={cn('flex shrink-0 items-center', className)} data-zone-move={groupId}>
      <DropdownMenu modal={false}>
        <StripGlyphTrigger icon="screen-full" label={t.zones.panelLayout} />
        <DropdownMenuContent align="end" className="min-w-48">
          <DropdownMenuLabel>{t.zones.moveSection}</DropdownMenuLabel>
          {EDGES.map(({ edge, icon }) => (
            <DropdownMenuItem data-zone-move-edge={edge} key={edge} onSelect={() => moveTreePaneToEdge(paneId, edge)}>
              <Codicon name={icon} size="0.875rem" />
              <span>{label[edge]}</span>
            </DropdownMenuItem>
          ))}
          {popOut && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={popOut}>
                <Codicon name="multiple-windows" size="0.875rem" />
                <span>{t.zones.openInNewWindow}</span>
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  )
}
