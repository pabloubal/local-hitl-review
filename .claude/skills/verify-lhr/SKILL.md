---
name: verify-lhr
description: Drive the built `lhr` CLI and its `lhr mcp` stdio server in throwaway git repos (human review flow, agent inbox/reply/resolve loop, anchors, MCP tools) and capture transcripts plus the on-disk `.lhr/` tree as proof. Use to verify a change to packages/cli or packages/core works the way a human reviewer and an agent experience it, beyond unit tests.
---

# Verify `lhr` (CLI and MCP server)

`lhr` is a zero-dependency Node binary (`packages/cli/dist/lhr.mjs`, built by esbuild). A human uses it to start review threads and submit a round; an agent uses it, or `lhr mcp` over stdio, to read the inbox, reply, resolve and reopen. Everything durable lives in `.lhr/` inside the reviewed repo (markdown files). There is no server to keep alive and no UI: each drive builds a throwaway git repo (a **session**), runs real `lhr` processes in it, and reads `.lhr/` back as the second view.

The VS Code extension is a different surface; use `verify-hitl-review` for it. The two share `packages/core`, so a core change needs both.

## Helper

`V` is the harness. Run all commands from the repo root. It has no dependencies and needs Node 20.11 or later.

```bash
V=.claude/skills/verify-lhr/scripts/lhr-verify.mjs
export LHR_RUN="$TMPDIR/verify-lhr/$(date +%s)"   # one dir per run; defaults to .../current
```

| Command                          | Does                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `$V build`                       | `npm run build -w @pablou/lhr`, then prints the built version.                                                                                                                                                                                                                                                                                                                                                           |
| `$V new [name]`                  | New session: a git repo with `README.md` and `src/app.ts` committed on `main` (base), plus an uncommitted edit (`// TODO validate input` on line 2 of `src/app.ts`) and an untracked `src/new.ts`. Does **not** run `lhr init`; that is a feature to drive. Prints `{"session","repo"}` and makes it the _current_ session; pass `--session <name>` to `run`, `mcp`, `tree`, `path`, `doctor` when more than one exists. |
| `$V path [--session s]`          | Print the session repo path (for reading files or editing the fixture).                                                                                                                                                                                                                                                                                                                                                  |
| `$V doctor [--session s]`        | Read-only. JSON; exit 0 only when the binary is worth driving.                                                                                                                                                                                                                                                                                                                                                           |
| `$V run [opts] -- <lhr args>`    | One `lhr` call in the session, in a hermetic environment. Prints stdout, stderr, `[exit N]`. Exits 0 only if the exit code equals `--expect` (default 0).                                                                                                                                                                                                                                                                |
| `$V mcp [opts] <script.json\|->` | Start one `lhr mcp` server, run a script of JSON-RPC steps against it, close it, assert it exits 0 on stdin EOF.                                                                                                                                                                                                                                                                                                         |
| `$V tree [--ev name]`            | Print every file under the session's `.lhr/` with contents; with `--ev`, copy it to evidence.                                                                                                                                                                                                                                                                                                                            |
| `$V stop`                        | Delete sessions and run state, terminate any MCP server this harness started (by recorded pid), keep evidence.                                                                                                                                                                                                                                                                                                           |

`run` options: `--agent` (agent mode: sets `LHR_SESSION_ID=verify-agent-session`, `LHR_AGENT_NAME=verify-agent`; override with `--agent-session`, `--agent-name`), `--stdin "<text>"` (for the `-` body argument), `--expect N`, `--ev <name>` (save this call to `evidence/<name>.txt`), `--session <name>`.

`mcp` options: `--agent-name`, `--agent-session`, `--no-session` (server sees no session id), `--ev <name>` (writes `<name>.txt` and the full JSON-RPC log `<name>.json`), `--session`. A script is a JSON array of steps: `{"method":"tools/list"}`, `{"call":"<tool>","args":{...}}`, `{"sleep":1100}`. A call may carry `"save":{"tid":"data.threads.0.shortId"}` (later strings `$tid` are substituted), `"expectError":true` and `"expectCode":"THREAD_NOT_FOUND"`. Ready-made scripts: `scripts/mcp-all-tools.json` (all seven tools; needs one submitted thread in the session) and `scripts/mcp-no-store.json` (no `.lhr/`).

## Launch

```bash
$V build && $V new && $V doctor
```

- **Built from this checkout.** The binary is `packages/cli/dist/lhr.mjs`; `npm run build -w @pablou/lhr` produces it in about 2 seconds. `node_modules` must exist (`npm ci` at the repo root). The harness never uses a globally installed `lhr`.
- **Session = unit of isolation.** Each `new` makes a fresh repo under `$LHR_RUN/sessions/<name>`. Sessions never share state, so any number can exist side by side, and two runs with different `LHR_RUN` values are fully independent. Start a new session for each feature file.
- **Hermetic environment.** Every call gets a fixed git identity (`GIT_CONFIG_GLOBAL` with `user.name = Test Human`, system config off), `NO_COLOR=1`, and has `FORCE_COLOR`, every `LHR_*` variable and `CLAUDE_CODE_SESSION_ID` removed. Human mode is "no `LHR_SESSION_ID`"; agent mode is "set". Without this, a drive run from inside Claude Code would act as an agent with the host's session id, and a CI-like host with no git identity would fail differently from yours.
- **Ready** = `doctor` prints `"ok": true`.

