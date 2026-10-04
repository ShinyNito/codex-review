import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { buildPrompt } from '../lib/prompt'

const COMMAND = {
  command: 'codex-review',
  args: '--quick',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 80 },
} as const
const PANE_PROPS = {
  title: 'Codex review',
  isFocused: true,
  bodyColumns: 40,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 20 },
  view: {},
} as const
const BAND_PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 8,
  bodyColumns: 80,
  scroll: { offset: 0, bodyRows: 20 },
  view: {},
} as const

const events = [
  { type: 'thread.started', thread_id: 't' },
  { type: 'item.started', item: { type: 'command_execution', command: "/bin/zsh -lc 'git diff'" } },
  {
    type: 'item.completed',
    item: { type: 'command_execution', command: 'git diff', exit_code: 0 },
  },
  { type: 'item.completed', item: { type: 'file_change', changes: [{ path: 'a.ts' }] } },
  { type: 'item.completed', item: { type: 'agent_message', text: 'codex report' } },
  { type: 'turn.completed', usage: {} },
]

const CODEX_CONFIG =
  'model = "gpt-test"\nmodel_reasoning_effort = "high"\n\n[profiles.fast]\nmodel = "other"\n'

/** Answers the Codex config the command reads for the model it shows. */
function stubCodexConfig(on: On) {
  mock.env(on, { HOME: '/home/test' })
  on('fs.read', async () => ({ value: CODEX_CONFIG }))
}

