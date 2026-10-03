# `lhr` CLI

What `packages/cli` builds: the `lhr` binary, including `lhr mcp`. It sits on the core library ([`core-api.md`](core-api.md)) and reads and writes the `.lhr/` tree ([`file-format-v2.md`](file-format-v2.md)). Design principles are in [ADR 0002](../adr/0002-cli-design.md), packaging in [ADR 0004](../adr/0004-repo-layout.md); terms follow `GLOSSARY.md`. The MCP tools are specified separately in `mcp.md`; this file only covers how `lhr mcp` starts.

Decisions that are still open are marked **[gap N]** and listed in [Open gaps](#open-gaps). Where this file says "core change needed", the core API doesn't offer it yet.

## Principles

- **Agents first.** Every command is non-interactive. `lhr` never prompts: a missing input is a usage error (exit `2`) with a correct example command.
- **Every input is a flag, an argument, or stdin.** `-` reads stdin, so agents never put multi-line markdown inside shell quotes.
- **Structured output.** `--json` on every command; stable exit codes.
- **Idempotent.** Resolving a resolved thread succeeds and does nothing. A retried write with the same `--client-id` is ignored.
- **`--dry-run`** on every write.
- **Layered `--help`** with copyable examples.

## Commands

| Command                                         | Purpose                                              |
| ----------------------------------------------- | ---------------------------------------------------- |
| `lhr init [path]`                               | Create `.lhr/` at a directory                        |
| `lhr inbox`                                     | Open, submitted threads where it is the agent's turn |
| `lhr thread list`                               | List threads                                         |
| `lhr thread show <id>`                          | Show one thread with its messages                    |
| `lhr thread create <path>[:<line>[-<end>]] [-]` | Start a thread                                       |
| `lhr thread reply <id> [-]`                     | Add a message to a thread                            |
| `lhr thread resolve <id> [-]`                   | Resolve a thread                                     |
| `lhr thread reopen <id> [-]`                    | Reopen a thread                                      |
| `lhr review submit --verdict <v> [-]`           | Submit the drafts as a review round (humans only)    |
| `lhr check`                                     | Validate the whole `.lhr/` tree                      |
| `lhr mcp`                                       | Run the MCP server on stdio                          |

- A bare `lhr` prints the top-level help to stdout and exits `0`. There is no interactive mode in Phase 2A.
- `lhr --version` prints the package version and a newline, and exits `0` **[gap 1]**.
- **Not in Phase 2A:** `review start` (dropped: drafts exist as soon as they're written), `review push` (Phase 4), `session *` and `doctor` (Phase 3), `migrate` (dropped; nothing to migrate). A bare interactive mode is Phase 4.
- Unknown commands and flags are usage errors (exit `2`, code `INVALID_INPUT`) and show the closest valid command or `see: lhr --help`.

ADR 0002's command list is superseded by this table: it adds `thread create` and `init`, and drops `review start`, `doctor` and `migrate` from Phase 2A.

## Global flags

Accepted by every command, before or after the subcommand.

| Flag                | Meaning                                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------------------- |
| `--repo <path>`     | Start path for review-root discovery (see below). Accepted by `lhr mcp` too.                            |
| `--json`            | Print the [JSON envelope](#json-output) on stdout instead of text. Not meaningful for `lhr mcp`.        |
| `--as human\|agent` | Override the identity mode (see [Identity](#identity)).                                                 |
| `--name <name>`     | Agent `author.name`. Only meaningful in agent mode **[gap 2]**.                                         |
| `--dry-run`         | Write commands only (`init`, `thread create\|reply\|resolve\|reopen`, `review submit`). Writes nothing. |
| `--help`, `-h`      | Help for the command at that level. Exits `0`.                                                          |
| `--version`         | Top level only.                                                                                         |

There is no `--quiet`, `--verbose` or colour flag. `--client-id <id>` is a per-command flag (see each command), not global.

Flags use `util.parseArgs` with `strict: true`. `--flag=value` and `--flag value` are both accepted. `--` ends flag parsing.

### Environment variables

| Variable                 | Meaning                                                                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `LHR_REPO`               | Start path when `--repo` is absent                                                                                                   |
| `LHR_SESSION_ID`         | Agent session ID. Its presence means the process is an agent. Exported by the plugin's `SessionStart` hook through `CLAUDE_ENV_FILE` |
| `LHR_AGENT_NAME`         | Agent `author.name` when `--name` is absent                                                                                          |
| `CLAUDE_CODE_SESSION_ID` | Read by `lhr mcp` only, as a fallback for `LHR_SESSION_ID`                                                                           |
| `NO_COLOR`               | Disables colour                                                                                                                      |
| `COLUMNS`                | Output width when stdout is not a terminal                                                                                           |

## Review root discovery

The **review root** is the nearest directory holding `.lhr/`, found by walking up. It isn't necessarily a git toplevel: a plain directory holding several repos can carry one `.lhr/` (decision: [how lhr finds the repository](https://github.com/pabloubal/local-hitl-review/issues/97)).

1. **Start path:** `--repo <path>` > `LHR_REPO` > the current directory.
2. **Walk up** from the start path to the first directory that contains `.lhr/`. The nearest wins, so a repo's own `.lhr/` shadows one in a parent workspace. Linked git worktrees each have their own `.lhr/`; target one by running inside it or passing `--repo <dir>`. There is no submodule or worktree special-casing.
3. **No `.lhr/` found:** exit `2`, code `NOT_A_REPO`. Reads never treat this as "empty", so a mistyped `--repo` can't look like "no feedback". The error's example is `lhr init --repo <start path>`.
4. The resolved review root is echoed in `--json` output (`data.root` on every successful response **[gap 3]**) and in error text.
5. A `.lhr/` that exists without a valid `format` file is `FORMAT_MISSING` or `FORMAT_VERSION` (exit `4`), not `NOT_A_REPO`.

Git handling for the root (non-git roots, nested repos, human `user.name`, `PATH_NOT_IN_REPO`) is a core concern: see [Non-git review roots](#non-git-review-roots).

### `lhr init [path]`

Creates `.lhr/format` (the text `2` and a newline) at exactly `path` (default: the start path). **It does not walk up.** It is the only command that creates `.lhr/`.

- Idempotent: if `.lhr/format` is already valid, it changes nothing and exits `0`.
- Also writes `.lhr/.gitignore` containing `drafts/`, so a later `git init` or an existing repo keeps drafts ignored.
- If an ancestor of `path` already has a `.lhr/`, the output says so (text: a `note:` line on stderr; JSON: `data.ancestor`) **[gap 4]**.
- `--dry-run` lists what it would create. `--json` supported.
- `path` doesn't exist: exit `2`, `INVALID_INPUT`.

```
$ lhr init
created .lhr/ in /work/app
$ lhr init
.lhr/ already exists in /work/app (nothing to do)
```

(Exact wording is part of the build ticket's tests; the first line states created or unchanged, then the absolute path.)

## Identity

Every write carries an `Author` (core-api § Writing). The CLI decides it once per invocation.

| Mode      | When                                     | `author`                                                                                          |
| --------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------- |
| **Agent** | `LHR_SESSION_ID` is set, or `--as agent` | `kind: agent`; `name` = `--name` > `LHR_AGENT_NAME` > `claude-code`; `session` = `LHR_SESSION_ID` |
| **Human** | otherwise, or `--as human`               | `kind: human`; `name` = `git config user.name` at the review root (core `humanAuthor()`)          |

- `--as` beats the environment. `--as agent` without `LHR_SESSION_ID` writes without `session` and prints a warning to stderr.
- Defaulting from the environment matters: an agent reply recorded as human would silently flip whose turn it is.
- **Agent mode never exposes drafts** (core `includeDrafts` is never passed). The CLI never passes `includeDrafts: true` in either mode.
- **Agent mode scopes `inbox`** to its session (below) and can't `review submit`.
- `/clear` in an agent session can leave `LHR_SESSION_ID` stale in a long-lived shell. Accepted: a stale nudge is harmless.
- `lhr mcp` has its own rule: `name` from the MCP `clientInfo.name`, `session` from `LHR_SESSION_ID`, falling back to `CLAUDE_CODE_SESSION_ID`, and no `session` recorded if neither is set. It always writes as an agent.

## Input conventions

- **Thread IDs.** A full ID or a unique prefix. Output prints the shortest unambiguous prefix beside the full ID **[gap 5]**. An ambiguous prefix is exit `2` (`INVALID_INPUT`) with the candidates listed in the message and a correct example. No match is exit `3` (`THREAD_NOT_FOUND`).
- **Bodies.** `-` (read stdin to EOF) or `--body <text>`, mutually exclusive. Giving both is exit `2`. A required body that is missing is exit `2` with an example. Bodies are markdown, stored as given. Reading `-` when stdin is a terminal is exit `2` instead of blocking **[gap 6]**.
- **Empty body** is an error on `reply` and `create`. It is allowed on `resolve` and `reopen`.
- **Severity values:** `critical`, `high`, `medium`, `low`. **Verdict values:** `approve`, `comment`, `request-changes`.
- **`--client-id <id>`** is a caller-chosen string, unique within a thread. Accepted by `thread create`, `thread reply` and `review submit`. The CLI never generates one.

## `lhr inbox`

The open, submitted threads where it is the agent's turn (core `inbox`). No filters.

- **Agent mode:** scoped to the current session (`LHR_SESSION_ID`): threads whose latest agent message came from that session, plus threads no agent has replied to yet. `--all-sessions` widens it. Without a session ID the scope is "all" and no warning is printed.
- **Human mode:** no session filter; `--all-sessions` is accepted and does nothing.
- Same output layout and JSON shape as `thread list` **[gap 7]**. Exit `0` even when empty (text: `0 threads in the inbox`).

```
lhr inbox
lhr inbox --all-sessions --json
```

## `lhr thread list`

Lists threads without message bodies.

| Flag                           | Meaning                                                                     |
| ------------------------------ | --------------------------------------------------------------------------- |
| `--status open\|resolved\|all` | Default `open`                                                              |
| `--whose-turn human\|agent`    | Filter by turn                                                              |
| `--path <p>`                   | Exact file path, or a directory prefix (`src/auth` matches `src/auth/x.ts`) |
| `--round <id>`                 | Threads with a message in that round (full round ID)                        |

Drafts are never included. Maps to core `threads(filter)`. Core `problems` go in `diagnostics` (JSON) or, in text, `N problems skipped; run lhr check` on stderr. Exit `0`.

```
lhr thread list
lhr thread list --whose-turn agent --path src/auth --json
```

## `lhr thread show <id>`

Shows one thread: header, re-anchored location, snippet, and every message in order. No flags beyond the global ones. Unknown ID: exit `3`.

```
lhr thread show 20261002T1015
lhr thread show 20261002T101500Z-k3m9qz --json
```

## `lhr thread create <path>[:<line>[-<end>]] [-]`

Starts a thread (core `createThread`). Written immediately, never part of a round; it becomes the human's turn and the writer is its reviewer.

- **Anchor:** `<path>:<line>` or `<path>:<line>-<end>` for a line thread, bare `<path>` for a file thread. Paths containing `:` use `--path <p> --line <n> [--end-line <n>]` instead (equivalent form). `line` and `end-line` are integers ≥ 1, `end ≥ line`.
- **Flags:** `--side new|old` (default `new`), `--base-commit <sha>` (required with `--side old`), `--severity <s>`, `--body <text>` or `-`, `--client-id <id>`, `--dry-run`. There is no `--text`: the anchor snapshot is always the file on disk.
- A relative `<path>` is resolved against the current directory and stored relative to the review root **[gap 8]**. A path outside the review root is a usage error (`INVALID_INPUT`, exit `2`). A path inside the root with no enclosing git repo is `PATH_NOT_IN_REPO` (exit `2`), as in `core-api.md`.
- **Idempotent** with `--client-id`: if any thread's opening message already has that `clientId`, the existing thread is returned with `created: false` and exit `0`.

```
lhr thread create src/auth/session.ts:42-47 --severity high - <<'EOF'
This returns the session after deleting it.
EOF
lhr thread create README.md --body "Document the new flags" --client-id readme-flags
```

## `lhr thread reply <id> [-]`

Adds a message to a thread (core `reply`). The body is required (`-` or `--body`). Flags: `--client-id`, `--severity`, `--dry-run`. There is no `--resolve` flag: use `thread resolve <id> -`.

- A `--client-id` the thread already has returns the existing message with `created: false`, exit `0`.
- **Human mode** may need a draft (`addDraftMessage`) rather than an immediate write **[gap 9]**.

```
lhr thread reply 20261002T1015 - <<'EOF'
Fixed in 3f2a9c1: expired sessions now return null.
EOF
```

## `lhr thread resolve <id> [-]` and `lhr thread reopen <id> [-]`

- **Without a body:** core `resolve()` / `reopen()`, an empty-bodied message with `status`. When the thread is already in that state, nothing is written: `created: false`, `changed: false`, exit `0`.
- **With a body** (`-` or `--body`): core `reply` with `status: "resolved"` (or `"open"`), so the comment and the status change are one message. `--client-id` is not offered on these commands; a body-carrying retry on an already-resolved thread still adds a message **[gap 10]**.
- `--dry-run` reports what would be written.

```
lhr thread resolve 20261002T1015
lhr thread resolve 20261002T1015 --body "Done in 3f2a9c1"
```

## `lhr review submit --verdict <v> [-]`

Submits every draft thread and message as one **review round** with a verdict, or a bare verdict when there are no drafts (core `submitRound`). Drafting stays in the extension.

- **Flags:** `--verdict approve|comment|request-changes` (required), `--summary <text>` or `-` (optional, default empty), `--client-id <id>`, `--dry-run`.
- **Agent mode fails** with exit `2` (`INVALID_INPUT`): rounds are submitted by a human reviewer. The error shows the exact command to run, with `--as human`. `--as human` bypasses it, since a human may run the CLI inside an agent shell.
- `--dry-run` lists the thread and message IDs that would be submitted, and writes nothing (not even `drafts/.submitting`).
- **Idempotent only with `--client-id`.** Core `submitRound` gains an optional `clientId`, stored on the round file; a repeat returns the existing round with `created: false`. Without it, a retry writes a second round, and the help says so. **Core change needed** (amends `core-api.md` and `file-format-v2.md`; see [Core changes this spec depends on](#core-changes-this-spec-depends-on)).

```
lhr review submit --verdict request-changes --client-id pr-42-r1 - <<'EOF'
Two blockers: session expiry and the missing migration.
EOF
lhr review submit --verdict approve --dry-run
```

## `lhr check`

Validates the whole tree, including `drafts/` (core `check()`), against file-format-v2 § Validation.

- Exit `0` when there are no errors (warnings allowed), `1` when there is at least one error, `2` on usage errors. This is the only command that exits `1`.
- **Text:** one line per diagnostic on stdout, `<severity> <code> <path>[:<line>] <message>`, then a summary `N errors, M warnings` **[gap 11]**.
- **JSON:** `data: { errors: <n>, warnings: <n> }`, with every diagnostic in `diagnostics`, whatever the exit code **[gap 11]**.

```
lhr check
lhr check --json
```

## `lhr mcp`

Runs the MCP server on stdio, for one review root. The tool set, schemas and `instructions` are specified in `mcp.md`. Startup rules that belong here:

- Accepts `--repo`. A multi-root workspace registers one `lhr mcp --repo <root>` per root. There is no `repo` tool argument.
- **Always starts**, even with no `.lhr/`. It resolves the review root on **each tool call** (a cheap walk-up) and keeps one `LhrTree` per resolved root, reloading the snapshot per call. With no `.lhr/` the tool returns an error that tells the user to run `lhr init`. **It never inits.**
- stdout carries only the MCP protocol. Diagnostics and warnings go to stderr.
- Identity: see [Identity](#identity). It disposes all trees when the server closes.
- Not offered over MCP: `check`, `review submit`, drafts, `init`, `session`, `--dry-run`, any author argument.

## JSON output

`--json` makes stdout one JSON object followed by a newline, never a bare array. stderr carries only human prose and warnings. Nothing but the JSON goes to stdout.

```json
{ "version": 1, "data": {}, "diagnostics": [] }
```

- `version` is an integer on every response, success and error. It is bumped only on breaking changes; additive fields don't bump it.
- `diagnostics` is always present: core `problems` verbatim (`severity, code, path, line?, message`).
- Timestamps are ISO-8601 UTC strings.
- Field names are camelCase and match core (`whoseTurn`, `clientId`, `startLine`).
- `data.root` is the resolved absolute review root **[gap 3]**.

### Thread object

Used by `thread list`, `thread show`, `inbox` and writes.

```json
{
  "id": "20261002T101500Z-k3m9qz",
  "shortId": "20261002T1015",
  "status": "open",
  "severity": "high",
  "whoseTurn": "agent",
  "reviewer": { "kind": "human", "name": "pablo" },
  "createdAt": "2026-10-02T10:15:00Z",
  "location": "src/auth/session.ts:42-47",
  "anchor": {
    "path": "src/auth/session.ts",
    "kind": "line",
    "side": "new",
    "startLine": 42,
    "endLine": 47,
    "state": "current",
    "method": "diff"
  },
  "messageCount": 2
}
```

- `location` is a ready-to-print `file:line[-end]` string. `anchor` holds the **re-anchored** values from core `anchors()`, not the saved ones. For an orphaned thread `startLine` and `endLine` are absent. File threads omit the line fields. The text forms for file threads, the `old` side and orphans are in § Human-readable output **[gap 12]**.
- `reviewer` is the core `Author`.
- `thread show` adds `snapshot` (the fenced snapshot body, line threads only), `savedStartLine` and `savedEndLine` when the anchor is not current **[gap 12]**, and `messages[]` `{ id, createdAt, author, body, round?, status?, severity? }`. It carries `messageCount` as well.
- `thread list` carries no message bodies.

### Per-command `data`

| Command                  | `data`                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------- |
| `thread list`            | `{ root, threads: Thread[] }` **[gap 13]**                                                        |
| `inbox`                  | `{ root, threads: Thread[] }` **[gap 13]**                                                        |
| `thread show`            | `{ root, thread: Thread }` **[gap 13]**                                                           |
| `thread create`          | `{ root, thread, message: { id }, created }`                                                      |
| `thread reply`           | `{ root, thread, message: { id }, created }`                                                      |
| `thread resolve\|reopen` | `{ root, thread, message: { id }?, created, changed }`; `message` absent when nothing was written |
| `review submit`          | `{ root, round: { id, verdict, threadIds, messageIds }, created }` **[gap 14]**                   |
| `check`                  | `{ root, errors, warnings }`                                                                      |
| `init`                   | `{ root, created, ancestor? }` **[gap 4]**                                                        |

- **Writes** return the affected object. A `--client-id` retry that hits an existing message returns the same payload with `created: false` and exit `0`.
- **`--dry-run`** returns the same shape with `dryRun: true`, IDs absent, nothing written.

### Errors

```json
{
  "version": 1,
  "error": {
    "code": "THREAD_NOT_FOUND",
    "message": "no thread matches \"01HX\"",
    "example": "lhr thread list --status open"
  }
}
```

`example` is a correct invocation, present when constructible. On error `diagnostics` is not included.

## Exit codes

| Exit | Meaning                                                         | Codes                                                                                                                                 |
| ---- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Success, including reads with diagnostics and idempotent no-ops |                                                                                                                                       |
| 1    | `lhr check` found errors (only)                                 |                                                                                                                                       |
| 2    | Usage error                                                     | `INVALID_INPUT`, unknown flag or command, missing argument, `NOT_A_REPO` (no `.lhr/`), `PATH_NOT_IN_REPO`, ambiguous thread-ID prefix |
| 3    | Not found                                                       | `THREAD_NOT_FOUND`, `MESSAGE_NOT_FOUND`, `DRAFT_NOT_FOUND`                                                                            |
| 4    | State conflict                                                  | `NOT_A_DRAFT`, `FORMAT_MISSING`, `FORMAT_VERSION`                                                                                     |
| 5    | Environment failure                                             | `GIT_FAILED`, `IO_FAILED`                                                                                                             |
| 130  | Interrupted (SIGINT)                                            | Nothing is printed beyond a newline; no partial JSON **[gap 15]**                                                                     |

`PATH_NOT_IN_REPO` is a new core code (decision [review root that isn't a git repo](https://github.com/pabloubal/local-hitl-review/issues/105)).

## Error text

Without `--json`, errors go to stderr:

```
error: no thread matches "01HX" (THREAD_NOT_FOUND)
  try: lhr thread list --status open
```

- First line: `error: <message> (<CODE>)`. Then an indented `try:` line with one copy-pasteable invocation, using the user's actual arguments where possible. Usage errors add `  see: lhr <cmd> --help`.
- Colour (`error:` in red) only when stderr is a terminal and `NO_COLOR` is unset.
- When the review root is known, errors that depend on it name it in the message.
- Each `LhrError` code has a fixed template: a message and a **structured example** (command plus arguments). The CLI renders the example as a command line; `mcp.md` renders the same structured example as a tool call (`thread_list {"status":"open"}`), because an MCP agent has no shell. One table in the implementation holds them. Required templates:

| Code                | Message                                              | Example (CLI rendering)                                          |
| ------------------- | ---------------------------------------------------- | ---------------------------------------------------------------- |
| `NOT_A_REPO`        | `no .lhr/ found from <start path>`                   | `lhr init --repo <start path>` (none over MCP: the user runs it) |
| `FORMAT_MISSING`    | `.lhr/ has no valid format file`                     | `lhr check`                                                      |
| `FORMAT_VERSION`    | `.lhr/ is format <n>; this lhr reads format 2`       | none                                                             |
| `THREAD_NOT_FOUND`  | `no thread matches "<id>"`                           | `lhr thread list --status all`                                   |
| `MESSAGE_NOT_FOUND` | `no message matches "<id>"`                          | `lhr thread show <thread id>`                                    |
| `DRAFT_NOT_FOUND`   | `no draft matches "<id>"`                            | `lhr thread list`                                                |
| `NOT_A_DRAFT`       | `<id> was already submitted and can't be changed`    | `lhr thread reply <thread id> -`                                 |
| `INVALID_INPUT`     | rule-specific (missing body, ambiguous prefix, ...)  | the command with the missing piece filled in                     |
| `PATH_NOT_IN_REPO`  | `<path> is not inside a git repository under <root>` | `lhr thread create <root-relative path>:1`                       |
| `GIT_FAILED`        | `git failed: <stderr first line>`                    | none                                                             |
| `IO_FAILED`         | `could not write <path>: <reason>`                   | none                                                             |

The wording of `FORMAT_*`, `NOT_A_DRAFT` and `*_NOT_FOUND` examples is a proposal for the build ticket to keep or adjust **[gap 16]**.

## Human-readable output

The reference renderer is the throwaway prototype on branch `prototype/thread-output` (`prototype/thread-output.mjs`; run `node prototype/thread-output.mjs list|show current|outdated|orphaned --width N`). Its layout is accepted ([decision](https://github.com/pabloubal/local-hitl-review/issues/101)). Fake data shapes aside, the build matches its output byte for byte, uncoloured. The prototype is not merged to `main`.

### Colour and width

- ANSI colour only when **stdout** is a terminal and `NO_COLOR` is unset. Piped output has the identical layout with no escape codes. There is no ASCII fallback: `─` and `│` stay.
- **Width:** terminal columns, else `COLUMNS`, else 80. Bodies wrap at width minus 2. Rules (`─`) cap at 100 columns.
- **Colours:** severity (critical bold red, high red, medium yellow, low dim); turn (`agent` cyan, `human` magenta); anchor marker `moved` yellow, `orphaned` red; status `open` green, `resolved` dim; headers, hints and the gutter dim; the short ID and the location bold.

### Thread list

First line (dim): `<N> open threads (status: open; --status all to widen)`, with the filter in words. A blank line, then the table, a blank line, and a dim hint `lhr thread show <id>   (unique prefix is enough)`.

**Wide (width ≥ 80):** a dim header row, then one row per thread. Columns, left-aligned:

| Column     | Width | Content                                                             |
| ---------- | ----- | ------------------------------------------------------------------- |
| `ID`       | 8     | Shortest unambiguous prefix, bold                                   |
| `SEV`      | 10    | `critical\|high\|medium\|low`, coloured                             |
| `TURN`     | 7     | `human` or `agent`, coloured                                        |
| `LOCATION` | rest  | The `location` string; truncated with `…` only if needed            |
| `ANCHOR`   | 10    | Blank when current, `moved` when outdated, `orphaned` when orphaned |
| `MSGS`     | 4+    | `messageCount`                                                      |

The `LOCATION` width is `width - 8 - 10 - 7 - 10 - 5`, minimum 20.

**Narrow (width < 80):** two lines per thread: `<id>  <severity>  <turn>  <anchor marker>` (trailing space trimmed), then the location indented two spaces. Locations are never cut mid-path (they are truncated at the end with `…` only if wider than the terminal).

No message bodies and no preview: the text list matches the JSON. Use `thread show` to read.

**Location strings** in the prototype: `path:line`, `path:start-end`, `path (file)` for file threads, and a ` (old)` suffix for the `old` side **[gap 12]**.

### Thread show

```
<short id><rest of id dim>  <status>  <severity>  turn: <turn>  reviewer: <name>
<location, bold>
! <anchor note, wrapped, only when the anchor is not current>
────────────────────────────────────────
  <snippet label>
> 42 │ <anchored line, bold>
  43 │ <context line, dim>
────────────────────────────────────────
<author> (<human|agent>)  <timestamp>  <round>, severity: <s>
  <body wrapped at width - 2>

lhr thread reply <short> -   |   lhr thread resolve <short>
```

- **Anchor note** (`!`-prefixed, coloured by state, wrapped at width - 2): for `outdated`, it states the saved line, the re-anchored line and the method, for example `anchor moved: saved at line 71, now line 88 (text-search).` For `orphaned`, it says the file or lines no longer exist at HEAD and that the snapshot is shown, for example `orphaned: src/old/legacy.ts no longer exists at HEAD. Showing the lines as they were when the comment was made (snapshot at 9ab01de).` The prototype also appends a free sentence (`Lines above were edited since this comment.`); the build need not **[gap 12]**.
- **Snippet:** a line-number gutter with `│`. `>` marks the anchored lines (bold); two lines of context each side (dim). The source is the working tree at the re-anchored lines; for orphaned threads it is the stored snapshot, labelled `snapshot <sha>` (otherwise `working tree`). Long lines are truncated with `…`. File threads have no snippet and no second rule.
- **Messages:** `<author name> (<kind>)` bold, a dim timestamp, then, when present, the round ID and `severity: <s>` joined by `, `. Body wrapped at width - 2 and indented two spaces, then a blank line. Messages are in name order. Timestamp format `YYYY-MM-DD HH:MM` **[gap 17]**.
- Closing dim hint with the reply and resolve commands.

## `--help` conventions

- Each level has help: `lhr --help` lists command groups and global flags; `lhr thread --help` lists the verbs; `lhr thread reply --help` lists arguments, flags and examples. `lhr <cmd> --help` goes to stdout and exits `0`. Usage errors print a one-line `see: lhr <cmd> --help` and never dump the full help to stderr.
- Per-command help sections, in this order: one-line summary, `Usage:`, `Arguments:`, `Flags:` (including the global ones that apply), `Examples:` (2 to 4 runnable lines, at least one using stdin for a write), `Exit codes:` only where a command has unusual ones (`check`), and `Notes:` for idempotency (`--client-id`) where it applies.
- The `review submit` help states that a retry without `--client-id` writes a second round.
- Help text is static; it never depends on repo state, and works outside a review root.
- Help is plain text: no colour, regardless of terminal.

## Packaging and bundling

Decision: [bundler and Node floor](https://github.com/pabloubal/local-hitl-review/issues/103).

- **Bundler:** esbuild, already a `devDependency` of `packages/vscode` (`^0.25.5`), so no new dependency. The CLI has its own `packages/cli/esbuild.mjs`, in the style of the extension's.
- **Build:** entry `packages/cli/src/main.ts`; `bundle: true`, `platform: 'node'`, `format: 'esm'`, `target: 'node20'`. Core is bundled from source with its JSON schemas inline. Not minified (readable stack traces matter more than 800 KB). A source map is emitted locally but not published. Output: one file, `dist/lhr.mjs`, starting with `#!/usr/bin/env node`, exec bit set. If a bundled CommonJS dependency needs `require`, add a `createRequire` banner; a built-binary test covers it.
- **Dependencies:** `@modelcontextprotocol/sdk` and `zod` are `devDependencies` (bundled), so the published package has **zero runtime dependencies**. Argument parsing is `util.parseArgs`; git is the `git` binary.
- **`packages/cli/package.json`:**

```json
{
  "name": "@pablou/lhr",
  "type": "module",
  "bin": { "lhr": "dist/lhr.mjs" },
  "files": ["dist/lhr.mjs"],
  "engines": { "node": ">=20" },
  "publishConfig": { "access": "public", "provenance": true }
}
```

- **Node floor `>=20`** (`parseArgs` is stable from 20). CI runs the CLI end-to-end tests on Node 20 and 22; that matrix change awaits maintainer approval.
- **Tests:** `node:test`, end-to-end against the built binary on real temporary git repos (ADR 0004). A smoke test runs `lhr --help` and an `lhr mcp` handshake on each supported Node.
- **Release** (decision [release pipeline](https://github.com/pabloubal/local-hitl-review/issues/107)): `npm publish` for `packages/cli` joins the existing `@semantic-release/exec` publish step after the `.vsix`, under one version, with npm trusted publishing and provenance. The package must exist on npm before trusted publishing can be linked, so the maintainer publishes once by hand first. The `ci-cd.yml` changes await maintainer approval. A failed publish after tagging is recovered by hand against the release tag.

## Non-git review roots

Behaviour the CLI relies on, owned by core (decision [review root that isn't a git repo](https://github.com/pabloubal/local-hitl-review/issues/105)):

- Repo membership is discovered per path: the nearest directory holding `.git` between the file and the review root; otherwise the enclosing repo of the root. `anchor.path` stays relative to the review root.
- The human author is `git config user.name` run at the root (global config in a non-git root); empty is an error.
- A non-git root's `.lhr/` is unversioned; `lhr init` writes `.lhr/.gitignore` for `drafts/`.
- A thread whose repo is gone is orphaned with a diagnostic; reads never throw.

## Core changes this spec depends on

- `submitRound` gains `clientId?` and returns `created`; the round file stores `clientId`; `check()` flags duplicates (amends `core-api.md` and `file-format-v2.md`).
- `openTree` accepts a review root that isn't a git toplevel and checks `.lhr/format`; `PATH_NOT_IN_REPO` added to `LhrError` codes (`core-api.md` updated: `Host.root` is the review root).
- `core-api.md` § Who writes as whom is corrected for the `LHR_SESSION_ID` contract (done on branch `worktree-wayfinder-98-agent-identity`).
- `GLOSSARY.md` gains **Review root**.

## Open gaps

Decisions missing from the closed tickets. Each needs a ruling before or during the build.

1. **`--version` output.** The release smoke test runs `lhr --version`, but no ticket defines its output. Proposed: the bare semver.
2. **`--name` in human mode** (and `--as human --name x`): ignore, or `INVALID_INPUT`?
3. **`data.root` in every JSON response.** Ticket 97 says the root is echoed in `--json` output; the envelope in ticket 100 has no slot for it. Proposed: `data.root`.
4. **`lhr init` output** text and JSON shape (including how an ancestor `.lhr/` is reported) are not specified; proposals above.
5. **Short-ID length.** Real IDs share a long timestamp prefix (`20261002T101500Z-k3m9qz`), so "shortest unambiguous prefix" can be 13+ characters, unlike the 6-character IDs faked in the prototype. Needs a minimum length and whether `shortId` is the shortest prefix or fixed.
6. **`-` with a terminal stdin.** Not stated; proposed exit `2` rather than blocking.
7. **`inbox` output.** Tickets 99/101 specify `thread list` and `thread show` only; assumed to reuse the list layout and JSON.
8. **Relative path base for `thread create`.** Cwd-relative converted to root-relative, or always root-relative? Matters when cwd is a repo below a workspace root.
9. **Human-mode `reply` and `create`.** Core's `reply`/`createThread` are immediate and for agents; humans normally use drafts (`addDraftMessage`, `createDraftThread`) that need a later `review submit`. Ticket 99 maps both commands to the immediate calls without saying what `--as human` does.
10. **Idempotency of `resolve|reopen` with a body.** No `--client-id` is offered, so a retried "resolve with comment" adds a second message.
11. **`lhr check` text and JSON shapes** are not specified; proposals above.
12. **Location and anchor forms not in the JSON decision:** file threads (`README.md (file)`), `old` side (`(old)` suffix) and orphans appear only in the prototype; `savedStartLine`/`savedEndLine` aren't in the thread object of ticket 100 but the "saved at line N" note needs them.
13. **`data` payload names** for lists and single threads (`threads`, `thread`) are not named in ticket 100 (only that arrays aren't bare).
14. **`review submit` payload** and its `--dry-run` output are not specified; proposal above.
15. **SIGINT** handling: only the exit code is decided.
16. **Error-template wording** for each code is not decided (ticket 100 requires the table; the wording and examples above are proposals).
17. **Timestamp rendering in `thread show`** (local time or UTC, and whether to show seconds) is not decided; the prototype's fake data uses `YYYY-MM-DD HH:MM`.
