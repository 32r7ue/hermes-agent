import { createContext, useContext } from 'react'

import { isWatchWindow } from '@/store/windows'

// A spectator surface mirrors a subagent run driven by its parent's agent:
// no composer, and prompts can't be edited, restored, or stopped from it.
// A whole watch window is one; inside a normal window, a spectator session
// tile (`SessionTile.watch`) provides it for its own subtree.
const SpectatorContext = createContext(false)

export const SpectatorProvider = SpectatorContext.Provider

export function useIsSpectator(): boolean {
  return useContext(SpectatorContext) || isWatchWindow()
}
