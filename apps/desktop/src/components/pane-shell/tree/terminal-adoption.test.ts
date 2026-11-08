import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// A saved layout that lost the terminal's own zone used to re-adopt the terminal
// into the FIRST group, the sessions sidebar, as a third tab beside Sessions/Bots.

describe('a bottom tool panel missing from a saved layout', () => {
  beforeEach(() => {
    window.localStorage.clear()
    vi.resetModules()
  })

  afterEach(() => {
    vi.resetModules()
  })

  it('comes back under the chat, never into the sessions sidebar or over the chat', async () => {
    const saved = JSON.stringify({
      type: 'split',
      id: 'spl-root',
      orientation: 'row',
      children: [
        { type: 'group', id: 'grp-sessions', panes: ['sessions'], active: 'sessions' },
        { type: 'group', id: 'grp-main', panes: ['workspace'], active: 'workspace' }
      ],
      weights: [1, 3.4]
    })

    for (const key of ['hermes.desktop.layoutTree.v2', 'hermes.desktop.layoutTree.v2.simple']) {
      window.localStorage.setItem(key, saved)
    }

    const tree = await import('@/components/pane-shell/tree/store')
    const model = await import('@/components/pane-shell/tree/model')
    const { registry } = await import('@/contrib/registry')

    for (const [id, placement] of [
      ['sessions', 'left'],
      ['workspace', 'main'],
      ['terminal', 'bottom']
    ] as const) {
      registry.register({ id, area: 'panes', title: id, data: { placement }, render: () => null })
    }

    tree.declareDefaultTree(
      model.split(
        'row',
        [
          model.group(['sessions'], { id: 'grp-sessions' }),
          model.split(
            'column',
            [model.group(['workspace'], { id: 'grp-main' }), model.group(['terminal'], { id: 'grp-terminal' })],
            [3, 1]
          )
        ],
        [1, 3.4]
      )
    )
    tree.watchContributedPanes()

    const layout = tree.$layoutTree.get()!
    const home = model.findGroupOfPane(layout, 'terminal')

    expect(home).toBeTruthy()
    expect(home!.panes).not.toContain('sessions')
    expect(home!.panes).not.toContain('workspace')
  })
})
