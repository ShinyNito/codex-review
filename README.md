# codex-reviewer

A Claude Code mod that reviews the current changes with `codex exec` and shows live progress in a pane.

## Usage

```
/codex-review [--read-only] [--model <name>] [--effort <level>] [extra focus]
```

`--read-only` runs Codex in the `read-only` sandbox with a prompt that only reports findings (file, line, why, the fix it would make) and a merge verdict, so nothing in the working tree changes.

`--model` and `--effort` switch the model and the reasoning effort for this run only (`/codex-review --model gpt-5.5 --effort high`). Without them the `model` option and then `~/.codex/config.toml` apply. Both accept `--flag value` or `--flag=value`.

- The pane does not open by itself. A band above the prompt carries the review: status, elapsed time, commands and files changed (with `+added −deleted` lines), the model with its reasoning effort, and, while it runs, the command Codex is executing right now. Its keys: `o` opens the full pane (running or finished), `c` cancels a running review, `x` hides the band after it ends. On a narrow terminal the model drops out first. Running `/codex-review` during a review also opens the pane.
- Files changed are read from Git, not from Codex's own report: the mod snapshots `git diff HEAD --numstat` and the untracked files at the start, compares again each time Codex finishes a step and at the end, and counts the files that differ.
- Runs `codex exec --json --ephemeral -s workspace-write` (`-s read-only` with `--read-only`) in the session's working directory, which must be a Git repository.
- Sends a built-in review prompt and lets Codex fix what it finds (unless `--read-only`). The prompt states the goal, the focus areas (performance first, no duplicate checks or state, no hand-written forwarding or reimplemented library features, the conventions of the project and of well-known open-source projects like it), the scope, and a completion bar (fixed and verified with the project's own checks) instead of a step-by-step recipe, following OpenAI's [GPT-6 Astra prompting guidance](https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra). Anything after the command is appended as extra focus.
- The pane adds the detail: a model, focus and work ledger and the last few Codex actions. Cancel kills the Codex process.
- When Codex exits there is nothing to poll: a toast appears and its final report is handed back to Claude to summarize.

## Options

Set in `/config`, under `codex-reviewer`:

| Option | Default | Effect |
| --- | --- | --- |
| `model` | empty | Passed to `codex exec -m`. Empty uses the model from `~/.codex/config.toml` (or `$CODEX_HOME/config.toml`). |

The pane shows the option when set, otherwise the top-level `model` and `model_reasoning_effort` from that config. Values under `[profiles.*]` are not read.

## Requirements

- [Codex CLI](https://github.com/openai/codex) on `PATH` and logged in.
- Codex runs in the `workspace-write` sandbox and cannot ask for approvals, so commands outside the sandbox are refused.

## Install

From GitHub, for every project:

```sh
claude plugin marketplace add ShinyNito/codex-review
claude plugin install codex-reviewer@codex-review --scope user
```

`codex-review` is the marketplace name and `codex-reviewer` the plugin. To update later, run `claude plugin marketplace update codex-review`.

From a local clone, for development:

```sh
claude plugin marketplace add /path/to/codex-review
claude plugin install codex-reviewer@codex-review --scope user
```

For one session only:

```sh
claude --plugin-dir /path/to/codex-review
```

After editing, run `/reload-plugins`.

## Development

```sh
claude plugin validate --strict .
claude plugin test .
npx --package typescript tsc --noEmit
```

| Path | Purpose |
| --- | --- |
| `hooks/register.tsx` | The command, the `codex exec` stream and the progress pane |
| `lib/review.ts` | Review instructions, event validation, Git change tracking and progress state updates |
| `types/index.d.ts` | Contract for the `$.state` values the pane reads |
| `tests/review.test.tsx` | Command, streaming, failure and rendering tests |

## Community

Shared on [LINUX DO](https://linux.do/), where feedback is welcome.

## License

[MIT](LICENSE)
