# Core library API

What `packages/core` exports for the extension, the `lhr` CLI and `lhr mcp`. The core is private and bundled into each client (ADR 0004), so this API can change freely. It only has to be precise enough to start implementing. Field names and file rules come from [`file-format-v2.md`](file-format-v2.md); terms follow `GLOSSARY.md`.

## Opening a tree

```ts
openTree(host: Host): Promise<LhrTree>

interface Host {
  root: string; // review root (the directory holding .lhr/); not necessarily a repo
  now?: () => Date; // default: () => new Date()
  random?: () => string; // 6 chars from [a-z2-7]; default: crypto
  gitPath?: string; // default: "git" on PATH
}
```

- **Review root.** `openTree` checks for `.lhr/format` at `root` instead of requiring it to be a repo toplevel (`FORMAT_MISSING` otherwise). Repo membership is discovered per path: walk up from the file to `root` and use the nearest directory holding `.git` (a directory or a worktree file). If none is nearer and `root` sits inside a larger repo, that enclosing repo (`rev-parse --show-toplevel` at `root`) is used, and core converts root-relative paths to toplevel-relative ones for repo calls. A submodule is its own repo. `anchor.path` stays relative to `root`; `commit` and `blob` are per-repo SHAs. A path with no enclosing repo throws `PATH_NOT_IN_REPO`.
- The core uses Node `fs` and the `git` binary directly. Only the clock, the random source and the git path are injected, so tests can pin IDs. Tests run on real temporary git repos (ADR 0004).
- `LhrTree` owns long-lived resources: one `git cat-file --batch` process per repo (started when a path in that repo is first read) and the per-file diff cache. Call `dispose()` when done. The CLI opens one per command. The extension and the MCP server keep one per review root (one per workspace folder in a multi-root workspace).
- Everything is async.

## Errors

- **Operational failures throw** `LhrError { code, message }`. Codes are stable strings: `NOT_A_REPO`, `PATH_NOT_IN_REPO`, `FORMAT_MISSING`, `FORMAT_VERSION`, `THREAD_NOT_FOUND`, `MESSAGE_NOT_FOUND`, `DRAFT_NOT_FOUND`, `NOT_A_DRAFT`, `INVALID_INPUT`, `GIT_FAILED`, `IO_FAILED`. `PATH_NOT_IN_REPO` is thrown when an anchor path has no enclosing repo; the CLI exits 2. `IO_FAILED` is thrown on an unexpected file-system failure while writing, including running out of retries for a unique file name and waiting more than about 5 seconds for the drafts lock held by another process. The CLI maps them to exit codes, and the MCP server maps them to tool errors.
- **Broken content never throws.** One bad file must not hide the rest of the tree. Reads skip what they can't parse and report it as a `Diagnostic`, the same type `check()` returns.

```ts
interface Diagnostic {
  severity: "error" | "warning";
  code: string; // stable, one per rule in file-format-v2.md § Validation
  path: string; // repo-relative
  line?: number;
  message: string;
}
```

## Reading

```ts
lhr.load(): Promise<TreeSnapshot>

interface TreeSnapshot {
  problems: Diagnostic[];
  threads(filter?: ThreadFilter): ThreadView[];
  thread(id: string): ThreadView | undefined;
  rounds(): RoundView[];
  inbox(opts?: { session?: string }): ThreadView[];
}

interface ThreadFilter {
  status?: "open" | "resolved";
  whoseTurn?: "human" | "agent";
  path?: string; // file or directory, relative to the review root
  round?: string;
  includeDrafts?: boolean; // default false
}
```

- **`path` is a prefix on whole path segments.** It matches `anchor.path` when they are equal or when `anchor.path` starts with `path + "/"`, so `repo1/src` matches `repo1/src/a.ts` but not `repo1/srcx/c.ts`. A trailing slash is ignored, and `""` or `"."` matches every path.
- `load()` reads the whole tree into an immutable snapshot and computes every derived value except anchor state. Filtering happens in memory. The core doesn't watch files: the extension reloads on its `FileSystemWatcher`, and the MCP server reloads on each tool call.
- **Drafts are hidden unless asked for.** The extension and the CLI's human mode pass `includeDrafts: true`. The MCP server and the CLI's agent mode never expose it. This is the single place that enforces "drafts stay hidden from agents until the round is submitted".

