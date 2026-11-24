import { useStore } from '@nanostores/react'
import { type ComponentProps, type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { requestComposerFocus } from '@/app/chat/composer/focus'
import { LocalFilePreview } from '@/app/chat/right-rail/preview-file'
import { TreeSkeleton } from '@/components/chat/skeletons'
import { ErrorBoundary } from '@/components/error-boundary'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tip } from '@/components/ui/tooltip'
import { useDelayedTrue } from '@/hooks/use-delayed-true'
import { useI18n } from '@/i18n'
import { readDesktopDir } from '@/lib/desktop-fs'
import { ALWAYS_EXCLUDED } from '@/lib/excluded-paths'
import { normalizeOrLocalPreviewTarget } from '@/lib/local-preview'
import { cn } from '@/lib/utils'
import { refreshRepoStatus, registerRepoStatusCwd } from '@/store/coding-status'
import { notifyError } from '@/store/notifications'
import type { PreviewTarget } from '@/store/preview'
import { openFolderAsProject } from '@/store/projects'
import { $currentCwd, $selectedStoredSessionId, $sessions } from '@/store/session'
import { $focusedWorkspaceCwd } from '@/store/session-states'
import { $filesInlineOpenPath, $sidePanelFocusRequest } from '@/store/side-panel'
import { $subagentsBySession } from '@/store/subagents'

import { SidebarPanelLabel } from '../shell/sidebar-label'

import { FileTypeIcon, ProjectTree } from './files/tree'
import { type TreeNode, useProjectTree } from './files/use-project-tree'

interface RightSidebarPaneProps {
  onActivateFile: (path: string) => void
  onActivateFolder: (path: string) => void
}

interface IndexedFile {
  name: string
  path: string
  relDir: string
  relPath: string
}

const MAX_INDEXED_FILES = 4000
const MAX_SEARCH_RESULTS = 120

function collectLoadedFiles(nodes: readonly TreeNode[], root: string, out: IndexedFile[] = []): IndexedFile[] {
  const cleanRoot = root.replace(/[\\/]+$/, '')

  for (const node of nodes) {
    if (node.placeholder) {
      continue
    }

    if (node.isDirectory) {
      if (node.children) {
        collectLoadedFiles(node.children, cleanRoot, out)
      }
    } else {
      const relPath = node.id.startsWith(`${cleanRoot}/`) ? node.id.slice(cleanRoot.length + 1) : node.name
      const slash = relPath.lastIndexOf('/')
      out.push({
        name: node.name,
        path: node.id,
        relDir: slash >= 0 ? relPath.slice(0, slash) : '',
        relPath
      })
    }
  }

  return out
}

const projectFileIndexCache = new Map<string, IndexedFile[]>()

