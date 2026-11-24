import { useStore } from '@nanostores/react'
import { type FC, useMemo, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { cn } from '@/lib/utils'
import { $selectedStoredSessionId, $sessions } from '@/store/session'
import { $subagentsBySession, type SubagentProgress } from '@/store/subagents'

const ACTIVE_STATUSES = new Set(['running', 'queued'])

function formatDuration(item: SubagentProgress): string {
  const seconds =
    typeof item.durationSeconds === 'number'
      ? item.durationSeconds
      : Math.max(0, Math.round((item.updatedAt - item.startedAt) / 1000))

  if (seconds < 60) {
    return `${seconds}s`
  }

  const mins = Math.floor(seconds / 60)
  const rem = seconds % 60

  return rem > 0 ? `${mins}m ${rem}s` : `${mins}m`
}

const TaskRow: FC<{ item: SubagentProgress; sessionLabel?: string }> = ({ item, sessionLabel }) => {
  const [expanded, setExpanded] = useState(false)
  const isRunning = ACTIVE_STATUSES.has(item.status)
  const isFailed = item.status === 'failed' || item.status === 'interrupted'

  return (
    <div className="rounded-lg border border-(--ui-stroke-tertiary) bg-(--ui-bg-secondary)/60">
      <button
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[0.8125rem] text-(--ui-text-primary) hover:bg-(--ui-control-hover-background)/60"
        onClick={() => setExpanded(prev => !prev)}
        type="button"
      >
        <Codicon
          className="shrink-0 text-(--ui-text-tertiary)"
          name={expanded ? 'chevron-down' : 'chevron-right'}
          size="0.8125rem"
        />
        <span
          className={cn(
            'size-1.5 shrink-0 rounded-full',
            isRunning ? 'animate-pulse bg-(--ui-blue)' : isFailed ? 'bg-(--ui-red)' : 'bg-(--ui-green)'
          )}
        />
        <span className="min-w-0 flex-1 truncate font-medium">{item.goal || 'Subagent task'}</span>
        {item.currentTool && isRunning && (
          <span className="max-w-28 shrink-0 truncate text-[0.7rem] text-(--ui-text-tertiary)">{item.currentTool}</span>
        )}
        <span className="shrink-0 text-[0.7rem] text-(--ui-text-quaternary) tabular-nums">{formatDuration(item)}</span>
      </button>

      {expanded && (
        <div className="space-y-1.5 border-t border-(--ui-stroke-tertiary) px-3 py-2 text-xs text-(--ui-text-secondary)">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.7rem] text-(--ui-text-tertiary)">
            <span>Status: {item.status}</span>
            {item.model && <span>Model: {item.model}</span>}
            {typeof item.toolCount === 'number' && item.toolCount > 0 && <span>{item.toolCount} tools</span>}
            {sessionLabel && <span className="truncate">Session: {sessionLabel}</span>}
          </div>
          {item.summary && <p className="whitespace-pre-wrap text-(--ui-text-primary)">{item.summary}</p>}
          {item.stream.length > 0 && (
            <div className="max-h-40 space-y-1 overflow-y-auto rounded bg-(--ui-bg-tertiary)/50 p-2 font-mono text-[0.7rem]">
              {item.stream.slice(-8).map((entry, idx) => (
                <div
                  className={cn(
                    'truncate',
                    entry.isError ? 'text-(--ui-red)' : 'text-(--ui-text-secondary)'
                  )}
                  key={`${entry.at}-${idx}`}
                >
                  {entry.text}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export const BackgroundTasksPane: FC = () => {
  const subagentsBySession = useStore($subagentsBySession)
  const activeSessionId = useStore($selectedStoredSessionId)
  const sessions = useStore($sessions)
  const [dismissedIds, setDismissedIds] = useState<ReadonlySet<string>>(() => new Set())
  const [runningOpen, setRunningOpen] = useState(true)
  const [finishedOpen, setFinishedOpen] = useState(true)

  const sessionTitleById = useMemo(
    () => new Map(sessions.map(s => [s.id, s.title?.trim() || ''])),
    [sessions]
  )

  const { finished, running } = useMemo(() => {
    const all: Array<{ item: SubagentProgress; sessionId: string }> = []

    for (const [sid, list] of Object.entries(subagentsBySession)) {
      for (const item of list) {
        if (!dismissedIds.has(`${sid}:${item.id}`)) {
          all.push({ item, sessionId: sid })
        }
      }
    }

    all.sort((a, b) => b.item.updatedAt - a.item.updatedAt)

    return {
      finished: all.filter(entry => !ACTIVE_STATUSES.has(entry.item.status)),
      running: all.filter(entry => ACTIVE_STATUSES.has(entry.item.status))
    }
  }, [dismissedIds, subagentsBySession])

  const clearFinished = () => {
    setDismissedIds(prev => {
      const next = new Set(prev)

      for (const entry of finished) {
        next.add(`${entry.sessionId}:${entry.item.id}`)
      }

      return next
    })
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-(--ui-sidebar-surface-background)" data-slot="background-tasks">
      <div className="flex h-8 shrink-0 items-center justify-between border-b border-(--ui-stroke-tertiary) px-3">
        <span className="text-xs font-medium text-(--ui-text-secondary)">Background tasks</span>
        {finished.length > 0 && (
          <Button
            aria-label="Clear finished tasks"
            className="text-(--ui-text-tertiary) hover:text-foreground"
            onClick={clearFinished}
            size="icon-xs"
            title="Clear finished tasks"
            type="button"
            variant="ghost"
          >
            <Codicon name="trash" size="0.8125rem" />
          </Button>
        )}
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
        {running.length === 0 && finished.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-1.5 px-4 text-center">
            <Codicon className="text-(--ui-text-quaternary)" name="layers" size="1.5rem" />
            <div className="text-sm font-medium text-(--ui-text-secondary)">No background tasks</div>
            <div className="text-xs text-(--ui-text-tertiary)">
              Subagents and background tasks will appear here while they run.
            </div>
          </div>
        ) : (
          <>
            {running.length > 0 && (
              <section className="space-y-2">
                <button
                  className="flex items-center gap-1.5 text-xs font-medium text-(--ui-text-secondary) hover:text-foreground"
                  onClick={() => setRunningOpen(v => !v)}
                  type="button"
                >
                  <Codicon name={runningOpen ? 'chevron-down' : 'chevron-right'} size="0.75rem" />
                  <span>Running</span>
                  <span className="text-(--ui-text-quaternary) tabular-nums">{running.length}</span>
                </button>
                {runningOpen && (
                  <div className="space-y-1.5">
                    {running.map(({ item, sessionId }) => (
                      <TaskRow
                        item={item}
                        key={`${sessionId}:${item.id}`}
                        sessionLabel={sessionId !== activeSessionId ? sessionTitleById.get(sessionId) : undefined}
                      />
                    ))}
                  </div>
                )}
              </section>
            )}

            {finished.length > 0 && (
              <section className="space-y-2">
                <button
                  className="flex items-center gap-1.5 text-xs font-medium text-(--ui-text-secondary) hover:text-foreground"
                  onClick={() => setFinishedOpen(v => !v)}
                  type="button"
                >
                  <Codicon name={finishedOpen ? 'chevron-down' : 'chevron-right'} size="0.75rem" />
                  <span>Finished</span>
                  <span className="text-(--ui-text-quaternary) tabular-nums">{finished.length}</span>
                </button>
                {finishedOpen && (
                  <div className="space-y-1.5">
                    {finished.map(({ item, sessionId }) => (
                      <TaskRow
                        item={item}
                        key={`${sessionId}:${item.id}`}
                        sessionLabel={sessionId !== activeSessionId ? sessionTitleById.get(sessionId) : undefined}
                      />
                    ))}
                  </div>
                )}
              </section>
            )}
          </>
        )}
      </div>
    </div>
  )
}