/** Answers the git commands: the repo check, then the diff and untracked lists the mod reads. */
function stubGit(on: On, isRepo: boolean, hasCwd = true, diff: () => string | Promise<string> = () => '') {
  if (hasCwd) on('session.cwd', async () => ({ value: '/work' }))
  on('process.run', async (_$, e) => {
    const stdout = !isRepo
      ? ''
      : e.argv[1] === 'rev-parse'
        ? 'true\n'
        : e.argv[1] === 'diff'
          ? await diff()
          : ''
    return {
      value: {
        exitCode: isRepo ? 0 : 128,
        stdout,
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
}

/** Stubs the ui nouns the command touches; the promise settles when the status line clears. */
function stubUi(on: On, opened: string[] = []): Promise<{
  toasts: string[]
  statuses: (string | undefined)[]
}> {
  const toasts: string[] = []
  const statuses: (string | undefined)[] = []
  on('ui.open', async (_$, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', async () => ({ value: undefined }))
  on('ui.toast', async (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  return new Promise((resolve) => {
    on('ui.status', async (_$, e) => {
      statuses.push(e.text)
      if (e.text === undefined) resolve({ toasts, statuses })
      return { value: undefined }
    })
  })
}

test('--model and --effort apply to one run and show in the band', async ($, on) => {
  mock.clock(on)
  stubGit(on, true)
  stubCodexConfig(on)
  const finished = stubUi(on, [])
  const argvs: (readonly string[])[] = []
  on('process.spawn', async function* (_$, e) {
    argvs.push(e.argv)
    yield { stream: 'stdout', text: events.map((event) => JSON.stringify(event)).join('\n') }
    return { value: { code: 0, signal: null } }
  })
  const submitted = new Promise<string>((resolve) => {
    on('prompt.submit', async (_$, e) => {
      resolve(e.text)
      return { text: e.text }
    })
  })

  await $.command.run({ ...COMMAND, args: '--quick --model gpt-5.5 --effort high speed' })
  await submitted
  await finished

  const argv = argvs[0] ?? []
  expect(argv[argv.indexOf('-m') + 1]).toBe('gpt-5.5')
  expect(argv[argv.indexOf('-c') + 1]).toBe('model_reasoning_effort="high"')
  expect(argv.at(-1)).toMatch('speed')
  expect(argv.at(-1)).not.toMatch('--model')
})

test('a flag without a value starts nothing', async ($, on) => {
  stubGit(on, true)
  const spawned: string[] = []
  on('process.spawn', async function* (_$, e) {
    spawned.push(...e.argv)
    return { value: { code: 0, signal: null } }
  })

  const result = await $.command.run({ ...COMMAND, args: '--model' })

  expect(result.text).toMatch('--model needs a value')
  expect(spawned).toEqual([])
})

test('--read-only runs Codex in the read-only sandbox', async ($, on) => {
  mock.clock(on)
  stubGit(on, true)
  stubCodexConfig(on)
  const finished = stubUi(on, [])
  const argvs: (readonly string[])[] = []
  on('process.spawn', async function* (_$, e) {
    argvs.push(e.argv)
    yield { stream: 'stdout', text: events.map((event) => JSON.stringify(event)).join('\n') }
    return { value: { code: 0, signal: null } }
  })
  const submitted = new Promise<string>((resolve) => {
    on('prompt.submit', async (_$, e) => {
      resolve(e.text)
      return { text: e.text }
    })
  })

  await $.command.run({ ...COMMAND, args: '--quick --read-only speed' })
  const text = await submitted
  await finished

  const argv = argvs[0] ?? []
  expect(argv[argv.indexOf('-s') + 1]).toBe('read-only')
  expect(argv.at(-1)).toMatch('do not modify')
  expect(argv.at(-1)).toMatch('speed')
  expect(text).toMatch('read-only review')
})

test('streams codex exec and hands the final report back', async ($, on) => {
  mock.clock(on)
  stubGit(on, true)
  stubCodexConfig(on)
  const opened: string[] = []
  const finished = stubUi(on, opened)
  const argvs: (readonly string[])[] = []
  on('process.spawn', async function* (_$, e) {
    argvs.push(e.argv)
    // One JSONL line split across two chunks, as a pipe may deliver it.
    const text = events.map((event) => JSON.stringify(event)).join('\n')
    yield { stream: 'stdout', text: text.slice(0, 40) }
    yield { stream: 'stdout', text: text.slice(40) }
    return { value: { code: 0, signal: null } }
  })
  const submitted = new Promise<string>((resolve) => {
    on('prompt.submit', async (_$, e) => {
      resolve(e.text)
      return { text: e.text }
    })
  })

  await $.command.run({ ...COMMAND, args: '--quick performance' })
  const text = await submitted
  const { toasts } = await finished

  expect(opened).toEqual([])
  expect(argvs[0]?.slice(0, 3)).toEqual(['codex', 'exec', '--json'])
  expect(argvs[0]).not.toContain('-m')
  expect(argvs[0]?.at(-1)).toMatch('performance')
  expect(text).toMatch('codex report')
  expect(toasts).toEqual(['Codex review finished'])
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'codex-reviewer',
      surface,
      component: 'Pane',
      requestId: 'codex-reviewer',
      props: PANE_PROPS,
    })
    expect(await ui.find({ type: 'Text', text: /Finished/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /git diff/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'gpt-test' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '1 commands 0 files edited' })).toBeDefined()
    await ui.unmount()
  }
})

test('reports a failing codex exec instead of handing back a report', async ($, on) => {
  mock.clock(on)
  stubGit(on, true)
  stubCodexConfig(on)
  const finished = stubUi(on)
  on('process.spawn', async function* () {
    yield { stream: 'stderr', text: 'not logged in' }
    return { value: { code: 1, signal: null } }
  })

  await $.command.run(COMMAND)
  const { toasts } = await finished

  expect(toasts).toEqual(['Codex review failed: not logged in'])
})

test('refuses to run outside a Git repository', async ($, on) => {
  mock.clock(on)
  stubGit(on, false)
  const spawned: (readonly string[])[] = []
  on('process.spawn', async function* (_$, e) {
    spawned.push(e.argv)
    return { value: { code: 0, signal: null } }
  })

  const result = await $.command.run(COMMAND)

  expect(result.text).toMatch('Not a Git working tree')
  expect(spawned).toEqual([])
})

test(
  'passes the model option to codex exec',
  { options: { model: 'gpt-override' } },
  async ($, on) => {
    mock.clock(on)
    stubGit(on, true)
    stubCodexConfig(on)
    const finished = stubUi(on)
    const argvs: (readonly string[])[] = []
    on('process.spawn', async function* (_$, e) {
      argvs.push(e.argv)
      yield {
        stream: 'stdout',
        text: JSON.stringify({
          type: 'item.completed',
          item: { type: 'agent_message', text: 'codex report' },
        }),
      }
      return { value: { code: 0, signal: null } }
    })
    on('prompt.submit', async (_$, e) => ({ text: e.text }))

    await $.command.run(COMMAND)
    await finished

    const argv = argvs[0] ?? []
    expect(argv[argv.indexOf('-m') + 1]).toBe('gpt-override')
  },
)

test('the band above the prompt reopens the pane and can be dismissed', async ($, on) => {
  mock.clock(on)
  stubGit(on, true)
  stubCodexConfig(on)
  const opened: string[] = []
  const finished = stubUi(on, opened)
  on('process.spawn', async function* () {
    yield {
      stream: 'stdout',
      text: JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: 'codex report' },
      }),
    }
    return { value: { code: 0, signal: null } }
  })
  on('prompt.submit', async (_$, e) => ({ text: e.text }))
  on('ui.render', async ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine band</Text>
  })

  await $.command.run(COMMAND)
  await finished
  opened.length = 0

  const ui = await $.ui.mount({
    plugin: 'codex-reviewer',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: BAND_PROPS,
  })
  expect(await ui.find({ type: 'Text', text: /Finished/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'engine band' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'gpt-test · high' })).toBeDefined()
  await ui.press({ key: 'open' })
  expect(opened).toEqual(['codex-reviewer'])

  await ui.press({ key: 'dismiss' })
  expect(await ui.find({ type: 'Text', text: 'engine band' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Finished/ })).toBeUndefined()
  await ui.unmount()
})

test('the band shows the latest activity and a second command reopens the running pane', async ($, on) => {
  const clock = mock.clock(on)
  stubGit(on, true)
  stubCodexConfig(on)
  const finished = stubUi(on)
  let release = () => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  on('process.spawn', async function* () {
    const started = {
      type: 'item.started',
      item: { type: 'command_execution', command: 'git diff --stat' },
    }
    yield { stream: 'stdout', text: `${JSON.stringify(started)}\n` }
    await held
    yield {
      stream: 'stdout',
      text: JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: 'codex report' },
      }),
    }
    return { value: { code: 0, signal: null } }
  })
  on('prompt.submit', async (_$, e) => ({ text: e.text }))
  on('ui.render', async ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine band</Text>
  })

  await $.command.run(COMMAND)
  await clock.settle()
  const ui = await $.ui.mount({
    plugin: 'codex-reviewer',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: BAND_PROPS,
  })
  expect(await ui.find({ type: 'Text', text: 'git diff --stat' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'cancel' })).toBeDefined()

  const reopened = await $.command.run(COMMAND)
  expect(reopened.text).toMatch('already running')
  release()
  await finished
  await ui.unmount()
})

