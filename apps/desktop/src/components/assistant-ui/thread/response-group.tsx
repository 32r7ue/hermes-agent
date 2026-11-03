import { ThreadPrimitive, useAuiState } from '@assistant-ui/react'
import { type ComponentProps, createContext, useEffect, useMemo, useState } from 'react'

import { DisclosureRow } from '@/components/chat/disclosure-row'
import { useI18n } from '@/i18n'

import { contentHasVisibleText, messageContentText, PROCESS_NOTIFICATION_RE } from './content'

interface GroupMessage {
  role: string
  content: unknown
  metadata?: { custom?: Record<string, unknown> }
}

/** Background deliveries continue the response without becoming human prompts. */
export function responseMessageRole(message: GroupMessage): string {
  const custom = message.metadata?.custom

  const background =
    message.role === 'system'
      ? Boolean(custom?.asyncResult || custom?.asyncResultKind)
      : message.role === 'user' && PROCESS_NOTIFICATION_RE.test(messageContentText(message.content))

  return background ? 'background' : message.role
}

export const ResponseActivityDisclosure = createContext<{ expanded: boolean; ownsDisclosure: boolean } | null>(null)

export const ResponseMessageIds = createContext<readonly string[]>([])

interface ResponseMessagesProps {
  components: ComponentProps<typeof ThreadPrimitive.MessageByIndex>['components']
  indices: readonly number[]
}

interface ResponseRow {
  index: number
  id: string
  role: string
  hasText: boolean
}

interface ResponseSection {
  key: string
  indices: number[]
  assistantIds: string[]
  response: boolean
}

/** Keep message runtimes intact; only their visual container and footer are shared. */
export function ResponseMessages({ components, indices }: ResponseMessagesProps) {
  const signature = useAuiState(s =>
    JSON.stringify(
      indices.flatMap(index => {
        const message = s.thread.messages[index]

        // A history replacement can notify this row before its parent updates indices.
        return message
          ? [
              {
                index,
                id: message.id,
                role: responseMessageRole(message),
                hasText: contentHasVisibleText(message.content)
              }
            ]
          : []
      })
    )
  )

  const sections = useMemo(() => {
    const rows = JSON.parse(signature) as ResponseRow[]
    const result: ResponseSection[] = []

    for (const row of rows) {
      const response = row.role === 'assistant' || row.role === 'background'
      const previous = result.at(-1)

      const section: ResponseSection =
        response && previous?.response ? previous : { key: row.id, indices: [], assistantIds: [], response }

      if (section !== previous) {
        result.push(section)
      }

      section.indices.push(row.index)

      if (row.role === 'assistant' && row.hasText) {
        section.assistantIds.push(row.id)
      }
    }

    return result
  }, [signature])

  return sections.map(section =>
    section.response ? (
      <ResponseMessageIds.Provider key={section.key} value={section.assistantIds}>
        <div className="group flex min-w-0 flex-col gap-(--scaffold-block-gap)" data-slot="aui_response-group">
          <ResponseSectionMessages components={components} section={section} />
        </div>
      </ResponseMessageIds.Provider>
    ) : (
      <ThreadPrimitive.MessageByIndex components={components} index={section.indices[0]!} key={section.key} />
    )
  )
}

/** Keep live status paragraphs visible, then fold the completed work above the answer. */
function ResponseSectionMessages({
  section,
  components
}: {
  section: ResponseSection
  components: ResponseMessagesProps['components']
}) {
  const { t } = useI18n()

  const running = useAuiState(
    s =>
      section.indices.some(index => s.thread.messages[index]?.status?.type === 'running') ||
      (s.thread.isRunning && section.indices.includes(s.thread.messages.length - 1))
  )

  const [expanded, setExpanded] = useState(false)
  useEffect(() => {
    if (!running) {
      setExpanded(false)
    }
  }, [running])
  const tail = section.assistantIds.at(-1)
  const tailIndex = useAuiState(s => section.indices.find(index => s.thread.messages[index]?.id === tail))
  const history = tailIndex === undefined ? [] : section.indices.filter(index => index < tailIndex)

  const disclosure = useMemo(() => ({ expanded, ownsDisclosure: history.length > 0 }), [expanded, history.length])

  return (
    <ResponseActivityDisclosure.Provider value={disclosure}>
      {history.length > 0 && !running && (
        <DisclosureRow onToggle={() => setExpanded(value => !value)} open={expanded}>
          {t.conversationUi.activity}
        </DisclosureRow>
      )}
      {section.indices.map(index => (
        <div className="min-w-0" hidden={!running && !expanded && history.includes(index)} key={index}>
          <ThreadPrimitive.MessageByIndex components={components} index={index} />
        </div>
      ))}
    </ResponseActivityDisclosure.Provider>
  )
}
