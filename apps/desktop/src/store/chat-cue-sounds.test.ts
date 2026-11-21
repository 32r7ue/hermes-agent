// `hermes config ui hermes.desktop.chatCue.<cue> false` lands as a storage event (ui-preferences sync).
import { expect, it } from 'vitest'

import { isSharedPreferenceKey } from '@/lib/ui-preferences/keys'

import { $chatCues, CHAT_CUES, chatCueStorageKey } from './chat-cue-sounds'
import { $completionSoundVariantId } from './completion-sound'

it('every cue key is machine-shared and follows external writes live', () => {
  for (const cue of CHAT_CUES) {
    const key = chatCueStorageKey(cue)
    expect(isSharedPreferenceKey(key)).toBe(true)

    window.localStorage.setItem(key, 'false')
    window.dispatchEvent(new StorageEvent('storage', { key, newValue: 'false' }))
    expect($chatCues[cue].get()).toBe(false)

    window.localStorage.setItem(key, 'true')
    window.dispatchEvent(new StorageEvent('storage', { key, newValue: 'true' }))
    expect($chatCues[cue].get()).toBe(true)
  }
})

it('the completion sound follows external writes live', () => {
  const key = 'hermes.desktop.completionSoundVariantId'
  window.localStorage.setItem(key, '0')
  window.dispatchEvent(new StorageEvent('storage', { key, newValue: '0' }))
  expect($completionSoundVariantId.get()).toBe(0)
})
