import { describe, expect, it } from 'vitest'

import type { SessionMessage } from '@/types/hermes'

import { toChatMessages } from '.'

describe('stored thinking time', () => {
  it('carries display_metadata.reasoning_seconds onto the reasoning part', () => {
    const [message] = toChatMessages([
      {
        id: 7,
        role: 'assistant',
        content: 'answer',
        reasoning: 'thinking it over',
        timestamp: 1000,
        display_metadata: { reasoning_seconds: 12.4 }
      } as unknown as SessionMessage
    ])

    expect(message?.parts.find(part => part.type === 'reasoning')).toMatchObject({ durationSeconds: 12.4 })
  })
})
