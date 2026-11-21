// The move down to a just-sent message, run on the compositor.
//
// The scroll itself happens at once, inside the commit that adds the bubble
// (before paint), so the first frame after Enter already has the message in
// view. What the eye sees as the glide is the transcript content sliding the
// distance it just jumped back to rest: a transform-only WAAPI animation, which
// Chromium runs off the main thread. Long React commits around a send (the reply
// placeholder, the admission receipt) can no longer stall it mid-flight the way
// they stalled use-stick-to-bottom's per-frame scrollTop spring.

export const SEND_GLIDE_DURATION_MS = 180
const SEND_GLIDE_EASING = 'cubic-bezier(0.22, 1, 0.36, 1)'

const running = new WeakMap<HTMLElement, { animation: Animation; timer: number }>()

/** The vertical offset a running glide currently renders `content` at. */
function currentGlideOffset(content: HTMLElement): number {
  if (!running.has(content)) {
    return 0
  }

  const transform = getComputedStyle(content).transform

  // matrix(a, b, c, d, tx, ty) or matrix3d(…, tx, ty, tz, w)
  const values = /^matrix(3d)?\((.+)\)$/.exec(transform ?? '')?.[2]?.split(',').map(Number)

  if (!values) {
    return 0
  }

  const ty = values.length === 16 ? values[13] : values[5]

  return Number.isFinite(ty) ? ty : 0
}

/**
 * How far a running glide inflates its scroller's scrollHeight. A transform
 * counts toward scrollable overflow, so mid-glide `scrollHeight` reads up to
 * the glide distance taller than the laid-out transcript; following that
 * phantom bottom overshoots, and the browser then clamps scrollTop back down
 * frame by frame as the glide settles — a visible shudder.
 */
export function glideOverflow(content: HTMLElement | null | undefined): number {
  return content ? Math.max(0, currentGlideOffset(content)) : 0
}

/** The scroller's real bottom: scrollHeight without a running glide's overflow. */
export function glideFreeScrollMax(el: HTMLElement, content: HTMLElement | null | undefined): number {
  return Math.max(0, el.scrollHeight - el.clientHeight - glideOverflow(content))
}

function motionAllowed(content: HTMLElement): boolean {
  if (typeof content.animate !== 'function' || document.hidden) {
    return false
  }

  return !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
}

/**
 * Slide `content` up by `delta` px — the distance its scroller just jumped
 * down — so the jump reads as a glide. A glide already in flight is retargeted
 * from where it currently renders, so content landing mid-glide (the reply
 * placeholder) extends the motion instead of snapping.
 */
export function glideContent(content: HTMLElement | null, delta: number): void {
  if (!content || !(delta > 0.5) || !motionAllowed(content)) {
    return
  }

  const from = delta + currentGlideOffset(content)
  cancelGlide(content)

  // Transform only, no fill: once finished (or cancelled) the effect releases
  // instead of holding a transform and its compositor layer.
  const animation = content.animate([{ transform: `translateY(${from}px)` }, { transform: 'translateY(0)' }], {
    duration: SEND_GLIDE_DURATION_MS,
    easing: SEND_GLIDE_EASING
  })

  // A paused document timeline (hidden/occluded window) would hold the opening
  // frame and leave the transcript displaced; never let it outlive its slot.
  const timer = window.setTimeout(() => {
    cancelGlide(content)
    settled(content)
  }, SEND_GLIDE_DURATION_MS + 150)

  running.set(content, { animation, timer })

  const release = () => {
    if (running.get(content)?.animation === animation) {
      window.clearTimeout(timer)
      running.delete(content)
      settled(content)
    }
  }

  animation.finished?.then(release, release)
}

export function cancelGlide(content: HTMLElement | null): void {
  const glide = content && running.get(content)

  if (!glide) {
    return
  }

  running.delete(content)
  window.clearTimeout(glide.timer)
  glide.animation.cancel()
}

// Scroll-position caches (the thread's live scroll state, use-stick-to-bottom's
// near-bottom flag) last read the scroller while the glide inflated it, and a
// transform ending fires neither scroll nor resize. A scroll event on the
// scroller makes them re-read the settled geometry; scrollTop is unchanged, so
// nothing reads it as the reader scrolling.
function settled(content: HTMLElement) {
  content.parentElement?.dispatchEvent(new Event('scroll'))
}

/**
 * Move `el` to `target` now and glide its content the distance travelled.
 * Only ever moves down: a target above the current position is left alone.
 */
export function jumpAndGlide(el: HTMLElement, content: HTMLElement | null, target: number): void {
  const before = el.scrollTop

  if (!(target > before)) {
    return
  }

  el.scrollTop = target
  glideContent(content, el.scrollTop - before)
}