```ts
interface ThreadView {
  id: string;
  createdAt: Date; // from the ID
  anchor: Anchor; // thread.md frontmatter, parsed
  snapshot?: string; // the fenced snapshot body, line threads only
  messages: MessageView[]; // in name order; drafts only with includeDrafts
  isDraft: boolean; // the thread itself is a draft
  status: "open" | "resolved";
  severity: "critical" | "high" | "medium" | "low";
  whoseTurn: "human" | "agent";
  reviewer: Author; // author of the opening message
}

interface MessageView {
  id: string;
  createdAt: Date;
  author: Author;
  body: string;
  round?: string;
  status?: "open" | "resolved";
  severity?: Severity;
  clientId?: string;
  isDraft: boolean;
}

interface Author {
  kind: "human" | "agent";
  name: string;
  session?: string;
  githubLogin?: string;
}
```

### Inbox

`inbox({ session })` lists the **open, submitted threads where it's the agent's turn**. An item leaves the inbox when an agent replies, not when it's read, so the core keeps no read state. With `session`, it keeps threads whose latest agent message came from that session, plus threads no agent has replied to yet. Nudge delivery state belongs to the session module, not the core.

## Anchoring

```ts
lhr.anchors(
  threads: ThreadView[],
  opts?: { overrides?: Map<string, string> }, // path → unsaved editor text
): Promise<Map<string, AnchorResult>>

interface AnchorResult {
  state: "current" | "outdated" | "orphaned";
  path: string; // may differ from anchor.path after a rename
  startLine?: number; // absent when orphaned
  endLine?: number;
  fromBranch?: string; // "from branch X" label, only while X exists
  method: "diff" | "text-search" | "moved" | "path" | "pinned";
  diagnostic?: Diagnostic; // set with code REPO_MISSING when the thread's repo is gone
}
```

- **Batched**, so all threads on a file share one diff: 200 threads went from 8.6 s to 1.1 s in the re-anchoring prototype. The algorithm is in [ADR 0006](../adr/0006-comment-anchoring.md).
- `overrides` replaces the on-disk content of a path, so the extension can re-anchor while a document has unsaved changes.
- **`old`-side threads aren't re-anchored.** They keep their saved lines against `anchor.commit` and report `current` with `method: "pinned"`. If the commit is unreachable and the snapshot can't be found, they report `orphaned`.
- A thread whose repo is gone (directory removed or no longer a repo) is `orphaned` with a `Diagnostic` (code `REPO_MISSING`, severity `warning`) in `AnchorResult.diagnostic`, and its snapshot is still shown. Reads never throw for it.
- File threads report `current` while their file exists (after following renames), otherwise `orphaned`.

## Writing

Every write takes an explicit `author`. `lhr.humanAuthor()` returns `{ kind: "human", name: <git user.name> }`, read with `git config user.name` run at the review root (global config when the root is not a repo; throws if empty). One author per review root. Every write adds a uniquely named file, so there are no locks. A rare `clientId` race between two processes is caught by `check()` as a duplicate.

### Anchor input

```ts
interface AnchorInput {
  path: string;
  kind: "line" | "file";
  side?: "new" | "old"; // default "new"
  startLine?: number; // line threads
  endLine?: number;
  text?: string; // unsaved content; default: the file on disk
  baseCommit?: string; // required for side "old"
}
```

The core fills in the rest: `commit` (HEAD, or `baseCommit` for the old side), `branch`, `blob` (`git hash-object -w --no-filters` of `text` or the file), and the snapshot with up to 3 lines of context on each side.

### Drafts (human reviewers)

```ts
lhr.createDraftThread(input: {
  anchor: AnchorInput;
  body: string;
  author: Author;
  severity?: Severity;
}): Promise<{ threadId: string; messageId: string }>

lhr.addDraftMessage(threadId: string, input: {
  body: string;
  author: Author;
  status?: "open" | "resolved";
  severity?: Severity;
}): Promise<{ messageId: string }>

lhr.updateDraft(messageId: string, patch: { body?: string; status?; severity? }): Promise<void>
lhr.discardDraft(id: string): Promise<void> // a draft message, or a draft thread with its messages

lhr.submitRound(input: {
  verdict: "approve" | "comment" | "request-changes";
  summary: string;
  author: Author; // kind must be "human"
  clientId?: string; // stored on the round file
}): Promise<{ roundId: string; threadIds: string[]; messageIds: string[]; created: boolean }>
```

