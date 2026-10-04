import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import {
  applyChanges,
  applyEvent,
  changedSince,
  IDLE,
  lineTotals,
  parseEvent,
  parseSnapshot,
  buildPrompt,
  parseArgs,
} from '../lib/review'
import type { CodexEvent, Snapshot } from '../lib/review'

import type { ActivityKind, ChangedFile, ReviewState } from '../types'

const PANE = 'codex-reviewer'
const COMMAND = 'codex-review'
const PANE_TITLE = 'Codex review'
const SECOND = 1000
const FRAME_MS = 100
const SWEEP_WIDTH = 8
const PULSE_FRAMES = 5
const DOT_FRAMES = 4
// The band shares its row layout with the plugins drawn above it: a label column, then 2-cell gaps.
const BAND_LABEL_COLUMNS = 6
const BAND_GAP = 2
const PANE_LABEL_COLUMNS = 6
const BAR_CELL = '━'
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const FALLBACK_COLUMNS = 40

const STDERR_TAIL = 2000
const CONFIG_TABLE_RE = /^\[/m
const CONFIG_MODEL_RE = /^model\s*=\s*"([^"]+)"/m
const CONFIG_EFFORT_RE = /^model_reasoning_effort\s*=\s*"([^"]+)"/m
const review = atom({ plugin: 'codex-reviewer', key: 'review' } as const, IDLE)
const isBandHidden = atom({ plugin: 'codex-reviewer', key: 'isBandHidden' } as const, false)

const PHASE_LOOK: Record<ReviewState['phase'], { icon: string; label: string; color: string }> = {
  idle: { icon: '○', label: 'Idle', color: 'gray' },
  running: { icon: '●', label: 'Reviewing', color: 'cyan' },
  done: { icon: '✔', label: 'Finished', color: 'green' },
  failed: { icon: '✘', label: 'Failed', color: 'red' },
  cancelled: { icon: '■', label: 'Cancelled', color: 'yellow' },
}

const ACTIVITY_LOOK: Record<ActivityKind, { icon: string; color: string }> = {
  command: { icon: '❯', color: 'cyan' },
  edit: { icon: '✎', color: 'green' },
  message: { icon: '✦', color: 'magenta' },
}

/** Splits a bar of `columns` cells into the dim run before, the bright sweep, and the dim run after. */
const sweepSegments = (frame: number, columns: number): [number, number, number] => {
  const start = (frame % (columns + SWEEP_WIDTH)) - SWEEP_WIDTH
  const head = Math.max(0, Math.min(columns, start + SWEEP_WIDTH) - Math.max(0, start))
  const before = Math.max(0, Math.min(columns, start))
  return [before, head, columns - before - head]
}

const frameOf = (state: ReviewState): number => Math.floor(state.now / FRAME_MS)

const spinnerOf = (frame: number, fallback: string): string =>
  SPINNER[frame % SPINNER.length] ?? fallback

const formatElapsed = (ms: number): string => {
  const seconds = Math.max(0, Math.floor(ms / SECOND))
  const minutes = Math.floor(seconds / 60)
  return minutes > 0 ? `${minutes}m${String(seconds % 60).padStart(2, '0')}s` : `${seconds}s`
}

const filesSummary = (files: readonly ChangedFile[]): string => {
  const { added, deleted } = lineTotals(files)
  return files.length === 0 ? '0 files' : `${files.length} files +${added} −${deleted}`
}