for (const { name, output, message } of [
  {
    name: 'failed turn without a trailing newline',
    output: JSON.stringify({ type: 'turn.failed', error: { message: 'rate limit' } }),
    message: 'rate limit',
  },
  { name: 'invalid JSON value', output: 'null\n', message: 'Invalid Codex event' },
  { name: 'missing final report', output: '', message: 'without a final report' },
]) {
  test(`reports ${name} as a failure`, async ($, on) => {
    mock.clock(on)
    stubGit(on, true)
    stubCodexConfig(on)
    const finished = stubUi(on)
    let submissions = 0
    let closed = false
    on('process.spawn', async function* () {
      try {
        if (output !== '') yield { stream: 'stdout', text: output }
        return { value: { code: 0, signal: null } }
      } finally {
        closed = true
      }
    })
    on('prompt.submit', async (_$, e) => {
      submissions++
      return { text: e.text }
    })

    await $.command.run(COMMAND)
    const { toasts } = await finished
    expect(toasts[0]).toMatch(message)
    expect(submissions).toBe(0)
    expect(closed).toBe(true)
  })
}

test('cancels a silent child, stops its timer, and permits another review', async ($, on) => {
  const clock = mock.clock(on)
  stubGit(on, true)
  stubCodexConfig(on)
  const finished = stubUi(on)
  let closed = false
  let spawns = 0
  let submissions = 0
  on('process.spawn', async function* (_$, _e, next) {
    spawns++
    if (spawns === 1) {
      try {
        await new Promise<void>((resolve) => {
          next.signal.addEventListener('abort', () => resolve(), { once: true })
        })
      } finally {
        closed = true
      }
    } else {
      yield {
        stream: 'stdout',
        text: JSON.stringify({
          type: 'item.completed',
          item: { type: 'agent_message', text: 'second report' },
        }),
      }
    }
    return { value: { code: 0, signal: null } }
  })
  on('prompt.submit', async (_$, e) => {
    submissions++
    return { text: e.text }
  })

  await $.command.run(COMMAND)
  await clock.settle()
  const ui = await $.ui.mount({
    plugin: 'codex-reviewer',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'codex-reviewer',
    props: PANE_PROPS,
  })
  await clock.advance(1000)
  await ui.press({ key: 'cancel' })
  const { toasts } = await finished
  expect(closed).toBe(true)
  expect(toasts).toEqual([])
  expect(submissions).toBe(0)
  expect(await ui.find({ type: 'Text', text: /Cancelled/ })).toBeDefined()
  await clock.advance(3000)
  expect(await ui.find({ type: 'Text', text: '1s' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'cancel' })).toBeUndefined()
  await ui.unmount()

  await $.command.run(COMMAND)
  await clock.settle()
  expect(spawns).toBe(2)
  expect(submissions).toBe(1)
})

