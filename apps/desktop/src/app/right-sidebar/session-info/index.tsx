import { useStore } from '@nanostores/react'
import { type FC, type ReactNode, useEffect, useState } from 'react'

import { SIDE_PANEL_TOOL_DEFS } from '@/app/side-panel/side-panel-host'
import { Codicon } from '@/components/ui/codicon'
import { useI18n } from '@/i18n'
import { useKeybindHint } from '@/lib/keybinds/use-keybind-hint'
import { cn } from '@/lib/utils'
import { registerRepoStatusCwd, repoStatusForCwd } from '@/store/coding-status'
import { $connection, $currentCwd, $currentUsage, $selectedStoredSessionId, $sessions } from '@/store/session'
import { $focusedWorkspaceCwd } from '@/store/session-states'
import { openSidePanelTool } from '@/store/side-panel'
import { $subagentsBySession } from '@/store/subagents'

const ToolKeyHint: FC<{ actionId?: string }> = ({ actionId }) => {
  const hint = useKeybindHint(actionId ?? '')

  return hint ? <span className="shrink-0 text-xs text-(--ui-text-quaternary)">{hint}</span> : null
}

const baseName = (path: string) =>
  path
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .pop() || path

const Row: FC<{ icon: string; children: ReactNode; onClick?: () => void; title?: string; trailing?: ReactNode }> = ({
  children,
  icon,
  onClick,
  title,
  trailing
}) => {
  const Tag = onClick ? 'button' : 'div'

  return (
    <Tag
      className={cn(
        'flex w-full min-w-0 items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[0.8125rem] text-(--ui-text-primary)',
        onClick && 'cursor-pointer hover:bg-(--ui-control-hover-background)'
      )}
      onClick={onClick}
      title={title}
      type={onClick ? 'button' : undefined}
    >
      <Codicon className="shrink-0 text-(--ui-text-tertiary)" name={icon} size="0.95rem" />
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {trailing}
    </Tag>
  )
}

const Section: FC<{ children: ReactNode; title?: string }> = ({ children, title }) => (
  <section className="grid gap-0.5 border-b border-(--ui-stroke-tertiary) px-2 py-3 last:border-b-0">
    {title && <h3 className="px-2 pb-1 text-xs font-medium text-(--ui-text-secondary)">{title}</h3>}
    {children}
  </section>
)

/** The repo the folder sits in, by name: the folder itself when it is the repo root. */
function useRepoName(cwd: string): null | string {
  const [root, setRoot] = useState<null | string>(null)

  useEffect(() => {
    let live = true
    setRoot(null)

    if (cwd) {
      void window.hermesDesktop?.gitRoot?.(cwd).then(found => live && setRoot(found ?? null))
    }

    return () => {
      live = false
    }
  }, [cwd])

  return root ? baseName(root) : null
}

/**
 * The right-sidebar launcher (empty state when no tool tab is open): shows
 * where the session runs (machine, folder, repo, branch), context usage, git
 * changes, running subagents/background tasks, and buttons to open tools.
 * Never a tab itself — disappears as soon as a tool opens and returns when the
 * last tab closes.
 */
