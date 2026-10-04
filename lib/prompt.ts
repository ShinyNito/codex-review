const FOCUS = `Focus: start with performance; remove duplicated validation, redundant state and duplicated tests; use modern idioms and do not hand-write what an imported package already provides; remove code that only forwards to something else; follow the conventions and layout of this project and of well-known open-source projects of the same kind.`

const REVIEW_STANDARD = `Review the whole diff independently; treat supplied context and focus as leads, not conclusions or limits. Ground findings in inspected code or verification results, and clearly distinguish hypotheses from confirmed problems.`

const FIX_REQUIREMENTS = `Review and fix the uncommitted changes in this workspace (visible in git status and git diff).

Goal: bring these changes to a state a human can review as-is, written in a standard, readable style that would fit a mature open-source project.
${FOCUS}
${REVIEW_STANDARD}

Scope: concentrate on these changes. Read surrounding code as needed to judge them, but only modify what relates to the changes.
Done when: supported problems are fixed and verified with the project's existing checks appropriate to the changes and their risks. You may edit related files, run those checks and fix failures caused by these changes without asking first. Report unrelated or blocked failures; broaden or repeat verification only when new changes, failures or unresolved concerns warrant it.
Leave anything that needs a product or architecture decision unchanged and note it in the report.

Finish with a short list: what you changed, why, what you actually verified and any limits, and what is left unresolved.`

const REPORT_REQUIREMENTS = `Review the uncommitted changes in this workspace (visible in git status and git diff). This is a read-only review: do not modify, create or delete any file.

Goal: tell the author what stands between these changes and a state a human can review as-is, written in a standard, readable style that would fit a mature open-source project.
${FOCUS}
${REVIEW_STANDARD}

Scope: concentrate on these changes. Read surrounding code as needed to judge them, and use the project's existing checks appropriate to the changes and their risks only if they do not write to the workspace. Broaden or repeat verification only when failures or unresolved concerns warrant it.
Done when: every problem you found is listed with its file and line, why it matters and the fix you would make, most important first.

Finish with that list, what you actually verified and any limits, then a one-line verdict: ready to merge, or what blocks it.`

/** The review instructions: fixing by default, report-only when `readOnly`; `focus` is appended. */
export function buildPrompt(focus: string, readOnly: boolean): string {
  const base = readOnly ? REPORT_REQUIREMENTS : FIX_REQUIREMENTS
  return focus === '' ? base : `${base}\n\nAdditional focus for this review: ${focus}`
}

/**
 * Asks Claude, which knows what the changes are for, to turn the review `requirements` into the
 * prompt Codex receives. The reply is sent to Codex as it stands.
 */
export function promptRequest(requirements: string): string {
  return `Write the prompt that Codex will receive to review the uncommitted changes in this workspace (git status, git diff). Codex cannot see this conversation, so include the relevant context you have: the intended behavior, constraints and what to leave alone. Keep that background compact, distinguish known facts from hypotheses, and present suspected risks as leads for Codex to verify. Tailor the prompt to these changes: put the areas that matter here first, name concrete files and risks only when supported by the available context, and leave out a requirement only when it cannot apply to them.

The requirements below come from the person running the review. Keep each one that applies, never weakened.

<requirements>
${requirements}
</requirements>

Write it the way the requirements are written: a goal, a scope and a completion bar, not a step-by-step recipe. Reply with only the prompt text: no preface, no commentary and no code fence around it. Do not edit files or start the review yourself: the codex-reviewer plugin sends your reply to Codex as it is.`
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