test('reserves the run during startup and releases it after startup fails', async ($, on) => {
  const clock = mock.clock(on)
  stubGit(on, true, false)
  stubCodexConfig(on)
  stubUi(on)
  let release = () => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  let attempts = 0
  let spawns = 0
  on('session.cwd', async () => {
    if (++attempts === 1) {
      await held
      throw new Error('cwd unavailable')
    }
    return { value: '/work' }
  })
  on('process.spawn', async function* () {
    spawns++
    yield {
      stream: 'stdout',
      text: JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: 'recovered' },
      }),
    }
    return { value: { code: 0, signal: null } }
  })
  on('prompt.submit', async (_$, e) => ({ text: e.text }))

  const first = $.command.run(COMMAND)
  await clock.settle()
  expect((await $.command.run(COMMAND)).text).toMatch('already running')
  expect(attempts).toBe(1)
  release()
  expect((await first).text).toMatch('could not start')
  expect((await $.command.run(COMMAND)).text).toMatch('review started')
  await clock.settle()
  expect(spawns).toBe(1)
})

test('keeps the completed report readable when delivery fails', async ($, on) => {
  mock.clock(on)
  stubGit(on, true)
  stubCodexConfig(on)
  const finished = stubUi(on)
  on('process.spawn', async function* () {
    yield {
      stream: 'stdout',
      text: JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: 'saved report' },
      }),
    }
    return { value: { code: 0, signal: null } }
  })
  on('prompt.submit', async () => ({ drop: 'prompt unavailable' }))

  await $.command.run(COMMAND)
  await finished
  const ui = await $.ui.mount({
    plugin: 'codex-reviewer',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'codex-reviewer',
    props: PANE_PROPS,
  })
  expect(await ui.find({ type: 'Text', text: /Finished/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /report could not be delivered/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /saved report/ })).toBeDefined()
  await ui.unmount()
})

test('files edited come from Git, not from what Codex reports', async ($, on) => {
  mock.clock(on)
  let isEdited = false
  let snapshots = 0
  stubGit(on, true, true, () => {
    snapshots++
    return isEdited ? '3\t1\tsrc/a.ts\0' : ''
  })
  stubCodexConfig(on)
  const finished = stubUi(on)
  on('process.spawn', async function* () {
    // Codex reports nothing about files; Git is the only witness.
    isEdited = true
    const done = { type: 'item.completed', item: { type: 'command_execution' } }
    const message = { type: 'item.completed', item: { type: 'agent_message', text: 'report' } }
    for (let i = 0; i < 20; i++) {
      yield { stream: 'stdout', text: `${JSON.stringify(done)}\n` }
    }
    yield { stream: 'stdout', text: `${JSON.stringify(message)}\n` }
    return { value: { code: 0, signal: null } }
  })
  on('prompt.submit', async (_$, e) => ({ text: e.text }))
  on('ui.render', async ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine band</Text>
  })

  await $.command.run(COMMAND)
  await finished
  expect(snapshots).toBe(2)

  const ui = await $.ui.mount({
    plugin: 'codex-reviewer',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: BAND_PROPS,
  })
  expect(await ui.find({ type: 'Text', text: /1 files \+3 −1/ })).toBeDefined()
  await ui.unmount()

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const pane = await $.ui.mount({
      plugin: 'codex-reviewer',
      surface,
      component: 'Pane',
      requestId: 'codex-reviewer',
      props: PANE_PROPS,
    })
    expect(await pane.find({ type: 'Text', text: /1 files edited \+3 −1/ })).toBeDefined()
    await pane.unmount()
  }
})

