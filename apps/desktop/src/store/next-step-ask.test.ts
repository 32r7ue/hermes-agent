import { describe, expect, it, vi } from 'vitest'

import { registerNextStepAsk, takeNextStepAsk } from './next-step-ask'

describe('next-step ask registry', () => {
  it('runs the surface’s open ask once, then nothing', () => {
    const run = vi.fn()
    registerNextStepAsk('surface-a', run)

    expect(takeNextStepAsk('surface-b')).toBe(false)
    expect(takeNextStepAsk('surface-a')).toBe(true)
    expect(takeNextStepAsk('surface-a')).toBe(false)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('forgets an ask whose panel went away', () => {
    const run = vi.fn()
    const unregister = registerNextStepAsk('surface-a', run)
    unregister()

    expect(takeNextStepAsk('surface-a')).toBe(false)
    expect(run).not.toHaveBeenCalled()
  })
})
