import { afterEach, describe, expect, it } from 'vitest'

import { clearReplyAnchor, replyAnchorCap, setReplyAnchor } from './reply-anchor'

function scroller(scrollTop: number) {
  const el = document.createElement('div')
  el.scrollTop = scrollTop
  Object.defineProperty(el, 'scrollTop', { configurable: true, value: scrollTop, writable: true })
  document.body.append(el)

  return el
}

describe('reply anchor', () => {
  afterEach(() => {
    clearReplyAnchor()
    document.body.replaceChildren()
  })

  it('keeps holding where the view is when the held reply is remounted', () => {
    const el = scroller(40)
    const reply = document.createElement('p')
    el.append(reply)
    setReplyAnchor(reply)

    expect(replyAnchorCap(el)).not.toBeNull()

    reply.remove()

    expect(replyAnchorCap(el)).toBe(40)

    clearReplyAnchor()

    expect(replyAnchorCap(el)).toBeNull()
  })

  it('never holds a scroller the anchor did not hold', () => {
    const reply = document.createElement('p')
    setReplyAnchor(reply)

    expect(replyAnchorCap(scroller(40))).toBeNull()
  })
})
