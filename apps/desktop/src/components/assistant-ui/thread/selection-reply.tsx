import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { requestComposerInsert } from '@/app/chat/composer/focus'
import { useComposerScope } from '@/app/chat/composer/scope'
import { usePaneVisible } from '@/components/pane-shell/pane-visibility'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'

interface SelectedQuote {
  text: string
  x: number
  y: number
}

// One `>` per marking, not per line: a four-line selection read as four
// separate quotes to the model. Markdown's lazy continuation keeps the
// following lines in the same blockquote; inner blank lines would end it, so
// they collapse, and the trailing blank line closes the marking.
export const quoteSelection = (text: string): string =>
  `> ${text
    .trim()
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .join('\n')}\n\n`

/** Quote into the owning draft; selecting text never changes the transcript. */
export function SelectionReply() {
  const marker = useRef<HTMLSpanElement>(null)
  const [quote, setQuote] = useState<SelectedQuote | null>(null)
  const { target } = useComposerScope()
  const visible = usePaneVisible()
  const { t } = useI18n()

  useEffect(() => {
    setQuote(null)
    const dismiss = () => setQuote(null)

    const update = () => {
      const root = marker.current?.parentElement
      const selection = window.getSelection()

      if (!visible || !root || !selection?.rangeCount || selection.isCollapsed) {
        return dismiss()
      }

      const range = selection.getRangeAt(0)
      const element = (node: Node) => (node instanceof Element ? node : node.parentElement)
      const start = element(range.startContainer)?.closest('[data-role]')
      const end = element(range.endContainer)?.closest('[data-role]')

      if (
        !start ||
        start !== end ||
        !root.contains(start) ||
        element(range.startContainer)?.closest('[contenteditable]')
      ) {
        return dismiss()
      }

      const text = selection.toString().trim()

      if (!text) {
        return dismiss()
      }

      const rect = range.getBoundingClientRect()
      setQuote({ text, x: Math.max(8, Math.min(rect.left, window.innerWidth - 210)), y: Math.max(8, rect.top - 40) })
    }

    const key = (event: KeyboardEvent) => (event.key === 'Escape' ? dismiss() : update())
    document.addEventListener('selectionchange', update)
    document.addEventListener('pointerup', update)
    document.addEventListener('keyup', key)
    window.addEventListener('scroll', dismiss, true)
    window.addEventListener('resize', dismiss)

    return () => {
      document.removeEventListener('selectionchange', update)
      document.removeEventListener('pointerup', update)
      document.removeEventListener('keyup', key)
      window.removeEventListener('scroll', dismiss, true)
      window.removeEventListener('resize', dismiss)
    }
  }, [visible])

  return (
    <>
      <span hidden ref={marker} />
      {visible && quote &&
        createPortal(
          <div
            className="fixed z-(--z-over-modal) rounded-lg border border-(--ui-stroke-tertiary) bg-(--dt-card) shadow-nous"
            style={{ left: quote.x, top: quote.y }}
          >
            <Button
              onClick={() => {
                requestComposerInsert(quoteSelection(quote.text), { target, mode: 'quote' })
                window.getSelection()?.removeAllRanges()
                setQuote(null)
              }}
              onPointerDown={event => event.preventDefault()}
              size="sm"
              variant="ghost"
            >
              {t.conversationUi.reply}
            </Button>
          </div>,
          document.body
        )}
    </>
  )
}
