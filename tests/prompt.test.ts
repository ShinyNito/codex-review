import { expect, test } from 'claude-code/testing'

import { buildPrompt, cleanPrompt, parseArgs, promptRequest } from '../lib/prompt'

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

const FIX_PROMPT = buildPrompt('', false)
const REPORT_PROMPT = buildPrompt('', true)

test('the request for a prompt carries the marker and the requirements word for word', () => {
  const requirements = buildPrompt('races', false)
  const request = promptRequest(requirements, '[mark]')

  expect(request).toMatch('[mark]')
  expect(request).toMatch(requirements)
})

test('a prompt Claude wrote is used as it stands, line breaks included', () => {
  expect(cleanPrompt(`\n${FIX_PROMPT}\n`, false)).toEqual({ prompt: FIX_PROMPT })
  expect(cleanPrompt(`\`\`\`text\n${FIX_PROMPT}\n\`\`\``, false)).toEqual({ prompt: FIX_PROMPT })
  expect(cleanPrompt(REPORT_PROMPT, true)).toEqual({ prompt: REPORT_PROMPT })
})

test('a prompt that lost a requirement is refused with the reason', () => {
  expect(cleanPrompt('  \n', false)).toEqual({ problem: 'Claude wrote no prompt' })
  expect(cleanPrompt('Look at the diff.', false)).toEqual({
    problem: 'the prompt Claude wrote lacks Goal:, Scope:, Done when:',
  })
  expect(cleanPrompt(FIX_PROMPT.replace('Done when:', 'Finished:'), false)).toEqual({
    problem: 'the prompt Claude wrote lacks Done when:',
  })
  expect(cleanPrompt(FIX_PROMPT, true)).toEqual({
    problem: 'the prompt Claude wrote does not forbid modifying files',
  })
  expect(cleanPrompt(FIX_PROMPT + 'x'.repeat(12000), false)).toEqual({
    problem: 'the prompt Claude wrote is too long or malformed',
  })
})
