import { describe, expect, it } from 'vitest'

import { reasoningHeadline } from './reasoning-headline'

describe('reasoningHeadline', () => {
  it('takes the newest title and marks a titles-only body', () => {
    expect(reasoningHeadline('**Gathering sources**\n\n**Clarifying the count**')).toEqual({
      headline: 'Clarifying the count',
      titleOnly: true
    })
  })

  it('keeps a body with prose expandable', () => {
    expect(reasoningHeadline('**Checking**\n\nI need to look at the config first.')).toEqual({
      headline: 'Checking',
      titleOnly: false
    })
  })

  it('has no headline for plain thinking text (Claude)', () => {
    expect(reasoningHeadline('Let me think about this carefully.')).toEqual({ headline: null, titleOnly: false })
  })
})