/** Whether `parts` fit `room` cells side by side, a gap between each. */
const fits = (parts: readonly string[], room: number): boolean =>
  parts.reduce((total, part) => total + part.length, 0) + BAND_GAP * (parts.length - 1) <= room

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
  focus: string,
  { model, effort, readOnly }: { model: string; effort?: string; readOnly: boolean },
): Promise<string | undefined> {
  if (signal.aborted) return
  // Which files the review changed comes from Git, not from Codex's own account of its edits.
  const base = await readSnapshot($, cwd).catch(() => undefined)
  const codex = $.process.spawn({
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
      buildPrompt(focus, readOnly),
    ],
  })
  let cancel = () => {}
  const cancelled = new Promise<undefined>((resolve) => {
    cancel = () => resolve(undefined)
  })
  signal.addEventListener('abort', cancel, { once: true })
  let buffer = ''
  let stderr = ''
  let lastMessage = ''
  let failure: string | undefined

  let tracking: Promise<void> = Promise.resolve()
  let isQueued = false
  /** Re-reads Git after Codex acts; a refresh already waiting covers any that arrive meanwhile. */
  function trackChanges(): Promise<void> {
    if (base === undefined || isQueued) return tracking
    isQueued = true
    tracking = tracking.then(async () => {
      isQueued = false
      if (signal.aborted) return
      try {
        const files = changedSince(base, await readSnapshot($, cwd))
        if (!signal.aborted) await update($, review, (state) => applyChanges(state, files))
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
      await update($, review, (state) => events.reduce(applyEvent, state))
      if (events.some((event) => event.type === 'item.completed')) void trackChanges()
    }
  }

  async function consume() {
    for await (const chunk of codex) {
      if (signal.aborted) return
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
    await trackChanges()
    const { code, signal: exitSignal } = await codex.result
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
    signal.removeEventListener('abort', cancel)
    await codex.return({ code: null, signal: null })
  }
}

/** The review as drawn. State outlives a hot reload but the Codex process does not, so a
 * review that reads "running" with no live run in this module was cut off by the reload. */
async function readReview($: EngineInterface, hasRun: boolean): Promise<ReviewState> {
  const stored = await read($, review)
  // State saved by an older version kept `files` as a count; start that list over.
  const state = Array.isArray(stored.files) ? stored : { ...stored, files: [] }
  if (state.phase !== 'running' || hasRun) return state
  return { ...state, phase: 'cancelled', detail: 'Interrupted: the plugin was reloaded.' }
}

export const register: Register = (on, options) => {
  const modelOverride = typeof options.model === 'string' ? options.model.trim() : ''
  let active: AbortController | undefined

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description:
        'Review the current changes with `codex exec` (optional: --read-only, --model <name>, --effort <level>, extra focus)',
    })
    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    if (active !== undefined) {
      await $.ui.open({ id: PANE, title: PANE_TITLE })
      return { text: 'A Codex review is already running; reopened its pane.' }
    }

    const args = parseArgs(e.args)
    if (args.error !== undefined) return { text: args.error }
    const { focus, readOnly } = args
    // `--model` and `--effort` apply to this run only; the option is the standing default.
    const model = args.model ?? modelOverride

    // Claim the run before the first await so concurrent commands cannot start two children.
    const run = new AbortController()
    active = run
    let tick: Timer | undefined
    try {
      const cwd = await $.session.cwd()
      const { exitCode, stdout } = await $.process.run(
        ['git', 'rev-parse', '--is-inside-work-tree'],
        { cwd },
      )
      if (exitCode !== 0 || stdout.trim() !== 'true') {
        active = undefined
        return {
          text: `Not a Git working tree: ${cwd}. Run /${COMMAND} from inside the project to review.`,
        }
      }

      const defaults = await readCodexDefaults($)
      const now = await $.clock.now()
      await update($, isBandHidden, () => false)
      await update($, review, (): ReviewState => ({
        ...IDLE,
        phase: 'running',
        focus,
        model: model || defaults.model,
        reasoningEffort: args.effort ?? defaults.reasoningEffort,
        startedAt: now,
        now,
      }))
      $.ui.status('Codex review running')
      tick = $.clock.every(FRAME_MS, () => {
        void $.clock
          .now()
          .then((now) =>
            update($, review, (state) =>
              active === run && state.phase === 'running' ? { ...state, now } : state,
            ),
          )
          .catch((error) => $.ui.log(String(error), { to: 'debug' }))
      })

      void (async () => {
        try {
          const report = await runReview($, run.signal, cwd, focus, {
            model,
            effort: args.effort,
            readOnly,
          })
          tick?.cancel()
          const now = await $.clock.now()
          await update($, review, (state): ReviewState => ({
            ...state,
            now,
            phase: run.signal.aborted ? 'cancelled' : 'done',
            detail: run.signal.aborted ? 'Cancelled.' : 'Review finished.',
          }))
          if (run.signal.aborted) return
          $.ui.toast('Codex review finished')
          try {
            await $.prompt.submit({
              text: readOnly
                ? `Codex finished a read-only review of the current changes. Its report:\n\n${report}\n\nSummarize the findings, most important first, and say which ones you would act on.`
                : `Codex finished reviewing and fixing the current changes. Its final report:\n\n${report}\n\nSummarize what Codex changed and flag anything that still needs a decision.`,
            })
          } catch (error) {
            await update($, review, (state) => ({
              ...state,
              detail: `Review finished, but the report could not be delivered: ${String(error)}\n\n${report}`,
            }))
            $.ui.toast(
              'Codex review finished, but report delivery failed. Open the pane to read it.',
            )
          }
        } catch (error) {
          const detail = run.signal.aborted
            ? 'Cancelled.'
            : error instanceof Error
              ? error.message
              : String(error)
          const now = await $.clock.now()
          await update($, review, (state): ReviewState => ({
            ...state,
            now,
            phase: run.signal.aborted ? 'cancelled' : 'failed',
            detail,
          }))
          if (!run.signal.aborted) $.ui.toast(`Codex review failed: ${detail}`)
        } finally {
          tick?.cancel()
          active = undefined
          $.ui.status(undefined)
        }
      })().catch((error) => $.ui.log(String(error), { to: 'debug' }))
    } catch (error) {
      tick?.cancel()
      const detail = error instanceof Error ? error.message : String(error)
      try {
        await update($, review, (state): ReviewState => ({ ...state, phase: 'failed', detail }))
      } finally {
        active = undefined
        $.ui.status(undefined)
      }
      return { text: `Codex review could not start: ${detail}` }
    }

    return {
      text: 'Codex review started; the status band shows progress and you are notified when it finishes.',
    }
  })

  // A one-line entry above the prompt: the way back into the pane after closing it.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const state = await readReview($, active !== undefined)
    if (e.props.hasSurvey || state.phase === 'idle' || (await read($, isBandHidden))) {
      return next(e)
    }

    const { Box, Text, Button } = $.ui.resolve(e)
    const look = PHASE_LOOK[state.phase]
    const isRunning = state.phase === 'running'
    const frame = frameOf(state)
    const status = `${isRunning ? spinnerOf(frame, look.icon) : look.icon} ${look.label}`
    const elapsed = formatElapsed(state.now - state.startedAt)
    const counts = `${state.commands} commands  ${filesSummary(state.files)}`
    const model =
      state.model === undefined
        ? ''
        : state.reasoningEffort === undefined
          ? state.model
          : `${state.model} · ${state.reasoningEffort}`
    const actions = isRunning ? ['o: Open', 'c: Cancel'] : ['o: Open', 'x: Hide']

    const room = (e.props.bodyColumns ?? FALLBACK_COLUMNS) - BAND_LABEL_COLUMNS - BAND_GAP
    const hasModel = model !== '' && fits([status, elapsed, counts, ...actions, model], room)

    const current = isRunning ? state.recent.at(-1) : undefined
    // Stack above whatever another plugin or the engine draws here, rather than replace it.
    const below = await next(e)

    return (
      <Box flexDirection="column" marginTop={1}>
        <Box columnGap={BAND_GAP}>
          <Box width={BAND_LABEL_COLUMNS}>
            <Text dimColor>Codex</Text>
          </Box>
          <Text bold color={look.color}>
            {status}
          </Text>
          <Text>{elapsed}</Text>
          <Text dimColor>{counts}</Text>
          {hasModel && <Text dimColor>{model}</Text>}
          <Button
            key="open"
            label="Open"
            hotkey="o"
            plain
            onPress={() => $.ui.open({ id: PANE, title: PANE_TITLE })}
          />
          {isRunning ? (
            <Button key="cancel" label="Cancel" hotkey="c" plain onPress={() => active?.abort()} />
          ) : (
            <Button
              key="dismiss"
              label="Hide"
              hotkey="x"
              plain
              onPress={() => update($, isBandHidden, () => true)}
            />
          )}
        </Box>
        {current !== undefined && (
          <Box paddingLeft={BAND_LABEL_COLUMNS + BAND_GAP}>
            <Text wrap="truncate-end">
              <Text color={ACTIVITY_LOOK[current.kind].color}>
                {ACTIVITY_LOOK[current.kind].icon}
              </Text>{' '}
              <Text dimColor>{current.text}</Text>
            </Text>
          </Box>
        )}
        {!isRunning && state.detail !== undefined && state.phase !== 'done' && (
          <Box paddingLeft={BAND_LABEL_COLUMNS + BAND_GAP}>
            <Text wrap="truncate-end" color={look.color}>
              {state.detail}
            </Text>
          </Box>
        )}
        {below}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const state = await readReview($, active !== undefined)
    if (state.phase === 'idle') return <Text dimColor>No review yet. Run /{COMMAND}.</Text>

    const isRunning = state.phase === 'running'
    const look = PHASE_LOOK[state.phase]
    const columns = e.props.bodyColumns ?? FALLBACK_COLUMNS
    const frame = frameOf(state)
    const spinner = spinnerOf(frame, look.icon)
    const isPulseOn = Math.floor(frame / PULSE_FRAMES) % 2 === 0
    const [before, head, after] = sweepSegments(frame, columns)
    const lastIndex = state.recent.length - 1
    const { added, deleted } = lineTotals(state.files)

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Box justifyContent="space-between">
            <Text bold color={look.color}>
              {isRunning ? spinner : look.icon} {look.label}
            </Text>
            <Text dimColor>{formatElapsed(state.now - state.startedAt)}</Text>
          </Box>
          {isRunning ? (
            <Box flexDirection="row">
              <Text dimColor>{BAR_CELL.repeat(before)}</Text>
              <Text bold color={look.color}>
                {BAR_CELL.repeat(head)}
              </Text>
              <Text dimColor>{BAR_CELL.repeat(after)}</Text>
            </Box>
          ) : (
            <Text color={look.color}>{BAR_CELL.repeat(columns)}</Text>
          )}
          <Box flexDirection="column" marginTop={1}>
            <Box columnGap={BAND_GAP}>
              <Box width={PANE_LABEL_COLUMNS}>
                <Text dimColor>model</Text>
              </Box>
              <Text bold>{state.model ?? 'default'}</Text>
              {state.reasoningEffort !== undefined && <Text dimColor>{state.reasoningEffort}</Text>}
            </Box>
            {state.focus !== '' && (
              <Box columnGap={BAND_GAP}>
                <Box width={PANE_LABEL_COLUMNS}>
                  <Text dimColor>focus</Text>
                </Box>
                <Text wrap="truncate-end">{state.focus}</Text>
              </Box>
            )}
            <Box columnGap={BAND_GAP}>
              <Box width={PANE_LABEL_COLUMNS}>
                <Text dimColor>work</Text>
              </Box>
              <Text>
                <Text bold>{state.commands}</Text>
                <Text dimColor> commands </Text>
                <Text bold color={state.files.length > 0 ? 'green' : undefined}>
                  {state.files.length}
                </Text>
                <Text dimColor> files edited</Text>
                {state.files.length > 0 && (
                  <>
                    <Text color="green"> +{added}</Text>
                    <Text color="red"> −{deleted}</Text>
                  </>
                )}
              </Text>
            </Box>
          </Box>
        </Box>

        <Box flexDirection="column">
          {state.recent.length === 0 && isRunning && (
            <Text dimColor>
              Waiting for Codex{'.'.repeat(1 + (Math.floor(frame / PULSE_FRAMES) % DOT_FRAMES))}
            </Text>
          )}
          {state.recent.map((activity, index) => {
            const { icon, color } = ACTIVITY_LOOK[activity.kind]
            const isCurrent = isRunning && index === lastIndex
            return (
              <Box key={`${index}-${activity.text}`} gap={1}>
                <Text color={color} dimColor={!isCurrent || !isPulseOn}>
                  {icon}
                </Text>
                <Text wrap="truncate-end" dimColor={!isCurrent} bold={isCurrent}>
                  {activity.text}
                </Text>
              </Box>
            )
          })}
        </Box>

        {state.detail !== undefined && (
          <Text color={state.phase === 'failed' ? 'red' : look.color}>{state.detail}</Text>
        )}

        <Box gap={2}>
          {isRunning && (
            <Button key="cancel" variant="secondary" onPress={() => active?.abort()}>
              Cancel
            </Button>
          )}
          <Button role="dismiss" onPress={() => $.ui.close({ id: PANE })}>
            Close
          </Button>
        </Box>
      </Box>
    )
  })
}