## Doctor

Run `$V doctor` before the first drive of a session and again after any drive that surprised you. It requires:

- `node`: 20 or later.
- `binExists` and `version`: `dist/lhr.mjs` exists and `--version` equals `packages/cli/package.json`.
- `buildFresh`: the binary is newer than every file in `packages/cli/src` and `packages/core/src`. If false, run `$V build`; a stale binary would verify old code.
- `session` and `fixtureBranch`: the session repo exists and is on `main`.
- `check`: once `.lhr/` exists, `lhr check` exits 0. This fails on purpose after a recipe corrupts a file; start a new session.
- `noStrayMcp`: no MCP server this harness started is still alive.

## Drive

Recipes for each feature are in [`features/`](features/README.md). Read the index first.

- **Chain with `&&`.** `run` and `mcp` exit non-zero on an unexpected exit code or error, so a chain stops at the first surprise.
- **Act through the CLI or MCP only.** Never write `.lhr/` files by hand to stand in for a command. The only allowed direct edits are to the fixture's source files (to move or break an anchor) and, in the recipe that says so, deliberate corruption to prove `check` fails.
- **Same-second writes mis-order (#155).** Message IDs have one-second resolution and sort by a random suffix within a second, so two writes inside one second can be read back in the wrong order (a `thread_reopen` right after `thread_resolve` once returned `resolved`). Put `sleep 1` between writes in CLI recipes (the MCP scripts carry `{"sleep":1100}` steps). A recipe whose result changes with the sleep is exercising #155, not the feature.
- **Drafts are human-only.** A human `thread create`/`reply` saves a draft that agents cannot see until `review submit`. Submit before switching to `--agent`.
- **Handles.** `thread create` prints a 4-character handle (`thread 43pg`). Pass it, a longer prefix, or the full ID to later commands; agent mode resolves handles among submitted threads only.
- **Exit codes.** 0 ok, 1 `check` found errors, 2 usage/invalid input, 3 not found, 4 conflict, 5 environment. Pass `--expect N` for negative cases.
- **Two output forms.** Text for people; `--json` prints `{"version":1,"data":...,"diagnostics":[]}` or `{"version":1,"error":{"code","message","example"}}`. MCP results carry the same envelope in `content[0].text` and `structuredContent`.

## Evidence

Everything goes to `$LHR_RUN/evidence/`. `run` and `mcp` append every call to `evidence/transcript.log` automatically; `--ev <feature>/<NN-step>` additionally saves a call as its own file.

- **Show the action and the result.** For a mutating call, save the call itself (`--ev`) and the state afterwards (`$V tree --ev <feature>/after`). The `.lhr/` files are the durable proof: `thread.md` frontmatter plus one markdown file per message.
- **Check the second view.** After a write, read it back through a different command (`thread show` / `thread list --json` / MCP `thread_show`) and, for human drafts, assert agents cannot see them.
- **Real user path only.** Use the commands a human or agent would type. Do not call core APIs, `__debug`, or hand-write `.lhr/` files.
- **Dry-runs.** `--dry-run` is verified by counting files under `.lhr/` before and after, not by trusting its name.
- **Negative cases count.** Capture at least one expected failure per feature (`--expect 2` / `3`) with its error code and the `try:` line.

## Cleanup

```bash
$V stop
ls "$LHR_RUN/evidence"   # proof survives
```

`stop` removes sessions, state and the hermetic git config, and terminates only MCP pids it recorded. The CLI itself has no background processes. The evidence directory is never deleted by the harness; remove it yourself when you no longer need it. Run `stop` after a failed attempt too.

## Also run in CI

The same flows exist as scenario tests in `packages/cli/test/scenarios-*.test.mjs` (shared fixtures in `scenario-helper.mjs`), which `npm test` runs on every PR with no workflow change:

| Feature file                     | Scenario file                |
| -------------------------------- | ---------------------------- |
| `init-and-check`, `human-review` | `scenarios-review.test.mjs`  |
| `agent-loop`                     | `scenarios-agent.test.mjs`   |
| `anchors`                        | `scenarios-anchors.test.mjs` |
| `mcp-server`                     | `scenarios-mcp.test.mjs`     |

When you change a recipe, change its scenario in the same PR, and the reverse. The scenarios assert; this skill produces the evidence a human can read. #155 is a `todo` test in `scenarios-agent.test.mjs`: remove `todo` when core is fixed. The Playwright `e2e` job covers the VS Code extension only.
