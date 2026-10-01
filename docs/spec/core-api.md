# Core library API

What `packages/core` exports for the extension, the `lhr` CLI and `lhr mcp`. The core is private and bundled into each client (ADR 0004), so this API can change freely. It only has to be precise enough to start implementing. Field names and file rules come from [`file-format-v2.md`](file-format-v2.md); terms follow `GLOSSARY.md`.

## Opening a tree

```ts
openTree(host: Host): Promise<LhrTree>

interface Host {
  root: string; // repo root (the directory holding .lhr/)
  now?: () => Date; // default: () => new Date()
  random?: () => string; // 6 chars from [a-z2-7]; default: crypto
  gitPath?: string; // default: "git" on PATH
}
```

- The core uses Node `fs` and the `git` binary directly. Only the clock, the random source and the git path are injected, so tests can pin IDs. Tests run on real temporary git repos (ADR 0004).
- `LhrTree` owns long-lived resources: a `git cat-file --batch` process and the per-file diff cache. Call `dispose()` when done. The CLI opens one per command. The extension and the MCP server keep one per repo (one per workspace folder in a multi-root workspace).
- Everything is async.

## Errors

- **Operational failures throw** `LhrError { code, message }`. Codes are stable strings: `NOT_A_REPO`, `FORMAT_MISSING`, `FORMAT_VERSION`, `THREAD_NOT_FOUND`, `MESSAGE_NOT_FOUND`, `DRAFT_NOT_FOUND`, `NOT_A_DRAFT`, `INVALID_INPUT`, `GIT_FAILED`. The CLI maps them to exit codes, and the MCP server maps them to tool errors.
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
  path?: string;
  round?: string;
  includeDrafts?: boolean; // default false
}
```

- `load()` reads the whole tree into an immutable snapshot and computes every derived value except anchor state. Filtering happens in memory. The core doesn't watch files: the extension reloads on its `FileSystemWatcher`, and the MCP server reloads on each tool call.
- **Drafts are hidden unless asked for.** Only the extension passes `includeDrafts: true`. The MCP server and the CLI's agent mode never expose it. This is the single place that enforces "drafts stay hidden from agents until the round is submitted".

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
}
```

- **Batched**, so all threads on a file share one diff: 200 threads went from 8.6 s to 1.1 s in the re-anchoring prototype. The algorithm is in [ADR 0006](../adr/0006-comment-anchoring.md).
- `overrides` replaces the on-disk content of a path, so the extension can re-anchor while a document has unsaved changes.
- **`old`-side threads aren't re-anchored.** They keep their saved lines against `anchor.commit` and report `current` with `method: "pinned"`. If the commit is unreachable and the snapshot can't be found, they report `orphaned`.
- File threads report `current` while their file exists (after following renames), otherwise `orphaned`.

## Writing

Every write takes an explicit `author`. `lhr.humanAuthor()` returns `{ kind: "human", name: <git user.name> }`. Every write adds a uniquely named file, so there are no locks. A rare `clientId` race between two processes is caught by `check()` as a duplicate.

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
}): Promise<{ roundId: string; threadIds: string[]; messageIds: string[] }>
```

- `submitRound` works with zero drafts: a bare approve or request-changes writes only the round file.
- It follows file-format-v2 § Submitting a review round. Before step 1 it writes `drafts/.submitting` holding the round ID. A rerun after an interruption finishes that same round instead of starting a second one, then deletes the marker.
- Editing or discarding a submitted message throws `NOT_A_DRAFT`.

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

- **MCP server:** always an agent. `name` is the agent product, and `session` comes from the MCP client.
- **CLI:** writes as an agent when the agent-session environment variable set by the plugin's `SessionStart` hook is present, otherwise as a human from git `user.name`. `--as human|agent` overrides it. Defaulting to the environment matters because an agent reply recorded as human would silently flip whose turn it is.
- **Extension:** always a human, through `humanAuthor()`.
