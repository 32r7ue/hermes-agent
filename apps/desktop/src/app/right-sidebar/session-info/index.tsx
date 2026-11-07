import { useStore } from '@nanostores/react'
import { type FC, type ReactNode, useEffect, useState } from 'react'

import { toggleTerminalPane } from '@/app/right-sidebar/terminal/reveal-focus'
import { Codicon } from '@/components/ui/codicon'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import { registerRepoStatusCwd, repoStatusForCwd } from '@/store/coding-status'
import { dockBelowSessionPanel, setFileBrowserOpen } from '@/store/layout'
import { openReview } from '@/store/review'
import { $connection, $currentCwd, $currentUsage } from '@/store/session'

// The panel's doors open their tool beneath it, in the same column.
const openFiles = () => {
  dockBelowSessionPanel('files')
  setFileBrowserOpen(true)
}

const openReviewBelow = () => {
  dockBelowSessionPanel('review')
  openReview()
}

const openTerminal = () => {
  dockBelowSessionPanel('terminal')
  toggleTerminalPane()
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
 * The session at a glance, for wide windows: where it runs (machine, folder, repo, branch), how full its
 * context is, what it has changed, and doors to the tools beside it. The right edge's own column: the
 * titlebar's right button and ⌘B show and hide it whole, and its doors stack their tool beneath it.
 */
export const SessionInfoPane: FC = () => {
  const { t } = useI18n()
  const s = t.sessionInfo
  const connection = useStore($connection)
  const cwd = useStore($currentCwd)
  const usage = useStore($currentUsage)
  const status = useStore(repoStatusForCwd(cwd))
  const repo = useRepoName(cwd)

  useEffect(() => registerRepoStatusCwd(cwd), [cwd])

  const remote = connection?.mode === 'remote'
  const machine = remote ? connection?.remoteHost || s.remote : s.thisComputer
  const folder = cwd ? baseName(cwd) : null
  const percent = usage.context_max ? Math.round(usage.context_percent ?? 0) : null
  const branch = status ? (status.detached ? t.statusStack.coding.detached : status.branch) : null

  return (
    <div className="h-full overflow-y-auto" data-slot="session-info">
      <Section title={s.environment}>
        <Row icon={remote ? 'remote' : 'device-desktop'}>{machine}</Row>
        {folder && (
          <Row icon="folder" onClick={openFiles} title={cwd}>
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
          <Row icon="diff" onClick={openReviewBelow}>
            <span className="text-(--ui-green) tabular-nums">+{status.added.toLocaleString()}</span>{' '}
            <span className="text-(--ui-red) tabular-nums">−{status.removed.toLocaleString()}</span>
          </Row>
        </Section>
      )}

      <Section>
        <Row icon="terminal" onClick={openTerminal}>
          {t.sidebar.terminal}
        </Row>
        <Row icon="files" onClick={openFiles}>
          {t.sidebar.files}
        </Row>
        <Row icon="git-compare" onClick={openReviewBelow}>
          {t.sidebar.review}
        </Row>
      </Section>
    </div>
  )
}
