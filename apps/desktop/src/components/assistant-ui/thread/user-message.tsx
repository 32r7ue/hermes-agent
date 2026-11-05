import { ActionBarPrimitive, BranchPickerPrimitive, MessagePrimitive, useAuiState } from '@assistant-ui/react'
import { useStore } from '@nanostores/react'
import { type FC, type ReactNode, useCallback, useEffect, useState } from 'react'

import { DirectiveContent } from '@/components/assistant-ui/directive-text'
import { isAttachmentRef } from '@/components/assistant-ui/reference-kinds'
import {
  messageAttachmentRefs,
  messageContentText,
  PROCESS_NOTIFICATION_RE
} from '@/components/assistant-ui/thread/content'
import { MessageHoverTime } from '@/components/assistant-ui/thread/message-hover-time'
import { ReactionBadge, ReactionPicker } from '@/components/assistant-ui/thread/message-reactions'
import { BackgroundResult } from '@/components/assistant-ui/thread/system-message'
import { threadUserOrdinal } from '@/components/assistant-ui/thread/thread-message-index'
import { MessageTimelineTimestamp } from '@/components/assistant-ui/thread/timeline-timestamp'
import { type RestoreMessageTarget } from '@/components/assistant-ui/thread/types'
import { useMessageReactions } from '@/components/assistant-ui/thread/use-message-reactions'
import { UserMessageText } from '@/components/assistant-ui/thread/user-message-text'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { triggerHaptic } from '@/lib/haptics'
import { StopFilled } from '@/lib/icons'
import { LruCache } from '@/lib/lru-cache'
import { $touchPointer, isTouchInteraction } from '@/lib/touch-interaction'
import { cn } from '@/lib/utils'
import { $gateway } from '@/store/gateway'
import { notifyThreadEditOpen } from '@/store/thread-scroll'
import { isWatchWindow } from '@/store/windows'

/** True when the user has a live text highlight (drag-select / triple-click). */
export function hasTextSelection(): boolean {
  const selection = window.getSelection()

  return Boolean(selection && !selection.isCollapsed && selection.toString().length > 0)
}

export function UserMessageContainer({
  attachments,
  children,
  messageId
}: {
  attachments?: ReactNode
  children: ReactNode
  messageId?: string
}) {
  return (
    <div
      className="group/user-message flex w-full min-w-0 flex-col items-end gap-2 pb-5 pt-2"
      data-message-id={messageId}
      data-role="user"
      data-slot="aui_user-message-root"
    >
      {attachments}
      {children}
    </div>
  )
}

// Shared "user bubble" base. Both the read-only message and the inline
// edit composer render the same bubble surface (rounded glass card);
// they only differ in border weight, cursor, and padding-right (the
// read-only view reserves room for the restore icon).
//
// The bubble stays interactive below the native titlebar drag regions.
export const USER_BUBBLE_BASE_CLASS =
  'composer-human-message standalone-glass relative flex w-full min-w-0 max-w-full flex-col gap-1.5 overflow-y-auto rounded-xl border bg-(--dt-user-bubble) px-3 py-2 text-left [-webkit-app-region:no-drag]'

export const USER_ACTION_ICON_BUTTON_CLASS =
  'grid place-items-center rounded-md bg-transparent text-(--ui-text-secondary) transition-colors hover:bg-(--ui-control-active-background) hover:text-foreground disabled:cursor-default disabled:text-(--ui-text-quaternary) disabled:opacity-70'

export const USER_ACTION_ICON_SIZE = '0.6875rem'
export const StopGlyph = <StopFilled aria-hidden className="size-3.5 -translate-y-px" />

