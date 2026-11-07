import { type ThreadMessage } from '@assistant-ui/react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, assert, beforeEach, describe, expect, it, vi } from 'vitest'

import { $displayTimestamps } from '@/store/display-timestamps'
import { clearAllPrompts, setApprovalRequest } from '@/store/prompts'
import { $activeSessionId } from '@/store/session'
import { clearDismissedToolRows } from '@/store/tool-dismiss'
import { $toolDisclosureStates } from '@/store/tool-view'

import { stubThreadEnvironment, stubThreadViewportSize, ThreadRuntime } from '../test-utils'
import { Thread } from '../thread'
import { formatTimelineRange } from '../thread/timestamp'

// Timeline timestamps render only when `display.timestamps` is enabled.
$displayTimestamps.set(true)

// Tool runs retain their own disclosure behavior. Approvals belong to a
// persistent transcript host outside those runs, so collapsing or mounting a
// tool row cannot hide or relocate the decision.

const createdAt = new Date('2026-06-03T00:00:00.000Z')

const resizeObservers = new Set<TestResizeObserver>()

// This suite drives resizes by hand, so it needs observers it can reach.
class TestResizeObserver {
  private target: Element | null = null

  constructor(private readonly callback: ResizeObserverCallback) {
    resizeObservers.add(this)
  }

  observe(target: Element) {
    this.target = target
  }

  unobserve() {}

  disconnect() {
    resizeObservers.delete(this)
  }
}

stubThreadEnvironment()
stubThreadViewportSize()
vi.stubGlobal('ResizeObserver', TestResizeObserver)

// A running assistant message with two tools: a completed read_file plus a
// pending terminal (no result), rendered as a flat two-row list.
function groupedPendingMessage(): ThreadMessage {
  return {
    id: 'assistant-group-1',
    role: 'assistant',
    content: [
      {
        type: 'tool-call',
        toolCallId: 'read-1',
        toolName: 'read_file',
        args: { path: '/etc/hosts' },
        argsText: JSON.stringify({ path: '/etc/hosts' }),
        result: { content: '127.0.0.1 localhost' }
      },
      {
        type: 'tool-call',
        toolCallId: 'term-1',
        toolName: 'terminal',
        args: { command: 'rm -rf /tmp/x' },
        argsText: JSON.stringify({ command: 'rm -rf /tmp/x' })
      }
    ],
    status: { type: 'running' },
    createdAt,
    metadata: {
      unstable_state: null,
      unstable_annotations: [],
      unstable_data: [],
      steps: [],
      custom: {}
    }
  } as unknown as ThreadMessage
}

function pendingOnlyMessage(): ThreadMessage {
  return {
    id: 'assistant-pending-only',
    role: 'assistant',
    content: [
      {
        type: 'tool-call',
        toolCallId: 'term-only',
        toolName: 'terminal',
        args: { command: 'sleep 10' },
        argsText: JSON.stringify({ command: 'sleep 10' })
      }
    ],
    status: { type: 'running' },
    createdAt,
    metadata: {
      unstable_state: null,
      unstable_annotations: [],
      unstable_data: [],
      steps: [],
      custom: {}
    }
  } as unknown as ThreadMessage
}

function completedOnlyMessage(): ThreadMessage {
  return {
    id: 'assistant-completed-only',
    role: 'assistant',
    content: [
      {
        type: 'tool-call',
        toolCallId: 'read-only',
        toolName: 'read_file',
        args: { path: '/etc/hosts' },
        argsText: JSON.stringify({ path: '/etc/hosts' }),
        timestamp: createdAt.getTime() / 1000 + 10.125,
        completedAt: createdAt.getTime() / 1000 + 12.875,
        result: { content: '127.0.0.1 localhost' }
      }
    ],
    status: { type: 'complete', reason: 'stop' },
    createdAt,
    metadata: {
      unstable_state: null,
      unstable_annotations: [],
      unstable_data: [],
      steps: [],
      custom: {}
    }
  } as unknown as ThreadMessage
}

