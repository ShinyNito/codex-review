import type { ActivityKind, ReviewState } from '../types'

const RECENT_LIMIT = 8

export const REVIEW_REQUIREMENTS = `Review and fix the uncommitted changes in this workspace (visible in git status and git diff).

Goal: bring these changes to a state a human can review as-is, written in a standard, readable style that would fit a mature open-source project.
Focus: start with performance; remove duplicated validation, redundant state and duplicated tests; use modern idioms and do not hand-write what an imported package already provides; remove code that only forwards to something else; follow the layout of well-known open-source projects (for example shadcn).

Scope: concentrate on these changes. Read surrounding code as needed to judge them, but only modify what relates to the changes.
Done when: the problems you found are fixed directly, and the project's existing checks (tests, lint, type check) pass with no regressions. You may edit related files, run those checks and fix failures without asking first.
Leave anything that needs a product or architecture decision unchanged and note it in the report.

Finish with a short list: what you changed, why, and what is left unresolved.`

export const IDLE: ReviewState = {
  phase: 'idle',
  focus: '',
  startedAt: 0,
  now: 0,
  commands: 0,
  files: [],
  recent: [],
}

/** Only events that affect progress or the final report cross this boundary. */
export type CodexEvent =
  | { type: 'item.started'; item: { type: 'command_execution'; command: string } }
  | {
      type: 'item.completed'
      item:
        | { type: 'command_execution' }
        | { type: 'file_change'; changes: { path: string }[] }
        | { type: 'agent_message'; text: string }
    }
  | { type: 'turn.failed'; error: { message: string } }

export function parseEvent(line: string): CodexEvent | undefined {
  if (line.trim() === '') return
  const event = JSON.parse(line)
  if (event === null || typeof event !== 'object') throw new Error('Invalid Codex event')
  if (event.type === 'turn.failed') {
    return {
      type: 'turn.failed',
      error: { message: String(event.error?.message ?? 'Codex turn failed') },
    }
  }
  if (event.type !== 'item.started' && event.type !== 'item.completed') return
  const item = event.item
  if (item === null || typeof item !== 'object') throw new Error('Invalid Codex item')
  if (event.type === 'item.started') {
    if (item.type !== 'command_execution') return
    if (typeof item.command !== 'string') throw new Error('Invalid Codex command')
  } else {
    switch (item.type) {
      case 'command_execution':
        break
      case 'file_change':
        if (
          !Array.isArray(item.changes) ||
          !item.changes.every(
            (change: unknown) =>
              change !== null &&
              typeof change === 'object' &&
              'path' in change &&
              typeof change.path === 'string',
          )
        )
          throw new Error('Invalid Codex file changes')
        break
      case 'agent_message':
        if (typeof item.text !== 'string') throw new Error('Invalid Codex message')
        break
      default:
        return
    }
  }
  return event
}

function logActivity(state: ReviewState, kind: ActivityKind, text: string): ReviewState {
  return { ...state, recent: [...state.recent, { kind, text }].slice(-RECENT_LIMIT) }
}

export function applyEvent(state: ReviewState, event: CodexEvent): ReviewState {
  if (event.type === 'turn.failed') return state
  const { item } = event
  if (event.type === 'item.started') {
    return logActivity(
      state,
      'command',
      event.item.command.replace(/^\/bin\/\w+ -lc /, '').replace(/^'(.*)'$/s, '$1'),
    )
  }
  switch (item.type) {
    case 'command_execution':
      return { ...state, commands: state.commands + 1 }
    case 'file_change': {
      const paths = item.changes.map((change) => change.path)
      return logActivity(
        { ...state, files: [...new Set([...state.files, ...paths])] },
        'edit',
        paths.join(', '),
      )
    }
    case 'agent_message':
      return logActivity(state, 'message', item.text.trim().split('\n', 1)[0] ?? '')
  }
}
