import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ESC_HOLD_MS } from '../esc-hold'

import { useComposerEscCancel } from './use-composer-esc-cancel'

function Harness({ busy, onCancel }: { busy: boolean; onCancel: () => void }) {
  useComposerEscCancel({ awaitingInput: false, busy, onCancel, target: 'main' })

  return null
}

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

describe('useComposerEscCancel', () => {
  it('cancels the turn on a HELD Esc while busy with chat focus', () => {
    vi.useFakeTimers()
    const onCancel = vi.fn()
    render(<Harness busy onCancel={onCancel} />)

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onCancel).not.toHaveBeenCalled()
    vi.advanceTimersByTime(ESC_HOLD_MS)
    fireEvent.keyUp(window, { key: 'Escape' })

    expect(onCancel).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('ignores a tapped Esc (a button remapped to Esc must not stop the chat)', () => {
    vi.useFakeTimers()
    const onCancel = vi.fn()
    render(<Harness busy onCancel={onCancel} />)

    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.keyUp(window, { key: 'Escape' })
    vi.advanceTimersByTime(ESC_HOLD_MS * 2)

    expect(onCancel).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('does not cancel on Esc when the turn is not busy', () => {
    const onCancel = vi.fn()
    render(<Harness busy={false} onCancel={onCancel} />)

    fireEvent.keyDown(window, { key: 'Escape' })

    expect(onCancel).not.toHaveBeenCalled()
  })

  it('does not cancel on Esc while an overlay surface covers the chat', () => {
    const onCancel = vi.fn()
    render(<Harness busy onCancel={onCancel} />)

    // OverlayView stamps `data-overlay-surface` on its root — the same signal
    // the type-to-focus path uses to stand down while an overlay is open.
    const overlay = document.createElement('div')
    overlay.setAttribute('data-overlay-surface', '')
    document.body.appendChild(overlay)

    fireEvent.keyDown(window, { key: 'Escape' })

    expect(onCancel).not.toHaveBeenCalled()
  })
})