// Two settled activity calls in a row, so the run earns a summary line and
// collapses behind it.
function settledRunMessage(): ThreadMessage {
  return {
    id: 'assistant-settled-run',
    role: 'assistant',
    content: [
      {
        type: 'tool-call',
        toolCallId: 'read-2',
        toolName: 'read_file',
        args: { path: '/repo/src/wiring.tsx' },
        argsText: JSON.stringify({ path: '/repo/src/wiring.tsx' }),
        timestamp: createdAt.getTime() / 1000 + 20,
        completedAt: createdAt.getTime() / 1000 + 21,
        result: { content: 'export const Wiring = () => null' }
      },
      {
        type: 'tool-call',
        toolCallId: 'term-3',
        toolName: 'terminal',
        args: { command: 'ls -la' },
        argsText: JSON.stringify({ command: 'ls -la' }),
        timestamp: createdAt.getTime() / 1000 + 22,
        completedAt: createdAt.getTime() / 1000 + 23.5,
        result: { exit_code: 0, stdout: 'wiring.tsx' }
      }
    ],
    status: { type: 'complete', reason: 'stop' },
    createdAt,
    metadata: {
      unstable_state: null,
      unstable_annotations: [],
      unstable_data: [],
      steps: [],
      custom: {}
    }
  } as unknown as ThreadMessage
}

// Activity, an edit, then more activity — all adjacent, so assistant-ui hands
// the whole stretch over as one group. The edit is the deliverable and has to
// survive that as its own card.
function editBetweenRunsMessage(): ThreadMessage {
  return {
    id: 'assistant-edit-between-runs',
    role: 'assistant',
    content: [
      {
        type: 'tool-call',
        toolCallId: 'read-5',
        toolName: 'read_file',
        args: { path: '/repo/src/a.ts' },
        argsText: JSON.stringify({ path: '/repo/src/a.ts' }),
        result: { content: 'a' }
      },
      {
        type: 'tool-call',
        toolCallId: 'search-3',
        toolName: 'search_files',
        args: { query: 'toolRuns' },
        argsText: JSON.stringify({ query: 'toolRuns' }),
        result: { hits: [] }
      },
      {
        type: 'tool-call',
        toolCallId: 'patch-2',
        toolName: 'patch',
        args: { path: '/repo/src/wiring.tsx' },
        argsText: JSON.stringify({ path: '/repo/src/wiring.tsx' }),
        result: { path: '/repo/src/wiring.tsx', inline_diff: '--- a\n+++ b\n+added line\n-removed line' }
      },
      {
        type: 'tool-call',
        toolCallId: 'read-6',
        toolName: 'read_file',
        args: { path: '/repo/src/b.ts' },
        argsText: JSON.stringify({ path: '/repo/src/b.ts' }),
        result: { content: 'b' }
      },
      {
        type: 'tool-call',
        toolCallId: 'term-4',
        toolName: 'terminal',
        args: { command: 'ls' },
        argsText: JSON.stringify({ command: 'ls' }),
        result: { exit_code: 0 }
      }
    ],
    status: { type: 'complete', reason: 'stop' },
    createdAt,
    metadata: {
      unstable_state: null,
      unstable_annotations: [],
      unstable_data: [],
      steps: [],
      custom: {}
    }
  } as unknown as ThreadMessage
}

// A finished turn that left a call without a result — interrupted, or the
// result landed elsewhere. The run is history and has to behave like it.
function abandonedRunMessage(): ThreadMessage {
  return {
    id: 'assistant-abandoned-run',
    role: 'assistant',
    content: [
      {
        type: 'tool-call',
        toolCallId: 'read-3',
        toolName: 'read_file',
        args: { path: '/repo/src/status.tsx' },
        argsText: JSON.stringify({ path: '/repo/src/status.tsx' }),
        result: { content: 'export const Status = () => null' }
      },
      {
        type: 'tool-call',
        toolCallId: 'search-1',
        toolName: 'search_files',
        args: { query: 'toolRuns' },
        argsText: JSON.stringify({ query: 'toolRuns' })
      }
    ],
    status: { type: 'complete', reason: 'stop' },
    createdAt,
    metadata: {
      unstable_state: null,
      unstable_annotations: [],
      unstable_data: [],
      steps: [],
      custom: {}
    }
  } as unknown as ThreadMessage
}

