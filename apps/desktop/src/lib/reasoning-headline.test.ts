import { describe, expect, it } from 'vitest'

import { reasoningAfterLead, reasoningHeadline, reasoningPreview } from './reasoning-headline'

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

describe('reasoningPreview', () => {
  it('lifts the opening sentence out of the body', () => {
    const text = 'I will check the **config** first. Then the tests.'
    const preview = reasoningPreview(text)!

    expect(preview).toEqual({ lead: 'I will check the **config** first.', text: 'I will check the config first.', whole: false })
    expect(reasoningAfterLead(text, preview.lead)).toBe('Then the tests.')
  })

  it('treats a one-sentence thought as whole', () => {
    expect(reasoningPreview('  Let me think about this.  ')).toMatchObject({ text: 'Let me think about this.', whole: true })
  })

  it('ends the sentence at a closing emphasis or a paragraph break', () => {
    expect(reasoningPreview('This is **done.** Next.')?.lead).toBe('This is **done.**')
    expect(reasoningPreview('Plan without a stop\n\nSecond paragraph.')).toMatchObject({
      lead: 'Plan without a stop',
      text: 'Plan without a stop',
      whole: false
    })
    expect(reasoningPreview('## Heading\n- item one.')?.lead).toBe('## Heading')
  })

  it('keeps the body whole when the header cannot show the sentence', () => {
    const long = `${'word '.repeat(80)}end.`
    const preview = reasoningPreview(`${long} After.`)!

    expect(preview.lead).toBeNull()
    expect(preview.text.endsWith('…')).toBe(true)
    expect(reasoningPreview('```ts\nconst x = 1\n```\nThat is the value.')).toMatchObject({
      lead: null,
      text: 'That is the value.'
    })
  })
})
