import type { ElementTable, RenderNode } from 'claude-code'

import { lineTotals } from '../lib/review'
import { COMMAND, FRAME_MS } from '../lib/constants'
import type { ActivityKind, ChangedFile, ReviewState } from '../types'

const SECOND = 1000
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

type ReviewProps = {
  elements: Pick<ElementTable, 'Box' | 'Text' | 'Button'>
  state: ReviewState
  columns?: number
  onCancel: () => void
}

type BandProps = ReviewProps & {
  onOpen: () => unknown
  onDismiss: () => unknown
  children?: RenderNode
}

export function ReviewBand({
  elements, state, columns, onOpen, onCancel, onDismiss, children,
}: BandProps) {
  const { Box, Text, Button } = elements
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

  const room = (columns ?? FALLBACK_COLUMNS) - BAND_LABEL_COLUMNS - BAND_GAP
  const hasModel = model !== '' && fits([status, elapsed, counts, ...actions, model], room)

  const current = isRunning ? state.recent.at(-1) : undefined

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
          onPress={onOpen}
        />
        {isRunning ? (
          <Button key="cancel" label="Cancel" hotkey="c" plain onPress={onCancel} />
        ) : (
          <Button
            key="dismiss"
            label="Hide"
            hotkey="x"
            plain
            onPress={onDismiss}
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
      {children}
    </Box>
  )
}

export function ReviewPane({
  elements, state, columns, onCancel, onClose,
}: ReviewProps & { onClose: () => unknown }) {
  const { Box, Text, Button } = elements
  if (state.phase === 'idle') return <Text dimColor>No review yet. Run /{COMMAND}.</Text>

  const isRunning = state.phase === 'running'
  const look = PHASE_LOOK[state.phase]
  const width = columns ?? FALLBACK_COLUMNS
  const frame = frameOf(state)
  const spinner = spinnerOf(frame, look.icon)
  const isPulseOn = Math.floor(frame / PULSE_FRAMES) % 2 === 0
  const [before, head, after] = sweepSegments(frame, width)
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
          <Text color={look.color}>{BAR_CELL.repeat(width)}</Text>
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
                <Text>
                  <Text color="green"> +{added}</Text>
                  <Text color="red"> −{deleted}</Text>
                </Text>
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
          <Button key="cancel" variant="secondary" onPress={onCancel}>
            Cancel
          </Button>
        )}
        <Button role="dismiss" onPress={onClose}>
          Close
        </Button>
      </Box>
    </Box>
  )
}
