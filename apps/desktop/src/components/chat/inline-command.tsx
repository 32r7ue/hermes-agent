import { randomUuid } from '@hermes/shared'
import { stripAnsi } from '@hermes/shared/ansi'
import { useStore } from '@nanostores/react'
import { useEffect, useRef, useState } from 'react'

import { GATEWAY_NOT_CONNECTED_MESSAGE } from '@/api/dial-readiness'
import { useSessionView } from '@/app/chat/session-view'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import { registryConnectionKind } from '@/store/connection-registry-state'
import { $gateway } from '@/store/gateway'
import { ambientRequestFor } from '@/store/session-gone-latch'
import { knownOwnerForSession, requestForOwnedSession } from '@/store/session-states'

export function isExecutableFence(language: string | undefined): boolean {
  return /^(bash|sh|zsh|shell|console|terminal)$/i.test(language ?? '')
}

export interface InlineCommandOwner {
  sessionId: string
  messageId: string
}

/** What the agent receives once a command it proposed has run. `lead` (the `::ask` action the user
 *  pressed) opens the message so the turn reads as the user's answer. */
export function inlineCommandResultPrompt(command: string, code: null | number, output: string, lead?: string): string {
  const result = `The user ran this command from your answer:\n\n${command}\n\nExit code: ${code}\nOutput:\n${output}\n\nContinue from this result. Do not repeat the command output unless it is needed to answer the user.`

  return lead ? `${lead}\n\n${result}` : result
}

const RESULT_SUBMIT_DEADLINE_MS = 60_000
const RESULT_SUBMIT_RETRY_MS = 1_000

type Gateway = NonNullable<ReturnType<typeof $gateway.get>>

const isNotConnected = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).includes(GATEWAY_NOT_CONNECTED_MESSAGE)

/** Hand a command's outcome back to its agent. The command may itself have restarted the gateway
 *  (`hermes gateway restart --detach`): the socket is then down for a few seconds, so keep retrying
 *  against whatever gateway is current instead of reporting "not connected". The submission id
 *  stays the same across attempts, so a retry can never queue the result twice. Once reconnected,
 *  a session the restart dropped is resumed once before the final attempt. */
export async function submitCommandResult({
  fallbackGateway,
  ownerSessionId,
  params,
  retryMs = RESULT_SUBMIT_RETRY_MS,
  deadlineMs = RESULT_SUBMIT_DEADLINE_MS
}: {
  deadlineMs?: number
  fallbackGateway: Gateway
  ownerSessionId: string
  params: Record<string, unknown> & { session_id: string }
  retryMs?: number
}): Promise<unknown> {
  const deadline = Date.now() + deadlineMs
  const ambient = () => ambientRequestFor($gateway.get() ?? fallbackGateway)
  let reconnected = false
  let resumed = false

  for (;;) {
    try {
      return await requestForOwnedSession(ownerSessionId, ambient(), 'prompt.submit', params)
    } catch (error) {
      if (isNotConnected(error)) {
        if (Date.now() >= deadline) {
          throw error
        }

        reconnected = true
        await new Promise(resolve => setTimeout(resolve, retryMs))

        continue
      }

      if (!reconnected || resumed) {
        throw error
      }

      resumed = true
      const { session_id } = await requestForOwnedSession<{ session_id: string }>(
        ownerSessionId,
        ambient(),
        'session.resume',
        { session_id: ownerSessionId }
      )

      params = { ...params, session_id }
    }
  }
}

/**
 * Runs a model-proposed command in a local PTY on an explicit user action, then resumes the owning
 * agent with the outcome as a hidden, queued turn. TTY output stays off the transcript. Shared by the
 * Run button on shell fences and by `::ask{... cmd="..."}`.
 */
