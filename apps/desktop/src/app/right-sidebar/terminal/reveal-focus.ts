import { paletteToggle } from '@/app/command-palette/contrib'
import { allPaneIds, findGroup, groupLeafIds } from '@/components/pane-shell/tree/model'
import {
  $layoutTree,
  isPaneVisible,
  restoreTreePane,
  rootRow,
  togglePaneVisible
} from '@/components/pane-shell/tree/store'
import { Terminal } from '@/lib/icons'
import { isFocusWithin } from '@/lib/keybinds/combo'
import { trackArea } from '@/store/desktop-metrics'

const TERMINAL_FOCUS_SCOPE = '[data-terminal]'

// Inactive tabs carry `invisible`. The on-screen instance does not, so this
// never targets a keep-alive tab that is not the keyboard surface. xterm's
// helper textarea is its real keyboard input — the same element the clipboard
// helper writes a selection into.
const FOCUS_TARGET = `${TERMINAL_FOCUS_SCOPE}:not(.invisible) .xterm-helper-textarea`

// The pane layout settles over a couple of frames (slot rect chase, theme
// repaint), and the composer focus bus can steal the keyboard on the macrotask
// between them. Three frames covers that settle plus one re-assert, then stops
// so a later deliberate click in the composer is not a focus fight.
const REVEAL_FOCUS_ATTEMPTS = 3

/**
 * Take keyboard focus for the active terminal once its pane has been revealed.
 *
 * Terminals stay mounted while the pane is hidden, so the activation effect
 * that calls `term.focus()` does not re-run on reveal. Every user reveal
 * (Ctrl+`, the palette row, the statusbar pill) has to claim the keyboard
 * itself and take it back if the composer wins the next frame.
 */
function focusRevealedTerminal(): void {
  scheduleFocusAttempt(REVEAL_FOCUS_ATTEMPTS)
}

function scheduleFocusAttempt(attempts: number): void {
  window.requestAnimationFrame(() => {
    // A hide that lands before the settle window ends must not pull the
    // keyboard back onto a pane the user just closed.
    if (!isPaneVisible('terminal') || isFocusWithin(TERMINAL_FOCUS_SCOPE)) {
      return
    }

    document.querySelector<HTMLTextAreaElement>(FOCUS_TARGET)?.focus()

    if (attempts > 1) {
      scheduleFocusAttempt(attempts - 1)
    }
  })
}

/**
 * User toggle of the terminal pane. The reveal direction claims keyboard
 * focus; the hide direction does not.
 */
export function toggleTerminalPane(): void {
  const revealed = !isPaneVisible('terminal')

  togglePaneVisible('terminal')
  trackArea('terminal_pane', revealed)

  if (revealed) {
    focusRevealedTerminal()
  }
}

// The tool panes ⌘J carries with the terminal when they share its column.
const COLUMN_TOOL_PANES = new Set(['terminal', 'files', 'review', 'logs'])

const isMainColumnPane = (paneId: string) =>
  paneId === 'workspace' || paneId.startsWith('session-tile:') || paneId.startsWith('route-tile:')

/**
 * ⌘J: the terminal's whole panel — every tool zone in the root column the
 * terminal lives in (Files and Review beside or above it), not the terminal
 * alone. Keyed on the terminal: on screen → close every tool in the column;
 * off → each tool zone shows the tab it had in front, and the terminal opens
 * with the keyboard. Other panes sharing the column (the session panel) are
 * left as they are. When the terminal sits under the chat (Basic / Focus),
 * its column is the main one and only the terminal toggles — a Files or
 * Review tab there would cover the conversation.
 */
export function toggleTerminalColumn(): void {
  const tree = $layoutTree.get()
  const column = rootRow()?.children.find(child => allPaneIds(child).includes('terminal'))

  if (!tree || !column || allPaneIds(column).some(isMainColumnPane)) {
    toggleTerminalPane()

    return
  }

  const tools = allPaneIds(column).filter(id => COLUMN_TOOL_PANES.has(id))

  if (isPaneVisible('terminal')) {
    for (const id of tools) {
      if (isPaneVisible(id)) {
        togglePaneVisible(id)
      }
    }

    trackArea('terminal_pane', false)

    return
  }

  for (const groupId of groupLeafIds(column)) {
    const group = findGroup(tree, groupId)
    const groupTools = group?.panes.filter(id => COLUMN_TOOL_PANES.has(id)) ?? []

    if (!group || groupTools.length === 0 || groupTools.includes('terminal')) {
      continue
    }

    const pane = group.active && groupTools.includes(group.active) ? group.active : groupTools[0]!

    if (!isPaneVisible(pane)) {
      restoreTreePane(pane)
    }
  }

  // Last, so the terminal's reveal owns the keyboard.
  toggleTerminalPane()
}

/**
 * ⌘K door onto the same pane the keybind and statusbar pill flip — was a
 * one-way "open" row under Go to, so it never showed on/off and couldn't hide.
 * Reads the TREE like every other pane toggle: `$terminalTakeover` stays true
 * behind a stacked sibling tab or a minimized zone, which would light the row
 * "on" for a terminal that isn't on screen.
 *
 * Lives here, not inline in the contrib controller, so the reveal-focus test
 * drives the real row without importing the whole app graph.
 */
export const terminalPaletteToggle = paletteToggle({
  id: 'view.showTerminal',
  label: 'Toggle terminal',
  action: 'view.showTerminal',
  icon: Terminal,
  keywords: ['terminal', 'shell', 'console', 'pty'],
  get: () => isPaneVisible('terminal'),
  set: () => toggleTerminalPane()
})
