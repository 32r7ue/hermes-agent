import { atom } from 'nanostores'
import { afterEach, beforeAll, expect, it } from 'vitest'

import { $terminalTakeover, setTerminalTakeover } from '@/app/right-sidebar/store'
import { toggleTerminalColumn } from '@/app/right-sidebar/terminal/reveal-focus'
import { group, split } from '@/components/pane-shell/tree/model'
import {
  $layoutTree,
  bindPaneVisibility,
  bindToolPaneCollapse,
  isPaneVisible
} from '@/components/pane-shell/tree/store'
import { registry } from '@/contrib/registry'

// ⌘J opens the terminal's whole column — Files and Review with it — and
// closes it again, leaving anything else in that column (the session panel)
// alone. Under the chat (the main column) it is the terminal alone.

const $files = atom(false)
const $review = atom(false)
const $panel = atom(true)

const sideTree = () =>
  split('row', [
    group(['workspace'], { active: 'workspace', id: 'grp-main' }),
    split('column', [
      group(['session-info'], { active: 'session-info', id: 'grp-panel' }),
      split('row', [group(['review'], { id: 'grp-review' }), group(['files'], { id: 'grp-files' })]),
      group(['terminal'], { active: 'terminal', id: 'grp-terminal' })
    ])
  ])

beforeAll(() => {
  for (const [id, placement] of [
    ['workspace', 'main'],
    ['session-info', 'right'],
    ['review', 'right'],
    ['files', 'right'],
    ['terminal', 'bottom']
  ] as const) {
    registry.register({ id, area: 'panes', title: id, data: { placement }, render: () => null })
  }

  $layoutTree.set(sideTree())
  bindPaneVisibility('files', $files, () => $files.set(false), () => $files.set(true))
  bindPaneVisibility('review', $review, () => $review.set(false), () => $review.set(true))
  bindPaneVisibility('session-info', $panel, () => $panel.set(false), () => $panel.set(true))
  bindToolPaneCollapse('terminal', $terminalTakeover, () => setTerminalTakeover(false), () => setTerminalTakeover(true))
})

afterEach(() => {
  $files.set(false)
  $review.set(false)
  $panel.set(true)
  setTerminalTakeover(false)
})

it('opens and closes the terminal together with Files and Review in its column', () => {
  expect(isPaneVisible('terminal')).toBe(false)

  toggleTerminalColumn()

  expect(isPaneVisible('terminal')).toBe(true)
  expect(isPaneVisible('files')).toBe(true)
  expect(isPaneVisible('review')).toBe(true)
  expect(isPaneVisible('session-info')).toBe(true)

  toggleTerminalColumn()

  expect(isPaneVisible('terminal')).toBe(false)
  expect(isPaneVisible('files')).toBe(false)
  expect(isPaneVisible('review')).toBe(false)
  // Not a tool: the session panel sharing the column stays.
  expect(isPaneVisible('session-info')).toBe(true)
})

it('toggles only the terminal when it sits under the chat', () => {
  $layoutTree.set(
    split('row', [
      split('column', [
        group(['workspace'], { active: 'workspace', id: 'grp-main' }),
        group(['terminal'], { active: 'terminal', id: 'grp-terminal' })
      ]),
      split('row', [group(['review'], { id: 'grp-review' }), group(['files'], { id: 'grp-files' })])
    ])
  )

  toggleTerminalColumn()

  expect(isPaneVisible('terminal')).toBe(true)
  expect(isPaneVisible('files')).toBe(false)
  expect(isPaneVisible('review')).toBe(false)

  $layoutTree.set(sideTree())
})
