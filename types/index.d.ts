export type ReviewPhase = 'idle' | 'running' | 'done' | 'failed' | 'cancelled'

export type ActivityKind = 'command' | 'edit' | 'message'

export type Activity = { kind: ActivityKind; text: string }

/** One file the review changed, with its line counts against the starting point. */
export type ChangedFile = { path: string; added: number; deleted: number }

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
  /** Files whose changes differ from when the review started, read from Git. */
  files: ChangedFile[]
  /** The latest things Codex did, oldest first; the last one is its latest reported activity. */
  recent: Activity[]
  detail?: string
}

declare module 'claude-code' {
  interface PluginState {
    'codex-reviewer': { review: ReviewState; isBandHidden: boolean }
  }
}
