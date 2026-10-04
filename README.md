# codex-reviewer

A Claude Code mod that reviews the current changes with `codex exec` and shows live progress in a pane.

## Usage

```
/codex-review [--quick] [--read-only] [--model <name>] [--effort <level>] [extra focus]
```

By default Claude writes the prompt Codex receives:

1. The command sends Claude a request that embeds the built-in review requirements (plus any extra focus you typed), word for word.
2. Claude, which knows what the changes are for, rewrites them for these changes: the areas that matter first, concrete files and risks named, no requirement weakened.
3. Its reply goes to Codex as it stands, with nothing added or spliced in. You can read it in the conversation.

While waiting, the next completed main-conversation answer goes directly to Codex. Interrupted or failed turns and rejected submissions do not start a review; a toast explains why.

`--quick` skips Claude and sends the built-in prompt straight away.

`--read-only` runs Codex in the `read-only` sandbox with a prompt that only reports findings (file, line, why, the fix it would make) and a merge verdict, so nothing in the working tree changes.

`--model` and `--effort` switch the model and the reasoning effort for this run only (`/codex-review --model gpt-5.5 --effort high`). Without them the `model` option and then `~/.codex/config.toml` apply. Both accept `--flag value` or `--flag=value`.

- The pane does not open by itself. A band above the prompt carries the review: status, elapsed time, commands and files changed (with `+added −deleted` lines), the model with its reasoning effort, and, while it runs, the command Codex is executing right now. Its keys: `o` opens the full pane (running or finished), `c` cancels a running review, `x` hides the band after it ends. On a narrow terminal the model drops out first. Running `/codex-review` during a review also opens the pane.
- Files changed are read from Git, not from Codex's own report: the mod snapshots `git diff HEAD --numstat` and the untracked files at the start, batches refreshes after completed commands or edits within 100 ms, and reads a final snapshot at the end. Slow Git reads are serialized with at most one refresh queued.
- Runs `codex exec --json --ephemeral -s workspace-write` (`-s read-only` with `--read-only`) in the session's working directory, which must be a Git repository.
- Lets Codex fix what it finds (unless `--read-only`). The built-in prompt, which Claude starts from and `--quick` sends as it is, states the goal, the focus areas (performance first, no duplicate checks or state, no hand-written forwarding or reimplemented library features, the conventions of the project and of well-known open-source projects like it), the scope, and a completion bar (fixed and verified with the project's own checks) instead of a step-by-step recipe, following OpenAI's [GPT-6 Astra prompting guidance](https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra). Anything after the command is appended to it as extra focus.
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
| `hooks/register.tsx` | Host calls, command and turn lifecycle, the `codex exec` stream and state updates |
| `components/review.tsx` | The status band and progress pane |
| `lib/prompt.ts` | Review instructions, the prompt request and command arguments |
| `lib/review.ts` | Event parsing, Git snapshots and progress reducers |
| `lib/constants.ts` | Shared command, pane and animation constants |
| `types/index.d.ts` | Contract for the `$.state` values the pane reads |
| `tests/` | Prompt and reducer tests, plus command, streaming, cancellation and rendering regressions |

Host calls (`$`) and state sources stay in the hooks module so the SDK can validate them statically. Components receive resolved elements and callbacks. The SDK's JSX fragment creates a `Box`, so inline groups inside `Text` also use `Text`.

## Community

Shared on [LINUX DO](https://linux.do/), where feedback is welcome.

## License

[MIT](LICENSE)
