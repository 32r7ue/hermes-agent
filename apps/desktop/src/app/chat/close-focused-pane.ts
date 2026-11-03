import { findGroup } from '@/components/pane-shell/tree/model'
import {
  $activeTreeGroup, $layoutTree, closeToolPane, closeTreePane,
  isHideOnlyPane, isMainStripPane, isSessionStripPane
} from '@/components/pane-shell/tree/store'

/** Cmd-W follows interaction focus before the chat fallback; hovering another zone cannot steal it. */
export function closeFocusedAuxiliaryPane(): boolean {
  const tree = $layoutTree.get()
  const focused = document.activeElement?.closest<HTMLElement>('[data-tree-group]')?.dataset.treeGroup
  const groupId = focused || $activeTreeGroup.get()
  const active = tree && groupId ? findGroup(tree, groupId)?.active : undefined

  if (!active || isSessionStripPane(active) || isHideOnlyPane(active)) {return false}

  if (isMainStripPane(active)) {closeTreePane(active)} else {closeToolPane(active)}

  return true
}
