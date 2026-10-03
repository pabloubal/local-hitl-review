# `lhr mcp` server

The MCP server that ships inside the `lhr` binary (ADR 0002: one program). It gives a coding agent that has no shell the agent-side half of the CLI: read its inbox, read threads, reply, resolve, reopen and open threads. Decisions come from issues 102 (tool set), 95 and 98 (identity), 97 (review root), 100 (envelope and errors) and 105 (non-git roots). Shared details live in [`cli.md`](cli.md) (envelope, error codes, thread object) and [`core-api.md`](core-api.md); this file does not repeat them. Terms follow `GLOSSARY.md`. Gaps are collected in [Open gaps](#open-gaps) instead of being guessed.

## Process and transport

- Started as `lhr mcp [--repo <path>]`. Transport is **stdio** only: JSON-RPC on stdin/stdout. No HTTP transport.
- **stdout carries only protocol frames.** Logs and warnings go to stderr. Nothing else may write to stdout.
- The server **always starts**, even outside a review root. A missing `.lhr/` is reported per call (see [Root resolution](#root-resolution)), never at startup, so a misconfigured client still shows the tools and a useful error.
- The process exits when stdin closes. On exit it disposes every open `LhrTree`.
- Built with `@modelcontextprotocol/sdk` and `zod`, both bundled (zero runtime dependencies, Node `>=20`; issue 103).

## Server identity and capabilities

- `serverInfo.name`: `lhr`. Claude Code then namespaces tools as `mcp__lhr__<tool>`, which is why tool names carry no `lhr_` prefix. `serverInfo.version`: the `@pablou/lhr` package version.
- Capabilities: **`tools` only.** No `resources`, `prompts`, `logging`, `completions` or `tools.listChanged` (the tool set is fixed). No pagination (`thread_list` carries no bodies and `thread_show` is a single thread); revisit if lists get large.
- Does not use the client's `roots` capability. Roots come from `--repo`, `LHR_REPO` and cwd.
- `instructions`, returned at `initialize`, is this block (wording may be tightened, the five points may not be dropped):

  ```
  Review loop: inbox -> thread_show -> thread_reply or thread_resolve.
  Act on threads where whoseTurn is "agent".
  Pass clientId on thread_reply and thread_create so a retry is safe.
  You cannot submit reviews or see drafts.
  The user creates the review store; if a tool says there is no .lhr/, tell the user to run `lhr init`.
  ```

## Root resolution

One server serves **one review root** (issue 97). There is no `repo` tool argument. A multi-root workspace registers one `lhr mcp --repo <root>` per root.

- **Start path:** `--repo <path>`, else `LHR_REPO`, else the process cwd. Fixed at startup.
- **Per call:** the review root is resolved again on every tool call by walking up from the start path to the nearest directory holding `.lhr/`. The root need not be a git toplevel (issue 105). This is cheap, and it means an `lhr init` run while the server is up takes effect on the next call.
- **No `.lhr/` found:** an error result with code `NOT_A_REPO` (see [Errors](#errors)). The server never runs `init` and never creates `.lhr/`.
- **State:** one `LhrTree` is kept per resolved root, opened lazily on first use. Normally that is one tree. If the nearest `.lhr/` changes between calls (a nearer one appears), a second tree is opened for it and both are kept until exit.
- The resolved root is returned in every success envelope (see [Results](#results)).

## Snapshot semantics

- Each tool call calls `tree.load()` and works on that fresh immutable snapshot. Nothing is cached across calls, and the server does not watch files (`core-api.md` § Reading). Threads written by the human a moment ago are visible to the next call.
- A write is followed by a `load()` only to build its returned thread object, so the response reflects the write.
- Anchor state is computed per call, only for the threads in the response (`lhr.anchors` on the threads returned), and returned as the **re-anchored** values, never the saved ones.
- Drafts are never visible: no tool passes `includeDrafts`.

## Identity

The server always writes as `{ kind: "agent" }`. The caller cannot choose an identity: there is no `author` or `as` argument.

| Field            | Source                                                                                          |
| ---------------- | ----------------------------------------------------------------------------------------------- |
| `author.name`    | `LHR_AGENT_NAME`, else `clientInfo.name` from `initialize` (trimmed), else `mcp-agent`.         |
| `author.session` | `LHR_SESSION_ID`, else `CLAUDE_CODE_SESSION_ID`, read from the server's environment at startup. |

- **Name precedence: `LHR_AGENT_NAME` > `clientInfo.name` > `mcp-agent`.** `clientInfo.name` is the agent product (for example `claude-code`). An empty or whitespace-only value counts as absent, and a write is never rejected over the name. **Amendment to issue 98**, which gave only `clientInfo.name`: `LHR_AGENT_NAME` now also applies to `lhr mcp`, and `mcp-agent` is the fallback. There is no `--name` flag on `lhr mcp`.
- MCP gives a stdio server no session ID. Claude Code sets `CLAUDE_CODE_SESSION_ID` in the server subprocess; it equals the `session_id` the `SessionStart` hook sees, so it matches the ADR 0001 registry key. `LHR_SESSION_ID` is the variable the CLI uses and takes precedence when both are set.
- If neither variable is set, the write is recorded as an agent **with no `session`**. The server never fabricates one (no PID, no `Mcp-Session-Id`, no random UUID). Nudge routing then falls to ADR 0001 rule 2.
- The environment is read once, so after `/clear` in a long-lived process the session ID can be stale. This is accepted: a stale nudge is harmless.
- `inbox` scopes to this session by default (see below). With no session known it is unscoped.

## Common behaviour

- **Names** are `snake_case`; **arguments** are `camelCase`, matching the CLI's JSON.
- **`id`** accepts a full thread ID, a prefix of it, or a handle (4 to 6 characters of the random part; [ADR 0007](../adr/0007-thread-id-handles.md), rules in `cli.md` § Input conventions). An ambiguous handle or prefix is an `INVALID_INPUT` error whose message lists the candidates. Thread objects carry `shortId` (the handle) beside the full `id`.
- **Input validation** is zod, `.strict()` objects: unknown arguments are rejected. A validation failure is returned as an `INVALID_INPUT` tool error (not a JSON-RPC error). Verified against `@modelcontextprotocol/sdk` 1.32: the high-level `McpServer` turns a schema failure into an `isError` result whose text is a plain `Input validation error: ...` string, not our error object, and it always advertises `tools.listChanged`. The server therefore uses the low-level `Server`, publishes the zod schemas as JSON Schema (draft-07) itself, and validates arguments in its own `tools/call` handler.
- **`severity`** is `critical | high | medium | low`. **`side`** is `new | old`.
- **Bodies** are markdown strings, passed directly as the `body` argument (the CLI's stdin form has no meaning here). Empty `body` is `INVALID_INPUT` wherever `body` is required.
- **Annotations:** every tool sets `openWorldHint: false` and `destructiveHint: false`.

| Tool                                  | `readOnlyHint` | `idempotentHint`                                        |
| ------------------------------------- | -------------- | ------------------------------------------------------- |
| `inbox`, `thread_list`, `thread_show` | `true`         | (not set)                                               |
| `thread_resolve`, `thread_reopen`     | `false`        | `true`                                                  |
| `thread_reply`, `thread_create`       | `false`        | `false` (a retry is safe only with the same `clientId`) |

The server never generates a `clientId` itself.

## Results

On success, every tool returns:

- `structuredContent`: the CLI `--json` envelope **unchanged**, `{ version, data, diagnostics }` (shape in [`cli.md`](cli.md) § JSON output). `version` is the envelope integer, not the server version.
- `content`: one text block holding that same object, serialized once with the serializer shared with the CLI.
- An `outputSchema` per tool (zod), declaring the envelope with the tool's `data` shape.

Payloads (`data`), as defined in `cli.md` § Thread object:

- **Reads** return threads with `id, shortId, status, severity, whoseTurn, reviewer, createdAt, location` (`path:line[-end]`, `path (file)`, as in `cli.md`) and the re-anchored `anchor` (`path, kind, side, startLine, endLine, state, method`). The thread object, `location` and `shortId` come from the CLI's serializer and handle code, so they match `lhr ... --json` in agent mode byte for byte; handles are computed over submitted threads only. `thread_list` and `inbox` add `messageCount` and carry no bodies. `thread_show` adds `messages[]` and `snapshot`.
- **Writes** return the same `data` as the CLI (one shared serializer, see `cli.md` § Per-command `data`): `{ root, thread, message: { id }, created }` for `thread_create` and `thread_reply`, and `{ root, thread, message?, created, changed }` for `thread_resolve` and `thread_reopen`. `created: false` means a `clientId` retry hit an existing message; it is still a success. `thread` is the Thread object, including `shortId`.
- `diagnostics` holds core's `problems` verbatim on `inbox`, `thread_list` and `thread_show` (`severity, code, path, line?, message`). A tree with broken files is still a success. Write tools return `diagnostics: []` unless the pre-write load found problems.
- The resolved review root is included in `data` as `root` (absolute path), per issue 97 ("echoed in `--json` output"). List results are `{ root, threads }`; `thread_show` is `{ root, thread }`.

## Tools

### `inbox`

Open, submitted threads where it is the agent's turn, newest information first as returned by core.

- **Description guidance:** "Start here. Lists open review threads waiting for your reply. A thread leaves the inbox when an agent replies in it, not when it is read. By default only threads for your own session (plus threads no agent has answered yet) are shown."
- **Input:**
  ```ts
  z.object({ allSessions: z.boolean().optional() }).strict();
  ```
- **Behaviour:** calls `snapshot.inbox({ session })` with the server's session. `allSessions: true`, or no session known, calls it with no `session`.
- **Output `data`:** `{ root, threads }`, thread objects with `messageCount`, no bodies.

### `thread_list`

- **Description guidance:** "List review threads without message bodies. Use thread_show for the conversation. Defaults to open threads. Drafts are never listed."
- **Input:**
  ```ts
  z.object({
    status: z.enum(["open", "resolved", "all"]).default("open"),
    whoseTurn: z.enum(["human", "agent"]).optional(),
    path: z.string().optional(), // exact file or directory prefix, review-root relative
    round: z.string().optional(), // round ID
  }).strict();
  ```
- **Behaviour:** `status: "all"` omits the core `status` filter.
- **Output `data`:** `{ root, threads }`, thread objects with `messageCount`, no bodies.

### `thread_show`

- **Description guidance:** "Show one thread: every message, the code snapshot it was written against, and where that code is now (location and anchor state: current, outdated or orphaned). `id` may be a full ID, a prefix, or the short handle shown by `thread_list`."
- **Input:** `z.object({ id: z.string().min(1) }).strict()`.
- **Output `data`:** `{ root, thread }`, one thread object with `messages[] { id, createdAt, author, body, round?, status?, severity? }` and `snapshot`.

### `thread_create`

Opens a new thread to flag something the agent is unsure about. Written immediately, never part of a round; it becomes the human's turn and the agent is its reviewer.

- **Description guidance:** "Open a new thread on a file or line when you need a human decision. Omit `line` for a file-level thread. Always pass a `clientId` (any unique string) so a retried call does not create a duplicate. Use side `old` with `baseCommit` only to comment on deleted code."
- **Input:**
  ```ts
  z.object({
    path: z.string().min(1), // review-root relative
    line: z.number().int().positive().optional(), // absent: file-level thread
    endLine: z.number().int().positive().optional(), // requires line, >= line
    side: z.enum(["new", "old"]).optional(), // default "new"
    baseCommit: z.string().optional(), // required when side is "old"
    body: z.string().min(1),
    severity: z.enum(["critical", "high", "medium", "low"]).optional(),
    clientId: z.string().min(1).optional(),
  }).strict();
  ```
- **Behaviour:** structured arguments only; no `path:line` strings. Maps to `createThread` with `kind: "file"` when `line` is absent, else `"line"`. The server never passes `text` (unsaved content): the file on disk is anchored. `endLine` without `line`, `endLine < line`, `side: "old"` without `baseCommit`, or `endLine`/`side`/`baseCommit` on a file-level thread is `INVALID_INPUT`.
- **Output `data`:** `{ thread, message: { id }, created }`.

### `thread_reply`

- **Description guidance:** "Reply to a thread as the agent. Pass a `clientId` so a retry is safe. Replying passes the turn to the human. To also close the thread, use thread_resolve with a body."
- **Input:**
  ```ts
  z.object({
    id: z.string().min(1),
    body: z.string().min(1),
    clientId: z.string().min(1).optional(),
  }).strict();
  ```
- **Behaviour:** `reply(id, { body, author, clientId })` with no `status`.
- **Output `data`:** `{ thread, message: { id }, created }`.

### `thread_resolve`

- **Description guidance:** "Mark a thread resolved. With `body`, posts that text as a reply and resolves in one step. Resolving an already resolved thread succeeds and does nothing."
- **Input:** `z.object({ id: z.string().min(1), body: z.string().min(1).optional() }).strict()`.
- **Behaviour:** with `body`, `reply(id, { body, author, status: "resolved" })`; without, `resolve(id, author)`. Idempotent: an already-resolved thread succeeds with no new message.
- **Output `data`:** `{ root, thread, message?, created, changed }`, as in `cli.md`. When nothing was written (`changed: false`), `message` is absent and `created` is `false`.

### `thread_reopen`

- **Description guidance:** "Reopen a resolved thread. With `body`, posts that text and reopens in one step. Reopening an open thread succeeds and does nothing."
- **Input and behaviour:** as `thread_resolve`, with `status: "open"` and `reopen(id, author)`.
- **Output `data`:** as `thread_resolve`.

## Errors

A failure is a tool result with `isError: true`, never a JSON-RPC error. Its single text content block is the JSON object:

```json
{
  "version": 1,
  "error": {
    "code": "THREAD_NOT_FOUND",
    "message": "no thread matches \"01HX\"",
    "example": "thread_list {\"status\":\"open\"}"
  }
}
```

- **No `structuredContent` on errors.** Verified against SDK 1.32: the client skips the "must return structured content" check when `isError` is set, but validates any `structuredContent` it receives against the tool's `outputSchema`, even on an error result. An error object there would fail that check, so errors carry text content only.
- `code` is a stable `LhrError` code; `message` and the structured example come from the single template table in [`cli.md`](cli.md) § Errors. The CLI renders the example as a command (`lhr thread list --status open`); MCP renders it as `<tool> <json-arguments>`. An MCP error must never show an `lhr ...` command string, since the agent has no shell.
- The CLI exit-code table does not apply.
- **Protocol errors** (JSON-RPC) are used only for unknown tools and malformed requests handled by the SDK.

| Code                               | When here                                                                                                  | `example`                                                                                        |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `INVALID_INPUT`                    | schema failure, ambiguous ID prefix (candidates in `message`), empty `body`, inconsistent anchor arguments | a correct call for the same tool                                                                 |
| `NOT_A_REPO`                       | no `.lhr/` found walking up from the start path                                                            | **none**: tells the _user_ to run `lhr init` (message includes the start path); the agent cannot |
| `FORMAT_MISSING`, `FORMAT_VERSION` | `.lhr/format` unreadable or from a newer version                                                           | none                                                                                             |
| `THREAD_NOT_FOUND`                 | no thread matches `id`                                                                                     | `thread_list {"status":"open"}`                                                                  |
| `MESSAGE_NOT_FOUND`                | core reports a missing message                                                                             | as in `cli.md`                                                                                   |
| `PATH_NOT_IN_REPO`                 | `thread_create` path has no enclosing git repo (issue 105)                                                 | `thread_create {"path":"<root-relative path>","line":1}`                                         |
| `GIT_FAILED`, `IO_FAILED`          | environment failure                                                                                        | none                                                                                             |

`DRAFT_NOT_FOUND` and `NOT_A_DRAFT` cannot occur: no tool touches drafts.

## Deliberately not exposed

- `check`: reads already carry `diagnostics`; `check` is a CI tool.
- `review_submit` and anything draft-related: submitting needs a human author, and drafts are never visible to agents.
- `session_*` (list, send, resume): Phase 3, and agents must not start other agents (ADR 0001, ADR 0002).
- `init`: the server never creates `.lhr/`.
- `dry_run`: the client's permission prompt gates writes.
- `author` / `as` / `name` / `session` arguments: identity is fixed (see [Identity](#identity)).
- A `repo` / `root` argument: one server per review root.
- Resources, prompts, pagination (see [Server identity and capabilities](#server-identity-and-capabilities)).

## Client registration (informational)

```
claude mcp add lhr -- npx -y @pablou/lhr mcp
claude mcp add lhr-repo2 -- npx -y @pablou/lhr mcp --repo /path/to/root2
```

Packaging and plugin wiring belong to the release and plugin tickets.

## Testing notes

- A built-binary test performs the `initialize` handshake over stdio, lists the seven tools and checks `instructions`.
- Tool tests run against real temporary review roots (ADR 0004), including a non-git root and a root with no `.lhr/`.
- Cover: ambiguous prefix, schema failure becoming `INVALID_INPUT`, `clientId` retry returning `created: false`, `inbox` session scoping with and without `allSessions`, identity with each of the env var combinations, and a thread written between two calls being visible to the second.

## Open gaps

Each needs a decision or a doc fix.

4. **Thread object in write results.** Issue 100 does not say whether `thread` in `{ thread, message, created }` is the list-shaped object (with `messageCount`) or the show-shaped one. The first implementation returns the list-shaped object (no bodies); confirm when the CLI write commands land.
6. **`/clear` staleness** of the session variable in a long-lived process is accepted but untested (issues 95, 98). `CLAUDE_CODE_SESSION_ID` is documented only in a changelog (anthropics/claude-code#63305).
7. **Server `name` and `version`** are not stated in any issue; `lhr` is implied by the `mcp__lhr__` tool namespace and the package version is assumed.
8. **Concurrent calls and multiple trees.** Not specified: whether calls are serialized, and when to dispose a tree for a root that has gone away. This spec keeps all trees until exit and does not serialize reads.
9. **`ThreadFilter.path`** semantics ("exact or directory prefix", issue 99) are not yet in `core-api.md`.

### Resolved

Covered by `cli.md`, `core-api.md` and ADR 0002 now on `main`: identity wording in `core-api.md` (issue 98), `NOT_A_REPO` without an `example`, the no-op write payload (`message` absent, `created: false`, `changed: false`), list `data` shape with `root`, `PATH_NOT_IN_REPO` and non-git roots (issue 105), and ADR 0002's command list.

**Gap 5, schema failures and error results**, verified against `@modelcontextprotocol/sdk` 1.32 while building the server (issue 127): the high-level server reports schema failures as plain-text `isError` results, so the server validates arguments itself and returns `INVALID_INPUT` (see [Common behaviour](#common-behaviour)); the server skips `outputSchema` validation for `isError` results, but the client validates any `structuredContent` present, so error results carry text content only (see [Errors](#errors)).

Accepted by the maintainer: **gap 3, agent name fallback.** The name is `LHR_AGENT_NAME` > `clientInfo.name` (trimmed) > `mcp-agent`; a write is never rejected over the name; there is no `--name` flag on `lhr mcp`. This amends issue 98 (see § Identity).