test('cancelling during the initial Git snapshot releases the run without spawning Codex', async ($, on) => {
  const clock = mock.clock(on)
  stubCodexConfig(on)
  const finished = stubUi(on)
  const argvs = stubCodex(on)
  let release = () => {}
  const held = new Promise<void>((resolve) => { release = resolve })
  let isFirst = true
  stubGit(on, true, true, async () => {
    if (isFirst) {
      isFirst = false
      await held
    }
    return ''
  })
  on('prompt.submit', async (_$, e) => ({ text: e.text }))

  await $.command.run(COMMAND)
  const ui = await $.ui.mount({
    plugin: 'codex-reviewer', surface: 'terminal', component: 'Pane',
    requestId: 'codex-reviewer', props: PANE_PROPS,
  })
  await ui.press({ key: 'cancel' })
  await finished
  expect(argvs).toEqual([])
  expect(await ui.find({ type: 'Text', text: /Cancelled/ })).toBeDefined()

  await $.command.run(COMMAND)
  await clock.settle()
  expect(argvs).toHaveLength(1)
  release()
  await clock.settle()
  expect(argvs).toHaveLength(1)
  expect(await ui.find({ type: 'Text', text: /Finished/ })).toBeDefined()
  await ui.unmount()
})

test('slow Git snapshots keep one queued refresh and still update the running pane', async ($, on) => {
  const clock = mock.clock(on)
  let added = 0
  let snapshots = 0
  stubGit(on, true, true, async () => {
    const snapshot = added === 0 ? '' : `${added}\t1\tsrc/a.ts\0`
    if (++snapshots === 2) await clock.sleep(1000)
    return snapshot
  })
  stubCodexConfig(on)
  const finished = stubUi(on)
  on('process.spawn', async function* () {
    for (added = 1; added <= 8; added++) {
      yield {
        stream: 'stdout',
        text: `${JSON.stringify({ type: 'item.completed', item: { type: 'command_execution' } })}\n`,
      }
      await clock.sleep(100)
    }
    added = 8
    await clock.sleep(1000)
    yield {
      stream: 'stdout',
      text: JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'report' } }),
    }
    return { value: { code: 0, signal: null } }
  })
  on('prompt.submit', async (_$, e) => ({ text: e.text }))

  await $.command.run(COMMAND)
  await clock.advance(1000)
  expect(snapshots).toBe(2)
  await clock.advance(100)
  expect(snapshots).toBe(3)
  const pane = await $.ui.mount({
    plugin: 'codex-reviewer', surface: 'terminal', component: 'Pane',
    requestId: 'codex-reviewer', props: PANE_PROPS,
  })
  expect(await pane.find({ type: 'Text', text: /1 files edited \+8 −1/ })).toBeDefined()
  expect(await pane.find({ type: 'Button', key: 'cancel' })).toBeDefined()
  await clock.advance(700)
  await finished
  expect(snapshots).toBe(4)
  await pane.unmount()
})

const TURN = { durationMs: 1, isAborted: false, reason: 'answer' } as const

