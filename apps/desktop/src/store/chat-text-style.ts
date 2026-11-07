import { atom } from 'nanostores'

import { persistString, storedString } from '@/lib/storage'

const KEY = 'hermes.desktop.chat-text-style.v1'

/**
 * Conversation text presets, painted as `data-chat-text-style` on the root
 * (styles.css). `default` is the theme's face at the theme's weight; `slim`
 * is the same face lighter and at Claude's size; `claude` mirrors Claude
 * Code's transcript: Anthropic Sans (installed locally) at variable weight
 * 360, 15px, line-height 1.4.
 */
export const CHAT_TEXT_STYLES = ['default', 'slim', 'claude'] as const
export type ChatTextStyle = (typeof CHAT_TEXT_STYLES)[number]

function normalizeChatTextStyle(value: unknown): ChatTextStyle {
  return CHAT_TEXT_STYLES.find(style => style === value) ?? 'default'
}

export const $chatTextStyle = atom<ChatTextStyle>(normalizeChatTextStyle(storedString(KEY)))

export function setChatTextStyle(value: string): void {
  $chatTextStyle.set(normalizeChatTextStyle(value))
}

if (typeof window !== 'undefined') {
  // Follow other windows and `hermes config ui` (the preference sync replays
  // machine-store changes as storage events).
  window.addEventListener('storage', event => {
    if (event.key === KEY) {
      setChatTextStyle(event.newValue ?? 'default')
    }
  })

  $chatTextStyle.subscribe(value => {
    const root = document.documentElement

    if (value === 'default') {
      delete root.dataset.chatTextStyle
    } else {
      root.dataset.chatTextStyle = value
    }

    persistString(KEY, value === 'default' ? null : value)
  })
}
