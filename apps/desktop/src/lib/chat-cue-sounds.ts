// Cursor's in-turn chat cues, mapped onto Hermes events the way Cursor's agent
// announcer fires them. The turn-end cue lives in completion-sound.ts (its
// "Cursor" variants); the thinking loop lives in thinking-cue.ts.

import { isSampleCompletionVariant } from '@/lib/completion-sound'
import { playSample, type SampleSoundId, warmSampleSounds } from '@/lib/sample-sounds'
import { ownsAmbientCue } from '@/store/ambient'
import { $chatCues, CHAT_CUES, type ChatCue } from '@/store/chat-cue-sounds'
import { $completionSoundVariantId } from '@/store/completion-sound'
import { $hapticsMuted } from '@/store/haptics'

// A turn that patches five files in a burst gets one cue, not a stutter.
const FILE_EDIT_MIN_GAP_MS = 400
let lastFileEditAt = -Infinity

export function chatCueEnabled(cue: ChatCue) {
  return $chatCues[cue].get() && !$hapticsMuted.get()
}

function cue(cueId: ChatCue, sample: SampleSoundId) {
  if (chatCueEnabled(cueId)) {
    playSample(sample)
  }
}

/** The user just sent (or steered) a message. Called synchronously from the
 *  submit handler so the cue lands on the keypress. Local to this window. */
export function playSendSound() {
  cue('sent', 'cursorRequestSent')
}

/** The user answered an approval card: approve → Cursor's "edits kept",
 *  deny → "edits undone". */
export function playApprovalSound(choice: string) {
  cue('approval', choice === 'deny' ? 'cursorEditsUndone' : 'cursorEditsKept')
}

/** The agent finished editing a file. Keyed per tool call so only one window plays it. */
export function playFileEditSound(dedupeKey: string) {
  if (!chatCueEnabled('fileEdited')) {
    return
  }

  const now = performance.now()

  if (now - lastFileEditAt < FILE_EDIT_MIN_GAP_MS) {
    return
  }

  lastFileEditAt = now
  void ownsAmbientCue(`edit-sound:${dedupeKey}`).then(
    owns => owns && chatCueEnabled('fileEdited') && playSample('cursorFileEdited')
  )
}

/** Decode the samples and open the audio device as soon as any recorded cue is
 *  switched on, so even the first one plays without a cold start. */
export function installSampleSoundWarmup() {
  const check = () => {
    if (
      !$hapticsMuted.get() &&
      (CHAT_CUES.some(c => $chatCues[c].get()) || isSampleCompletionVariant($completionSoundVariantId.get()))
    ) {
      void warmSampleSounds()
    }
  }

  const idle = window.requestIdleCallback ?? ((cb: () => void) => window.setTimeout(cb, 300))
  idle(check)
  CHAT_CUES.forEach(c => $chatCues[c].listen(check))
  $completionSoundVariantId.listen(check)
  $hapticsMuted.listen(check)
}