// The gap between one sequential call finishing and the next arriving: the
// turn is still running, the run is still the tail, but for this instant every
// call has a result.
function betweenSequentialCallsMessage(): ThreadMessage {
  return {
    id: 'assistant-between-calls',
    role: 'assistant',
    content: [
      {
        type: 'tool-call',
        toolCallId: 'term-a',
        toolName: 'terminal',
        args: { command: 'sleep 2; echo alpha' },
        argsText: JSON.stringify({ command: 'sleep 2; echo alpha' }),
        result: { exit_code: 0, stdout: 'alpha' }
      },
      {
        type: 'tool-call',
        toolCallId: 'term-b',
        toolName: 'terminal',
        args: { command: 'sleep 2; echo bravo' },
        argsText: JSON.stringify({ command: 'sleep 2; echo bravo' }),
        result: { exit_code: 0, stdout: 'bravo' }
      }
    ],
    status: { type: 'running' },
    createdAt,
    metadata: {
      unstable_state: null,
      unstable_annotations: [],
      unstable_data: [],
      steps: [],
      custom: {}
    }
  } as unknown as ThreadMessage
}

// Still streaming, but the agent has moved past its first run and left both of
// its calls unresolved. Only the run at the tail is still live.
function movedOnMessage(): ThreadMessage {
  return {
    id: 'assistant-moved-on',
    role: 'assistant',
    content: [
      {
        type: 'tool-call',
        toolCallId: 'read-4',
        toolName: 'read_file',
        args: { path: '/repo/src/status.tsx' },
        argsText: JSON.stringify({ path: '/repo/src/status.tsx' })
      },
      {
        type: 'tool-call',
        toolCallId: 'search-2',
        toolName: 'search_files',
        args: { query: 'toolRuns' },
        argsText: JSON.stringify({ query: 'toolRuns' })
      },
      { type: 'text', text: 'Let me read the rest of the file.' },
      {
        type: 'tool-call',
        toolCallId: 'term-2',
        toolName: 'terminal',
        args: { command: 'ls' },
        argsText: JSON.stringify({ command: 'ls' })
      }
    ],
    status: { type: 'running' },
    createdAt,
    metadata: {
      unstable_state: null,
      unstable_annotations: [],
      unstable_data: [],
      steps: [],
      custom: {}
    }
  } as unknown as ThreadMessage
}

const GroupHarness = ({ message }: { message: ThreadMessage }) => (
  <ThreadRuntime messages={[message]}>
    <Thread />
  </ThreadRuntime>
)

beforeEach(() => {
  clearAllPrompts()
  $activeSessionId.set('sess-1')
  $toolDisclosureStates.set({})
  clearDismissedToolRows()
})

afterEach(() => {
  cleanup()
  clearAllPrompts()
  $activeSessionId.set(null)
  clearDismissedToolRows()
})

describe('settled tool run', () => {
  it('collapses to a summary line naming the work', async () => {
    const { container } = render(<GroupHarness message={settledRunMessage()} />)

    expect(await screen.findByText('Explored wiring.tsx, ran 1 command')).toBeTruthy()
    expect(container.querySelectorAll('[data-tool-row]')).toHaveLength(0)
  })

  it('expands to the underlying rows when the summary is clicked', async () => {
    const { container } = render(<GroupHarness message={settledRunMessage()} />)

    fireEvent.click(await screen.findByText('Explored wiring.tsx, ran 1 command'))

    await waitFor(() => {
      expect(container.querySelectorAll('[data-tool-row]').length).toBeGreaterThan(0)
    })
  })

  it('keeps a lone call behind a readable expandable summary', async () => {
    const { container } = render(<GroupHarness message={completedOnlyMessage()} />)

    expect(container.querySelectorAll('[data-tool-row]')).toHaveLength(0)
    const toggle = container.querySelector('[data-tool-summary] button[aria-expanded]')!
    expect(toggle).not.toBeNull()
    fireEvent.click(toggle)
    await waitFor(() => expect(container.querySelectorAll('[data-tool-row]')).toHaveLength(1))
  })
})

