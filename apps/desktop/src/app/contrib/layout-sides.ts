import { computed } from 'nanostores'

import { allPaneIds } from '@/components/pane-shell/tree/model'
import {
  $collapsedTreeSides,
  $layoutTree,
  bindTreeSideVisibility,
  mirrorLayoutTree
} from '@/components/pane-shell/tree/store'
import { modeLayout } from '@/store/interface-mode'
import {
  $panesFlipped,
  $sessionPanelOpen,
  $sidebarOpen,
  fileBrowserSide,
  setSidebarOpen
} from '@/store/layout'

/** Side toggles belong to panes, not physical edges. Derive the flip from the
 * tree so dragging sessions or choosing a mirrored preset remaps the buttons. */
export function bindLayoutSides() {
  const sessionsOnRight = () => {
    const tree = $layoutTree.get()

    if (!tree) {
      return null
    }

    const order = allPaneIds(tree)
    const sessions = order.indexOf('sessions')
    const main = order.indexOf('workspace')

    return sessions >= 0 && main >= 0 ? sessions > main : null
  }

  $layoutTree.subscribe(() => {
    const flipped = sessionsOnRight()

    if (flipped !== null && flipped !== $panesFlipped.get()) {
      $panesFlipped.set(flipped)
    }
  })

  $panesFlipped.listen(flipped => {
    const current = sessionsOnRight()

    // Restoration replaces the tree; a transient mismatch is not a flip gesture.
    if (!modeLayout.restoring && current !== null && current !== flipped) {
      mirrorLayoutTree()
    }
  })

  // The right sidebar (side panel) open state is owned by `$sessionPanelOpen` (⌘B
  // and the titlebar toggle). Closing individual tool tabs never collapses the
  // side — it returns to the empty-state launcher instead.
  const $leftEdgeOpen = computed([$panesFlipped, $sidebarOpen, $sessionPanelOpen], (flipped, sidebar, panel) =>
    flipped ? panel : sidebar
  )

  const $rightEdgeOpen = computed([$panesFlipped, $sidebarOpen, $sessionPanelOpen], (flipped, sidebar, panel) =>
    flipped ? sidebar : panel
  )

  bindTreeSideVisibility('left', $leftEdgeOpen, open =>
    $panesFlipped.get() ? $sessionPanelOpen.set(open) : setSidebarOpen(open)
  )
  bindTreeSideVisibility('right', $rightEdgeOpen, open =>
    $panesFlipped.get() ? setSidebarOpen(open) : $sessionPanelOpen.set(open)
  )

  // Keep `$sessionPanelOpen` truthful if a tool reveal (`⌘G`, `⌘J`, `⌃\``) opens
  // the right side directly via `setTreeSideCollapsed`.
  $collapsedTreeSides.listen(collapsed => {
    const open = !collapsed.has(fileBrowserSide())

    if ($sessionPanelOpen.get() !== open) {
      $sessionPanelOpen.set(open)
    }
  })
}
