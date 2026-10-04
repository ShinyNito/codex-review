import type { ActivityKind, ChangedFile, ReviewState } from '../types'

const RECENT_LIMIT = 8

const FOCUS = `Focus: start with performance; remove duplicated validation, redundant state and duplicated tests; use modern idioms and do not hand-write what an imported package already provides; remove code that only forwards to something else; follow the conventions and layout of this project and of well-known open-source projects of the same kind.`

const FIX_REQUIREMENTS = `Review and fix the uncommitted changes in this workspace (visible in git status and git diff).

Goal: bring these changes to a state a human can review as-is, written in a standard, readable style that would fit a mature open-source project.
${FOCUS}

Scope: concentrate on these changes. Read surrounding code as needed to judge them, but only modify what relates to the changes.
Done when: the problems you found are fixed directly, and the project's existing checks (tests, lint, type check) pass with no regressions. You may edit related files, run those checks and fix failures without asking first.
Leave anything that needs a product or architecture decision unchanged and note it in the report.

Finish with a short list: what you changed, why, and what is left unresolved.`

const REPORT_REQUIREMENTS = `Review the uncommitted changes in this workspace (visible in git status and git diff). This is a read-only review: do not modify, create or delete any file.

Goal: tell the author what stands between these changes and a state a human can review as-is, written in a standard, readable style that would fit a mature open-source project.
${FOCUS}

Scope: concentrate on these changes. Read surrounding code as needed to judge them, and run the project's existing checks (tests, lint, type check) if they do not write to the workspace.
Done when: every problem you found is listed with its file and line, why it matters and the fix you would make, most important first.

Finish with that list, then a one-line verdict: ready to merge, or what blocks it.`

/** The review instructions: fixing by default, report-only when `readOnly`; `focus` is appended. */
export function buildPrompt(focus: string, readOnly: boolean): string {
  const base = readOnly ? REPORT_REQUIREMENTS : FIX_REQUIREMENTS
  return focus === '' ? base : `${base}\n\nAdditional focus for this review: ${focus}`
}

/** Splits the command's arguments into the report-only flag and the extra focus. */
export function parseArgs(args: string): { readOnly: boolean; focus: string } {
  const words = args.trim().split(/\s+/).filter((word) => word !== '')
  const readOnly = words.includes('--read-only')
  return { readOnly, focus: words.filter((word) => word !== '--read-only').join(' ') }
}

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
        | { type: 'file_change' }
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
    case 'file_change':
      return state
    case 'agent_message':
      return logActivity(state, 'message', item.text.trim().split('\n', 1)[0] ?? '')
  }
}

/** What Git reports per path: line counts, by path. The review's starting point is one of these. */
export type Snapshot = ReadonlyMap<string, { added: number; deleted: number }>

/**
 * Reads `git diff HEAD --numstat -z --no-renames` and `git ls-files --others -z` output.
 * Binary files count as 0/0 and an untracked file counts as new with no lines.
 */
export function parseSnapshot(numstat: string, untracked: string): Snapshot {
  const files = new Map<string, { added: number; deleted: number }>()
  for (const record of numstat.split('\0')) {
    const [added, deleted, path] = record.split('\t')
    if (path === undefined || path === '') continue
    files.set(path, { added: Number(added) || 0, deleted: Number(deleted) || 0 })
  }
  for (const path of untracked.split('\0')) {
    if (path !== '' && !files.has(path)) files.set(path, { added: 0, deleted: 0 })
  }
  return files
}

/** The files that differ from `base`: new paths, or paths whose line counts moved. */
export function changedSince(base: Snapshot, current: Snapshot): ChangedFile[] {
  const changed: ChangedFile[] = []
  for (const [path, { added, deleted }] of current) {
    const before = base.get(path)
    if (before?.added === added && before.deleted === deleted) continue
    changed.push({ path, added, deleted })
  }
  return changed.sort((a, b) => a.path.localeCompare(b.path))
}

export function lineTotals(files: readonly ChangedFile[]) {
  return files.reduce(
    (total, file) => ({ added: total.added + file.added, deleted: total.deleted + file.deleted }),
    { added: 0, deleted: 0 },
  )
}

/** Records the files Git now shows as changed, logging the ones not seen before. */
export function applyChanges(state: ReviewState, files: ChangedFile[]): ReviewState {
  const known = new Set(state.files.map((file) => file.path))
  return files
    .filter((file) => !known.has(file.path))
    .reduce(
      (next, { path, added, deleted }) => logActivity(next, 'edit', `${path} +${added} −${deleted}`),
      { ...state, files },
    )
}
