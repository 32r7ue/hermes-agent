import { useAuiState } from '@assistant-ui/react'
import { registryBackendScopeKey } from '@hermes/shared'
import { useStore } from '@nanostores/react'
import { useCallback } from 'react'

import { requestComposerSubmit } from '@/app/chat/composer/focus'
import { useSessionView } from '@/app/chat/session-view'
import type { ChatMessage } from '@/lib/chat-messages'
import { activeGatewayConnectionId } from '@/store/gateway'
import { $activeGatewayProfile } from '@/store/profile'
import { toggleMessageReaction } from '@/store/reactions'
import { $reactionsEnabled } from '@/store/reactions-enabled'
import {
  $agentReactions,
  $localReactions,
  agentLiveReactions,
  mergeReactions,
  setLocalReaction
} from '@/store/reactions-local'
import { sessionEventScopeFor } from '@/store/session-states'
import type { MessageReaction } from '@/types/hermes'

// Stable empty identity — a fresh [] per render would re-run every consumer.
const EMPTY_REACTIONS: MessageReaction[] = []

/** The hidden turn a reaction starts. The gateway puts the reaction itself in
 *  front of it (`agent.reactions.pending_reaction_note`). */
const REACTION_WAKE_PROMPT =
  'The user reacted to your message (see the note). Take it as feedback and respond to it briefly; do not repeat your earlier answer.'

/** Paint the tapback locally, then persist behind it. `wake` runs once the
 *  reaction is stored, so the turn it starts sees it. */
function commitReaction(
  messageId: string,
  role: ChatMessage['role'],
  rowId: number | undefined,
  reactions: MessageReaction[],
  emoji: null | string,
  sessionId: null | string,
  wake?: () => void
): void {
  // Flip the UI immediately — a tapback is direct manipulation and must never
  // wait on a round-trip. Persistence follows in the background.
  setLocalReaction(messageId, emoji)
  void toggleMessageReaction({ id: messageId, role, rowId, reactions } as ChatMessage, emoji, 'user', sessionId).then(
    stored => stored && wake?.()
  )
}

/**
 * A message's reactions and the one way to change them.
 *
 * Reads the durable list off `metadata.custom`, layers this window's live
 * overlays on top (the user's own click, the agent's mid-turn event), and
 * hands back a `react` that paints locally first and persists behind it.
 * Shared by the assistant footer slot, the user bubble's picker, and the
 * double-click gesture so all three apply identical tapback semantics.
 */
export function useMessageReactions(
  messageId: string,
  role: ChatMessage['role']
): {
  enabled: boolean
  react: (emoji: null | string) => void
  reactions: MessageReaction[]
} {
  const reactions = useAuiState(s => {
    const custom = (s.message.metadata?.custom ?? {}) as { reactions?: MessageReaction[] }

    return custom.reactions ?? EMPTY_REACTIONS
  })

  const rowId = useAuiState(s => {
    const custom = (s.message.metadata?.custom ?? {}) as { rowId?: number }

    return custom.rowId
  })

  const enabled = useStore($reactionsEnabled)
  const localAll = useStore($localReactions)
  const agentAll = useStore($agentReactions)
  const sessionView = useSessionView()
  const runtimeSessionId = useStore(sessionView.$runtimeId)
  const storedSessionId = useStore(sessionView.$storedId)
  const sessionId = runtimeSessionId ?? storedSessionId
  const busy = useStore(sessionView.$busy)
  // A reaction to the agent's message wakes an idle primary chat: a hidden
  // turn the agent answers. Busy chats get the note on their next turn anyway.
  const wakes = role === 'assistant' && sessionView.kind === 'primary' && !busy

  // The agent overlay is keyed by bare DB row id, and row ids are only
  // meaningful within ONE source's database. Resolve the source this
  // displayed session actually belongs to — the scope its own events
  // proved, falling back to the actively served source when the runtime's
  // events arrived untagged (local legacy primary) — so an overlay recorded
  // on source A can never repaint a coincidental same-numbered row on
  // source B (a tile from another connection, a cross-source resume).
  const activeProfile = useStore($activeGatewayProfile)

  const viewScope =
    sessionEventScopeFor(runtimeSessionId) ?? registryBackendScopeKey(activeGatewayConnectionId(), activeProfile)

  const agentLive = rowId === undefined ? undefined : agentLiveReactions(agentAll, rowId, viewScope)

  return {
    enabled,
    react: useCallback(
      (emoji: null | string) =>
        commitReaction(
          messageId,
          role,
          rowId,
          reactions,
          emoji,
          sessionId,
          emoji && wakes
            ? () => void requestComposerSubmit(REACTION_WAKE_PROMPT, { displayKind: 'hidden', target: 'active' })
            : undefined
        ),
      [messageId, reactions, role, rowId, sessionId, wakes]
    ),
    reactions: mergeReactions(reactions, localAll[messageId], agentLive)
  }
}
