import { expect, test } from 'claude-code/testing'

import { buildPrompt, parseArgs, promptRequest } from '../lib/prompt'

test('boolean flags are removed from the extra focus', () => {
  expect(parseArgs('--quick --read-only race')).toEqual({ readOnly: true, quick: true, focus: 'race' })
  expect(parseArgs('')).toEqual({ readOnly: false, quick: false, focus: '' })
  expect(parseArgs('  --read-only  race  conditions ')).toEqual({
    readOnly: true,
    quick: false,
    focus: 'race conditions',
  })
  expect(parseArgs('race --read-only')).toEqual({ readOnly: true, quick: false, focus: 'race' })
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
    quick: false,
    model: 'gpt-5.5',
    effort: 'high',
    focus: 'race',
  })
  expect(parseArgs('--model').error).toMatch('--model needs a value')
  expect(parseArgs('--effort "x y"').error).toMatch('--effort needs a value')
})

test('the prompt request includes the review requirements word for word', () => {
  const requirements = buildPrompt('races', false)
  expect(promptRequest(requirements)).toMatch(requirements)
})
