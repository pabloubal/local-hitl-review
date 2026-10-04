# lhr verification map

This directory is the maintained source for verifying the user-facing behavior of the `lhr` CLI and `lhr mcp`. Read this index before driving, then use the matching feature file as the recipe. `SKILL.md` has the helper reference.

## Baseline preconditions

- `V=.claude/skills/verify-lhr/scripts/lhr-verify.mjs`, `export LHR_RUN="$TMPDIR/verify-lhr/$(date +%s)"`.
- `$V build && $V new && $V doctor` prints `"ok": true`. A fresh session has `README.md` and `src/app.ts` committed on `main`, an uncommitted `// TODO validate input` on line 2 of `src/app.ts`, an untracked `src/new.ts`, and **no** `.lhr/`.
- Use a new session (`$V new <name>`) per feature file. Recipes say when they need a submitted thread first; the set-up is spelled out in each.
- Human mode is the default; `--agent` switches a `run` to agent mode. The human's name in this harness is `Test Human`; the agent's is `verify-agent`.

## Driving conventions

- Chain steps with `&&`; `run` and `mcp` fail the chain on an unexpected exit.
- `sleep 1` between any two writes (see #155 in SKILL.md).
- Handles come from `thread create` output (`thread <4 chars>`); capture them into a shell variable: `T=$($V run -- thread create ... | sed -n 's/^thread //p')`.
- Read `.lhr/` through `$V tree`, never by editing it.
- Reset fixture source edits with `git -C "$($V path)" checkout -- src/app.ts` (restores the base file; the TODO line is part of the working-tree edit, so re-create the session when the exact fixture matters).

## Proof and skip reporting

- Capture the command, stdout, stderr and exit code (`run`/`mcp` do this) and the resulting `.lhr/` tree.
- Mutation proof includes a read-only second view (`thread show`, `thread list --json`, or MCP `thread_show`).
- Record the feature ID and entry point (CLI or MCP) with every artifact: name evidence `<feature>/<NN-step>`.
- Report an unreachable path with the command attempted and the unmet precondition. Do not report a CLI entry point as verification of the MCP one, or the reverse.

## Feature entry contract

Each feature file starts with an H1 and one paragraph, then exactly four H2s: `Sub-features`, `How to get to it (user POV)`, `Driving it with lhr-verify.mjs`, `Gotchas`.

## Features

Each feature also has CI scenarios in `packages/cli/test/scenarios-*.test.mjs` (see SKILL.md, "Also run in CI"); update both together.

- [Initialize and check a review store](./init-and-check.md): `lhr init`, `lhr check`, `--version`, `--help`.
- [Human review round](./human-review.md): creating draft threads, listing and showing them, `review submit`, retries, dry-runs.
- [Agent inbox loop](./agent-loop.md): `inbox`, `thread reply`, `resolve`, `reopen`, `--client-id` idempotency, agent-mode limits.
- [Anchors](./anchors.md): how a thread's location follows, outdates or loses its code; old-side and file-level threads.
- [MCP server](./mcp-server.md): `lhr mcp` over stdio, all seven tools, error results, missing store.
