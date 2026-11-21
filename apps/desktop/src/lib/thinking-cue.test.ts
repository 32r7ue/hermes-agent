// Cursor's progress-loop schedule: 4 s grace, then clip + 5 s, gated on the turn.
import type { WritableAtom } from 'nanostores'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { playSample } from '@/lib/sample-sounds'
import { setChatCue } from '@/store/chat-cue-sounds'
import { setHapticsMuted } from '@/store/haptics'
import { $busy } from '@/store/session'

import { installThinkingCue, THINKING_CUE_GAP_MS, THINKING_CUE_START_DELAY_MS } from './thinking-cue'

const awaiting = vi.hoisted(() => ({ store: null as null | WritableAtom<boolean> }))

vi.mock('@/lib/sample-sounds', () => ({ playSample: vi.fn(), sampleDurationMs: () => 1000 }))
vi.mock('@/store/prompts', async () => {
  const { atom } = await import('nanostores')
  awaiting.store = atom(false)

  return { $activeSessionAwaitingInput: awaiting.store }
})

let uninstall: () => void

beforeEach(() => {
  vi.useFakeTimers()
  uninstall = installThinkingCue()
})

afterEach(() => {
  uninstall()
  $busy.set(false)
  awaiting.store!.set(false)
  setChatCue('thinking', true)
  setHapticsMuted(false)
  vi.useRealTimers()
  vi.clearAllMocks()
})

it('stays quiet for short turns and pulses every clip + 5 s after the 4 s grace', () => {
  $busy.set(true)
  vi.advanceTimersByTime(THINKING_CUE_START_DELAY_MS - 1)
  expect(playSample).not.toHaveBeenCalled()

  vi.advanceTimersByTime(1)
  expect(playSample).toHaveBeenCalledWith('cursorProgress')

  vi.advanceTimersByTime(1000 + THINKING_CUE_GAP_MS)
  expect(playSample).toHaveBeenCalledTimes(2)

  $busy.set(false)
  vi.advanceTimersByTime(60_000)
  expect(playSample).toHaveBeenCalledTimes(2)
})

it('pauses while the agent waits on the user and when switched off', () => {
  $busy.set(true)
  awaiting.store!.set(true)
  vi.advanceTimersByTime(30_000)
  expect(playSample).not.toHaveBeenCalled()

  awaiting.store!.set(false)
  setChatCue('thinking', false)
  vi.advanceTimersByTime(30_000)
  expect(playSample).not.toHaveBeenCalled()

  setChatCue('thinking', true)
  vi.advanceTimersByTime(THINKING_CUE_START_DELAY_MS)
  expect(playSample).toHaveBeenCalledTimes(1)
})
