// This install is a personal fork: the stock updater would pull upstream over the fork's own
// changes. Instead, when a new official release is out and not merged yet, offer to hand the merge
// to an agent (Opus 5.5, medium effort) in a fresh chat. Backend: tui_gateway/methods_fork_upstream.py.
import { requestComposerSubmit } from '@/app/chat/composer/focus'
import { translateNow } from '@/i18n'
import { persistString, storedString } from '@/lib/storage'
import { activeGateway } from '@/store/gateway'
import { notify } from '@/store/notifications'
import { requestFreshSession } from '@/store/profile'

interface ForkUpstreamStatus {
  current?: null | string
  latest?: null | string
  merged?: boolean | null
  supported: boolean
}

const DISMISSED_KEY = 'hermes.desktop.fork-upstream-dismissed.v1'
const TOAST_ID = 'fork-upstream-release'
const CHECK_EVERY_MS = 30 * 60 * 1000
const FIRST_CHECK_MS = 20 * 1000

// The model switch and effort run as slash commands in the new chat, exactly as if typed.
const MERGE_STEPS = ['/model claude-opus-5-5 --provider anthropic --session', '/reasoning medium'] as const

export function forkMergePrompt(tag: string, current: null | string | undefined): string {
  return [
    `Merge the official Hermes release ${tag} into this fork (branch benny in ~/.hermes/hermes-agent; remote upstream is NousResearch, fetch-only).`,
    current ? `The fork currently contains ${current}.` : '',
    'Keep every fork change unless upstream now does the same thing better; resolve conflicts by intent, not by side.',
    current
      ? `Tell ours from theirs with git, never by guessing from style: the fork's own changes are exactly git diff ${current} benny (and git log ${current}..benny); upstream's changes are git diff ${current} ${tag}. For a conflicting hunk, git log -L or git blame shows which side last touched each line: a fork commit means our change (keep it, re-applied onto upstream's new code); an upstream commit means a tiny design change from them (take theirs).`
      : 'Tell ours from theirs with git, never by guessing from style: the fork\'s own changes are git diff $(git merge-base benny upstream/main) benny.',
    'Read the fork rule in AGENTS.md first. Merge the tag (git merge ' + tag + '), fix conflicts, then run the type check and the',
    'tests for the areas that conflicted. Rebuild the desktop app (hermes desktop --build-only). Do not push.',
    'Finish with a short list: what upstream added, what conflicted and how you resolved it, and anything you dropped.'
  ]
    .filter(Boolean)
    .join(' ')
}

/** Submit `texts` one after another into the new chat's composer, waiting for it to mount. */
function submitInOrder(texts: readonly string[], attempt = 0): void {
  if (!texts.length) {
    return
  }

  if (requestComposerSubmit(texts[0], { target: 'active' })) {
    // Each slash command settles before the next line goes in.
    window.setTimeout(() => submitInOrder(texts.slice(1)), 1500)
  } else if (attempt < 40) {
    window.setTimeout(() => submitInOrder(texts, attempt + 1), 250)
  }
}

export function startForkMerge(tag: string, current?: null | string): void {
  requestFreshSession()
  window.setTimeout(() => submitInOrder([...MERGE_STEPS, forkMergePrompt(tag, current)]), 400)
}

export async function checkForkUpstream(force = false): Promise<ForkUpstreamStatus | null> {
  const gateway = activeGateway()

  if (!gateway) {
    return null
  }

  let status: ForkUpstreamStatus

  try {
    status = await gateway.request<ForkUpstreamStatus>('fork.upstream_status', { force })
  } catch {
    return null // An older backend without the method, or a transport blip: try again next round.
  }

  const tag = status.latest

  if (!status.supported || status.merged !== false || !tag || storedString(DISMISSED_KEY) === tag) {
    return status
  }

  notify({
    action: {
      label: translateNow('notifications.forkUpdateMerge'),
      onClick: () => {
        persistString(DISMISSED_KEY, tag)
        startForkMerge(tag, status.current)
      }
    },
    durationMs: 0,
    icon: 'gift',
    id: TOAST_ID,
    kind: 'info',
    message: translateNow('notifications.forkUpdateMessage'),
    onDismiss: () => persistString(DISMISSED_KEY, tag),
    title: translateNow('notifications.forkUpdateTitle', tag)
  })

  return status
}

if (typeof window !== 'undefined' && !import.meta.env?.VITEST) {
  window.setTimeout(() => void checkForkUpstream(true), FIRST_CHECK_MS)
  window.setInterval(() => void checkForkUpstream(), CHECK_EVERY_MS)
}
