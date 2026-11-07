import { atom } from 'nanostores'

import { persistString, storedString } from '@/lib/storage'

const REVEAL_KEY = 'hermes.desktop.reply-reveal.v1'
const HOLD_TOP_KEY = 'hermes.desktop.reply-hold-top.v1'

/**
 * How a reply arrives. `reveal` (default) holds it until it is done, then shows it whole with a soft
 * sweep; `live` is the original token-by-token stream.
 */
export const REPLY_REVEAL_MODES = ['reveal', 'live'] as const
export type ReplyRevealMode = (typeof REPLY_REVEAL_MODES)[number]

const normalizeMode = (value: unknown): ReplyRevealMode => REPLY_REVEAL_MODES.find(mode => mode === value) ?? 'reveal'

export const $replyReveal = atom<ReplyRevealMode>(normalizeMode(storedString(REVEAL_KEY)))

/** Whether a finished reply holds the view at its top instead of following to its end. */
export const $replyHoldTop = atom<boolean>(storedString(HOLD_TOP_KEY) !== 'off')

export function setReplyReveal(value: string): void {
  $replyReveal.set(normalizeMode(value))
}

export function setReplyHoldTop(value: boolean): void {
  $replyHoldTop.set(value)
}

if (typeof window !== 'undefined') {
  // Follow other windows (the preference sync replays changes as storage events).
  window.addEventListener('storage', event => {
    if (event.key === REVEAL_KEY) {
      setReplyReveal(event.newValue ?? 'reveal')
    } else if (event.key === HOLD_TOP_KEY) {
      setReplyHoldTop(event.newValue !== 'off')
    }
  })

  $replyReveal.subscribe(value => persistString(REVEAL_KEY, value === 'reveal' ? null : value))
  $replyHoldTop.subscribe(value => persistString(HOLD_TOP_KEY, value ? null : 'off'))
}
