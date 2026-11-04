import { randomUuid } from '@hermes/shared'
import { stripAnsi } from '@hermes/shared/ansi'
import { useStore } from '@nanostores/react'
import { useEffect, useRef, useState } from 'react'

import { useSessionView } from '@/app/chat/session-view'
import { Codicon } from '@/components/ui/codicon'
import { useI18n } from '@/i18n'
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

/** TTY output stays off the transcript; its completion resumes the same agent. */
export function InlineCommand({ command, owner }: { command: string; owner: InlineCommandOwner }) {
  const view = useSessionView()
  const runtimeId = useStore(view.$runtimeId)
  const storedId = useStore(view.$storedId)
  const busy = useStore(view.$busy)
  const sessionId = runtimeId ?? storedId
  const { t } = useI18n()
  const [running, setRunning] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [input, setInput] = useState('')
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

  const execute = async () => {
    const gateway = $gateway.get()
    const ownerSessionId = view.$runtimeId.get() ?? view.$storedId.get()

    if (
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
        session_id: targetId, command: 'pwd'
      })

      if (!active.current) {return}
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
          const line = output.trimEnd().split('\n').at(-1) ?? ''

          if (/password|passphrase|\by\/n\b|\byes\/no\b|press .*|enter .*|\?\s*$|:\s*$/i.test(line)) {
            setPrompt(line.slice(-400))
          }
        })
      )
      subscriptions.current.push(
        terminal.onExit(session.id, ({ code }) => {
          terminalId.current = null
          subscriptions.current.splice(0).forEach(unsubscribe => unsubscribe())
          setPrompt('')
          // Capture the original session and dispatcher; changing chat cannot retarget this result.
          void requestForOwnedSession(ownerSessionId, ambient, 'prompt.submit', {
            session_id: targetId,
            submission_id: randomUuid(),
            display_kind: 'hidden',
            queued: true,
            text: `The user ran this command from your answer:\n\n${command}\n\nExit code: ${code}\nOutput:\n${output}\n\nContinue from this result. Do not repeat the command output unless it is needed to answer the user.`
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

  return (
    <div data-slot="inline-command">
      <button
        aria-label={t.conversationUi.runCommand}
        className="absolute right-11 top-2 z-10 grid size-7 place-items-center rounded-md text-(--ui-text-secondary) hover:bg-accent hover:text-foreground disabled:opacity-40"
        disabled={running || busy || !sessionId || sessionId !== owner.sessionId}
        onClick={() => void execute()}
        type="button"
      >
        <Codicon className={running ? 'animate-spin' : undefined} name={running ? 'loading' : 'play'} size="1rem" />
      </button>
      {running && (
        <form
          className="flex flex-wrap items-center gap-2 border-t border-(--ui-stroke-tertiary) px-3 py-2"
          onSubmit={event => {
            event.preventDefault()

            if (terminalId.current) {
              void window.hermesDesktop.terminal.write(terminalId.current, `${input}\r`)
            }

            setInput('')
            setPrompt('')
          }}
        >
          {prompt && <span className="w-full text-sm text-foreground">{prompt}</span>}
          <input
            aria-label={t.conversationUi.input}
            className="min-w-0 flex-1 rounded bg-background px-2 py-1 text-sm"
            onChange={event => setInput(event.target.value)}
            placeholder={`${t.conversationUi.input}…`}
            type={/password|passphrase/i.test(prompt) ? 'password' : 'text'}
            value={input}
          />
          <button className="text-sm" type="submit">
            ↵
          </button>
          <button
            aria-label={t.composer.stop}
            onClick={() => {
              if (terminalId.current) {
                void window.hermesDesktop.terminal.write(terminalId.current, '\x03')
              }
            }}
            type="button"
          >
            ×
          </button>
        </form>
      )}
      {error && (
        <div aria-live="polite" className="px-3 py-2 text-sm text-(--ui-red)">
          {error}
        </div>
      )}
    </div>
  )
}
