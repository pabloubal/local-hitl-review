# Agent inbox loop

An agent works the reviewer's feedback: it lists the threads waiting on it (`inbox`), reads one, replies, resolves it when fixed, or reopens a thread it resolved. Retries are safe with `--client-id`. This is the CLI path; the MCP tools for the same loop are in [mcp-server](./mcp-server.md).

## Sub-features

- `inbox`: `lhr inbox` lists open, submitted threads where it is the agent's turn; `--all-sessions` widens to every agent session.
- `reply`: `thread reply <handle>` adds an agent message and hands the turn back to the human.
- `resolve`: `thread resolve <handle> [--body]` sets the thread `resolved` and records a closing message.
- `reopen`: `thread reopen <handle> [--body]` sets it open again.
- `idempotent-reply`: a repeated `reply --client-id X` reports `exists message <id>` and adds nothing.
- `agent-create`: an agent can start a thread itself (`thread create <path>:<line> --client-id X -`); it is submitted immediately (no draft), prints `created thread <handle>`, and a repeat prints `exists thread <handle>`.
- `identity`: an agent's messages are attributed to `LHR_AGENT_NAME` (here `verify-agent`) with its session id.
- `limits`: an agent cannot submit a review and cannot see drafts.

## How to get to it (user POV)

- An agent (or a developer in agent mode: `LHR_SESSION_ID` set) runs `lhr inbox`, `lhr thread show k3m9`, `lhr thread reply k3m9 -`, `lhr thread resolve k3m9 --body "Done in 3f2a9c1"`.

## Driving it with lhr-verify.mjs

Preconditions: baseline, `init`, and one submitted thread: `T=$($V run --stdin "Validate." -- thread create src/app.ts:2 - | sed -n 's/^thread //p') && sleep 1 && $V run -- review submit --verdict request-changes --summary s`, then `sleep 1`.

- **Inbox.** `$V run --agent --ev agent-loop/01-inbox -- inbox` prints `1 thread in the inbox` and a row `<T>  medium  agent  src/app.ts:2`. `--json` shows `"whoseTurn":"agent","isDraft":false`.
- **Reply.** `$V run --agent --ev agent-loop/02-reply --stdin "Added the guard." -- thread reply "$T" --client-id r1 -` prints `added message <ts>-agent-<rand> on thread <T>`. `$V run --agent -- inbox` now prints `0 threads in the inbox`; `$V run -- thread list` shows `TURN human`, `MSGS 2`.
- **Idempotent.** Repeat the same command: `exists message <same id> on thread <T>`, exit 0; `$V tree` shows one agent message file.
- **Show.** `$V run -- thread show "$T"` ends with `verify-agent (agent)  <date>` and `Added the guard.`.
- **Resolve.** `$V run --agent --ev agent-loop/03-resolve -- thread resolve "$T" --body "Done."`; `$V run -- thread list --status all` still lists it (TURN human) while `$V run -- thread list` (open only) prints `0 open threads`. `$V tree --ev agent-loop/after-resolve` shows the new `<ts>-agent-<rand>.md` message file with `status: resolved` in its frontmatter and the body `Done.`; a reopen writes `status: open` the same way.
- **Reopen.** `$V run --agent --ev agent-loop/04-reopen -- thread reopen "$T" --body "Not done after all."` then `$V run -- thread list` shows the thread again.
- **Identity.** `$V run --agent --agent-name other-agent --stdin x -- thread reply "$T" -`: `thread show` attributes the message to `other-agent`.
- **Agent-started thread.** `$V run --agent --stdin "Agent thread." -- thread create README.md --client-id c1 -` prints `created thread <handle>`; repeating prints `exists thread <handle>`; `$V run -- thread list` shows it without any `review submit`.
- **Limits.** `$V run --agent --expect 2 -- review submit --verdict approve` (refused, see [human-review](./human-review.md)). A draft created by the human after the submit stays out of `$V run --agent -- inbox` until the next submit.

## Gotchas

- Agent writes need no `sleep` between them: same-second messages are read back in write order (#155, fixed in 0.23.6). On an older build, `reopen` straight after `resolve` reports `resolved` with `changed:false`.
- `inbox` is scoped to the agent's session; a thread another session answered still shows with `--all-sessions`.
- A human `thread resolve`/`reopen` is a draft until `review submit` (see human-review); the agent versions apply immediately.
- Agent mode without `LHR_SESSION_ID` (`--as agent`) prints a warning and writes messages with no session; the harness always sets one.