// Agent-to-agent deliveries ("Message from 🤖 <sender>: …", the Bot Mode /
// multi-profile convention; optional "(@<handle>)" carries the sender's
// profile name for avatar resolution — a relayed sender is re-stamped
// "(@<handle>@<connection>)" so a reply reaches the right machine (#103731);
// legacy "[Message from agent '<sender>'] …" too). They arrive on the user
// role because the recipient's turn runs on it, but they are NOT the human
// speaking — render them as a compact attributed timeline notice instead of
// a user bubble.
export const AGENT_MESSAGE_RE =
  /^(?:Message from (?:🤖\s*)?([^:\n(]{1,64}?)(?:\s*\(@([a-z0-9][a-z0-9_-]{0,63})(?:@[a-zA-Z0-9][a-zA-Z0-9_-]{0,63})?\))?:\s*|\[Message from agent '([^']{1,64})'\]\s*)([\s\S]*)$/u

// sender handle -> avatar data URL. Module-level so a chat full of notices
// from one bot resolves once. Bounded LRU: handles are parsed out of message
// text (unbounded distinct senders over a long session list) and hits hold
// base64 avatar data URLs, so an unbounded map pins image bytes for the
// window's lifetime. Eviction only costs a refetch.
// Misses expire after 30s — an avatar can appear at any moment (bot just
// created, art backfill still running), and a permanent negative cache
// froze the 🤖 glyph until an app restart.
const AGENT_AVATAR_CACHE_MAX = 128
export const agentAvatarCache = new LruCache<string, { at: number; url: null | string }>(AGENT_AVATAR_CACHE_MAX)
const AVATAR_MISS_TTL_MS = 30_000
const agentAvatarInflight = new Map<string, Promise<null | string>>()

export async function resolveAgentAvatar(handle: string): Promise<null | string> {
  const key = handle.trim().toLowerCase()

  if (!key) {
    return null
  }

  const hit = agentAvatarCache.get(key)

  if (hit) {
    if (hit.url !== null) {
      return hit.url
    }

    // Negative entry: honor it only within the TTL, then re-probe.
    if (Date.now() - hit.at < AVATAR_MISS_TTL_MS) {
      return null
    }
  }

  const inflight = agentAvatarInflight.get(key)

  if (inflight) {
    return inflight
  }

  const run = (async (): Promise<null | string> => {
    try {
      const gateway = $gateway.get()

      if (!gateway) {
        return null
      }

      const res = await gateway.request<{ profiles?: Array<{ has_avatar?: boolean; name: string }> }>('profiles.list', {
        include_sessions: false
      })

      const profiles = res?.profiles ?? []
      let profile = profiles.find(p => p.name.toLowerCase() === key)

      // 'hermes' is the conventional alias for the primary profile.
      if (!profile && key === 'hermes') {
        profile = profiles.find(p => p.name === 'default')
      }

      if (!profile?.has_avatar) {
        return null
      }

      const asset = await gateway.request<{ data?: string; found?: boolean }>('profiles.get_asset', {
        asset: 'avatar',
        name: profile.name
      })

      return asset?.found && asset.data ? asset.data : null
    } catch {
      // Older gateway (no profiles.* RPCs) or transient failure — the 🤖
      // glyph fallback is always correct.
      return null
    } finally {
      agentAvatarInflight.delete(key)
    }
  })()

  agentAvatarInflight.set(key, run)
  const out = await run
  agentAvatarCache.set(key, { at: Date.now(), url: out })

  return out
}

const AgentMessageNote: FC<{ text: string }> = ({ text }) => {
  const match = AGENT_MESSAGE_RE.exec(text)
  const sender = (match?.[1] || match?.[3] || 'agent').trim()
  const handle = (match?.[2] || match?.[3] || sender).trim()
  const body = (match?.[4] || '').trim()
  const [avatar, setAvatar] = useState<null | string>(() => agentAvatarCache.get(handle.toLowerCase())?.url ?? null)

  useEffect(() => {
    let live = true

    void resolveAgentAvatar(handle).then(url => {
      if (live && url) {
        setAvatar(url)
      }
    })

    return () => {
      live = false
    }
  }, [handle])

  // Grok-bots shape: an inter-agent delivery is a timeline EVENT, not a
  // conversation bubble — a subtle centered notice ("Message from 🤖 X"),
  // with the delivered text one click away instead of shouting in the
  // transcript. The recipient's reply below it stays a normal assistant
  // message, so the exchange still reads in order.
  return (
    <div
      className="flex max-w-[min(86%,44rem)] flex-col gap-0.5 self-center px-2 py-0.5 text-[0.6875rem] leading-5 text-muted-foreground/60"
      data-slot="aui_agent-message-note"
    >
      <span className="flex items-center justify-center gap-1.5">
        {avatar ? (
          <img alt="" aria-hidden className="size-4 shrink-0 rounded-full object-cover" src={avatar} />
        ) : (
          <span aria-hidden className="text-[0.8125rem] leading-none">
            🤖
          </span>
        )}
        <span className="wrap-anywhere">Message from {sender}</span>
      </span>
      {body && (
        <details className="self-center">
          <summary className="cursor-pointer select-none text-center text-muted-foreground/45 hover:text-muted-foreground/70">
            show message
          </summary>
          <div className="mt-1 max-w-[36rem] rounded-lg border border-(--ui-stroke-tertiary) px-3 py-2 text-left text-[0.75rem] leading-5 text-foreground/85">
            <UserMessageText text={body} />
          </div>
        </details>
      )}
    </div>
  )
}

const ProcessNotificationNote: FC<{ text: string }> = ({ text }) => {
  const body = text.replace(/^\[IMPORTANT:\s*/, '').replace(/\]$/, '')
  const newline = body.indexOf('\n')
  const headline = (newline === -1 ? body : body.slice(0, newline)).trim()
  const detail = newline === -1 ? '' : body.slice(newline + 1).trim()

  return <BackgroundResult process report={detail} text={headline} />
}

function isChipOnlyTurn(hasBody: boolean, attachmentRefs: readonly string[]): boolean {
  return !hasBody && attachmentRefs.length > 0 && attachmentRefs.every(isAttachmentRef)
}

interface UserBubbleActionsProps {
  fullText: string
  messageId: string
  onCancel?: () => Promise<void> | void
  onRequestRestoreConfirm?: (messageId: string, target: RestoreMessageTarget) => void
  runtimeUserOrdinal: RestoreMessageTarget['userOrdinal']
  showRestore: boolean
  showStop: boolean
  touch: boolean
}

/** Bottom-right cluster: when it was sent, then Stop or Restore. Its fill
 *  masks the last line's tail while shown. Touch has no hover, so Stop/Restore
 *  stay visible there and a cluster with neither is not rendered. */
const UserBubbleActions: FC<UserBubbleActionsProps> = ({
  fullText,
  messageId,
  onCancel,
  onRequestRestoreConfirm,
  runtimeUserOrdinal,
  showRestore,
  showStop,
  touch
}) => {
  const copy = useI18n().t.assistant.thread

  if (touch && !showStop && !showRestore) {
    return null
  }

  return (
    <div
      className={cn(
        // In flow under the bubble, unfilled: it used to float over the bubble's
        // bottom edge in a grey box of its own.
        'pointer-events-none flex items-center gap-1 transition-opacity',
        touch
          ? 'opacity-100'
          : 'opacity-0 group-hover/user-message:opacity-100 group-hover/user-message:transition-none group-focus-within/user-message:opacity-100'
      )}
    >
      {!touch && <MessageHoverTime className={cn(!showStop && !showRestore && 'pr-0.5')} />}
      {showStop ? (
        <button
          aria-label={copy.stop}
          className={cn('pointer-events-auto', touch ? 'size-11' : 'size-5', USER_ACTION_ICON_BUTTON_CLASS)}
          onClick={event => {
            event.preventDefault()
            event.stopPropagation()
            void onCancel?.()
          }}
          type="button"
        >
          {StopGlyph}
        </button>
      ) : showRestore ? (
        <Tip label={copy.restoreFromHere}>
          <button
            aria-label={copy.restoreCheckpoint}
            className={cn('pointer-events-auto', touch ? 'size-11' : 'size-6', USER_ACTION_ICON_BUTTON_CLASS)}
            onClick={event => {
              event.preventDefault()
              event.stopPropagation()
              triggerHaptic('selection')
              onRequestRestoreConfirm?.(messageId, {
                text: fullText,
                userOrdinal: runtimeUserOrdinal
              })
            }}
            onPointerDown={event => {
              event.preventDefault()
              event.stopPropagation()
            }}
            type="button"
          >
            <Codicon name="discard" size="0.875rem" />
          </button>
        </Tip>
      ) : null}
    </div>
  )
}

interface TouchUserBubbleProps {
  children: ReactNode
  className: string
  editable: boolean
  expandable: boolean
  expanded: boolean
  onToggleExpanded: () => void
  showRestore: boolean
  showStop: boolean
}

/** Touch bubble: the prose stays plain selectable text, so a long press keeps
 *  the platform's selection handles and Copy, and editing is an explicit button
 *  below it instead of a tap on the bubble. A clamped prompt gets an explicit
 *  expand toggle in the same row. The row leaves room for the Stop/Restore
 *  cluster pinned over its end. */
function TouchUserBubble({
  children,
  className,
  editable,
  expandable,
  expanded,
  onToggleExpanded,
  showRestore,
  showStop
}: TouchUserBubbleProps) {
  const copy = useI18n().t.assistant.thread

  return (
    <>
      <div className={cn(className, 'cursor-text')} data-selectable-text="true">
        {children}
      </div>
      <div className={cn('flex justify-end', (showStop || showRestore) && 'pr-11')}>
        {expandable && (
          <Button
            aria-expanded={expanded}
            aria-label={copy.expandMessage}
            data-slot="aui_user-touch-expand"
            onClick={() => {
              triggerHaptic('selection')
              onToggleExpanded()
            }}
            size="icon"
            variant="ghost"
          >
            <Codicon name={expanded ? 'chevron-up' : 'chevron-down'} />
          </Button>
        )}
        {editable && (
          <ActionBarPrimitive.Edit asChild>
            <Button
              aria-label={copy.editMessage}
              data-slot="aui_user-touch-edit"
              onClick={notifyThreadEditOpen}
              size="icon"
              variant="ghost"
            >
              <Codicon name="edit" />
            </Button>
          </ActionBarPrimitive.Edit>
        )}
      </div>
    </>
  )
}

export const UserMessage: FC<{
  onCancel?: () => Promise<void> | void
  onRequestRestoreConfirm?: (messageId: string, target: RestoreMessageTarget) => void
}> = ({ onCancel, onRequestRestoreConfirm }) => {
  const { t } = useI18n()
  const copy = t.assistant.thread
  const touch = useStore($touchPointer)
  const messageId = useAuiState(s => s.message.id)
  const content = useAuiState(s => s.message.content)
  const messageText = messageContentText(content)
  const threadRunning = useAuiState(s => s.thread.isRunning)

  const latestUserId = useAuiState(s => {
    for (let i = s.thread.messages.length - 1; i >= 0; i--) {
      const message = s.thread.messages[i] as { id?: string; role?: string }

      if (message.role === 'user') {
        return message.id ?? null
      }
    }

    return null
  })

  const runtimeUserOrdinal = useAuiState(s => threadUserOrdinal(s.thread.messages, s.message.id))

  const attachmentRefs = useAuiState(s => {
    const custom = (s.message.metadata?.custom ?? {}) as { attachmentRefs?: unknown }

    return messageAttachmentRefs(custom.attachmentRefs)
  })

  const [pickerOpen, setPickerOpen] = useState(false)
  const { enabled: reactionsEnabled, react, reactions: shownReactions } = useMessageReactions(messageId, 'user')

  const pickEmoji = useCallback(
    (emoji: null | string) => {
      setPickerOpen(false)
      react(emoji)
    },
    [react]
  )

  // Watch windows spectate a subagent run driven elsewhere: prompts can't be
  // edited, restored, or stopped from here. Prompts render in full (no clamp).
  const readOnly = isWatchWindow()

  // Injected background-process notification, not a human prompt — render the
  // compact system-style notice (after all hooks above have run).
  if (PROCESS_NOTIFICATION_RE.test(messageText.trim())) {
    return (
      <MessagePrimitive.Root
        className="flex w-full min-w-0 flex-col items-stretch"
        data-role="user"
        data-slot="aui_user-message-root"
      >
        <ProcessNotificationNote text={messageText.trim()} />
      </MessagePrimitive.Root>
    )
  }

  // Agent-to-agent delivery, not a human prompt — attributed inter-agent card.
  if (AGENT_MESSAGE_RE.test(messageText.trim())) {
    return (
      <MessagePrimitive.Root
        className="flex w-full min-w-0 flex-col items-stretch pb-(--conversation-turn-gap)"
        data-role="user"
        data-slot="aui_user-message-root"
      >
        <AgentMessageNote text={messageText.trim()} />
      </MessagePrimitive.Root>
    )
  }

  const hasBody = messageText.trim().length > 0
  const chipOnlyTurn = isChipOnlyTurn(hasBody, attachmentRefs)
  const isLatestUser = messageId === latestUserId
  const showStop = !readOnly && isLatestUser && threadRunning && Boolean(onCancel)
  // Restore (re-run this exact prompt) is available everywhere the Stop button
  // isn't — including mid-stream on older prompts, since the action interrupts
  // the live turn before rewinding.
  const showRestore = !readOnly && !showStop && Boolean(onRequestRestoreConfirm) && hasBody

  const bubbleClassName = cn(
    USER_BUBBLE_BASE_CLASS,
    'cursor-pointer text-[length:var(--conversation-text-font-size)] leading-(--dt-line-height) text-foreground/95 transition-colors',
    'border-(--ui-stroke-tertiary) hover:border-(--ui-stroke-secondary)'
  )

  const bubbleContent = hasBody ? (
    <div className="min-h-[1.25rem]">
      <UserMessageText className="wrap-anywhere" text={messageText} />
    </div>
  ) : (
    // A file-only turn (a bare large paste, a dropped file) has no prose, so
    // its chips ARE the prompt: they fill the bubble rather than leaving it
    // empty above a detached row. Images keep their thumbnail row below.
    chipOnlyTurn && (
      <div className="flex min-h-[1.25rem] flex-wrap gap-1">
        <DirectiveContent text={attachmentRefs.join(' ')} />
      </div>
    )
  )

  return (
    <MessagePrimitive.Root asChild>
      <UserMessageContainer
        attachments={
          // Previews sit above the prompt and share its right edge.
          attachmentRefs.length > 0 && !chipOnlyTurn ? (
            <div className="w-fit max-w-[min(85%,42rem)] self-end" data-slot="aui_user-attachments">
              <DirectiveContent text={attachmentRefs.join(' ')} />
            </div>
          ) : null
        }
        messageId={messageId}
      >
        <ActionBarPrimitive.Root className="relative w-full max-w-full" data-slot="aui_user-bubble-actions">
          <div className="human-message-with-todos-wrapper flex w-full flex-col gap-0">
            <ReactionPicker
              onOpenChange={setPickerOpen}
              onSelect={pickEmoji}
              open={pickerOpen}
              selected={shownReactions.find(reaction => reaction.author === 'user')?.emoji}
            >
              <div
                className="relative w-full"
                // The app context menu skips PLAIN right-clicks here (the
                // attr below) so this handler keeps the picker gesture; a
                // link/image/selection inside the bubble still gets the app
                // menu, and this handler's selection guard keeps ⌘C flows.
                data-context-menu-skip=""
                onContextMenu={
                  // Right-click is the desktop reaction gesture. A touch long-press
                  // in the browser-hosted Desktop stays the platform's, so selection
                  // handles and Copy are never replaced by the picker; a mouse
                  // right-click on the same device still opens it.
                  readOnly || !reactionsEnabled
                    ? undefined
                    : event => {
                        if (hasTextSelection() || isTouchInteraction(event.nativeEvent)) {
                          return
                        }

                        event.preventDefault()
                        setPickerOpen(true)
                      }
                }
              >
                {touch ? (
                  <TouchUserBubble
                    className={bubbleClassName}
                    editable={!readOnly}
                    expandable={false}
                    expanded={false}
                    onToggleExpanded={() => undefined}
                    showRestore={showRestore}
                    showStop={showStop}
                  >
                    {bubbleContent}
                  </TouchUserBubble>
                ) : readOnly ? (
                  <div className={cn(bubbleClassName, 'cursor-text')}>{bubbleContent}</div>
                ) : (
                  // Always editable — clicking opens the edit composer even while a
                  // turn streams; sending the edit reverts (interrupt + rewind).
                  // A live text highlight wins: finishing a drag-select must not
                  // open the editor and throw the selection away.
                  <ActionBarPrimitive.Edit asChild>
                    <button
                      aria-label={copy.editMessage}
                      className={bubbleClassName}
                      onClick={event => {
                        if (hasTextSelection()) {
                          event.preventDefault()
                          event.stopPropagation()

                          return
                        }

                        triggerHaptic('selection')
                      }}
                      onPointerDown={() => {
                        if (hasTextSelection()) {
                          return
                        }

                        notifyThreadEditOpen()
                      }}
                      type="button"
                    >
                      {bubbleContent}
                    </button>
                  </ActionBarPrimitive.Edit>
                )}
              </div>
            </ReactionPicker>
            <div className="flex min-h-6 items-center justify-end gap-2 px-1 pt-1.5" data-slot="aui_user-message-meta">
              <UserBubbleActions
                fullText={messageText}
                messageId={messageId}
                onCancel={onCancel}
                onRequestRestoreConfirm={onRequestRestoreConfirm}
                runtimeUserOrdinal={runtimeUserOrdinal}
                showRestore={showRestore}
                showStop={showStop}
                touch={touch}
              />
              <MessageTimelineTimestamp />
            </div>
            {/* Below the bubble, same register as the assistant action row:
                same emoji size, same vertical padding, right-aligned to the
                sent bubble. Overlaying the corner read badly in practice. */}
            <ReactionBadge
              className="justify-end gap-1.5 py-1.5 pr-1.5"
              onRetract={() => react(null)}
              reactions={shownReactions}
            />
            <BranchPickerPrimitive.Root
              className={cn(
                'checkpoint-container flex items-center gap-1 pb-0 pt-1 pl-1.5 text-[0.75rem] leading-none text-(--ui-text-tertiary)',
                readOnly && 'hidden'
              )}
              hideWhenSingleBranch
            >
              <span aria-hidden className="checkpoint-icon size-1.5 rounded-full border border-current" />
              <BranchPickerPrimitive.Previous
                className="checkpoint-restore-text rounded-sm bg-transparent px-1 opacity-65 hover:opacity-100 disabled:hidden disabled:cursor-default"
                title={copy.restorePrevious}
              >
                {copy.restoreCheckpoint}
              </BranchPickerPrimitive.Previous>
              <span className="checkpoint-divider opacity-55">
                <BranchPickerPrimitive.Number />/<BranchPickerPrimitive.Count />
              </span>
              <BranchPickerPrimitive.Next
                className="checkpoint-restore-text rounded-sm bg-transparent px-1 opacity-65 hover:opacity-100 disabled:hidden disabled:cursor-default"
                title={copy.restoreNext}
              >
                {copy.goForward}
              </BranchPickerPrimitive.Next>
            </BranchPickerPrimitive.Root>
          </div>
        </ActionBarPrimitive.Root>
      </UserMessageContainer>
    </MessagePrimitive.Root>
  )
}
