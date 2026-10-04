# MCP server

`lhr mcp` runs a Model Context Protocol server on stdio for one review root. An MCP client (an agent harness) gets seven tools covering the same loop as the CLI: `inbox`, `thread_list`, `thread_show`, `thread_create`, `thread_reply`, `thread_resolve`, `thread_reopen`. The server cannot submit reviews or see drafts; if there is no `.lhr/` it tells the client to ask the user to run `lhr init`.

## Sub-features

- `mcp-handshake`: `initialize` answers `serverInfo.name: "lhr"` with the package version and `capabilities: {"tools":{}}`; `instructions` describe the review loop.
- `mcp-tools-list`: `tools/list` returns exactly the seven tools above.
- `mcp-read`: `inbox`, `thread_list` (`status`, `whoseTurn`, `path`, `round`), `thread_show` return the CLI's envelope with `structuredContent`.
- `mcp-write`: `thread_create`, `thread_reply`, `thread_resolve`, `thread_reopen` write to `.lhr/` and return `{thread, message, created}` (`changed` for resolve/reopen).
- `mcp-idempotent`: a repeated `thread_reply` with the same `clientId` returns `created:false` and the same message id.
- `mcp-errors`: failures are `isError:true` results with `{code, message, example}` (`THREAD_NOT_FOUND`, `INVALID_INPUT`, `NOT_A_REPO`); the example is a tool call, not a shell command.
- `mcp-identity`: the author name is `LHR_AGENT_NAME`, else the client's `clientInfo.name`, else `mcp-agent`; the session is `LHR_SESSION_ID`, else `CLAUDE_CODE_SESSION_ID`.
- `mcp-shutdown`: closing stdin ends the server with exit 0.

## How to get to it (user POV)

- An MCP client config runs `lhr mcp` (optionally `--repo <path>`); the agent calls the tools by name.

## Driving it with lhr-verify.mjs

Preconditions: baseline, `init`, one submitted thread: `$V run --stdin "Validate." -- thread create src/app.ts:2 - && sleep 1 && $V run -- review submit --verdict request-changes --summary s && sleep 1`.

- **All seven tools.** `$V mcp --ev mcp-server/01-all-tools .claude/skills/verify-lhr/scripts/mcp-all-tools.json` prints, for each step, `OK`, and finally `server exit: code 0 OK (closed on stdin EOF)`. Expect: step 1 `7 tools: inbox, thread_list, thread_show, thread_create, thread_reply, thread_resolve, thread_reopen`; the first `thread_reply` has `created:true` and `whoseTurn:"human"`, the repeat `created:false` with the same message id; `thread_create` returns a thread whose `reviewer` is `{"kind":"agent","name":"verify-lhr","session":"verify-mcp-session"}` (name from `clientInfo`); `thread_resolve` returns `status:"resolved"`; `thread_reopen` returns `status:"open"`; the two negative steps print `OK isError=true (expected error THREAD_NOT_FOUND)` / `INVALID_INPUT`.
- **Second view on disk.** `$V tree --ev mcp-server/after-all-tools` shows `agent-` message files under the thread and a new thread directory for the agent-created one. `$V run -- thread list --status all` (CLI) lists both threads, one `TURN human`.
- **Identity.** `$V mcp --agent-name named-agent --agent-session sess-9 <script with a thread_reply>` attributes the message to `named-agent` with `author.session: sess-9`; with `LHR_AGENT_NAME` unset and no `--agent-name` it is `verify-lhr` (the client name).
- **No session.** `--no-session` makes the author carry no `session`: verified with `--agent-name nosess`, the message file has `author.kind: agent` and `author.name: nosess` and no `author.session`.
- **No store.** In a new session without `init`: `$V mcp --ev mcp-server/02-no-store .claude/skills/verify-lhr/scripts/mcp-no-store.json` prints `OK isError=true (expected error NOT_A_REPO)` whose message tells the client to ask the user to run `lhr init`.
- **Dry check of the contract.** `tools/list` in `evidence/mcp-server/01-all-tools.json` has `inputSchema` and `annotations` per tool: the read tools `readOnlyHint:true`; every tool `destructiveHint:false`.

## Gotchas

- Exercise the server only through `$V mcp`; piping JSON into `lhr mcp` by hand misses the handshake and the exit assertion.
- The script's `save` map pulls fields from `structuredContent`; a failing path leaves `$tid` unsubstituted, and the next call fails `INVALID_INPUT`. Read the step output before the later steps.
- The server caches the tree per review root for its lifetime. Whether a CLI write made while it runs is seen on the next tool call is _(unverified live)_.
- Same-second writes mis-order (#155): the script sleeps 1.1 s between writes. Remove a sleep and `thread_reopen` after `thread_resolve` returns `resolved`/`changed:false`; that is the bug, not a regression in the tool.
- The server writes nothing to stdout except JSON-RPC; a stray log line on stdout would break clients, and the harness would report a JSON parse error.
