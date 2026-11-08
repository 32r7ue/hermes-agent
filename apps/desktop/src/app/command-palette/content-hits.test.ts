import { describe, expect, it } from 'vitest'

import { leadingSnippetParts, snippetParts, snippetText } from './content-hits'

describe('snippetParts', () => {
  it('splits FTS markers into emphasized hits', () => {
    expect(snippetParts('...set >>>nebius<<< 20%, >>>sandisk<<< 20%')).toEqual([
      { hit: false, text: '...set ' },
      { hit: true, text: 'nebius' },
      { hit: false, text: ' 20%, ' },
      { hit: true, text: 'sandisk' },
      { hit: false, text: ' 20%' }
    ])
  })

  it('flattens newlines so the snippet fits one row', () => {
    expect(snippetText('line one\n>>>two<<<\nthree')).toBe('line one two three')
  })
  it('drops markdown emphasis around a hit', () => {
    expect(snippetText('The **>>>Habsburgs<<<** won')).toBe('The Habsburgs won')
  })
})

describe('leadingSnippetParts', () => {
  it('cuts long text before the first hit so the hit stays visible', () => {
    const parts = leadingSnippetParts(`${'word '.repeat(30)}near the >>>hit<<< end`)

    expect(parts[0].text.startsWith('…')).toBe(true)
    expect(parts[0].text.length).toBeLessThanOrEqual(33)
    expect(parts[1]).toEqual({ hit: true, text: 'hit' })
  })
})