/** Records submissions without starting a model turn; tests drive the turn events explicitly. */
function stubPrompt(on: On) {
  const submitted: string[] = []
  on('prompt.submit', async (_$, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  on('turn.complete', async (_$, e) => ({ text: e.answer }))
  return submitted
}

function stubCodex(on: On) {
  const argvs: (readonly string[])[] = []
  on('process.spawn', async function* (_$, e) {
    argvs.push(e.argv)
    yield { stream: 'stdout', text: events.map((event) => JSON.stringify(event)).join('\n') }
    return { value: { code: 0, signal: null } }
  })
  return argvs
}

async function expectPlanningStopped(
  finished: ReturnType<typeof stubUi>,
  argvs: ReturnType<typeof stubCodex>,
  reason: string,
) {
  const { toasts, statuses } = await finished
  expect(argvs).toEqual([])
  expect(statuses).toEqual(['Claude is writing the review prompt', undefined])
  expect(toasts).toHaveLength(1)
  expect(toasts[0]).toMatch(reason)
}

test('passes the next main answer unchanged without reply matching, format checks or a timeout', async ($, on) => {
  const clock = mock.clock(on)
  stubGit(on, true)
  stubCodexConfig(on)
  const finished = stubUi(on)
  const argvs = stubCodex(on)
  const submitted: string[] = []
  on('prompt.submit', async (_$, e) => {
    submitted.push(e.text)
    return { text: `${e.text}\nRewritten by another hook.` }
  })
  on('turn.complete', async (_$, e) => ({ text: e.answer }))
  const written = ` \n\`\`\`text\nLook at the diff. ${'x'.repeat(12000)}\n\`\`\`\n `

  await $.command.run({ ...COMMAND, args: '--read-only speed' })
  await clock.advance(1)
  expect(submitted[0]).toMatch(buildPrompt('speed', true))
  await clock.advance(6 * 60 * 1000)
  expect((await $.command.run(COMMAND)).text).toMatch('already writing')
  expect(argvs).toEqual([])

  await $.turn.complete({ ...TURN, turnId: 'sub-turn', agentId: 'sub', answer: written })
  expect(argvs).toEqual([])
  await $.turn.complete({ ...TURN, turnId: 'any-main-turn', answer: written })
  await clock.settle()
  const { toasts } = await finished
  expect(argvs).toHaveLength(1)
  expect(argvs[0]?.at(-1)).toBe(written)
  expect(argvs[0]?.[argvs[0].indexOf('-s') + 1]).toBe('read-only')
  expect(toasts).toEqual(['Codex review finished'])
})

for (const { reason, isAborted, message } of [
  { reason: 'aborted', isAborted: true, message: 'was interrupted' },
  { reason: 'error', isAborted: false, message: 'ended with error' },
] as const) {
  test(`cleans up a prompt turn ending with ${reason}`, async ($, on) => {
    const clock = mock.clock(on)
    const finished = stubUi(on)
    const argvs = stubCodex(on)
    const submitted = stubPrompt(on)
    await $.command.run({ ...COMMAND, args: '' })
    await clock.advance(1)
    await $.turn.complete({ ...TURN, turnId: 'ask', reason, isAborted, answer: '' })
    await expectPlanningStopped(finished, argvs, message)

    expect((await $.command.run({ ...COMMAND, args: '' })).text).toMatch('Asked Claude')
    await clock.advance(1)
    expect(submitted).toHaveLength(2)
  })
}

for (const failure of ['dropped', 'unimplemented'] as const) {
  test(`cleans up a prompt submission that is ${failure}`, async ($, on) => {
    const clock = mock.clock(on)
    const finished = stubUi(on)
    const argvs = stubCodex(on)
    if (failure === 'dropped') on('prompt.submit', async () => ({ drop: 'blocked' }))
    await $.command.run({ ...COMMAND, args: '' })
    await clock.advance(1)
    await expectPlanningStopped(finished, argvs,
      failure === 'dropped' ? 'blocked' : 'no implementation for prompt.submit')
    expect((await $.command.run({ ...COMMAND, args: '' })).text).toMatch('Asked Claude')
  })
}

for (const failure of ['not a repository', 'cwd unavailable'] as const) {
  test(`cleans up when the prepared review cannot start: ${failure}`, async ($, on) => {
    const clock = mock.clock(on)
    stubGit(on, false, failure === 'not a repository')
    if (failure === 'cwd unavailable') on('session.cwd', async () => ({ deny: failure }))
    const finished = stubUi(on)
    const argvs = stubCodex(on)
    stubPrompt(on)
    await $.command.run({ ...COMMAND, args: '' })
    await clock.advance(1)
    await $.turn.complete({ ...TURN, turnId: 'ask', answer: buildPrompt('', false) })
    await expectPlanningStopped(finished, argvs,
      failure === 'not a repository' ? 'Not a Git working tree' : failure)
    expect((await $.command.run({ ...COMMAND, args: '' })).text).toMatch('Asked Claude')
  })
}
