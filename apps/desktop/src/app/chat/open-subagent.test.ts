import { beforeEach, describe, expect, it, vi } from 'vitest'

const { $layoutTree, $sessionTiles, focusOpenSession, openSessionTile } = await vi.hoisted(async () => {
  const { atom } = await import('nanostores')
  const { vi } = await import('vitest')

  return {
    $layoutTree: atom<null | { panes: string[] }>(null),
    $sessionTiles: atom<{ storedSessionId: string; watch?: boolean }[]>([]),
    focusOpenSession: vi.fn<(id: string) => 'main' | 'tile' | null>(() => null),
    openSessionTile: vi.fn()
  }
})

vi.mock('@/store/session-states', () => ({
  $sessionTiles,
  focusOpenSession: (id: string) => focusOpenSession(id),
  openSessionTile: (...args: unknown[]) => openSessionTile(...args)
}))

vi.mock('@/components/pane-shell/tree/store', async importActual => ({
  ...(await importActual<Record<string, unknown>>()),
  $layoutTree
}))

vi.mock('@/components/pane-shell/tree/model', () => ({
  findGroupOfPane: (tree: { panes: string[] }, paneId: string) => (tree.panes.includes(paneId) ? { id: 'g' } : null)
}))

import { openSubagentPane } from './open-subagent'

describe('openSubagentPane', () => {
  const resolveOwner = vi.fn(async (_id: string) => 'work' as unknown)

  beforeEach(() => {
    focusOpenSession.mockReset()
    focusOpenSession.mockReturnValue(null)
    openSessionTile.mockReset()
    resolveOwner.mockClear()
    $sessionTiles.set([])
    $layoutTree.set({ panes: ['workspace'] })
  })

  it('opens the child as a spectator tile split to the right, routed by its parent', async () => {
    await openSubagentPane('child-1', {
      parentSessionId: 'parent-1',
      resolveOwner: resolveOwner as never,
      title: 'Fix the bug'
    })

    expect(resolveOwner).toHaveBeenCalledWith('parent-1')
    expect(openSessionTile).toHaveBeenCalledWith('child-1', 'right', undefined, undefined, {
      ownerProfile: 'work',
      watch: true,
      watchParentSessionId: 'parent-1',
      workspaceMode: 'sessions',
      workspaceTabTitle: 'Fix the bug'
    })
    expect(focusOpenSession).toHaveBeenLastCalledWith('child-1')
  })

  it('carries an exact owner route when the parent has one', async () => {
    const route = { connectionId: 'remote-1', profile: 'coder' }
    resolveOwner.mockResolvedValueOnce(route)

    await openSubagentPane('child-1', { parentSessionId: 'parent-1', resolveOwner: resolveOwner as never })

    expect(openSessionTile.mock.calls[0][4]).toEqual({
      ownerRoute: route,
      watch: true,
      watchParentSessionId: 'parent-1',
      workspaceMode: 'sessions'
    })
  })

  it('fronts an already-open child instead of opening a duplicate', async () => {
    focusOpenSession.mockReturnValue('tile')

    await openSubagentPane('child-1', { parentSessionId: 'parent-1', resolveOwner: resolveOwner as never })

    expect(openSessionTile).not.toHaveBeenCalled()
    expect(resolveOwner).not.toHaveBeenCalled()
  })

  it('does not open twice when a second click raced the owner lookup', async () => {
    focusOpenSession.mockReturnValueOnce(null).mockReturnValueOnce('tile')

    await openSubagentPane('child-1', { parentSessionId: 'parent-1', resolveOwner: resolveOwner as never })

    expect(openSessionTile).not.toHaveBeenCalled()
  })

  it('stacks another child into the open spectator pane instead of a new split', async () => {
    $sessionTiles.set([{ storedSessionId: 'other', watch: true }, { storedSessionId: 'plain' }])
    $layoutTree.set({ panes: ['workspace', 'session-tile:other', 'session-tile:plain'] })

    await openSubagentPane('child-2', { parentSessionId: 'parent-1', resolveOwner: resolveOwner as never })

    expect(openSessionTile).toHaveBeenCalledWith(
      'child-2',
      'center',
      'session-tile:other',
      null,
      expect.objectContaining({ watch: true })
    )
  })
})
