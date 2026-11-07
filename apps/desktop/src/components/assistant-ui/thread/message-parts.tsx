import {
  MessagePrimitive,
  type ReasoningMessagePartComponent,
  type TextMessagePartProps,
  type ToolCallMessagePartProps,
  useAuiState,
  useMessagePartReasoning,
  useMessagePartText
} from '@assistant-ui/react'
import { useStore } from '@nanostores/react'
import { type ComponentProps, type FC, Fragment, type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { useSessionView } from '@/app/chat/session-view'
import { CatalogInstallTool } from '@/components/assistant-ui/catalog-install-tool'
import { ClarifyTool } from '@/components/assistant-ui/clarify'
import { ConnectorExecution, ConnectorTool } from '@/components/assistant-ui/connector-tool'
import { MarkdownText, MarkdownTextContent } from '@/components/assistant-ui/markdown-text'
import { McpSetupTool } from '@/components/assistant-ui/mcp-setup-tool'
import { SetupBeatTool } from '@/components/assistant-ui/setup-beat/setup-beat-tool'
import { setThemeCall } from '@/components/assistant-ui/theme-picker/args'
import { ThemeTool } from '@/components/assistant-ui/theme-picker/theme-tool'
import { AgentDeliveryNotice, deliveryTargetFromCommand } from '@/components/assistant-ui/thread/agent-delivery'
import { TimelineTimestamp } from '@/components/assistant-ui/thread/timeline-timestamp'
import { DelegateTool } from '@/components/assistant-ui/tool/delegate'
import {
  REASONING_RUN_KEY,
  splitRunItems,
  ToolEmbedContext,
  ToolFallback,
  toolGroupKey,
  ToolRun
} from '@/components/assistant-ui/tool/fallback'
import { parseMaybeObject, toolCallFailed } from '@/components/assistant-ui/tool/fallback-model'
import { GeneratedImage } from '@/components/chat/generated-image-result'
import { SCAFFOLD_LABEL_CLASS, SCAFFOLD_META_CLASS, ScaffoldRow } from '@/components/chat/scaffold-row'
import { useI18n } from '@/i18n'
import { mcpTargets, toolLabels } from '@/lib/connector-tools'
import { generatedImageFromResult } from '@/lib/generated-images'
import { separateGluedReasoningBlocks } from '@/lib/reasoning-blocks'
import { reasoningHeadline } from '@/lib/reasoning-headline'
import { runEndedRecently, setReplyAnchor } from '@/lib/reply-anchor'
import { isTodoToolName } from '@/lib/todos'
import { type CardToolName, isCardTool, isCardToolName } from '@/lib/tool-render-class'
import { useEnterAnimation } from '@/lib/use-enter-animation'
import { cn } from '@/lib/utils'
import { onboardingChatStore } from '@/store/onboarding-session'
import { $reasoningCollapsedByDefault, $showReasoning } from '@/store/reasoning-disclosure'
import { $replyHoldTop, $replyReveal } from '@/store/reply-display'
import { useForcedTextDirection } from '@/store/text-direction'
import { $showToolActivity } from '@/store/tool-activity'


type TimelineToolCallProps = ToolCallMessagePartProps & { completedAt?: number; timestamp?: number }

// A call sealed without a result (turn stopped, completion event lost) is
// neither pending nor successful; only the generic row can say so.
const settledWithoutResult = ({ completedAt, result }: TimelineToolCallProps): boolean =>
  result === undefined && completedAt !== undefined

const ImageGenerateTool: FC<TimelineToolCallProps> = props => {
  const { args, completedAt, result, timestamp } = props
  const aspectRatio = typeof args?.aspect_ratio === 'string' ? args.aspect_ratio : undefined

  // The image card owns successful generations. Failed or malformed results
  // still need the normal tool row: it extracts the error text and gives the
  // user an honest, expandable failure rather than silently dropping the call.
  if (settledWithoutResult(props) || (result !== undefined && !generatedImageFromResult(result))) {
    return <ToolFallback {...props} />
  }

  return (
    <div className="mt-1.5">
      <TimelineTimestamp className="mb-0.5 block" completedAt={completedAt} timestamp={timestamp} />
      <GeneratedImage aspectRatio={aspectRatio} result={result} />
    </div>
  )
}

const DelegateToolPart: FC<TimelineToolCallProps> = props => {
  // A call that failed outright dispatched nothing — there are no children to
  // list, only an error. The generic row extracts and expands it properly.
  if (props.isError || settledWithoutResult(props)) {
    return <ToolFallback {...props} />
  }

  return (
    <>
      <TimelineTimestamp className="mb-0.5 block" completedAt={props.completedAt} timestamp={props.timestamp} />
      <DelegateTool args={props.args} result={props.result} toolCallId={props.toolCallId} />
    </>
  )
}

const ClarifyToolPart: FC<TimelineToolCallProps> = props => {
  // Stopped on this question, never answered: history. ClarifyTool reads
  // the session's live clarify request, so a later turn's question would
  // otherwise paint onto this row as a second live card.
  if (settledWithoutResult(props)) {
    return <ToolFallback {...props} />
  }

  return (
    <>
      <TimelineTimestamp className="mb-0.5 block" completedAt={props.completedAt} timestamp={props.timestamp} />
      <ClarifyTool {...props} />
    </>
  )
}

const ThemeToolPart: FC<TimelineToolCallProps> = props => {
  if (settledWithoutResult(props)) {
    return <ToolFallback {...props} />
  }

  return (
    <>
      <TimelineTimestamp className="mb-0.5 block" completedAt={props.completedAt} timestamp={props.timestamp} />
      <ThemeTool {...props} />
    </>
  )
}

const SetupBeatToolPart: FC<TimelineToolCallProps> = props => {
  if (settledWithoutResult(props)) {
    return <ToolFallback {...props} />
  }

  return <SetupBeatTool {...props} />
}

const ConnectionsToolPart: FC<TimelineToolCallProps> = props =>
  mcpTargets(props.toolName, props.args).length > 0 ? <McpSetupTool {...props} /> : <ConnectorTool {...props} />

const TOOL_CARDS: Record<CardToolName, FC<TimelineToolCallProps>> = {
  clarify: ClarifyToolPart,
  delegate_task: DelegateToolPart,
  image_generate: ImageGenerateTool,
  manage_catalog: CatalogInstallTool,
  manage_connections: ConnectionsToolPart,
  set_theme: ThemeToolPart,
  setup_beat: SetupBeatToolPart
}

// A failure the user still has to see. The gateway's tool.complete carries the
// failure inside `result`, never as the top-level error that sets isError, so
// this reads the body like the run summary does. A non-zero exit_code counts
// too, matching the gateway's _tool_result_needs_user, which forwards terminal
// {output, exit_code: 1, error: null} even with display.tool_progress off.
const failedCallNeedsUser = (part: TimelineToolCallProps): boolean => {
  const exitCode = parseMaybeObject(part.result).exit_code

  return toolCallFailed(part) || (typeof exitCode === 'number' && exitCode !== 0)
}

const ChainToolFallback: FC<TimelineToolCallProps> = props => {
  const showToolActivity = useStore($showToolActivity)

  // todo parts are hoisted to a dedicated panel above the message content.
  if (isTodoToolName(props.toolName)) {
    return null
  }

  // An inter-agent delivery run through the terminal tool renders as the
  // compact "Messaged X" / "Message from X" notices, not a transcript row
  // (Grok-bots parity; the receiving side already renders notices via
  // AGENT_MESSAGE_RE). Non-delivery terminal calls fall through unchanged.
  if (props.toolName === 'terminal' && !props.isError && !settledWithoutResult(props)) {
    const command = typeof props.args?.command === 'string' ? props.args.command : ''

    if (deliveryTargetFromCommand(command)) {
      return <AgentDeliveryNotice {...props} />
    }
  }

  // A reaction's UI is the emoji landing on the bubble (message.reaction
  // event) — a "React To Message" tool block next to it would be the agent
  // narrating its own tapback. Failures still render so they're debuggable.
  if (props.toolName === 'react_to_message' && !props.isError) {
    return null
  }

  if (isCardToolName(props.toolName)) {
    const ToolCard = TOOL_CARDS[props.toolName]

    return <ToolCard {...props} />
  }

  // A reloaded transcript holds the model's own call: set_theme reached through the tool_call bridge.
  if (setThemeCall(props.toolName, props.args)) {
    return <ThemeToolPart {...props} />
  }

  if (toolLabels(props.args).length > 0) {
    return <ConnectorExecution {...props} />
  }

  // The tool feed (reads, searches, commands) follows display.tool_progress,
  // never show_reasoning. Cards, approvals, and failed calls the user must act
  // on remain regardless.
  if (!showToolActivity && !failedCallNeedsUser(props) && !isCardTool(props.toolName)) {
    return null
  }

  return <ToolFallback {...props} />
}

// Match the compact terminal/log viewers rather than the full thread's slack.
const PREVIEW_RELOCK_THRESHOLD_PX = 24

type TimelineTextPartProps = TextMessagePartProps & { completedAt?: number; timestamp?: number }

// When a reply was last held back while streaming. Module-level, not per mount: the finished turn
// swaps the streamed message for its stored copy (a new id, a fresh mount ~100ms later), and that copy
// has never seen itself stream. A part that lands done right after a hold is the reply landing.
let lastHeldAt = 0
const REVEAL_WINDOW_MS = 2_500

const TimelineMarkdownText: FC<TimelineTextPartProps> = ({ completedAt, timestamp }) => {
  const { status, text } = useMessagePartText()
  const streaming = status.type === 'running'
  const tail = useAuiState(s => s.message.isLast)
  const messageDone = useAuiState(s => s.message.status?.type !== 'running')
  const threadRunning = useAuiState(s => s.thread.isRunning)
  const liveStream = useStore($replyReveal) === 'live'
  const holdTop = useStore($replyHoldTop)
  const ref = useRef<HTMLDivElement>(null)

  if (streaming) {
    lastHeldAt = Date.now()
  }

  // Decided once per mount (history renders still), and again on the streaming → done flip.
  const [revealing, setRevealing] = useState(
    () => !streaming && tail && (Date.now() - lastHeldAt < REVEAL_WINDOW_MS || runEndedRecently(REVEAL_WINDOW_MS))
  )

  const [was, setWas] = useState({ streaming, threadRunning })

  // Landing while mounted: the part stops streaming, or the turn ends under the tail reply.
  if (was.streaming !== streaming || was.threadRunning !== threadRunning) {
    setWas({ streaming, threadRunning })

    if ((was.streaming && !streaming) || (tail && was.threadRunning && !threadRunning)) {
      setRevealing(true)
    }
  }

  // The turn's reply landing whole: hold the view at its top so reading starts there.
  useLayoutEffect(() => {
    if (holdTop && revealing && messageDone && tail) {
      setReplyAnchor(ref.current)
    }
  }, [holdTop, messageDone, revealing, tail])

  // assistant-ui adds an empty continuation after a tool starts. It is not
  // prose yet and must not create paragraph spacing above pending approvals.
  if (!text.trim()) {
    return null
  }

  // A reply still streaming stays hidden and appears whole when it is done. The line
  // above it (or the bottom loader, when there is none) stays live until then.
  if (streaming && !liveStream) {
    return null
  }

  return (
    <div
      className={cn('min-w-0', revealing && !liveStream && 'aui-text-reveal')}
      onAnimationEnd={event => {
        if (event.target === event.currentTarget && event.animationName === 'aui-text-reveal-sweep') {
          setRevealing(false)
        }
      }}
      ref={ref}
    >
      <MarkdownText />
      <TimelineTimestamp className="mt-1 block" completedAt={completedAt} timestamp={timestamp} />
    </div>
  )
}

const ThinkingDisclosure: FC<{
  children: ReactNode
  completedAt?: number
  reasoningText?: string
  storedSeconds?: number
  messageRunning?: boolean
  pending?: boolean
  timestamp?: number
  // Required: the block's duration is remembered against this key, so a
  // component that mounts after the block finished can still report it.
  timerKey: string
}> = ({
  children,
  completedAt,
  messageRunning = false,
  pending = false,
  reasoningText = '',
  storedSeconds,
  timestamp,
  timerKey
}) => {
  const { t } = useI18n()
  const sessionId = useStore(useSessionView().$runtimeId)
  const onboardingChat = useStore(useMemo(() => onboardingChatStore(sessionId), [sessionId]))
  // The first-run chat rests reasoning collapsed: its cards and short replies carry the run.
  const reasoningCollapsedByDefault = useStore($reasoningCollapsedByDefault) || onboardingChat
  // `null` = no explicit user toggle yet. Live reasoning remains visible by
  // default, unless the user opts into the low-jitter collapsed presentation.
  const [userOpen, setUserOpen] = useState<boolean | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const enterRef = useEnterAnimation(messageRunning, timerKey)
  const showPreview = !reasoningCollapsedByDefault && pending
  const open = userOpen ?? showPreview
  const isPreview = userOpen === null && showPreview

  // Three ways a finished block can report itself. With a measured duration it
  // says so, unless the timer's whole seconds round it to "0s" — accurate and
  // useless — in which case it just says it was quick. With no duration at all
  // it still has to read as finished; a turn that ended must not go on saying
  // "Thinking".
  const { headline, titleOnly } = reasoningHeadline(reasoningText)
  // Live: the model's current step ("Clarifying the move count") instead of a bare "Thinking".
  let thoughtLabel = headline ?? t.assistant.thread.thinking

  // No durations: a finished thought reads as its headline, else "Thought".
  if (!pending) {
    thoughtLabel = headline ?? t.assistant.thread.thought
  }

  const expandable = pending || !titleOnly

  // Follow new tokens until the user scrolls up to read earlier reasoning.
  useEffect(() => {
    if (!isPreview) {
      return
    }

    const el = scrollRef.current
    const content = contentRef.current

    if (!el || !content) {
      return
    }

    // Height-gated: the observer also fires when the container's WIDTH changes
    // (sidebar sash drag resizes every message), and pinning there forces a
    // scrollHeight read+write per preview per frame. Only actual content
    // growth needs the pin; the height rides the RO entry, reflow-free.
    let lastHeight = -1
    let following = true

    const trackScroll = () => {
      following = el.scrollHeight - el.scrollTop - el.clientHeight < PREVIEW_RELOCK_THRESHOLD_PX
    }

    const pin = (entries: readonly ResizeObserverEntry[]) => {
      const height = entries[entries.length - 1]?.borderBoxSize?.[0]?.blockSize ?? -1
      const grew = height < 0 || height > lastHeight
      lastHeight = height

      if (grew && following) {
        el.scrollTop = el.scrollHeight
      }
    }

    // No sync pin(): the observer's guaranteed initial delivery runs it with
    // layout already clean (still before paint), avoiding a forced reflow.
    const observer = new ResizeObserver(pin)
    observer.observe(content)
    el.addEventListener('scroll', trackScroll, { passive: true })

    return () => {
      observer.disconnect()
      el.removeEventListener('scroll', trackScroll)
    }
    // Re-run when the disclosure toggles so the observer attaches to the new
    // DOM after expand/collapse (refs are conditionally rendered on `open`).
  }, [isPreview, open])

  return (
    <div
      className="text-[length:var(--conversation-tool-font-size)] text-(--ui-text-tertiary)"
      data-conversation-scaffold=""
      data-slot="aui_thinking-disclosure"
      ref={enterRef}
    >
      <ScaffoldRow
        onToggle={expandable ? () => setUserOpen(!open) : undefined}
        open={expandable && open}
        trailing={
          <span className="flex shrink-0 items-center gap-1.5">
            <TimelineTimestamp className={SCAFFOLD_META_CLASS} completedAt={completedAt} timestamp={timestamp} />
          </span>
        }
      >
        <span className={cn(SCAFFOLD_LABEL_CLASS, pending && 'shimmer')}>{thoughtLabel}</span>
      </ScaffoldRow>
      {expandable && open && (
        <div
          className={cn(
            // Body sits flush with the "Thinking" header — no left indent —
            // and inherits the disclosure-level opacity fade defined in
            // styles.css (~0.67 at rest, 1 on hover/focus). overflow-auto so
            // the max-h-40 preview is a real scroller, not a clip.
            // Even a body that fits must hand vertical input to the thread.
            'mt-0.5 w-full min-w-0 max-w-full overflow-auto overscroll-x-contain overscroll-y-auto wrap-anywhere pb-1',
            isPreview && 'max-h-40'
          )}
          data-slot="aui_thinking-body"
          ref={scrollRef}
        >
          <div ref={contentRef}>{children}</div>
        </div>
      )}
    </div>
  )
}

// Self-gate "Thinking…" on this message's own reasoning parts. Reading
// `thread.isRunning` directly would flicker shimmer/timer on every old
// assistant whenever the external-store runtime clears+reimports its
// repository (one ref-identity bump per streaming delta).
const ReasoningAccordionGroup: FC<{ children?: ReactNode; endIndex: number; startIndex: number }> = ({
  children,
  endIndex,
  startIndex
}) => {
  const showReasoning = useStore($showReasoning)
  const messageId = useAuiState(s => s.message.id)
  const messageRunning = useAuiState(s => s.message.status?.type === 'running')

  // Also pending while the reply after it is still being written (held until done), so the
  // line stays lit straight through to the reply instead of handing over to another marker.
  const heldReply = useStore($replyReveal) === 'reveal'

  const pending = useAuiState(s => {
    if (!s.thread.isRunning || s.message.status?.type !== 'running') {
      return false
    }

    const after = s.message.parts.slice(endIndex + 1)

    return (
      (heldReply && after.length > 0 && after.every(p => p?.type === 'text')) ||
      s.message.parts
        .slice(Math.max(0, startIndex), endIndex + 1)
        .some(p => p?.type === 'reasoning' && p.status?.type !== 'complete')
    )
  })

  // A reasoning group with no actual text is pure noise — drop the whole
  // "Thinking" disclosure rather than leave an empty header eating a row. This
  // applies live too: encrypted/spinner-coerced reasoning (Opus reasoning max)
  // never carries visible text, and the bottom-of-thread loader already signals
  // "thinking", so an empty header is never wanted. Real reasoning surfaces the
  // instant its first token lands.
  const hasContent = useAuiState(s =>
    s.message.parts
      .slice(Math.max(0, startIndex), endIndex + 1)
      .some(p => p?.type === 'reasoning' && typeof p.text === 'string' && p.text.trim().length > 0)
  )

  const timestamp = useAuiState(s =>
    s.message.parts.slice(Math.max(0, startIndex), endIndex + 1).reduce<number | undefined>((earliest, part) => {
      const value = part.type === 'reasoning' ? (part as { timestamp?: number }).timestamp : undefined

      return value === undefined ? earliest : earliest === undefined ? value : Math.min(earliest, value)
    }, undefined)
  )

  const completedAt = useAuiState(s =>
    s.message.parts.slice(Math.max(0, startIndex), endIndex + 1).reduce<number | undefined>((latest, part) => {
      const value = part.type === 'reasoning' ? (part as { completedAt?: number }).completedAt : undefined

      return value === undefined ? latest : latest === undefined ? value : Math.max(latest, value)
    }, undefined)
  )

  const reasoningText = useAuiState(s =>
    s.message.parts
      .slice(Math.max(0, startIndex), endIndex + 1)
      .map(part => (part.type === 'reasoning' ? part.text : ''))
      .filter(Boolean)
      .join('\n')
  )

  const storedSeconds = useAuiState(s =>
    s.message.parts.slice(Math.max(0, startIndex), endIndex + 1).reduce<number | undefined>((total, part) => {
      const value = part.type === 'reasoning' ? (part as { durationSeconds?: number }).durationSeconds : undefined

      return value === undefined ? total : (total ?? 0) + value
    }, undefined)
  )

  if (!hasContent || !showReasoning) {
    return null
  }

  return (
    // Keyed per block, not per message: the timer registry hands every caller
    // of a key the same origin, so a turn that thinks three separate times used
    // to measure the second and third blocks from the first one's start and
    // report the running total as each block's duration.
    <ThinkingDisclosure
      completedAt={completedAt}
      messageRunning={messageRunning}
      pending={pending}
      reasoningText={reasoningText}
      storedSeconds={storedSeconds}
      timerKey={`reasoning:${messageId}:${startIndex}`}
      timestamp={timestamp}
    >
      {children}
    </ThinkingDisclosure>
  )
}

// Read the part from context, same contract as MarkdownText's
// useMessagePartText — the reasoning-only smoothing wrapper (removed) stalled
// the char-reveal at empty, blanking the widget.
const ReasoningTextPart: ReasoningMessagePartComponent = () => {
  const { status, text } = useMessagePartReasoning()
  const messageRunning = useAuiState(s => s.message.status?.type === 'running')

  // The group above already hides grouped parts; this covers a Reasoning part
  // rendered without a ReasoningGroup wrapper (assistant-ui drops the group
  // when a ChainOfThought component is registered).
  const showReasoning = useStore($showReasoning)
  const textDirection = useForcedTextDirection()

  if (!showReasoning) {
    return null
  }

  return (
    <MarkdownTextContent
      containerClassName="text-[length:var(--conversation-tool-font-size)] leading-snug text-muted-foreground/85 [&_strong]:font-medium [&_strong]:text-inherit"
      containerProps={{ 'data-slot': 'aui_reasoning-text' } as ComponentProps<'div'>}
      isRunning={status.type === 'running' || messageRunning}
      scratchpad
      text={separateGluedReasoningBlocks(text.trimStart())}
      textDirection={textDirection}
    />
  )
}

// Rendering one part inside an activity group: the plain per-part components,
// never a group component, so a part can't re-enter the grouping below.
export const PART_COMPONENTS = {
  Reasoning: ReasoningTextPart,
  Text: TimelineMarkdownText,
  tools: { Fallback: ChainToolFallback }
} as const

const partAt = (index: number) => <MessagePrimitive.PartByIndex components={PART_COMPONENTS} index={index} key={index} />

/** Consecutive reasoning parts inside [start, end] as [segStart, segEnd] pairs; tools in between stay single. */
function activitySegments(keys: readonly string[], start: number, end: number) {
  const segments: ({ end: number; kind: 'reasoning'; start: number } | { index: number; kind: 'tool' })[] = []

  for (let i = start; i <= end; i++) {
    const last = segments.at(-1)

    if (keys[i] !== REASONING_RUN_KEY) {
      segments.push({ index: i, kind: 'tool' })
    } else if (last?.kind === 'reasoning' && last.end === i - 1) {
      last.end = i
    } else {
      segments.push({ end: i, kind: 'reasoning', start: i })
    }
  }

  return segments
}

/**
 * Everything between two pieces of narration — thoughts and tool calls — as one
 * level-1 line ("Searched 3 sites, ran 2 commands"). Opening it lists each step
 * (level 2: a thought's headline, a tool row), and each step opens to its full
 * text or output (level 3). Cards (diffs, questions, connectors) stay in place
 * and split the lines around them. A run that is only thinking has no other
 * step to list, so it shows the thought itself instead of a "Thought" wrapper.
 */
const ActivityGroup: FC = () => {
  const showToolActivity = useStore($showToolActivity)

  // Where this chain of thought sits in the message: its parts are a slice of
  // message.parts, so the first one's reference gives the offset.
  const range = useAuiState(state => {
    const first = state.chainOfThought.parts[0]
    const start = first ? state.message.parts.indexOf(first as never) : -1

    return `${start}:${state.chainOfThought.parts.length}`
  })

  const [startIndex, length] = range.split(':').map(Number)
  const endIndex = startIndex + length - 1

  // Joined string, not an array: the selector re-runs on every delta and is compared with Object.is.
  const keyString = useAuiState(state =>
    state.message.parts
      .map(part =>
        part.type === 'tool-call'
          ? toolGroupKey(part.toolName, part.args)
          : part.type === 'reasoning'
            ? REASONING_RUN_KEY
            : ''
      )
      .join('\u0000')
  )

  const keys = useMemo(() => keyString.split('\u0000'), [keyString])

  // Live, a run whose newest step is a thought names that thought.
  const lastReasoning = useAuiState(state => {
    const part = state.message.parts[endIndex]

    return part?.type === 'reasoning' ? part.text : ''
  })

  if (startIndex < 0) {
    return null
  }

  const items = splitRunItems(keys.slice(startIndex, endIndex + 1))

  const segmentNodes = (start: number, end: number) =>
    activitySegments(keys, start, end).map(segment =>
      segment.kind === 'tool' ? (
        partAt(segment.index)
      ) : (
        <ReasoningAccordionGroup endIndex={segment.end} key={`reasoning:${segment.start}`} startIndex={segment.start}>
          {Array.from({ length: segment.end - segment.start + 1 }, (_, offset) => partAt(segment.start + offset))}
        </ReasoningAccordionGroup>
      )
    )

  return (
    <ToolEmbedContext.Provider value={false}>
      {items.map(item => {
        if (item.kind === 'card') {
          return <Fragment key={`card:${item.index}`}>{partAt(startIndex + item.index)}</Fragment>
        }

        const start = startIndex + item.start
        const end = startIndex + item.end
        const onlyThinking = keys.slice(start, end + 1).every(key => key === REASONING_RUN_KEY)

        // Thinking alone, or the tool feed switched off: no summary line, the steps render as they are.
        if (onlyThinking || !showToolActivity) {
          return <Fragment key={`run:${start}`}>{segmentNodes(start, end)}</Fragment>
        }

        return (
          <ToolRun
            endIndex={end}
            key={`run:${start}`}
            liveStep={end === endIndex && lastReasoning ? reasoningHeadline(lastReasoning).headline : null}
            startIndex={start}
          >
            {segmentNodes(start, end)}
          </ToolRun>
        )
      })}
    </ToolEmbedContext.Provider>
  )
}

// Module-level constant so the `components` prop on `MessagePrimitive.Parts`
// has a stable identity across renders. Without this every AssistantMessage
// render would create a fresh `components` object and force every part to
// re-render on every streaming delta. `ChainOfThought` takes every run of
// reasoning and tool calls; ActivityGroup decides how it reads.
export const MESSAGE_PARTS_COMPONENTS = {
  ChainOfThought: ActivityGroup,
  Text: TimelineMarkdownText
} as const

/** Narration stays in order; each activity run between it owns one summary line. */
export function AssistantMessageParts() {
  return (
    <div data-slot="aui_message-parts">
      <MessagePrimitive.Parts components={MESSAGE_PARTS_COMPONENTS} />
    </div>
  )
}
