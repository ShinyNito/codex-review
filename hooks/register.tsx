import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import { ReviewBand, ReviewPane } from '../components/review'
import { buildPrompt, cleanPrompt, parseArgs, promptRequest } from '../lib/prompt'
import type { ReviewArgs } from '../lib/prompt'
import { applyChanges, applyEvent, changedSince, IDLE, parseEvent, parseSnapshot } from '../lib/review'
import type { CodexEvent, Snapshot } from '../lib/review'
import type { ReviewState } from '../types'
import { COMMAND, FRAME_MS, PANE, PANE_TITLE } from '../lib/constants'

const review = atom({ plugin: 'codex-reviewer', key: 'review' } as const, IDLE)
const isBandHidden = atom({ plugin: 'codex-reviewer', key: 'isBandHidden' } as const, false)

const PLANNING_TIMEOUT_MS = 5 * 60 * 1000
const STARTED = 'Codex review started; the status band shows progress and you are notified when it finishes.'

type Planning = {
  kind: 'planning'
  args: ReviewArgs
  request: string
  turnId?: string
  timeout?: Timer
  submission?: Timer
}

type Active = Planning | { kind: 'running'; controller: AbortController }

type Live = { modelOverride: string; active?: Active }

const STDERR_TAIL = 2000
const TRACKING_INTERVAL_MS = 100
const CONFIG_TABLE_RE = /^\[/m
const CONFIG_MODEL_RE = /^model\s*=\s*"([^"]+)"/m
const CONFIG_EFFORT_RE = /^model_reasoning_effort\s*=\s*"([^"]+)"/m

/** Codex's own defaults: the top-level keys of its config.toml, before any `[table]`. */
async function readCodexDefaults($: EngineInterface) {
  const home = (await $.env.get('CODEX_HOME')) ?? `${(await $.env.get('HOME')) ?? ''}/.codex`
  try {
    const topLevel = (await $.fs.read(`${home}/config.toml`)).split(CONFIG_TABLE_RE)[0] ?? ''
    return {
      model: CONFIG_MODEL_RE.exec(topLevel)?.[1],
      reasoningEffort: CONFIG_EFFORT_RE.exec(topLevel)?.[1],
    }
  } catch {
    return { model: undefined, reasoningEffort: undefined }
  }
}

/** Git's view of the working tree: what differs from HEAD, plus untracked files. */
async function readSnapshot($: EngineInterface, cwd: string): Promise<Snapshot> {
  const [tracked, untracked] = await Promise.all([
    $.process.run(['git', 'diff', 'HEAD', '--numstat', '-z', '--no-renames'], { cwd }),
    $.process.run(['git', 'ls-files', '--others', '--exclude-standard', '-z'], { cwd }),
  ])
  // A repository with no commit has no HEAD to diff against; everything is untracked then.
  return parseSnapshot(tracked.exitCode === 0 ? tracked.stdout : '', untracked.stdout)
}

/** Reads the stream to completion, or closes it to kill the child on cancellation. */
async function runReview(
  $: EngineInterface,
  signal: AbortSignal,
  cwd: string,
  prompt: string,
  { model, effort, readOnly }: { model: string; effort?: string; readOnly: boolean },
): Promise<string> {
  signal.throwIfAborted()
  let codex: ReturnType<EngineInterface['process']['spawn']> | undefined
  let cancel = () => {}
  const cancelled = new Promise<never>((_resolve, reject) => {
    cancel = () => reject(signal.reason)
  })
  signal.addEventListener('abort', cancel, { once: true })
  let tracking: Promise<void> = Promise.resolve()
  let refresh: Timer | undefined

  async function consume() {
    // Which files the review changed comes from Git, not from Codex's own account of its edits.
    const base = await readSnapshot($, cwd).catch(() => undefined)
    signal.throwIfAborted()
    const child = $.process.spawn({
      argv: [
        'codex',
        'exec',
        '--json',
        '--ephemeral',
        '--skip-git-repo-check',
        ...(model === '' ? [] : ['-m', model]),
        ...(effort === undefined ? [] : ['-c', `model_reasoning_effort="${effort}"`]),
        '-s',
        readOnly ? 'read-only' : 'workspace-write',
        '-C',
        cwd,
        prompt,
      ],
    })
    codex = child

    let buffer = ''
    let stderr = ''
    let lastMessage = ''
    let failure: string | undefined
    let isQueued = false

    /** Serialize snapshots, keeping at most one refresh behind a slow Git read. */
    function trackChanges(): Promise<void> {
      if (base === undefined || isQueued) return tracking
      isQueued = true
      tracking = tracking.then(async () => {
        isQueued = false
        if (signal.aborted) return
        try {
          const files = changedSince(base, await readSnapshot($, cwd))
          await update($, review, (state) => signal.aborted ? state : applyChanges(state, files))
        } catch (error) {
          $.ui.log(String(error), { to: 'debug' })
        }
      })
      return tracking
    }

    async function consumeLines(lines: string[]) {
      const events: CodexEvent[] = []
      for (const line of lines) {
        const event = parseEvent(line)
        if (event === undefined) continue
        if (event.type === 'turn.failed') {
          failure = event.error.message
        } else {
          if (event.type === 'item.completed' && event.item.type === 'agent_message') {
            lastMessage = event.item.text
          }
          events.push(event)
        }
      }
      if (events.length > 0 && !signal.aborted) {
        await update($, review, (state) => signal.aborted ? state : events.reduce(applyEvent, state))
        if (!signal.aborted && refresh === undefined && base !== undefined && events.some((event) =>
          event.type === 'item.completed' && event.item.type !== 'agent_message',
        )) {
          refresh = $.clock.after(TRACKING_INTERVAL_MS, () => {
            refresh = undefined
            void trackChanges()
          })
        }
      }
    }

    for await (const chunk of child) {
      signal.throwIfAborted()
      if (chunk.stream === 'stderr') {
        stderr = (stderr + chunk.text).slice(-STDERR_TAIL)
        continue
      }
      buffer += chunk.text
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      await consumeLines(lines)
    }
    await consumeLines([buffer])
    refresh?.cancel()
    await trackChanges()
    const { code, signal: exitSignal } = await child.result
    if (failure !== undefined || code !== 0) {
      throw new Error(failure ?? (stderr.trim() || `codex exec exited with ${exitSignal ?? code}`))
    }
    if (lastMessage.trim() === '') throw new Error('Codex exited without a final report')
    return lastMessage
  }

  try {
    // One cancellation subscription for the entire run, rather than one per chunk.
    return await Promise.race([consume(), cancelled])
  } finally {
    refresh?.cancel()
    signal.removeEventListener('abort', cancel)
    // Closing the SDK stream terminates the child, including a pending pull.
    await codex?.return({ code: null, signal: null })
    if (!signal.aborted) await tracking
  }
}

