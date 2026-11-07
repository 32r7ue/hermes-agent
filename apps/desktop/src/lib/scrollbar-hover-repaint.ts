// Chromium paints a custom ::-webkit-scrollbar once and does not repaint it when
// only the scroller's :hover changes, so the hover-only thumb sometimes never
// shows and sometimes stays after the pointer left (sidebar session list). When
// the pointer crosses a scroller's edge, toggle its overflow for one layout so
// the scrollbar is rebuilt with the current :hover style. scrollTop survives.
const SCROLLER = '.scrollbar-fade'

function scrollers(node: EventTarget | null): Set<HTMLElement> {
  const found = new Set<HTMLElement>()
  let el = node instanceof Element ? node.closest<HTMLElement>(SCROLLER) : null

  while (el) {
    found.add(el)
    el = el.parentElement?.closest<HTMLElement>(SCROLLER) ?? null
  }

  return found
}

export function repaintScrollbar(el: HTMLElement): void {
  const previous = el.style.overflowY
  el.style.overflowY = 'hidden'
  void el.offsetWidth
  el.style.overflowY = previous
}

function onCross(event: MouseEvent): void {
  const from = scrollers(event.type === 'mouseover' ? event.relatedTarget : event.target)
  const to = scrollers(event.type === 'mouseover' ? event.target : event.relatedTarget)
  const changed = [...from, ...to].filter(el => from.has(el) !== to.has(el))

  if (changed.length) {
    requestAnimationFrame(() => changed.forEach(repaintScrollbar))
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('mouseover', onCross, { passive: true })
  document.addEventListener('mouseout', event => {
    // Leaving the window: relatedTarget is null, so every scroller under the pointer lost :hover.
    if (!event.relatedTarget) {onCross(event)}
  }, { passive: true })
}
