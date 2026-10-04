export type ReviewPhase = 'idle' | 'running' | 'done' | 'failed' | 'cancelled'

export type ActivityKind = 'command' | 'edit' | 'message'

export type Activity = { kind: ActivityKind; text: string }

export type ReviewState = {
  phase: ReviewPhase
  focus: string
  /** The model Codex runs with: the mod's `model` option, else the default from its config. */
  model?: string
  reasoningEffort?: string
  startedAt: number
  /** Last clock tick, so the pane redraws its elapsed time while running. */
  now: number
  /** Shell commands Codex has finished. */
  commands: number
  /** Unique paths Codex has edited. */
  files: string[]
  /** The latest things Codex did, oldest first; the last one is its latest reported activity. */
  recent: Activity[]
  detail?: string
}

declare module 'claude-code' {
  interface PluginState {
    'codex-reviewer': { review: ReviewState; isBandHidden: boolean }
  }
}