/** Persisted progress survives reload; its process does not. */
async function readReview($: EngineInterface, isActive: boolean): Promise<ReviewState> {
  const state = await read($, review)
  return state.phase === 'running' && !isActive
    ? { ...state, phase: 'cancelled', detail: 'Interrupted: the plugin was reloaded.' }
    : state
}

function finishPlanning($: EngineInterface, live: Live, asked: Planning, reason?: string) {
  if (live.active !== asked) return
  live.active = undefined
  asked.timeout?.cancel()
  asked.submission?.cancel()
  $.ui.status(undefined)
  if (reason !== undefined) $.ui.toast(`Codex review not started: ${reason}`)
}

async function startReview($: EngineInterface, live: Live, args: ReviewArgs, prompt: string) {
  // Reserve the run before awaiting host calls.
  const controller = new AbortController()
  live.active = { kind: 'running', controller }
  const { signal } = controller
  const model = args.model ?? live.modelOverride
  let tick: Timer | undefined
  try {
    const cwd = await $.session.cwd()
    const { exitCode, stdout } = await $.process.run(
      ['git', 'rev-parse', '--is-inside-work-tree'],
      { cwd },
    )
    if (exitCode !== 0 || stdout.trim() !== 'true') {
      throw new Error(`Not a Git working tree: ${cwd}. Run /${COMMAND} from inside the project to review.`)
    }

    const defaults = await readCodexDefaults($)
    const now = await $.clock.now()
    signal.throwIfAborted()
    await update($, isBandHidden, () => false)
    await update($, review, (): ReviewState => ({
      ...IDLE,
      phase: 'running',
      focus: args.focus,
      model: model || defaults.model,
      reasoningEffort: args.effort ?? defaults.reasoningEffort,
      startedAt: now,
      now,
    }))
    tick = $.clock.every(FRAME_MS, () => {
      void $.clock.now()
        .then((now) => update($, review, (state) =>
          live.active?.kind === 'running' && live.active.controller === controller && state.phase === 'running'
            ? { ...state, now }
            : state,
        ))
        .catch((error) => $.ui.log(String(error), { to: 'debug' }))
    })
    $.ui.status('Codex review running')

    void (async () => {
      try {
        const report = await runReview($, signal, cwd, prompt, {
          model,
          effort: args.effort,
          readOnly: args.readOnly,
        })
        signal.throwIfAborted()
        tick?.cancel()
        const now = await $.clock.now()
        await update($, review, (state): ReviewState => ({
          ...state, now, phase: 'done', detail: 'Review finished.',
        }))
        $.ui.toast('Codex review finished')
        try {
          const delivery = await $.prompt.submit({
            text: args.readOnly
              ? `Codex finished a read-only review of the current changes. Its report:\n\n${report}\n\nSummarize the findings, most important first, and say which ones you would act on.`
              : `Codex finished reviewing and fixing the current changes. Its final report:\n\n${report}\n\nSummarize what Codex changed and flag anything that still needs a decision.`,
          })
          if (delivery.drop !== undefined) throw new Error(delivery.drop)
        } catch (error) {
          await update($, review, (state) => ({
            ...state,
            detail: `Review finished, but the report could not be delivered: ${String(error)}\n\n${report}`,
          }))
          $.ui.toast('Codex review finished, but report delivery failed. Open the pane to read it.')
        }
      } catch (error) {
        const detail = signal.aborted
          ? 'Cancelled.'
          : error instanceof Error ? error.message : String(error)
        const now = await $.clock.now()
        await update($, review, (state): ReviewState => ({
          ...state, now, phase: signal.aborted ? 'cancelled' : 'failed', detail,
        }))
        if (!signal.aborted) $.ui.toast(`Codex review failed: ${detail}`)
      } finally {
        tick?.cancel()
        live.active = undefined
        $.ui.status(undefined)
      }
    })().catch((error) => $.ui.log(String(error), { to: 'debug' }))
  } catch (error) {
    tick?.cancel()
    live.active = undefined
    throw error
  }
}