export const SessionInfoPane: FC = () => {
  const { t } = useI18n()
  const s = t.sessionInfo
  const connection = useStore($connection)
  const focusedWorkspaceCwd = useStore($focusedWorkspaceCwd)
  const currentCwd = useStore($currentCwd)
  const selectedSessionId = useStore($selectedStoredSessionId)
  const sessions = useStore($sessions)
  const usage = useStore($currentUsage)
  const subagentsBySession = useStore($subagentsBySession)

  const activeSession = selectedSessionId ? sessions.find(item => item.id === selectedSessionId) : undefined
  const cwd = focusedWorkspaceCwd?.trim() || currentCwd?.trim() || activeSession?.cwd?.trim() || ''

  const status = useStore(repoStatusForCwd(cwd))
  const repo = useRepoName(cwd)

  useEffect(() => registerRepoStatusCwd(cwd), [cwd])

  const remote = connection?.mode === 'remote'
  const machine = remote ? connection?.remoteHost || s.remote : s.thisComputer
  const folder = cwd ? baseName(cwd) : null
  const percent = usage.context_max ? Math.round(usage.context_percent ?? 0) : null
  const branch = status ? (status.detached ? t.statusStack.coding.detached : status.branch) : null

  const allSubagents = Object.values(subagentsBySession)
    .flat()
    .sort((a, b) => b.updatedAt - a.updatedAt)

  const activeSubagents = allSubagents.filter(item => item.status === 'running' || item.status === 'queued')
  const finishedSubagents = allSubagents.filter(item => item.status !== 'running' && item.status !== 'queued')

  return (
    <div className="h-full overflow-y-auto" data-slot="session-info">
      <Section title={s.environment}>
        <Row icon={remote ? 'remote' : 'device-desktop'}>{machine}</Row>
        {folder && (
          <Row icon="folder" onClick={() => openSidePanelTool('files')} title={cwd}>
            {folder}
          </Row>
        )}
        {repo && repo !== folder && <Row icon="repo">{repo}</Row>}
        {branch && <Row icon="git-branch">{branch}</Row>}
      </Section>

      {percent !== null && (
        <Section>
          <Row
            icon="dashboard"
            trailing={
              <span className="flex items-center gap-2 text-xs text-(--ui-text-tertiary) tabular-nums">
                {percent}%
                <span className="h-1.5 w-8 overflow-hidden rounded-full bg-(--ui-bg-tertiary)">
                  <span
                    className={cn('block h-full rounded-full', percent >= 80 ? 'bg-amber-400' : 'bg-(--ui-blue)')}
                    style={{ width: `${Math.max(4, percent)}%` }}
                  />
                </span>
              </span>
            }
          >
            {s.context}
          </Row>
        </Section>
      )}

      {status && (status.added > 0 || status.removed > 0 || status.changed > 0) && (
        <Section title={s.changes}>
          <Row
            icon="diff"
            onClick={() => openSidePanelTool('review')}
            trailing={
              status.changed > 0 ? (
                <span className="shrink-0 text-xs text-(--ui-text-tertiary) tabular-nums">
                  {status.changed} {status.changed === 1 ? 'file' : 'files'}
                </span>
              ) : undefined
            }
          >
            <span className="text-(--ui-green) tabular-nums">+{status.added.toLocaleString()}</span>{' '}
            <span className="text-(--ui-red) tabular-nums">−{status.removed.toLocaleString()}</span>
          </Row>
        </Section>
      )}

      <Section>
        {SIDE_PANEL_TOOL_DEFS.filter(tool => tool.kind !== 'background-tasks' || allSubagents.length > 0).map(tool => (
          <Row
            icon={tool.icon}
            key={tool.kind}
            onClick={() => openSidePanelTool(tool.kind)}
            trailing={
              tool.kind === 'background-tasks' && activeSubagents.length > 0 ? (
                <span className="rounded-full bg-(--ui-blue)/15 px-1.5 py-0.5 text-[0.65rem] font-medium text-(--ui-blue) tabular-nums">
                  {activeSubagents.length}
                </span>
              ) : (
                <ToolKeyHint actionId={tool.keybind} />
              )
            }
          >
            {tool.label}
          </Row>
        ))}
      </Section>

      {activeSubagents.length > 0 && (
        <Section>
          <div className="flex items-center gap-2 px-2 pb-1 text-xs font-medium text-(--ui-text-secondary)">
            <span>Subagents</span>
            <span className="rounded-full bg-(--ui-bg-tertiary) px-1.5 py-0.5 text-[0.65rem] text-(--ui-text-tertiary) tabular-nums">
              {activeSubagents.length}
            </span>
          </div>
          {activeSubagents.slice(0, 4).map(item => (
            <Row
              icon="loading"
              key={item.id}
              onClick={() => openSidePanelTool('background-tasks')}
              trailing={
                <span className="flex items-center gap-1 text-[0.7rem] text-(--ui-blue) tabular-nums">
                  <span className="size-1.5 animate-pulse rounded-full bg-(--ui-blue)" />
                  running
                </span>
              }
            >
              {item.goal || 'Subagent'}
            </Row>
          ))}
        </Section>
      )}

      {finishedSubagents.length > 0 && (
        <Section>
          <div className="flex items-center gap-2 px-2 pb-1 text-xs font-medium text-(--ui-text-secondary)">
            <span>Background Tasks</span>
            <span className="rounded-full bg-(--ui-bg-tertiary) px-1.5 py-0.5 text-[0.65rem] text-(--ui-text-tertiary) tabular-nums">
              {finishedSubagents.length}
            </span>
          </div>
          {finishedSubagents.slice(0, 4).map(item => (
            <Row
              icon={item.status === 'failed' || item.status === 'interrupted' ? 'error' : 'pass'}
              key={item.id}
              onClick={() => openSidePanelTool('background-tasks')}
            >
              {item.goal || 'Background task'}
            </Row>
          ))}
          {finishedSubagents.length > 4 && (
            <button
              className="px-2 py-1 text-left text-xs text-(--ui-text-tertiary) hover:text-foreground"
              onClick={() => openSidePanelTool('background-tasks')}
              type="button"
            >
              See all
            </button>
          )}
        </Section>
      )}
    </div>
  )
}
