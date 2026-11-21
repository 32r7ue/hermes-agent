import { atom, type WritableAtom } from 'nanostores'

import { persistStore } from '@/lib/persist-store'
import { persistBoolean, storedBoolean } from '@/lib/storage'

// Cursor's in-turn chat cues (lib/chat-cue-sounds.ts). One machine-shared key per
// cue, so each is switchable from Settings → Sounds or live from the agent:
//   hermes config ui hermes.desktop.chatCue.thinking false
export const CHAT_CUES = ['sent', 'thinking', 'fileEdited', 'approval'] as const

export type ChatCue = (typeof CHAT_CUES)[number]

export const chatCueStorageKey = (cue: ChatCue) => `hermes.desktop.chatCue.${cue}`

export const $chatCues = Object.fromEntries(
  CHAT_CUES.map(cue => {
    const store = atom(storedBoolean(chatCueStorageKey(cue), true))
    persistStore(store, (on, options) => persistBoolean(chatCueStorageKey(cue), on, options), true)

    return [cue, store]
  })
) as Record<ChatCue, WritableAtom<boolean>>

if (typeof window !== 'undefined') {
  // Other windows and `hermes config ui` (the preference sync replays
  // machine-store changes as storage events).
  window.addEventListener('storage', event => {
    const cue = CHAT_CUES.find(c => chatCueStorageKey(c) === event.key)

    if (cue) {
      $chatCues[cue].set(storedBoolean(chatCueStorageKey(cue), true))
    }
  })
}

export function setChatCue(cue: ChatCue, on: boolean) {
  $chatCues[cue].set(on)
}