- `submitRound` works with zero drafts: a bare approve or request-changes writes only the round file.
- It follows file-format-v2 § Submitting a review round. Before step 1 it writes `drafts/.submitting` holding the round ID and the caller's `clientId`. A rerun after an interruption finishes that same round instead of starting a second one, then deletes the marker. The interrupted round counts as the rerun's own only when both have the same `clientId` (or neither has one; the round file's `clientId` wins once it exists). Otherwise the rerun never lends its `clientId`, verdict or summary to that round: if the round file exists it finishes that round first and then submits its own round from the drafts left (`resumed: true`); if not, nothing was published yet, so it drops the marker and submits its own round.
- **Idempotency:** if a round already has the given `clientId`, `submitRound` returns that round with `created: false`, like `reply` and `createThread`. Without a `clientId` a retry writes a new round. The `.submitting` marker only covers interrupted runs. `created` is true exactly when this call wrote the round file, so finishing an own interrupted round whose file already existed also returns `created: false`.
- Editing or discarding a submitted message throws `NOT_A_DRAFT`.
- Every draft call (`createDraftThread`, `addDraftMessage`, `updateDraft`, `discardDraft`, `submitRound`) takes the drafts lock (file-format-v2 § Tree), so they never interleave, across processes too. A call that can't get the lock within about 5 seconds throws `IO_FAILED`. A `submitRound` that had to wait for the lock and finds that a concurrent submit wrote a round with the same author, verdict and summary treats it as a double submit: it returns that round with `resumed: true` instead of writing a second round. Otherwise it is an ordinary submit of the drafts that are left (none left means a bare round).

### Immediate writes

```ts
lhr.reply(threadId: string, input: {
  body: string;
  author: Author;
  clientId?: string;
  status?: "open" | "resolved";
  severity?: Severity;
}): Promise<{ messageId: string; created: boolean }>

lhr.createThread(input: {
  anchor: AnchorInput;
  body: string;
  author: Author; // an agent opening a thread
  clientId?: string;
  severity?: Severity;
}): Promise<{ threadId: string; messageId: string; created: boolean }>

lhr.resolve(threadId: string, author: Author): Promise<{ messageId?: string; changed: boolean }>
lhr.reopen(threadId: string, author: Author): Promise<{ messageId?: string; changed: boolean }>
```

- **`reply`** is how agents answer. It's written immediately with no `round`. A `clientId` the thread already has returns the existing message ID with `created: false`.
- **`createThread`** lets an agent start a thread to flag something it's unsure about. It's written immediately and is never part of a round. It becomes the human's turn, and the agent is its reviewer. The `clientId` goes on the opening message. If any thread's opening message already has that `clientId`, the call returns that thread with `created: false`.
- **`resolve` / `reopen`** write an empty-bodied message with `status` immediately, for humans and agents alike, like GitHub's "Resolve conversation". When the thread is already in that state, they write nothing and return `changed: false`. A resolve or reopen with a comment goes through `addDraftMessage` (humans) or `reply` (agents).

## Validation

```ts
lhr.check(): Promise<{ diagnostics: Diagnostic[] }>
```

This validates the whole tree, including `drafts/`, against the rules and JSON Schemas in file-format-v2 § Validation. It never throws for content problems. The CLI prints the diagnostics and exits `0` when there are no errors, `1` on errors, and `2` on usage errors.

## Who writes as whom

- **MCP server (`lhr mcp`):** always an agent. `name` is `clientInfo.name` from the MCP handshake. `session` is the `LHR_SESSION_ID` environment variable, falling back to `CLAUDE_CODE_SESSION_ID`; MCP itself gives a stdio server no session ID. With neither set, no `session` is recorded. The ID is fixed when the process starts, so after `/clear` a long-lived server may report a stale session; this is accepted, since a nudge to a stale ID is harmless.
- **CLI:** writes as an agent when `LHR_SESSION_ID` is set, otherwise as a human from git `user.name`. The plugin's `SessionStart` hook exports `LHR_SESSION_ID` through `CLAUDE_ENV_FILE`, so the agent's Bash tool sees it. As an agent, `author.name` is `--name`, then `LHR_AGENT_NAME`, then `claude-code`, and `author.session` is `LHR_SESSION_ID`. `--as human|agent` overrides the mode; `--as agent` without a session still writes, omits `session` and prints a warning (`lhr check` flags the gap). Defaulting to the environment matters because an agent reply recorded as human would silently flip whose turn it is.
- **Extension:** always a human, through `humanAuthor()`.
