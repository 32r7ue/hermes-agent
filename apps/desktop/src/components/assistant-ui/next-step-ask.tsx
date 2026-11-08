import { useAuiState } from '@assistant-ui/react'
import { type FC, useEffect } from 'react'

import { requestComposerSubmit } from '@/app/chat/composer/focus'
import { useComposerScope, useComposerSurfaceId } from '@/app/chat/composer/scope'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { formatCombo } from '@/lib/keybinds/combo'
import { registerNextStepAsk } from '@/store/next-step-ask'

// Untrusted model output: keep it one short line of question and a button-sized label.
const QUESTION_MAX = 140
const ACTION_MAX = 32

const clean = (value: string | undefined, max: number) => (value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)

/**
 * `::ask{q="Commit both changes?" action="Commit"}` — the agent's one pending decision at the end of
 * a reply: the question and a single button that answers yes (⌘↩ from an empty composer). Answering
 * no is just writing the next message. Only the last reply's ask is live; once anything follows it,
 * or while a turn runs, nothing renders.
 */
export const NextStepAsk: FC<{ attrs: Readonly<Record<string, string>>; streaming: boolean }> = ({
  attrs,
  streaming
}) => {
  const question = clean(attrs.q ?? attrs.question, QUESTION_MAX)
  const action = clean(attrs.action, ACTION_MAX)
  const live = useAuiState(s => s.message.isLast && !s.thread.isRunning)
  const { target } = useComposerScope()
  const surfaceId = useComposerSurfaceId()
  const shown = live && !streaming && Boolean(question && action)

  useEffect(() => {
    if (!shown || !surfaceId) {
      return
    }

    return registerNextStepAsk(surfaceId, () => void requestComposerSubmit(action, { surfaceId, target }))
  }, [action, shown, surfaceId, target])

  if (!shown) {
    return null
  }

  return (
    <div
      className="mt-(--turn-block-gap) flex max-w-160 items-center gap-3 rounded-xl border border-(--ui-stroke-secondary) py-2.5 pr-2.5 pl-4"
      data-slot="aui_next-step-ask"
    >
      <span className="min-w-0 flex-1 text-[0.875rem] text-(--ui-text-primary)">{question}</span>
      <Button
        className="shrink-0 gap-2"
        data-slot="aui_next-step-ask-action"
        onClick={() => void requestComposerSubmit(action, { surfaceId, target })}
        size="sm"
        type="button"
      >
        {action}
        {/* Ink of the button itself, not the grey key chip, which washes out on a filled button. */}
        <Kbd className="border-0 bg-transparent px-0 text-current opacity-60 shadow-none" size="sm" variant="ghost">
          {formatCombo('mod+enter')}
        </Kbd>
      </Button>
    </div>
  )
}
