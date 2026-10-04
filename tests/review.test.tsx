import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const COMMAND = {
  command: 'codex-review',
  args: '',
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
function stubGit(on: On, isRepo: boolean, hasCwd = true, diff: () => string = () => '') {
  if (hasCwd) on('session.cwd', async () => ({ value: '/work' }))
  on('process.run', async (_$, e) => {
    const stdout = !isRepo
      ? ''
      : e.argv[1] === 'rev-parse'
        ? 'true\n'
        : e.argv[1] === 'diff'
          ? diff()
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
function stubUi(on: On, opened: string[] = []): Promise<{ toasts: string[] }> {
  const toasts: string[] = []
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
      if (e.text === undefined) resolve({ toasts })
      return { value: undefined }
    })
  })
}

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

  await $.command.run({ ...COMMAND, args: '--read-only speed' })
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

  await $.command.run({ ...COMMAND, args: 'performance' })
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
    expect(await ui.find({ type: 'Text', text: '1' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '2' })).toBeDefined()
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
  on('prompt.submit', async () => {
    throw new Error('prompt unavailable')
  })

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
  stubGit(on, true, true, () => (isEdited ? '3\t1\tsrc/a.ts\0' : ''))
  stubCodexConfig(on)
  const finished = stubUi(on)
  on('process.spawn', async function* () {
    // Codex reports nothing about files; Git is the only witness.
    isEdited = true
    const done = { type: 'item.completed', item: { type: 'command_execution' } }
    const message = { type: 'item.completed', item: { type: 'agent_message', text: 'report' } }
    yield { stream: 'stdout', text: `${JSON.stringify(done)}\n${JSON.stringify(message)}\n` }
    return { value: { code: 0, signal: null } }
  })
  on('prompt.submit', async (_$, e) => ({ text: e.text }))
  on('ui.render', async ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine band</Text>
  })

  await $.command.run(COMMAND)
  await finished

  const ui = await $.ui.mount({
    plugin: 'codex-reviewer',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: BAND_PROPS,
  })
  expect(await ui.find({ type: 'Text', text: /1 files \+3 −1/ })).toBeDefined()
  await ui.unmount()
})