// A diff is what the user reviews, so it is never what gets summarized away.
// It stays on screen at the point in the turn where it happened, with the
// activity either side of it collapsing around it.
describe('a file edit among ordinary activity', () => {
  it('stays visible between the two runs it interrupted', async () => {
    const { container } = render(<GroupHarness message={editBetweenRunsMessage()} />)

    await screen.findByText('Explored 2 files')

    const shape = [...container.querySelectorAll('[data-tool-summary],[data-tool-row]')].map(node =>
      node.hasAttribute('data-tool-summary') ? 'summary' : 'row'
    )

    expect(shape).toEqual(['summary', 'row', 'summary'])
  })
})

describe('live tool run', () => {
  it('honors explicit disclosure across live updates and completion', async () => {
    const message = groupedPendingMessage()
    const { container, rerender } = render(<GroupHarness message={message} />)
    const toggle = () => container.querySelector('[data-tool-summary] button[aria-expanded]') as HTMLButtonElement

    await waitFor(() => expect(toggle()).not.toBeNull())
    fireEvent.click(toggle())
    expect(toggle().getAttribute('aria-expanded')).toBe('true')
    expect(container.querySelector('[data-tool-ticker]')).toBeNull()
    fireEvent.click(toggle())
    expect(toggle().getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelectorAll('[data-tool-row]')).toHaveLength(0)
    fireEvent.click(toggle())

    const next = {
      ...message,
      content: [
        ...message.content,
        {
          type: 'tool-call',
          toolCallId: 'read-next',
          toolName: 'read_file',
          args: { path: '/tmp/next' },
          argsText: '{}'
        }
      ]
    } as ThreadMessage

    rerender(<GroupHarness message={next} />)
    await waitFor(() => expect(container.querySelectorAll('[data-tool-row]')).toHaveLength(3))
    rerender(<GroupHarness message={{ ...next, status: { type: 'complete', reason: 'stop' } }} />)
    await waitFor(() => expect(toggle().getAttribute('aria-expanded')).toBe('true'))
    fireEvent.click(toggle())
    expect(container.querySelectorAll('[data-tool-row]')).toHaveLength(0)
  })

  it('updates named skill summaries when identifying arguments arrive late', async () => {
    const message = groupedPendingMessage()
    const first = { ...message.content[0], toolName: 'skill_view', args: {}, result: { success: true } }

    const { container, rerender } = render(
      <GroupHarness message={{ ...message, content: [first, message.content[1]] } as ThreadMessage} />
    )

    const summary = () => container.querySelector('[data-tool-summary]')?.textContent
    await waitFor(() => expect(summary()).toContain('Loaded skill'))
    const named = { ...first, args: { name: 'research-notes' } }
    rerender(<GroupHarness message={{ ...message, content: [named, message.content[1]] } as ThreadMessage} />)
    await waitFor(() => expect(summary()).toContain('research-notes'))
  })

  // Liveness used to also require an unresolved call, which is false for the
  // instant between one sequential call finishing and the next arriving — so a
  // string of commands settled and re-opened between every one, unmounting the
  // ticker and dropping its reel back to the first row instead of scrolling.
  it('stays live in the gap between two sequential calls', async () => {
    const { container } = render(<GroupHarness message={betweenSequentialCallsMessage()} />)

    expect(await screen.findByText('Running 2 commands')).toBeTruthy()
    expect(container.querySelector('[data-tool-ticker]')).toBeNull()
    expect(container.querySelectorAll('[data-tool-row]')).toHaveLength(0)
    expect(container.querySelector('[data-tool-summary] button[aria-expanded]')).not.toBeNull()
  })

  // The ticker is a one-line window, so a row opened inside it had its output
  // sliced to that line and then ticked away by the next call. Opening a row
  // is a request to read it: the run gives up the window until it settles.
  it('opens the grouped calls in place without a live ticker', async () => {
    const { container } = render(<GroupHarness message={betweenSequentialCallsMessage()} />)
    fireEvent.click(await screen.findByText('Running 2 commands'))
    expect(container.querySelectorAll('[data-tool-row]')).toHaveLength(2)
    expect(container.querySelector('[data-tool-ticker]')).toBeNull()
  })
})

