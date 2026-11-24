import { describe, expect, it } from 'vitest'

import { allPaneIds, group, type LayoutNode, moveGroupToEdge, movePaneToEdge, split } from './model'

const isSessions = (g: { panes: string[] }) => g.panes.includes('sessions')

const shape = (node: LayoutNode): unknown =>
  node.type === 'group' ? node.panes.join('+') : { [node.orientation]: node.children.map(shape) }

const tree = () =>
  split(
    'row',
    [
      group(['sessions'], { id: 'side' }),
      group(['workspace'], { id: 'main' }),
      group(['files', 'terminal'], { id: 'tools' })
    ],
    [1, 3, 1.5],
    'root'
  )

describe('moveGroupToEdge', () => {
  it('bottom: spans the content beside the pinned sidebar, not the sidebar', () => {
    const next = moveGroupToEdge(tree(), 'tools', 'bottom', isSessions)

    expect(shape(next)).toEqual({ row: ['sessions', { column: ['workspace', 'files+terminal'] }] })
  })

  it('left: lands inside the pinned sidebar', () => {
    const next = moveGroupToEdge(tree(), 'tools', 'left', isSessions)

    expect(shape(next)).toEqual({ row: ['sessions', 'files+terminal', 'workspace'] })
  })

  it('top over a split content keeps every pane', () => {
    const start = split('row', [
      group(['sessions']),
      group(['workspace']),
      group(['review']),
      group(['files', 'terminal'], { id: 'tools' })
    ])

    const next = moveGroupToEdge(start, 'tools', 'top', isSessions)

    expect(shape(next)).toEqual({ row: ['sessions', { column: ['files+terminal', { row: ['workspace', 'review'] }] }] })
    expect(allPaneIds(next).sort()).toEqual(['files', 'review', 'sessions', 'terminal', 'workspace'])
  })

  it('round-trips bottom then right', () => {
    const down = moveGroupToEdge(tree(), 'tools', 'bottom', isSessions)
    const back = moveGroupToEdge(down, 'tools', 'right', isSessions)

    expect(shape(back)).toEqual({ row: ['sessions', 'workspace', 'files+terminal'] })
  })

  it('a tab splits off to the edge; its zone keeps the rest (Claude Code Move)', () => {
    const next = movePaneToEdge(tree(), 'terminal', 'bottom', isSessions)

    expect(shape(next)).toEqual({ row: ['sessions', { column: [{ row: ['workspace', 'files'] }, 'terminal'] }] })
  })

  it('a lone tab carries its zone', () => {
    const start = split('row', [group(['sessions']), group(['workspace']), group(['terminal'], { id: 't' })])

    expect(shape(movePaneToEdge(start, 'terminal', 'left', isSessions))).toEqual({
      row: ['sessions', 'terminal', 'workspace']
    })
  })

  it('is a no-op for a missing or lone zone', () => {
    const start = tree()

    expect(moveGroupToEdge(start, 'nope', 'left')).toBe(start)

    const lone = group(['workspace'], { id: 'main' })

    expect(moveGroupToEdge(lone, 'main', 'left')).toBe(lone)
  })
})
