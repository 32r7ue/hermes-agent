import { useAuiState } from '@assistant-ui/react'
import { useStore } from '@nanostores/react'
import { type FC, useEffect, useMemo, useRef } from 'react'

import { requestComposerSubmit } from '@/app/chat/composer/focus'
import { useComposerScope, useComposerSurfaceId } from '@/app/chat/composer/scope'
import { useSessionView } from '@/app/chat/session-view'
import { InlineCommandInput, useInlineCommandRunner } from '@/components/chat/inline-command'
import { WIDGET_SHELL_CLASS } from '@/components/chat/widget-shell'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { Kbd } from '@/components/ui/kbd'
import { formatCombo } from '@/lib/keybinds/combo'
import { cn } from '@/lib/utils'
import { registerNextStepAsk } from '@/store/next-step-ask'

// Untrusted model output: keep it one short line of question and a button-sized label.
const QUESTION_MAX = 140
const ACTION_MAX = 32
// A command is not collapsed (quoting matters), only trimmed and bounded.
const COMMAND_MAX = 2000

const clean = (value: string | undefined, max: number) => (value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)

/**
 * `::ask{q="Commit both changes?" action="Commit"}` — the agent's one pending decision at the end of
 * a reply: the question and a single button that answers yes (⌘↩ from an empty composer). Answering
 * no is just writing the next message. Only the last reply's ask is live; once anything follows it,
 * or while a turn runs, nothing renders.
 *
 * With `cmd="hermes gateway restart"` the button runs that command first (the shell-fence Run path:
 * local PTY, never shown), and only once it exits is the agent resumed with the action plus the
 * command's exit code and output. The panel looks the same; while the command runs the button
 * spins and is inert, and a terminal prompt (password, y/n) gets the inline answer box.
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
  const command = (attrs.cmd ?? '').trim().slice(0, COMMAND_MAX)
  const view = useSessionView()
  const runtimeId = useStore(view.$runtimeId)
  const storedId = useStore(view.$storedId)
  const sessionId = runtimeId ?? storedId
  const messageId = useAuiState(s => s.message.id)

  const owner = useMemo(
    () => (command && sessionId ? { sessionId, messageId } : undefined),
    [command, messageId, sessionId]
  )

  const runner = useInlineCommandRunner(owner)
  const shown = live && !streaming && Boolean(question && action)
  const { canRun, execute, running } = runner

  // One explicit press = one run; the runner also refuses re-entry while a run is in flight.
  const answer = command
    ? () => {
        if (canRun) {
          void execute(command, action)
        }
      }
    : () => void requestComposerSubmit(action, { surfaceId, target })

  const answerRef = useRef(answer)
  answerRef.current = answer

  useEffect(() => {
    if (!shown || !surfaceId || running) {
      return
    }

    return registerNextStepAsk(surfaceId, () => answerRef.current())
  }, [running, shown, surfaceId])

  if (!shown) {
    return null
  }

  // Same panel as the "N files changed" card: widget shell, hairline, tool-size
  // sans text; the action keeps its filled button.
  return (
    <>
      <div
        className={cn(
          WIDGET_SHELL_CLASS,
          'mt-(--turn-block-gap) flex max-w-160 flex-col gap-2.5 rounded-xl border border-(--ui-stroke-secondary) font-sans text-[length:var(--conversation-tool-font-size)]'
        )}
        data-slot="aui_next-step-ask"
      >
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 text-(--ui-text-primary)">{question}</span>
          <Button
            aria-busy={running || undefined}
            className="shrink-0 gap-2"
            data-slot="aui_next-step-ask-action"
            disabled={running}
            onClick={answer}
            size="sm"
            type="button"
          >
            {action}
            {running ? (
              <Codicon className="animate-spin opacity-60" name="loading" size="0.875rem" />
            ) : (
              /* Ink of the button itself, not the grey key chip, which washes out on a filled button. */
              <Kbd
                className="border-0 bg-transparent px-0 text-current opacity-60 shadow-none"
                size="sm"
                variant="ghost"
              >
                {formatCombo('mod+enter')}
              </Kbd>
            )}
          </Button>
        </div>
        {/* The command's terminal question belongs to this decision: it answers inside the panel. */}
        {command && (
          <InlineCommandInput
            className="border-t border-(--ui-stroke-tertiary) pt-2.5"
            runner={runner}
            showInput={Boolean(runner.prompt)}
          />
        )}
      </div>
    </>
  )
}
