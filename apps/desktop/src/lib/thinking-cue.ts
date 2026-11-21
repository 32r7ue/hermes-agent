// Cursor's "still working" cue, on Cursor's own schedule (its agent announcer
// drives VS Code's progress signal loop): nothing for the first 4 s of a turn,
// then progress.mp3, then 5 s after each play ends, again — about every 6 s.
// It follows the turn in THIS window's chat only, and goes quiet the moment the
// turn ends, the agent waits on the user (approval, clarify, sudo, secret), or
// the cue is switched off.

import { chatCueEnabled } from '@/lib/chat-cue-sounds'
import { playSample, sampleDurationMs } from '@/lib/sample-sounds'
import { $chatCues } from '@/store/chat-cue-sounds'
import { $hapticsMuted } from '@/store/haptics'
import { $activeSessionAwaitingInput } from '@/store/prompts'
import { $busy } from '@/store/session'

export const THINKING_CUE_START_DELAY_MS = 4000
export const THINKING_CUE_GAP_MS = 5000

let timer: number | null = null

function stop() {
  if (timer !== null) {
    window.clearTimeout(timer)
    timer = null
  }
}

function tick() {
  playSample('cursorProgress')
  timer = window.setTimeout(tick, sampleDurationMs('cursorProgress') + THINKING_CUE_GAP_MS)
}

function sync() {
  const working = $busy.get() && !$activeSessionAwaitingInput.get() && chatCueEnabled('thinking')

  if (!working) {
    return stop()
  }

  if (timer === null) {
    timer = window.setTimeout(tick, THINKING_CUE_START_DELAY_MS)
  }
}

export function installThinkingCue(): () => void {
  const unsubs = [$busy, $activeSessionAwaitingInput, $chatCues.thinking, $hapticsMuted].map(store =>
    store.listen(sync)
  )

  sync()

  return () => {
    unsubs.forEach(off => off())
    stop()
  }
}
