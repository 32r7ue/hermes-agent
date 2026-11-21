// Contribution-area constants the SDK barrel re-exports whole: host-owned
// areas with no feature module of their own, plus area contracts whose module
// lives in core but has no other public door.

export const PANES_AREA = 'panes'
export const STATUSBAR_AREAS = { left: 'statusBar.left', right: 'statusBar.right' } as const
/** Titlebar slots are PERMANENT mount points: a component registered here
 *  stays mounted across chat ↔ page navigation, so `useEffect` setup/cleanup
 *  runs once per registration, not once per route. Page-owned controls that
 *  should exist only while a page is up go to `WORKSPACE_PAGE_HEADER_AREA`. */
export const TITLEBAR_AREAS = { center: 'titleBar.center', left: 'titleBar.left', right: 'titleBar.right' } as const
/** Draw the `MEDIA:` files your package's OWN tools produced, in place of the
 *  built-in player (ownership is checked against the backend's tool registry). */
export {
  TOOL_MEDIA_RENDERER_AREA,
  type ToolMediaFile,
  type ToolMediaRendererContribution,
  type ToolMediaRendererProps
} from '@/lib/tool-media-renderers'