function useProjectFileIndex(cwd: string, active: boolean, showIgnored: boolean): { files: IndexedFile[]; indexing: boolean } {
  const [files, setFiles] = useState<IndexedFile[]>([])
  const [indexing, setIndexing] = useState(false)

  useEffect(() => {
    if (!active || !cwd) {
      return
    }

    const cacheKey = `${cwd}:${showIgnored ? '1' : '0'}`
    const cached = projectFileIndexCache.get(cacheKey)

    if (cached) {
      setFiles(cached)

      return
    }

    let cancelled = false
    setIndexing(true)

    const cleanRoot = cwd.replace(/[\\/]+$/, '')

    void (async () => {
      const queue: string[] = [cleanRoot]
      const found: IndexedFile[] = []

      while (queue.length > 0 && found.length < MAX_INDEXED_FILES && !cancelled) {
        const dir = queue.shift()!

        try {
          const res = await readDesktopDir(dir)

          for (const entry of res.entries) {
            if (cancelled || found.length >= MAX_INDEXED_FILES) {
              break
            }

            if (ALWAYS_EXCLUDED.has(entry.name)) {
              continue
            }

            if (!showIgnored && entry.name.startsWith('.') && entry.name !== '.env' && entry.name !== '.claude') {
              continue
            }

            const fullPath = `${dir}/${entry.name}`

            if (entry.isDirectory) {
              queue.push(fullPath)
            } else {
              const relPath = fullPath.startsWith(`${cleanRoot}/`) ? fullPath.slice(cleanRoot.length + 1) : entry.name
              const slash = relPath.lastIndexOf('/')
              found.push({
                name: entry.name,
                path: fullPath,
                relDir: slash >= 0 ? relPath.slice(0, slash) : '',
                relPath
              })
            }
          }
        } catch {
          // Skip unreadable subdirectories during background indexing.
        }
      }

      if (!cancelled) {
        projectFileIndexCache.set(cacheKey, found)
        setFiles(found)
        setIndexing(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [active, cwd, showIgnored])

  return { files, indexing }
}

function scoreMatch(item: IndexedFile, needle: string): number {
  const nameLower = item.name.toLowerCase()
  const pathLower = item.relPath.toLowerCase()

  if (nameLower === needle) {
    return 100
  }

  if (nameLower.startsWith(needle)) {
    return 80
  }

  if (nameLower.includes(needle)) {
    return 60
  }

  if (pathLower.includes(needle)) {
    return 40
  }

  // Simple subsequence match on relative path
  let qi = 0

  for (let i = 0; i < pathLower.length && qi < needle.length; i += 1) {
    if (pathLower[i] === needle[qi]) {
      qi += 1
    }
  }

  return qi === needle.length ? 20 : 0
}

function parentDirOf(filePath: string): string {
  const cleaned = filePath.replace(/[\\/]+$/, '')
  const slash = cleaned.lastIndexOf('/')

  return slash > 0 ? cleaned.slice(0, slash) : ''
}

export function RightSidebarPane({ onActivateFile, onActivateFolder }: RightSidebarPaneProps) {
  const { t } = useI18n()
  const r = t.rightSidebar
  const focusedWorkspaceCwd = useStore($focusedWorkspaceCwd)
  const currentCwd = useStore($currentCwd)
  const selectedSessionId = useStore($selectedStoredSessionId)
  const sessions = useStore($sessions)
  const subagentsBySession = useStore($subagentsBySession)

  // Auto-recognize the folder the agent is actively working in — even when no
  // project was explicitly selected in the sidebar.
  const targetCwd = useMemo(() => {
    if (focusedWorkspaceCwd?.trim()) {
      return focusedWorkspaceCwd.trim()
    }

    if (currentCwd?.trim()) {
      return currentCwd.trim()
    }

    const activeSession = selectedSessionId ? sessions.find(s => s.id === selectedSessionId) : undefined

    if (activeSession?.cwd?.trim()) {
      return activeSession.cwd.trim()
    }

    const recentSubagentFiles = (selectedSessionId ? subagentsBySession[selectedSessionId] : undefined)
      ?.flatMap(item => [...item.filesWritten, ...item.filesRead])
      .filter(Boolean)

    if (recentSubagentFiles && recentSubagentFiles.length > 0) {
      return parentDirOf(recentSubagentFiles[0]!)
    }

    return ''
  }, [currentCwd, focusedWorkspaceCwd, selectedSessionId, sessions, subagentsBySession])

  const hasWorkspace = Boolean(targetCwd)

  const [treeVisible, setTreeVisible] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedIdx, setSelectedIdx] = useState(0)
  const [activeFileTarget, setActiveFileTarget] = useState<PreviewTarget | null>(null)
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const searchInputRef = useRef<HTMLInputElement | null>(null)

  const {
    collapseAll,
    collapseNonce,
    data,
    effectiveCwd,
    loadChildren,
    openState,
    refreshRoot,
    rootError,
    rootLoading,
    setNodeOpen,
    setShowIgnored,
    showIgnored
  } = useProjectTree(hasWorkspace ? targetCwd : '')

  // Focus the file search box whenever Files is mounted, opened, or switched to.
  useEffect(() => {
    const timers: number[] = []

    const focusSearch = () => {
      setTreeVisible(true)

      const attempt = () => {
        const el = searchInputRef.current

        if (el && !el.closest('[data-pane-hidden]')) {
          el.focus()
          el.select()
        }
      }

      requestAnimationFrame(attempt)
      timers.push(window.setTimeout(attempt, 40))
    }

    focusSearch()

    const unsub = $sidePanelFocusRequest.subscribe(req => {
      if (req?.kind === 'files') {
        focusSearch()
      }
    })

    return () => {
      unsub()
      timers.forEach(id => window.clearTimeout(id))
    }
  }, [])

  // Reset inline open file when switching workspaces.
  useEffect(() => {
    setActiveFileTarget(null)
    setActiveFilePath(null)
    setSearchQuery('')
  }, [targetCwd])

  useEffect(() => {
    const activeCwd = effectiveCwd || (hasWorkspace ? targetCwd : '')

    if (!activeCwd) {
      return
    }

    return registerRepoStatusCwd(activeCwd)
  }, [effectiveCwd, hasWorkspace, targetCwd])

  const handleRefresh = useCallback(() => {
    void refreshRoot()
    setReloadKey(k => k + 1)
    const activeCwd = effectiveCwd || (hasWorkspace ? targetCwd : '')

    if (activeCwd) {
      void refreshRepoStatus(activeCwd)
    }
  }, [effectiveCwd, hasWorkspace, refreshRoot, targetCwd])

  const cwdName =
    effectiveCwd
      .split(/[\\/]+/)
      .filter(Boolean)
      .pop() ?? effectiveCwd

  const canCollapse = Object.values(openState).some(Boolean)

  const openInlineFile = useCallback(
    async (path: string) => {
      try {
        const preview = await normalizeOrLocalPreviewTarget(path, effectiveCwd || undefined)

        if (!preview) {
          throw new Error(r.couldNotPreview(path))
        }

        setActiveFilePath(path)
        setActiveFileTarget(preview)
        setReloadKey(k => k + 1)
      } catch (error) {
        notifyError(error, r.previewUnavailable)
      }
    },
    [effectiveCwd, r]
  )

  // Open files requested from chat links or tool cards inline inside this viewer.
  useEffect(
    () =>
      $filesInlineOpenPath.subscribe(path => {
        if (!path) {
          return
        }

        $filesInlineOpenPath.set(null)
        void openInlineFile(path)
      }),
    [openInlineFile]
  )

  const normalizedQuery = searchQuery.trim().replace(/^\?+/, '').trim().toLowerCase()
  const isSearching = normalizedQuery.length > 0

  const { files: indexedFiles, indexing } = useProjectFileIndex(effectiveCwd, isSearching, showIgnored)

  const searchResults = useMemo(() => {
    if (!isSearching) {
      return []
    }

    const merged = new Map<string, IndexedFile>()

    for (const item of collectLoadedFiles(data, effectiveCwd)) {
      merged.set(item.path, item)
    }

    for (const item of indexedFiles) {
      merged.set(item.path, item)
    }

    const scored: Array<{ item: IndexedFile; score: number }> = []

    for (const item of merged.values()) {
      const score = scoreMatch(item, normalizedQuery)

      if (score > 0) {
        scored.push({ item, score })
      }
    }

    scored.sort((a, b) => b.score - a.score || a.item.relPath.length - b.item.relPath.length)

    return scored.slice(0, MAX_SEARCH_RESULTS).map(s => s.item)
  }, [data, effectiveCwd, indexedFiles, isSearching, normalizedQuery])

  useEffect(() => {
    setSelectedIdx(0)
  }, [normalizedQuery])

  const handleSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      setSearchQuery('')
      searchInputRef.current?.blur()
      requestComposerFocus('active')

      return
    }

    if (event.key === 'ArrowDown' && searchResults.length > 0) {
      event.preventDefault()
      setSelectedIdx(i => (i + 1) % searchResults.length)

      return
    }

    if (event.key === 'ArrowUp' && searchResults.length > 0) {
      event.preventDefault()
      setSelectedIdx(i => (i - 1 + searchResults.length) % searchResults.length)

      return
    }

    if (event.key === 'Enter' && searchResults.length > 0) {
      event.preventDefault()
      const hit = searchResults[selectedIdx] ?? searchResults[0]

      if (hit) {
        void openInlineFile(hit.path)
      }
    }
  }

  const activeRelPath = useMemo(() => {
    if (!activeFilePath) {
      return null
    }

    const cleanRoot = effectiveCwd.replace(/[\\/]+$/, '')

    return activeFilePath.startsWith(`${cleanRoot}/`) ? activeFilePath.slice(cleanRoot.length + 1) : activeFilePath
  }, [activeFilePath, effectiveCwd])

  return (
    <aside
      aria-label={r.aria}
      className="relative flex h-full w-full min-w-0 flex-col overflow-hidden bg-(--ui-sidebar-surface-background) text-(--ui-text-tertiary)"
    >
      {!hasWorkspace ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
          <SidebarPanelLabel className="pl-0 text-(--ui-text-quaternary)">{r.noProjectOpen}</SidebarPanelLabel>
          <Button className="h-7 gap-1.5 text-xs" onClick={() => void openFolderAsProject()} size="sm" variant="outline">
            <Codicon name="folder-opened" size="0.8125rem" />
            {r.openFolder}
          </Button>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          {/* Top toolbar matching the split Files layout */}
          <div className="flex h-8 shrink-0 items-center justify-between gap-2 border-b border-(--ui-stroke-tertiary) px-2.5">
            <div className="flex min-w-0 flex-1 items-center gap-1.5">
              {activeRelPath ? (
                <>
                  <FileTypeIcon name={activeRelPath.split('/').pop() ?? activeRelPath} />
                  <span className="min-w-0 truncate text-xs text-(--ui-text-primary)" title={activeFilePath ?? undefined}>
                    {activeRelPath}
                  </span>
                  <Button
                    aria-label="Close file"
                    className="size-5 shrink-0 text-(--ui-text-tertiary) hover:text-foreground"
                    onClick={() => {
                      setActiveFileTarget(null)
                      setActiveFilePath(null)
                    }}
                    size="icon-xs"
                    title="Close file"
                    type="button"
                    variant="ghost"
                  >
                    <Codicon name="close" size="0.75rem" />
                  </Button>
                </>
              ) : (
                <span className="truncate text-xs text-(--ui-text-quaternary)">{cwdName}</span>
              )}
            </div>

            <div className="flex shrink-0 items-center gap-0.5">
              <Tip label={r.collapseAll}>
                <Button
                  aria-label={r.collapseAll}
                  className="text-(--ui-text-tertiary) hover:text-foreground"
                  disabled={!canCollapse}
                  onClick={collapseAll}
                  size="icon-xs"
                  type="button"
                  variant="ghost"
                >
                  <Codicon name="collapse-all" size="0.8125rem" />
                </Button>
              </Tip>

              <Tip label={treeVisible ? 'Hide file tree' : 'Show file tree'}>
                <Button
                  aria-label={treeVisible ? 'Hide file tree' : 'Show file tree'}
                  aria-pressed={treeVisible}
                  className={cn(
                    'text-(--ui-text-tertiary) hover:text-foreground',
                    treeVisible && 'bg-(--ui-control-hover-background) text-foreground'
                  )}
                  onClick={() => setTreeVisible(v => !v)}
                  size="icon-xs"
                  type="button"
                  variant="ghost"
                >
                  <Codicon name="list-tree" size="0.8125rem" />
                </Button>
              </Tip>

              <DropdownMenu modal={false}>
                <DropdownMenuTrigger asChild>
                  <Button
                    aria-label="More file options"
                    className="text-(--ui-text-tertiary) hover:text-foreground"
                    size="icon-xs"
                    type="button"
                    variant="ghost"
                  >
                    <Codicon name="ellipsis" size="0.8125rem" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-44">
                  <DropdownMenuItem onSelect={handleRefresh}>
                    <Codicon name="refresh" size="0.875rem" />
                    <span>{r.refreshTree}</span>
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setShowIgnored(!showIgnored)}>
                    <Codicon name={showIgnored ? 'eye-closed' : 'eye'} size="0.875rem" />
                    <span>{showIgnored ? r.hideIgnored : r.showIgnored}</span>
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => void openFolderAsProject()}>
                    <Codicon name="folder-opened" size="0.875rem" />
                    <span>{r.openFolder}</span>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          {/* Split body: open file viewer on LEFT, searchable file tree on RIGHT */}
          <div className="flex min-h-0 flex-1 overflow-hidden">
            <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
              {activeFileTarget ? (
                <LocalFilePreview
                  onClose={() => {
                    setActiveFileTarget(null)
                    setActiveFilePath(null)
                  }}
                  reloadKey={reloadKey}
                  target={activeFileTarget}
                />
              ) : (
                <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1.5 px-6 text-center">
                  <Codicon className="mb-1 text-(--ui-text-tertiary)" name="folder" size="1.5rem" />
                  <div className="text-sm font-medium text-(--ui-text-secondary)">Open files appear here</div>
                  <div className="text-xs text-(--ui-text-tertiary)">Pick a file in the tree.</div>
                </div>
              )}
            </div>

            {treeVisible && (
              <div className="flex w-56 shrink-0 flex-col border-l border-(--ui-stroke-tertiary) bg-(--ui-sidebar-surface-background)">
                <div className="p-2 pb-1.5">
                  <div className="flex h-7 items-center gap-1.5 rounded-md border border-(--ui-stroke-secondary) bg-(--ui-bg-secondary)/60 px-2 transition focus-within:border-(--ui-accent) focus-within:ring-1 focus-within:ring-(--ui-accent)">
                    <Codicon className="shrink-0 text-(--ui-text-tertiary)" name="search" size="0.8125rem" />
                    <input
                      aria-label="Filter or search files"
                      className="min-w-0 flex-1 bg-transparent text-xs text-(--ui-text-primary) placeholder:text-(--ui-text-quaternary) focus:outline-none"
                      onChange={e => setSearchQuery(e.target.value)}
                      onKeyDown={handleSearchKeyDown}
                      placeholder="Filter, or ? to search"
                      ref={searchInputRef}
                      type="text"
                      value={searchQuery}
                    />
                    {searchQuery && (
                      <button
                        aria-label="Clear search"
                        className="grid size-4 shrink-0 place-items-center rounded text-(--ui-text-tertiary) hover:text-foreground"
                        onClick={() => setSearchQuery('')}
                        type="button"
                      >
                        <Codicon name="close" size="0.7rem" />
                      </button>
                    )}
                  </div>
                </div>

                {isSearching ? (
                  <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
                    {searchResults.length === 0 ? (
                      <div className="px-2 py-4 text-center text-xs text-(--ui-text-quaternary)">
                        {indexing ? 'Searching…' : 'No matching files'}
                      </div>
                    ) : (
                      <div className="flex flex-col gap-0.5">
                        {searchResults.map((item, idx) => (
                          <button
                            className={cn(
                              'flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-xs text-(--ui-text-secondary) hover:bg-(--ui-control-hover-background) hover:text-foreground',
                              idx === selectedIdx && 'bg-(--ui-row-active-background) text-foreground'
                            )}
                            key={item.path}
                            onClick={() => void openInlineFile(item.path)}
                            title={item.relPath}
                            type="button"
                          >
                            <span className="flex w-3.5 shrink-0 items-center justify-center">
                              <FileTypeIcon name={item.name} />
                            </span>
                            <span className="min-w-0 flex-1 truncate">{item.name}</span>
                            {item.relDir && (
                              <span className="max-w-20 shrink-0 truncate text-[0.65rem] text-(--ui-text-quaternary)">
                                {item.relDir}
                              </span>
                            )}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                ) : (
                  <FileTreeBody
                    collapseNonce={collapseNonce}
                    cwd={effectiveCwd}
                    data={data}
                    error={rootError}
                    loading={rootLoading}
                    onActivateFile={onActivateFile}
                    onActivateFolder={onActivateFolder}
                    onLoadChildren={loadChildren}
                    onNodeOpenChange={setNodeOpen}
                    onPreviewFile={openInlineFile}
                    onRetry={handleRefresh}
                    openState={openState}
                  />
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </aside>
  )
}

export function RightSidebarSectionHeader({ children, className, ...props }: ComponentProps<'div'>) {
  return (
    <div className={cn('group/project-header flex h-7 shrink-0 items-center px-2.5', className)} {...props}>
      {children}
    </div>
  )
}

interface FileTreeBodyProps {
  collapseNonce: number
  cwd: string
  data: ReturnType<typeof useProjectTree>['data']
  error: string | null
  loading: boolean
  onActivateFile: (path: string) => void
  onActivateFolder: (path: string) => void
  onLoadChildren: (id: string) => void | Promise<void>
  onNodeOpenChange: (id: string, open: boolean) => void
  onPreviewFile?: (path: string) => void
  /** Force-reload the root. The hook also auto-retries while errored, so this
   *  is the impatient-user path. */
  onRetry?: () => void
  openState: ReturnType<typeof useProjectTree>['openState']
}

function FileTreeBody({
  collapseNonce,
  cwd,
  data,
  error,
  loading,
  onActivateFile,
  onActivateFolder,
  onLoadChildren,
  onNodeOpenChange,
  onPreviewFile,
  onRetry,
  openState
}: FileTreeBodyProps) {
  const { t } = useI18n()
  const r = t.rightSidebar
  const showSkeleton = useDelayedTrue(loading && data.length === 0)

  if (!cwd) {
    return <EmptyState body={r.noProjectBody} title={r.noProjectTitle} />
  }

  if (error) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
        <EmptyState body={r.unreadableBody(error)} title={r.unreadableTitle} />
        {onRetry && (
          <button
            className="text-[0.68rem] font-medium text-muted-foreground transition hover:text-foreground"
            onClick={onRetry}
            type="button"
          >
            {r.tryAgain}
          </button>
        )}
      </div>
    )
  }

  if (loading && data.length === 0) {
    return showSkeleton ? <FileTreeLoadingState /> : <div className="min-h-0 flex-1" />
  }

  if (data.length === 0) {
    return <EmptyState body={r.emptyBody} title={r.emptyTitle} />
  }

  return (
    <ErrorBoundary
      fallback={({ reset }) => (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
          <EmptyState body={r.treeErrorBody} title={r.treeErrorTitle} />
          <button
            className="text-[0.68rem] font-medium text-muted-foreground transition hover:text-foreground"
            onClick={reset}
            type="button"
          >
            {r.tryAgain}
          </button>
        </div>
      )}
      key={cwd}
      label="file-tree"
    >
      <ProjectTree
        collapseNonce={collapseNonce}
        cwd={cwd}
        data={data}
        onActivateFile={onActivateFile}
        onActivateFolder={onActivateFolder}
        onLoadChildren={onLoadChildren}
        onNodeOpenChange={onNodeOpenChange}
        onPreviewFile={onPreviewFile}
        openState={openState}
      />
    </ErrorBoundary>
  )
}

function FileTreeLoadingState() {
  const { t } = useI18n()

  return (
    <div aria-label={t.rightSidebar.loadingTree} className="min-h-0 flex-1" role="status">
      <TreeSkeleton />
    </div>
  )
}

export function PaneEmptyState({ label }: { label: string }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-4">
      <SidebarPanelLabel className="pl-0 text-(--ui-text-quaternary)">{label}</SidebarPanelLabel>
    </div>
  )
}

export function EmptyState({ body, title }: { body: string; title?: string }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 px-4 text-center">
      {title && (
        <div className="text-[0.7rem] font-semibold uppercase tracking-[0.07em] text-muted-foreground/75">{title}</div>
      )}
      <div className="text-[0.68rem] leading-relaxed text-muted-foreground/65">{body}</div>
    </div>
  )
}