// A run whose calls never resolved used to read as live forever, which stranded
// it in the present tense and — because a live run withholds its toggle — left
// it permanently expanded with no way to collapse it.
describe('tool run left unresolved', () => {
  it('settles with the turn rather than narrating work that stopped', async () => {
    const { container } = render(<GroupHarness message={abandonedRunMessage()} />)

    expect(await screen.findByText('Explored 2 files')).toBeTruthy()
    expect(container.querySelectorAll('[data-tool-row]')).toHaveLength(0)
    expect(container.querySelector('[data-tool-summary] button[aria-expanded]')).not.toBeNull()
  })

  it('settles once the agent moves on, even mid-turn', async () => {
    const { container } = render(<GroupHarness message={movedOnMessage()} />)

    expect(await screen.findByText('Explored 2 files')).toBeTruthy()
    expect(container.querySelector('[data-tool-summary] button[aria-expanded]')).not.toBeNull()
  })
})

describe('flat tool list approval surfacing', () => {
  it('keeps the approval visible in the same host when tool rows arrive', async () => {
    setApprovalRequest({ command: 'rm -rf /tmp/x', description: 'dangerous command', sessionId: 'sess-1' })
    const message = groupedPendingMessage()
    assert(message.role === 'assistant')

    const { container, rerender } = render(
      <GroupHarness message={{ ...message, content: [{ type: 'text', text: 'Waiting for approval.' }] }} />
    )

    const run = await screen.findByRole('button', { name: /Run/ })
    const host = run.closest('[data-approval-stack]')
    expect(host).not.toBeNull()
    expect(host?.parentElement?.getAttribute('data-slot')).toBe('aui_thread-content')
    expect(host?.closest('[hidden], [inert], [data-tool-row], [data-tool-group]')).toBeNull()

    rerender(<GroupHarness message={message} />)

    await waitFor(() => {
      expect(container.querySelector('[data-approval-stack]')).toBe(host)
      expect(screen.getByRole('button', { name: /Run/ })).toBe(run)
      expect(run.closest('[hidden], [inert]')).toBeNull()
      expect(screen.getByRole('button', { name: /Reject/ })).toBeTruthy()
    })
  })

  it('gives the steps inside a summary group no dismiss control', async () => {
    const { container } = render(<GroupHarness message={completedOnlyMessage()} />)

    fireEvent.click(container.querySelector('[data-tool-summary] button')!)

    await waitFor(() => {
      expect(container.querySelectorAll('[data-slot="tool-block"]').length).toBeGreaterThan(1)
    })
    expect(screen.queryByLabelText('Dismiss')).toBeNull()
  })

  it('does not show dismiss for pending tool rows', async () => {
    const { container } = render(<GroupHarness message={pendingOnlyMessage()} />)

    await waitFor(() => {
      expect(container.querySelectorAll('[data-slot="tool-block"]').length).toBeGreaterThan(0)
    })

    expect(screen.queryByLabelText('Dismiss')).toBeNull()
  })
})

describe('tool lifecycle timestamps', () => {
  it('shows the precise call and completion times on a settled tool row', async () => {
    const { container } = render(<GroupHarness message={completedOnlyMessage()} />)

    fireEvent.click(container.querySelector('[data-tool-summary] button')!)
    await screen.findByText(/Read/)

    const timestamps = Array.from(container.querySelectorAll('[data-slot="timeline-timestamp"]')).map(node =>
      node.textContent?.trim()
    )

    const startedAt = createdAt.getTime() / 1000 + 10.125

    expect(timestamps).toContain(formatTimelineRange(startedAt, createdAt.getTime() / 1000 + 12.875))
  })

  it('shows the full lifecycle range when settled calls are collapsed', async () => {
    const { container } = render(<GroupHarness message={settledRunMessage()} />)

    await waitFor(() => expect(container.querySelector('[data-tool-summary]')).toBeTruthy())

    const timestamps = Array.from(container.querySelectorAll('[data-slot="timeline-timestamp"]')).map(node =>
      node.textContent?.trim()
    )

    expect(timestamps).toContain(
      formatTimelineRange(createdAt.getTime() / 1000 + 20, createdAt.getTime() / 1000 + 23.5)
    )
  })
})
