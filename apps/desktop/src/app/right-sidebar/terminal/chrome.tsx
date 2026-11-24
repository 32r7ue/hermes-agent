import { TerminalSlot } from './persistent'

/** Pane-side terminal chrome: pure edge-to-edge terminal slot (no duplicate
 *  right-hand tab rail since Terminal already lives in the side-panel tab bar). */
export function TerminalPaneChrome() {
  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        <TerminalSlot />
      </div>
    </div>
  )
}
