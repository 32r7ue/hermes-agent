import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  $sidePanelFocusedEdge,
  $sidePanelMaximized,
  $sidePanelOpen,
  $sidePanelZones,
  closeFocusedSidePanelTab,
  moveSidePanelTab,
  openSidePanelTool,
  toggleSidePanel,
  toggleSidePanelMaximized
} from '@/store/side-panel'
import { $subagentsBySession } from '@/store/subagents'

vi.mock('@/app/contrib/panes', () => ({
  FilesPane: () => <div data-testid="mock-files-pane">Open files appear here</div>,
  ReviewPaneContent: () => <div data-testid="mock-review-pane">Review diff</div>
}))

vi.mock('@/app/contrib/wiring', () => ({
  WiredPane: ({ part }: { part: string }) => <div data-testid={`mock-wired-${part}`}>Terminal PTY</div>
}))

vi.mock('@/app/chat/right-rail/preview', () => ({
  PreviewTilePane: ({ tabId }: { tabId: string }) => <div data-testid={`mock-browser-${tabId}`}>Browser</div>
}))

import { SidePanelShell } from './side-panel-host'

function resetSidePanel() {
  $sidePanelOpen.set(false)
  $sidePanelMaximized.set(false)
  $sidePanelFocusedEdge.set(null)
  $sidePanelZones.set({
    bottom: { activeTabId: null, size: 260, tabs: [] },
    left: { activeTabId: null, size: 380, tabs: [] },
    right: { activeTabId: null, size: 540, tabs: [] },
    top: { activeTabId: null, size: 240, tabs: [] }
  })
  $subagentsBySession.set({})
}

describe('SidePanelShell', () => {
  beforeEach(resetSidePanel)
  afterEach(resetSidePanel)

  it('starts closed, opens to Launcher on ⌘B (no tab), and closes cleanly on ⌘B again', () => {
    const { container } = render(
      <SidePanelShell>
        <div data-testid="chat-workspace">Chat</div>
      </SidePanelShell>
    )

    expect(screen.getByTestId('chat-workspace')).toBeTruthy()
    expect(container.querySelector('[data-side-panel-edge="right"]')).toBeNull()

    // ⌘B opens right side panel to the Launcher — NOT as a tab
    act(() => toggleSidePanel())
    expect(container.querySelector('[data-side-panel-edge="right"]')).not.toBeNull()
    expect(container.querySelector('[data-slot="session-info"]')).not.toBeNull()
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(0)

    // ⌘B closes right side panel completely — NO leftover rail
    act(() => toggleSidePanel())
    expect(container.querySelector('[data-side-panel-edge="right"]')).toBeNull()
  })

  it('opens tools from Launcher as tabs, returns to Launcher when last tab closes via ⌘W', () => {
    const { container } = render(
      <SidePanelShell>
        <div data-testid="chat-workspace">Chat</div>
      </SidePanelShell>
    )

    act(() => toggleSidePanel())
    fireEvent.click(screen.getByRole('button', { name: /Files/i }))

    // Files tab is open, Launcher is gone
    expect(container.querySelector('[data-slot="session-info"]')).toBeNull()
    expect(container.querySelector('[data-side-panel-tab="files"]')).not.toBeNull()
    expect(screen.getByTestId('mock-files-pane')).toBeTruthy()

    // Open Terminal alongside Files
    act(() => openSidePanelTool('terminal'))
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(2)
    expect(screen.getByTestId('mock-wired-terminal')).toBeTruthy()

    // ⌘W closes active tab (Terminal), returning to Files — NO rail left behind
    act(() => {
      expect(closeFocusedSidePanelTab()).toBe(true)
    })
    expect(container.querySelector('[data-side-panel-tab="terminal"]')).toBeNull()
    expect(container.querySelector('[data-side-panel-tab="files"]')).not.toBeNull()

    // ⌘W closes last tab (Files) -> right panel stays open and shows Launcher again
    act(() => {
      expect(closeFocusedSidePanelTab()).toBe(true)
    })
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(0)
    expect(container.querySelector('[data-slot="session-info"]')).not.toBeNull()
  })

  it('moves a tab to bottom split panel and removes bottom panel cleanly when closed', () => {
    const { container } = render(
      <SidePanelShell>
        <div data-testid="chat-workspace">Chat</div>
      </SidePanelShell>
    )

    act(() => {
      openSidePanelTool('files')
      openSidePanelTool('terminal')
    })

    // Move Terminal to bottom (matching 00:12 in the ClaudeDevs video)
    act(() => moveSidePanelTab('right', 'terminal', 'bottom'))

    expect(container.querySelector('[data-side-panel-edge="right"] [data-side-panel-tab="files"]')).not.toBeNull()
    expect(container.querySelector('[data-side-panel-edge="bottom"] [data-side-panel-tab="terminal"]')).not.toBeNull()

    // Close bottom panel via its × button -> completely gone, zero leftover rail
    const closeBottom = container.querySelector('[data-side-panel-close="bottom"]') as HTMLButtonElement
    fireEvent.click(closeBottom)

    expect(container.querySelector('[data-side-panel-edge="bottom"]')).toBeNull()
    expect(container.querySelector('[data-side-panel-edge="right"] [data-side-panel-tab="files"]')).not.toBeNull()
  })

  it('shows live running subagents/background tasks in Launcher and opens Background tasks tab', () => {
    $subagentsBySession.set({
      s1: [
        {
          filesRead: [],
          filesWritten: [],
          goal: 'Run dev server in background',
          id: 'sub-1',
          parentId: null,
          startedAt: Date.now() - 5000,
          status: 'running',
          stream: [],
          taskCount: 1,
          taskIndex: 0,
          updatedAt: Date.now()
        }
      ]
    })

    const { container } = render(
      <SidePanelShell>
        <div data-testid="chat-workspace">Chat</div>
      </SidePanelShell>
    )

    act(() => toggleSidePanel())
    expect(screen.getByText('Subagents')).toBeTruthy()
    expect(screen.getByText('Run dev server in background')).toBeTruthy()

    fireEvent.click(screen.getByText('Run dev server in background'))
    expect(container.querySelector('[data-side-panel-tab="background-tasks"]')).not.toBeNull()
    expect(screen.getByText('Running')).toBeTruthy()
  })

  it('toggles maximize cleanly and resets when panel closes', () => {
    const { container } = render(
      <SidePanelShell>
        <div data-testid="chat-workspace">Chat</div>
      </SidePanelShell>
    )

    act(() => openSidePanelTool('files'))
    expect($sidePanelMaximized.get()).toBe(false)

    act(() => toggleSidePanelMaximized())
    expect($sidePanelMaximized.get()).toBe(true)

    // Closing side panel resets maximized so it never reopens stuck in fullscreen
    act(() => toggleSidePanel())
    expect($sidePanelOpen.get()).toBe(false)
    expect($sidePanelMaximized.get()).toBe(false)
    expect(container.querySelector('[data-side-panel-edge="right"]')).toBeNull()
  })
})
