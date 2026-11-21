/**
 * Open a delegated subagent's transcript BESIDE the parent chat, in this
 * window: a spectator session tile docked to the right (`SessionTile.watch`).
 *
 * Why a session tile and not the right rail: a tile already is the full chat
 * surface (Thread, tool rows, streaming) bound to a runtime through the tile
 * delegate, and gateway events route into it by runtime id. A spectator tile
 * resumes the child exactly like a watch window (`session.resume` with
 * `lazy: true`), so the gateway's subagent live mirror streams the child's run
 * into it, and it never builds an agent on — or submits into — the child.
 *
 * Re-clicking a subagent that is already open fronts its tab. Further
 * subagents stack as tabs in the existing spectator pane instead of carving
 * one more split per child.
 */
import { findGroupOfPane } from '@/components/pane-shell/tree/model'
import { $layoutTree } from '@/components/pane-shell/tree/store'
import { TILE_PANE_PREFIX } from '@/store/session-focus'
import { noteUserSessionOpen } from '@/store/session-open-intent'
import { isSessionOwnerRoute, type SessionOwnerScope } from '@/store/session-request-router'
import {
  $sessionTiles,
  focusOpenSession,
  openSessionTile,
  type SessionTileWorkspaceScope
} from '@/store/session-states'

export interface OpenSubagentOptions {
  /** The parent chat's stored id — the child runs on its backend/profile. */
  parentSessionId?: null | string
  /** Tab title (the child's goal); a hidden child has no Sessions row. */
  title?: string
  /** Test seam: owner resolution (defaults to the session-actions resolver). */
  resolveOwner?: (storedSessionId: string) => Promise<SessionOwnerScope>
}

async function defaultResolveOwner(storedSessionId: string): Promise<SessionOwnerScope> {
  // Lazy: the session-actions utils pull in a large module graph.
  const { resolveSessionOwner } = await import('@/app/session/hooks/use-session-actions/utils')

  return resolveSessionOwner(storedSessionId)
}

function ownerScope(owner: SessionOwnerScope): Pick<SessionTileWorkspaceScope, 'ownerProfile' | 'ownerRoute'> {
  if (isSessionOwnerRoute(owner)) {
    return { ownerRoute: owner }
  }

  return typeof owner === 'string' && owner.trim() ? { ownerProfile: owner.trim() } : {}
}

/** Pane of an already-open spectator tile, to stack the next child beside it. */
function openSpectatorPane(exceptStoredSessionId: string): null | string {
  const tree = $layoutTree.get()

  if (!tree) {
    return null
  }

  for (const tile of $sessionTiles.get()) {
    if (!tile.watch || tile.storedSessionId === exceptStoredSessionId) {
      continue
    }

    const paneId = `${TILE_PANE_PREFIX}${tile.storedSessionId}`

    if (findGroupOfPane(tree, paneId)) {
      return paneId
    }
  }

  return null
}

export async function openSubagentPane(childSessionId: string, options: OpenSubagentOptions = {}): Promise<void> {
  if (!childSessionId) {
    return
  }

  // Already on screen (its tile, or main)? Front it — never a duplicate.
  if (focusOpenSession(childSessionId)) {
    return
  }

  let owner: SessionOwnerScope

  try {
    owner = await (options.resolveOwner ?? defaultResolveOwner)(options.parentSessionId || childSessionId)
  } catch {
    owner = undefined
  }

  // A double click can land a second open while the owner resolved.
  if (focusOpenSession(childSessionId)) {
    return
  }

  noteUserSessionOpen()

  const scope: SessionTileWorkspaceScope = {
    ...ownerScope(owner),
    watch: true,
    ...(options.parentSessionId ? { watchParentSessionId: options.parentSessionId } : {}),
    workspaceMode: 'sessions',
    ...(options.title?.trim() ? { workspaceTabTitle: options.title.trim() } : {})
  }

  const spectatorPane = openSpectatorPane(childSessionId)

  if (spectatorPane) {
    openSessionTile(childSessionId, 'center', spectatorPane, null, scope)
  } else {
    openSessionTile(childSessionId, 'right', undefined, undefined, scope)
  }

  focusOpenSession(childSessionId)
}
