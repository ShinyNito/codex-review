import type { ActivityKind, ChangedFile, ReviewState } from '../types'

const RECENT_LIMIT = 8

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
  let added = 0
  let deleted = 0
  for (const file of files) {
    added += file.added
    deleted += file.deleted
  }
  return { added, deleted }
}

/** Records the files Git now shows as changed, logging the ones not seen before. */
export function applyChanges(state: ReviewState, files: ChangedFile[]): ReviewState {
  if (
    state.files.length === files.length && files.every((file, index) => {
      const previous = state.files[index]!
      return file.path === previous.path && file.added === previous.added && file.deleted === previous.deleted
    })
  ) return state
  const known = new Set(state.files.map((file) => file.path))
  const edits = files
    .filter((file) => !known.has(file.path))
    .map(({ path, added, deleted }) => ({ kind: 'edit' as const, text: `${path} +${added} −${deleted}` }))
  return {
    ...state,
    files,
    recent: edits.length === 0 ? state.recent : [...state.recent, ...edits].slice(-RECENT_LIMIT),
  }
}
