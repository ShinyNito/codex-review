import { expect, test } from 'claude-code/testing'

import {
  applyChanges,
  buildPrompt,
  changedSince,
  IDLE,
  lineTotals,
  parseArgs,
  parseSnapshot,
} from '../lib/review'

test('reads numstat and untracked output, binary files counting as 0/0', () => {
  const snapshot = parseSnapshot('3\t1\tsrc/a.ts\0-\t-\tlogo.png\0', 'notes.md\0')

  expect([...snapshot]).toEqual([
    ['src/a.ts', { added: 3, deleted: 1 }],
    ['logo.png', { added: 0, deleted: 0 }],
    ['notes.md', { added: 0, deleted: 0 }],
  ])
})

test('only files that moved since the start count as changed', () => {
  const base = parseSnapshot('3\t1\tsrc/a.ts\0', '')
  const current = parseSnapshot('3\t1\tsrc/a.ts\0', 'new.ts\0')
  expect(changedSince(base, current).map((file) => file.path)).toEqual(['new.ts'])

  const edited = parseSnapshot('5\t1\tsrc/a.ts\0', 'new.ts\0')
  expect(changedSince(base, edited).map((file) => file.path)).toEqual(['new.ts', 'src/a.ts'])
})

test('a file that Codex edited and then restored is not reported', () => {
  const base = parseSnapshot('3\t1\tsrc/a.ts\0', '')
  expect(changedSince(base, parseSnapshot('3\t1\tsrc/a.ts\0', ''))).toEqual([])
})

test('logs a file once, when it first shows up', () => {
  const first = applyChanges(IDLE, [{ path: 'a.ts', added: 2, deleted: 0 }])
  const second = applyChanges(first, [{ path: 'a.ts', added: 4, deleted: 1 }])

  expect(first.recent).toEqual([{ kind: 'edit', text: 'a.ts +2 −0' }])
  expect(second.recent).toHaveLength(1)
  expect(lineTotals(second.files)).toEqual({ added: 4, deleted: 1 })
})

test('--read-only is a flag, everything else is the extra focus', () => {
  expect(parseArgs('')).toEqual({ readOnly: false, focus: '' })
  expect(parseArgs('  --read-only  race  conditions ')).toEqual({
    readOnly: true,
    focus: 'race conditions',
  })
  expect(parseArgs('race --read-only')).toEqual({ readOnly: true, focus: 'race' })
})

test('the report-only prompt forbids edits and the fixing prompt does not', () => {
  expect(buildPrompt('', true)).toMatch('do not modify')
  expect(buildPrompt('', false)).not.toMatch('do not modify')
  expect(buildPrompt('', false)).not.toMatch('shadcn')
  expect(buildPrompt('speed', true)).toMatch('Additional focus for this review: speed')
})

test('--model and --effort take a value, spaced or with =', () => {
  expect(parseArgs('--model gpt-5.5 --effort=high race')).toEqual({
    readOnly: false,
    model: 'gpt-5.5',
    effort: 'high',
    focus: 'race',
  })
  expect(parseArgs('--model').error).toMatch('--model needs a value')
  expect(parseArgs('--effort "x y"').error).toMatch('--effort needs a value')
})
