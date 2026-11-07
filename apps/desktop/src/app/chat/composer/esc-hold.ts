/**
 * Esc stops a running turn only when HELD. A key remapped to Escape (a mouse or
 * keyboard macro button) arrives as an instant press-and-release that the page
 * cannot tell apart from the physical key, so a tap no longer stops anything:
 * hold Esc for ESC_HOLD_MS and the turn stops while the key is still down.
 */
export const ESC_HOLD_MS = 400

let timer: null | number = null

function disarm() {
  if (timer !== null) {
    window.clearTimeout(timer)
    timer = null
  }

  window.removeEventListener('keyup', onKeyUp, true)
  window.removeEventListener('blur', disarm)
}

function onKeyUp(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    disarm()
  }
}

/** Arm on Esc keydown; `stop` runs only if Esc is still held after ESC_HOLD_MS.
 *  Auto-repeat keydowns while armed are ignored. */
export function armEscHoldToStop(stop: () => void): void {
  if (timer !== null) {
    return
  }

  window.addEventListener('keyup', onKeyUp, true)
  window.addEventListener('blur', disarm)
  timer = window.setTimeout(() => {
    disarm()
    stop()
  }, ESC_HOLD_MS)
}
