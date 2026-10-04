const FOCUS = `Focus: start with performance; remove duplicated validation, redundant state and duplicated tests; use modern idioms and do not hand-write what an imported package already provides; remove code that only forwards to something else; follow the conventions and layout of this project and of well-known open-source projects of the same kind.`

const FIX_REQUIREMENTS = `Review and fix the uncommitted changes in this workspace (visible in git status and git diff).

Goal: bring these changes to a state a human can review as-is, written in a standard, readable style that would fit a mature open-source project.
${FOCUS}

Scope: concentrate on these changes. Read surrounding code as needed to judge them, but only modify what relates to the changes.
Done when: the problems you found are fixed directly, and the project's existing checks (tests, lint, type check) pass with no regressions. You may edit related files, run those checks and fix failures without asking first.
Leave anything that needs a product or architecture decision unchanged and note it in the report.

Finish with a short list: what you changed, why, and what is left unresolved.`

const READ_ONLY_SENTENCE = 'This is a read-only review: do not modify, create or delete any file.'

const REPORT_REQUIREMENTS = `Review the uncommitted changes in this workspace (visible in git status and git diff). ${READ_ONLY_SENTENCE}

Goal: tell the author what stands between these changes and a state a human can review as-is, written in a standard, readable style that would fit a mature open-source project.
${FOCUS}

Scope: concentrate on these changes. Read surrounding code as needed to judge them, and run the project's existing checks (tests, lint, type check) if they do not write to the workspace.
Done when: every problem you found is listed with its file and line, why it matters and the fix you would make, most important first.

Finish with that list, then a one-line verdict: ready to merge, or what blocks it.`

/** The review instructions: fixing by default, report-only when `readOnly`; `focus` is appended. */
export function buildPrompt(focus: string, readOnly: boolean): string {
  const base = readOnly ? REPORT_REQUIREMENTS : FIX_REQUIREMENTS
  return focus === '' ? base : `${base}\n\nAdditional focus for this review: ${focus}`
}

// At most 36 KB in UTF-8, leaving room for the other codex exec arguments.
const MAX_PROMPT_LENGTH = 12_000
const REQUIRED_SECTIONS = [
  ['Goal:', /^Goal:/m],
  ['Scope:', /^Scope:/m],
  ['Done when:', /^Done when:/m],
] as const

/**
 * Asks Claude, which knows what the changes are for, to turn the review `requirements` into the
 * prompt Codex receives. The reply is sent to Codex as it stands.
 */
export function promptRequest(requirements: string, marker: string): string {
  return `${marker}
Write the prompt that Codex will receive to review the uncommitted changes in this workspace (git status, git diff). Codex cannot see this conversation, so use what you know of it and of the diff: what the changes are meant to do, where they are most likely to be wrong, and what to leave alone. Tailor the prompt to these changes: put the areas that matter here first, name concrete files and risks, and leave out a requirement only when it cannot apply to them.

The requirements below come from the person running the review. Keep each one that applies, never weakened. Keep the labels "Goal:", "Scope:" and "Done when:" at the start of their own lines, and the closing line that says what the final report contains. If the requirements forbid modifying files, keep that sentence word for word.

<requirements>
${requirements}
</requirements>

Write it the way the requirements are written: a goal, a scope and a completion bar, not a step-by-step recipe. Keep the reply within ${MAX_PROMPT_LENGTH} characters. Reply with only the prompt text: no preface, no commentary and no code fence around it. Do not edit files or start the review yourself: the codex-reviewer plugin sends your reply to Codex as it is.`
}

/** The prompt inside Claude's reply, or why it cannot be sent to Codex. */
export function cleanPrompt(
  answer: string,
  readOnly: boolean,
): { prompt: string } | { problem: string } {
  if (answer.length > MAX_PROMPT_LENGTH || answer.includes('\0')) {
    return { problem: 'the prompt Claude wrote is too long or malformed' }
  }
  let prompt = answer.trim()
  const opening = /^(`{3,}|~{3,})[^`~\r\n]*\r?\n/.exec(prompt)
  if (opening !== null) {
    const fence = opening[1]!
    const body = prompt.slice(opening[0].length)
    const closing = new RegExp(`^${fence[0]}{${fence.length},}[ \t]*\\r?$`, 'm').exec(body)
    // Only unwrap a fence whose first closing delimiter ends the entire reply.
    if (closing !== null && closing.index + closing[0].length === body.length) {
      prompt = body.slice(0, closing.index).trim()
    }
  }
  if (prompt === '') return { problem: 'Claude wrote no prompt' }
  const missing = REQUIRED_SECTIONS
    .filter(([, pattern]) => !pattern.test(prompt))
    .map(([label]) => label)
  if (missing.length > 0) {
    return { problem: `the prompt Claude wrote lacks ${missing.join(', ')}` }
  }
  if (readOnly && !prompt.includes(READ_ONLY_SENTENCE)) {
    return { problem: 'the prompt Claude wrote does not forbid modifying files' }
  }
  return { prompt }
}

export type ReviewArgs = {
  readOnly: boolean
  /** From `--quick`: send the built-in prompt without asking Claude to write one. */
  quick: boolean
  /** From `--model`, for this run only. */
  model?: string
  /** From `--effort`, for this run only. */
  effort?: string
  focus: string
  /** Set when a flag is malformed; the run must not start. */
  error?: string
}

const VALUE = /^[\w.:/-]+$/

/** Splits the command's arguments into its flags and the extra focus. */
export function parseArgs(args: string): ReviewArgs {
  const words = args.trim().split(/\s+/).filter((word) => word !== '')
  const result: ReviewArgs = { readOnly: false, quick: false, focus: '' }
  const focus: string[] = []
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!
    const [flag, inline] = word.startsWith('--') ? word.split(/=(.*)/s) : [word]
    if (flag === '--read-only') {
      result.readOnly = true
    } else if (flag === '--quick') {
      result.quick = true
    } else if (flag === '--model' || flag === '--effort') {
      const value = inline ?? words[++i]
      if (value === undefined || !VALUE.test(value)) {
        result.error = `${flag} needs a value, for example ${flag} ${flag === '--model' ? 'gpt-5.5' : 'high'}`
        return result
      }
      if (flag === '--model') result.model = value
      else result.effort = value
    } else {
      focus.push(word)
    }
  }
  result.focus = focus.join(' ')
  return result
}
