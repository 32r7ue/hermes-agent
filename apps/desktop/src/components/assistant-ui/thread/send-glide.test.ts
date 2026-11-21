import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { cancelGlide, glideFreeScrollMax, glideOverflow, jumpAndGlide, SEND_GLIDE_DURATION_MS } from './send-glide'

function scroller(scrollHeight: number, clientHeight: number) {
  const el = document.createElement('div')
  const content = document.createElement('div')
  el.append(content)
  let top = 0
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => scrollHeight })
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => clientHeight })
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (value: number) => {
      top = Math.max(0, Math.min(value, scrollHeight - clientHeight))
    }
  })

  return { content, el }
}

describe('send glide', () => {
  let animate: ReturnType<typeof vi.fn>
  let transform = 'none'

  beforeEach(() => {
    vi.useFakeTimers()
    transform = 'none'
    animate = vi.fn(() => ({ cancel: vi.fn(), finished: new Promise(() => {}) }) as unknown as Animation)
    Element.prototype.animate = animate as unknown as Element['animate']
    vi.spyOn(window, 'getComputedStyle').mockImplementation(() => ({ transform }) as CSSStyleDeclaration)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('jumps in the same call and slides the content back the distance, transform only', () => {
    const { content, el } = scroller(1000, 400)
    el.scrollTop = 500

    jumpAndGlide(el, content, 600)

    expect(el.scrollTop).toBe(600)
    expect(animate).toHaveBeenCalledTimes(1)
    const [keyframes, options] = animate.mock.calls[0]
    expect(keyframes).toEqual([{ transform: 'translateY(100px)' }, { transform: 'translateY(0)' }])
    expect(options).toMatchObject({ duration: SEND_GLIDE_DURATION_MS })
    expect(options).not.toHaveProperty('fill')
    cancelGlide(content)
  })

  it('retargets a glide in flight from where it renders instead of snapping', () => {
    const { content, el } = scroller(2000, 400)
    el.scrollTop = 1000

    jumpAndGlide(el, content, 1100)
    transform = 'matrix(1, 0, 0, 1, 0, 40)'
    expect(glideOverflow(content)).toBe(40)

    jumpAndGlide(el, content, 1130)

    expect(animate.mock.calls[1][0][0]).toEqual({ transform: 'translateY(70px)' })
    cancelGlide(content)
    expect(glideOverflow(content)).toBe(0)
  })

  it('measures the bottom without the glide overflow', () => {
    const { content, el } = scroller(1100, 400)
    el.scrollTop = 600
    jumpAndGlide(el, content, 700)
    transform = 'matrix(1, 0, 0, 1, 0, 100)'

    expect(glideFreeScrollMax(el, content)).toBe(600)
    cancelGlide(content)
  })

  it('never moves up, and only jumps under reduced motion', () => {
    const { content, el } = scroller(1000, 400)
    el.scrollTop = 500
    jumpAndGlide(el, content, 300)
    expect(el.scrollTop).toBe(500)

    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce') }))
    jumpAndGlide(el, content, 600)
    expect(el.scrollTop).toBe(600)
    expect(animate).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('cancels a glide a paused timeline would hold, and tells scroll caches it settled', () => {
    const { content, el } = scroller(1000, 400)
    const cancel = vi.fn()
    animate.mockReturnValue({ cancel, finished: new Promise(() => {}) })
    const onScroll = vi.fn()
    el.addEventListener('scroll', onScroll)

    jumpAndGlide(el, content, 200)
    vi.advanceTimersByTime(SEND_GLIDE_DURATION_MS + 200)

    expect(cancel).toHaveBeenCalled()
    expect(onScroll).toHaveBeenCalled()
  })
})
