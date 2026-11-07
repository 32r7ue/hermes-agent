import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { onComposerInsertRequest } from '@/app/chat/composer/focus'
import { ComposerScopeProvider, MAIN_COMPOSER_SCOPE } from '@/app/chat/composer/scope'

import { quoteSelection, SelectionReply } from './selection-reply'

afterEach(() => {
  window.getSelection()?.removeAllRanges()
  cleanup()
  vi.restoreAllMocks()
})

it('quotes a selection into its own composer and leaves the original message intact', async () => {
  const inserts: unknown[] = []
  const off = onComposerInsertRequest(detail => inserts.push(detail))

  const view = render(
    <ComposerScopeProvider value={{ ...MAIN_COMPOSER_SCOPE, target: 'tile:example' }}>
      <div>
        <p data-role="assistant">First line. Second line.</p>
        <SelectionReply />
      </div>
    </ComposerScopeProvider>
  )

  const text = view.container.querySelector('p')!.firstChild!
  const range = document.createRange()
  range.setStart(text, 0)
  range.setEnd(text, 11)
  range.getBoundingClientRect = () => ({ left: 100, top: 200 }) as DOMRect
  act(() => {
    window.getSelection()!.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
  })
  fireEvent.click(screen.getByRole('button', { name: 'Reply to selection' }))
  await waitFor(() => expect(inserts).toEqual([{ mode: 'quote', target: 'tile:example', text: '> First line.' }]))
  expect(view.container.querySelector('p')!.textContent).toBe('First line. Second line.')
  expect(window.getSelection()!.isCollapsed).toBe(true)
  off()
})

it('does not offer a reply for a selection spanning different messages', () => {
  const view = render(
    <div>
      <p data-role="assistant">One</p>
      <p data-role="user">Two</p>
      <SelectionReply />
    </div>
  )

  const rows = view.container.querySelectorAll('p')
  const range = document.createRange()
  range.setStart(rows[0]!.firstChild!, 0)
  range.setEnd(rows[1]!.firstChild!, 3)
  act(() => {
    window.getSelection()!.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
  })
  expect(screen.queryByRole('button', { name: 'Reply to selection' })).toBeNull()
})

it('marks a multi-line selection with a single quote marker', () => {
  expect(quoteSelection('First point.\n\nSecond point.\n Third point. ')).toBe(
    '> First point.\nSecond point.\nThird point.\n\n'
  )
})