export const register: Register = (on, options) => {
  const live: Live = {
    modelOverride: typeof options.model === 'string' ? options.model.trim() : '',
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description:
        'Review the current changes with `codex exec` (optional: --quick, --read-only, --model <name>, --effort <level>, extra focus)',
    })
    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    if (live.active?.kind === 'running') {
      await $.ui.open({ id: PANE, title: PANE_TITLE })
      return { text: 'A Codex review is already running; reopened its pane.' }
    }
    if (live.active?.kind === 'planning') {
      return { text: 'Claude is already writing the review prompt; wait for it or interrupt that turn.' }
    }

    const args = parseArgs(e.args)
    if (args.error !== undefined) return { text: args.error }
    if (args.quick) {
      try {
        await startReview($, live, args, buildPrompt(args.focus, args.readOnly))
        return { text: STARTED }
      } catch (error) {
        return { text: `Codex review could not start: ${String(error)}` }
      }
    }

    const asked: Planning = {
      kind: 'planning',
      args,
      request: promptRequest(
        buildPrompt(args.focus, args.readOnly),
        `[codex-review-prompt:${crypto.randomUUID()}]`,
      ),
    }
    live.active = asked
    $.ui.status('Claude is writing the review prompt')
    asked.timeout = $.clock.after(PLANNING_TIMEOUT_MS, () => {
      finishPlanning($, live, asked, 'timed out waiting for Claude’s prompt; run /codex-review again or use --quick')
    })
    // The host forbids prompt.submit inside command.run; defer it with the host clock.
    asked.submission = $.clock.after(1, () => {
      if (live.active !== asked) return
      void $.prompt.submit({ text: asked.request })
        .then((result) => {
          if (result.drop !== undefined) finishPlanning($, live, asked, result.drop)
          else if (result.text !== asked.request) {
            finishPlanning($, live, asked, 'the prompt request was rewritten')
          }
        })
        .catch((error) => finishPlanning($, live, asked, String(error)))
    })
    return {
      text: 'Asked Claude to write the review prompt; Codex starts when it replies. If that fails, run /codex-review again, or use --quick for the built-in prompt.',
    }
  })

  on('turn.start', ($, e, next) => {
    if (live.active?.kind === 'planning') {
      if (live.active.turnId === undefined && e.text === live.active.request) {
        live.active.turnId = e.turnId
      } else if (live.active.turnId !== e.turnId) {
        finishPlanning($, live, live.active, 'another turn started before the prompt arrived')
      }
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const asked = live.active
    const result = await next(e)
    if (asked?.kind !== 'planning' || live.active !== asked || e.agentId !== undefined || asked.turnId !== e.turnId) {
      return result
    }
    if (e.reason !== 'answer') {
      finishPlanning($, live, asked, e.reason === 'aborted'
        ? 'the request for a prompt was interrupted'
        : `the request for a prompt ended with ${e.reason}`)
      return result
    }
    const reply = cleanPrompt(e.answer, asked.args.readOnly)
    if ('problem' in reply) {
      finishPlanning($, live, asked, `${reply.problem}; run /codex-review again`)
      return result
    }
    finishPlanning($, live, asked)
    try {
      await startReview($, live, asked.args, reply.prompt)
    } catch (error) {
      $.ui.toast(`Codex review could not start: ${String(error)}`)
    }
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || await read($, isBandHidden)) return next(e)
    const state = await readReview($, live.active?.kind === 'running')
    if (state.phase === 'idle') return next(e)
    return (
      <ReviewBand
        elements={$.ui.resolve(e)}
        state={state}
        columns={e.props.bodyColumns}
        onOpen={() => $.ui.open({ id: PANE, title: PANE_TITLE })}
        onCancel={() => {
          if (live.active?.kind === 'running') live.active.controller.abort()
        }}
        onDismiss={() => update($, isBandHidden, () => true)}
      >
        {await next(e)}
      </ReviewBand>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => (
    <ReviewPane
      elements={$.ui.resolve(e)}
      state={await readReview($, live.active?.kind === 'running')}
      columns={e.props.bodyColumns}
      onCancel={() => {
        if (live.active?.kind === 'running') live.active.controller.abort()
      }}
      onClose={() => $.ui.close({ id: PANE })}
    />
  ))
}
