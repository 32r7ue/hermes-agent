import { atom } from 'nanostores'

import type { ComposerTarget } from '@/app/chat/composer/focus'

/**
 * "Send now" for a steer still waiting for the current step (Claude Code's
 * model). The bubble asks the composer that owns its transcript to stop the
 * turn and send the words as the next prompt; a hard stop drops the agent's
 * pending steer, so they reach the model once. The waiting bubble hides
 * itself (it was never delivered, so nothing stored it either) and the
 * resent prompt draws its own.
 */
export interface SteerSendNowRequest {
  messageId: string
  target: ComposerTarget
  text: string
}

/** Pending-steer bubbles whose words were re-sent as a prompt. */
export const $sentNowSteerIds = atom<ReadonlySet<string>>(new Set())

const bus = new EventTarget()
const EVENT = 'steer-send-now'

export function requestSteerSendNow(request: SteerSendNowRequest): void {
  bus.dispatchEvent(new CustomEvent<SteerSendNowRequest>(EVENT, { detail: request }))
}

/** The owning composer calls this once it took the words; the bubble then hides. */
export function markSteerSentNow(messageId: string): void {
  $sentNowSteerIds.set(new Set([...$sentNowSteerIds.get(), messageId]))
}

export function onSteerSendNow(listener: (request: SteerSendNowRequest) => void): () => void {
  const handler = (event: Event) => listener((event as CustomEvent<SteerSendNowRequest>).detail)
  bus.addEventListener(EVENT, handler)

  return () => bus.removeEventListener(EVENT, handler)
}
