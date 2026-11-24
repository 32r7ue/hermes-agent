/**
 * BROWSER BAR: back / forward / reload / pill search-or-URL bar / Downloads /
 * Select & Annotate / Screenshot to prompt / Open in default browser.
 */

import { useEffect, useRef, useState } from 'react'

import { requestComposerFocus } from '@/app/chat/composer/focus'
import { Codicon } from '@/components/ui/codicon'
import { Input } from '@/components/ui/input'
import { PaneStripGlyph } from '@/components/ui/pane-tab'
import { useI18n } from '@/i18n'
import { isSubmitEnter } from '@/lib/ime'
import { ANNOTATE_BLUE } from '@/lib/preview-annotate'
import { cn } from '@/lib/utils'
import { $sidePanelFocusRequest } from '@/store/side-panel'

interface PreviewBrowserBarProps {
  annotateMode?: boolean
  canGoBack: boolean
  canGoForward: boolean
  commentCount?: number
  consoleOpen: boolean
  devToolsOpen: boolean
  loading: boolean
  onBack: () => void
  onClose?: () => void
  onFlushComments?: () => void
  onForward: () => void
  onNavigate: (url: string) => void
  onOpenExternal?: () => void
  onPopIn?: () => void
  onPopOut?: () => void
  onReload: () => void
  onScreenshot?: () => void
  onToggleAnnotate?: () => void
  onToggleConsole: () => void
  onToggleDevTools: () => void
  url: string
}

/**
 * Turn what the user typed into a navigable URL — or a Google search when it
 * reads like a plain query (spaces, or a single word with no dot/protocol).
 */
export function normalizePreviewAddress(value: string): null | string {
  const address = value.trim()

  if (!address) {
    return null
  }

  const scheme = /^(about|blob|chrome|data|devtools|file|ftp|https?|javascript|view-source):/i.exec(address)?.[1]

  if (scheme && /^(data|javascript)$/i.test(scheme)) {
    return null
  }

  if (scheme) {
    try {
      new URL(address)

      return address
    } catch {
      return null
    }
  }

  const loopback = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?(?:[/?#]|$)/i.test(address)

  const looksLikeHost =
    loopback || (!/\s/.test(address) && /^[a-z0-9-]+(\.[a-z0-9-]+)+(?::\d+)?(?:[/?#].*)?$/i.test(address))

  if (!looksLikeHost) {
    return `https://www.google.com/search?q=${encodeURIComponent(address)}`
  }

  const candidate = `${loopback ? 'http' : 'https'}://${address}`

  try {
    new URL(candidate)

    return candidate
  } catch {
    return `https://www.google.com/search?q=${encodeURIComponent(address)}`
  }
}

export function PreviewBrowserBar({
  annotateMode = false,
  canGoBack,
  canGoForward,
  commentCount = 0,
  loading,
  onBack,
  onFlushComments,
  onForward,
  onNavigate,
  onOpenExternal,
  onReload,
  onScreenshot,
  onToggleAnnotate,
  url
}: PreviewBrowserBarProps) {
  const { t } = useI18n()
  const copy = t.preview.web
  const [draft, setDraft] = useState<null | string>(null)
  const [pending, setPending] = useState<null | string>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const shown = draft ?? pending ?? (url === 'about:blank' ? '' : url)

  useEffect(() => setPending(null), [url])

  // Auto-focus the address bar on a fresh blank Browser tab and whenever
  // Browser is opened/focused via side-panel shortcuts or tabs.
  useEffect(() => {
    const timers: number[] = []

    const focusBar = () => {
      const attempt = () => {
        const el = inputRef.current

        if (el && !el.closest('[data-pane-hidden]')) {
          el.focus()
          el.select()
        }
      }

      requestAnimationFrame(attempt)
      timers.push(window.setTimeout(attempt, 40))
    }

    if (!url || url === 'about:blank') {
      focusBar()
    }

    const unsub = $sidePanelFocusRequest.subscribe(req => {
      if (req?.kind === 'browser') {
        focusBar()
      }
    })

    return () => {
      unsub()
      timers.forEach(id => window.clearTimeout(id))
    }
  }, [url])

  const commit = (value: string) => {
    const address = normalizePreviewAddress(value)

    if (!address) {
      return
    }

    setDraft(null)
    setPending(address)
    onNavigate(address)
  }

  return (
    <div className="flex h-10 shrink-0 items-center gap-1 border-b border-(--ui-stroke-tertiary) bg-(--ui-sidebar-surface-background) px-2">
      <PaneStripGlyph
        disabled={!canGoBack}
        icon={<Codicon name="arrow-left" size="0.875rem" />}
        label={copy.goBack}
        onSelect={onBack}
      />
      <PaneStripGlyph
        disabled={!canGoForward}
        icon={<Codicon name="arrow-right" size="0.875rem" />}
        label={copy.goForward}
        onSelect={onForward}
      />
      <PaneStripGlyph
        icon={<Codicon name="refresh" size="0.875rem" spinning={loading} />}
        label={copy.reload}
        onSelect={onReload}
      />

      {/* Hermes-style square Search or URL bar */}
      <div className="relative mx-1 flex min-w-0 flex-1 items-center">
        <Codicon
          className="pointer-events-none absolute left-2 text-(--ui-text-tertiary)"
          name={loading ? 'loading' : 'search'}
          size="0.8125rem"
          spinning={loading}
        />
        <Input
          aria-label={copy.address}
          className={cn(
            'h-7 w-full rounded-md border-(--ui-stroke-secondary) bg-(--ui-bg-secondary)/70 pl-7 pr-2.5 text-xs'
          )}
          inputMode="url"
          onBlur={() => setDraft(null)}
          onChange={event => setDraft(event.target.value)}
          onFocus={event => {
            setDraft(shown)
            event.currentTarget.select()
          }}
          onKeyDown={event => {
            if (isSubmitEnter(event)) {
              commit(event.currentTarget.value)
              event.currentTarget.blur()
            }

            if (event.key === 'Escape') {
              setDraft(null)
              event.currentTarget.blur()
              requestComposerFocus('active')
            }
          }}
          placeholder="Search Google or enter a URL"
          ref={inputRef}
          size="xs"
          spellCheck={false}
          value={shown}
        />
      </div>

      {/* Right actions: Select & Annotate, Screenshot -> Prompt, Open in Browser (Zen / default) */}
      {onToggleAnnotate ? (
        <PaneStripGlyph
          active={annotateMode}
          icon={<Codicon name="target" size="0.875rem" />}
          label={annotateMode ? copy.annotateOn : 'Select and annotate page'}
          onSelect={onToggleAnnotate}
        />
      ) : null}

      {commentCount > 0 && onFlushComments ? (
        <button
          className="shrink-0 rounded-full px-2 py-0.5 text-[0.6875rem] font-semibold text-white"
          onClick={onFlushComments}
          style={{ background: ANNOTATE_BLUE }}
          type="button"
        >
          {copy.addComments(commentCount)}
        </button>
      ) : null}

      {onScreenshot ? (
        <PaneStripGlyph
          icon={<Codicon name="device-camera" size="0.875rem" />}
          label="Screenshot browser and attach to prompt"
          onSelect={onScreenshot}
        />
      ) : null}

      {onOpenExternal ? (
        <PaneStripGlyph
          disabled={!url || url === 'about:blank'}
          icon={<Codicon name="link-external" size="0.875rem" />}
          label={t.preview.openInBrowser}
          onSelect={onOpenExternal}
        />
      ) : null}
    </div>
  )
}