export function useInlineCommandRunner(owner: InlineCommandOwner | undefined) {
  const view = useSessionView()
  const runtimeId = useStore(view.$runtimeId)
  const storedId = useStore(view.$storedId)
  const busy = useStore(view.$busy)
  const sessionId = runtimeId ?? storedId
  const [running, setRunning] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [error, setError] = useState('')
  const terminalId = useRef<string | null>(null)
  const subscriptions = useRef<(() => void)[]>([])
  const active = useRef(false)

  useEffect(
    () => () => {
      active.current = false
      subscriptions.current.splice(0).forEach(unsubscribe => unsubscribe())

      if (terminalId.current) {
        void window.hermesDesktop.terminal.dispose(terminalId.current)
      }
    },
    []
  )

  const execute = async (command: string, lead?: string) => {
    const gateway = $gateway.get()
    const ownerSessionId = view.$runtimeId.get() ?? view.$storedId.get()

    if (
      !owner ||
      active.current ||
      view.$busy.get() ||
      !gateway ||
      ownerSessionId !== owner.sessionId ||
      !view.$messages.get().some(message => message.id === owner.messageId)
    ) {
      return
    }

    active.current = true
    setRunning(true)
    setError('')
    setPrompt('')

    try {
      const route = knownOwnerForSession(ownerSessionId)

      if (
        route &&
        typeof route === 'object' &&
        (route.mode === 'remote' || registryConnectionKind(route.connectionId) !== 'local')
      ) {
        throw new Error('Inline commands require a local terminal connection')
      }

      const ambient = ambientRequestFor(gateway)
      let targetId = view.$runtimeId.get()

      if (!targetId) {
        const resumed = await requestForOwnedSession<{ session_id: string }>(
          ownerSessionId,
          ambient,
          'session.resume',
          { session_id: ownerSessionId }
        )

        targetId = resumed.session_id
      }

      if (!active.current || (view.$runtimeId.get() !== ownerSessionId && view.$storedId.get() !== ownerSessionId)) {
        active.current = false
        setRunning(false)

        return
      }

      // Ask the canonical owner to validate the frozen local terminal policy and cwd.
      const location = await requestForOwnedSession<{ stdout: string }>(ownerSessionId, ambient, 'shell.exec', {
        session_id: targetId,
        command: 'pwd'
      })

      if (!active.current) {
        return
      }

      const terminal = window.hermesDesktop.terminal
      const session = await terminal.start({ command, cwd: location.stdout.trim(), cols: 100, rows: 24 })

      if (!active.current) {
        await terminal.dispose(session.id)

        return
      }

      terminalId.current = session.id
      let output = ''
      subscriptions.current.push(
        terminal.onData(session.id, data => {
          // Strip terminal control sequences; keep a bounded result for the agent.
          output = (output + stripAnsi(data).replace(/\r/g, '')).slice(-16000)
          const question = terminalQuestion(output.trimEnd().split('\n').at(-1) ?? '')

          if (question) {
            setPrompt(question)
          }
        })
      )
      subscriptions.current.push(
        terminal.onExit(session.id, ({ code }) => {
          terminalId.current = null
          subscriptions.current.splice(0).forEach(unsubscribe => unsubscribe())
          setPrompt('')
          // Capture the original session and dispatcher; changing chat cannot retarget this result.
          void submitCommandResult({
            fallbackGateway: gateway,
            ownerSessionId,
            params: {
              session_id: targetId,
              submission_id: randomUuid(),
              display_kind: 'hidden',
              queued: true,
              text: inlineCommandResultPrompt(command, code, output, lead)
            }
          })
            .catch(err => setError(String(err)))
            .finally(() => {
              active.current = false
              setRunning(false)
            })
        })
      )
      await terminal.attach(session.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      active.current = false
      setRunning(false)
    }
  }

  const write = (data: string) => {
    if (terminalId.current) {
      void window.hermesDesktop.terminal.write(terminalId.current, data)
    }
  }

  return {
    /** False while a run is in flight, a turn is live, or another session owns the view. */
    canRun: Boolean(owner && sessionId && sessionId === owner.sessionId) && !running && !busy,
    clearPrompt: () => setPrompt(''),
    error,
    execute,
    prompt,
    running,
    write
  }
}

export type InlineCommandRunner = ReturnType<typeof useInlineCommandRunner>

/** The last output line when it asks the user something (password, y/n, "press Enter"), else null.
 *  Box-drawing borders are stripped first, and a line that mentions Ctrl+C is a hint about stopping
 *  a long-running command (a foreground server's "Press Ctrl+C to stop" banner), never a question. */
export function terminalQuestion(line: string): null | string {
  const text = line.replace(/[│┃║╎╏┆┇┊┋]/g, ' ').trim()

  if (!text || /\bctrl[-+ ]?c\b|\^c\b/i.test(text)) {
    return null
  }

  return /password|passphrase|\by\/n\b|\byes\/no\b|press .*|enter .*|\?\s*$|:\s*$/i.test(text) ? text.slice(-400) : null
}

/** `(y/N)`, `[Y/n]`, `yes/no`: a two-way terminal question answered with buttons, not typing.
 *  The capitalised letter is the command's default, so that button is the filled one. */
export function yesNoDefault(prompt: string): 'n' | 'y' | null {
  const match = /[([]\s*([yY])\s*\/\s*([nN])\s*[)\]]|\b(yes)\/(no)\b/i.exec(prompt)

  if (!match) {
    return null
  }

  return match[2] === 'N' && match[1] === 'y' ? 'n' : 'y'
}

/** Answer box for a running command's terminal prompt (password, y/n, Ctrl-C), plus its run error.
 *  `className` places it: a fence pads it under the code; the ask panel nests it under its hairline. */
export function InlineCommandInput({
  className,
  runner,
  showInput = true
}: {
  className?: string
  runner: InlineCommandRunner
  showInput?: boolean
}) {
  const { t } = useI18n()
  const [input, setInput] = useState('')
  const yesNo = yesNoDefault(runner.prompt)

  const answer = (value: string) => {
    runner.write(`${value}\r`)
    setInput('')
    runner.clearPrompt()
  }

  return (
    <>
      {runner.running && showInput && (
        <form
          className={cn(
            'flex items-center gap-2 font-sans text-[length:var(--conversation-tool-font-size)]',
            className ?? 'border-t border-(--ui-stroke-tertiary) px-3 py-2'
          )}
          data-slot="inline-command-input"
          onSubmit={event => {
            event.preventDefault()
            answer(input)
          }}
        >
          {runner.prompt && (
            <span className="min-w-0 flex-1 truncate text-(--ui-text-secondary)" title={runner.prompt}>
              {runner.prompt.replace(/\s*[([]\s*[yY]\s*\/\s*[nN]\s*[)\]]\s*:?\s*$/, '')}
            </span>
          )}
          {yesNo ? (
            <>
              <Button
                onClick={() => answer('n')}
                size="sm"
                type="button"
                variant={yesNo === 'n' ? 'default' : 'outline'}
              >
                {t.common.no}
              </Button>
              <Button
                onClick={() => answer('y')}
                size="sm"
                type="button"
                variant={yesNo === 'y' ? 'default' : 'outline'}
              >
                {t.common.yes}
              </Button>
            </>
          ) : (
            <>
              <input
                aria-label={t.conversationUi.input}
                autoFocus
                className={cn(
                  'h-7 min-w-0 rounded-md bg-transparent px-2 text-(--ui-text-primary) outline-none',
                  'shadow-[inset_0_0_0_1px_var(--ui-stroke-secondary)] placeholder:text-(--ui-text-tertiary)',
                  'focus-visible:shadow-[inset_0_0_0_1px_var(--ui-stroke-primary)]',
                  runner.prompt ? 'w-48' : 'flex-1'
                )}
                onChange={event => setInput(event.target.value)}
                placeholder={`${t.conversationUi.input}…`}
                type={/password|passphrase/i.test(runner.prompt) ? 'password' : 'text'}
                value={input}
              />
              <Button aria-label={t.common.send} size="icon-xs" type="submit" variant="ghost">
                <Codicon name="newline" size="0.875rem" />
              </Button>
            </>
          )}
          <Button
            aria-label={t.composer.stop}
            onClick={() => runner.write('\x03')}
            size="icon-xs"
            type="button"
            variant="ghost"
          >
            <Codicon name="close" size="0.875rem" />
          </Button>
        </form>
      )}
      {runner.error && (
        <div aria-live="polite" className="px-3 py-2 text-sm text-(--ui-red)">
          {runner.error}
        </div>
      )}
    </>
  )
}

/** TTY output stays off the transcript; its completion resumes the same agent. */
export function InlineCommand({ command, owner }: { command: string; owner: InlineCommandOwner }) {
  const { t } = useI18n()
  const runner = useInlineCommandRunner(owner)

  return (
    <div data-slot="inline-command">
      <button
        aria-label={t.conversationUi.runCommand}
        className="absolute right-11 top-2 z-10 grid size-7 place-items-center rounded-md text-(--ui-text-secondary) hover:bg-accent hover:text-foreground disabled:opacity-40"
        disabled={!runner.canRun}
        onClick={() => void runner.execute(command)}
        type="button"
      >
        <Codicon
          className={runner.running ? 'animate-spin' : undefined}
          name={runner.running ? 'loading' : 'play'}
          size="1rem"
        />
      </button>
      <InlineCommandInput runner={runner} />
    </div>
  )
}
