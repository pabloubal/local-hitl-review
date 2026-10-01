# Core read path: load, derived values and inbox (#68)

Goal: `tree.load()` reads a `.lhr/` tree into an immutable `TreeSnapshot` with every derived value except anchor state (docs/spec/core-api.md § Reading, § Inbox; docs/spec/file-format-v2.md).

Acceptance criteria:
- [x] Tests written first from fixture trees, one per derived-value rule (opening message/reviewer, status incl. reopen, severity precedence, whose turn, timestamps from IDs, drafts hidden).
- [x] Inbox: an item leaves when an agent replies; `session` filtering keeps threads whose latest agent message came from that session plus threads no agent has replied to.
- [x] A malformed message file yields a `Diagnostic` and the rest of its thread still loads.
- [x] `npm test -w packages/core` and root `npx tsc --noEmit` / lint pass.

Design:
- `load()` is a method on `LhrTree` (spec writes `lhr.load()`). Split: `read.ts` (fs + per-file validation → records + diagnostics) and `snapshot.ts` (pure: derivation, filtering, inbox, freezing). Shared types in `model.ts`. Pure derivation is unit-testable without fs; `load.test.ts` covers the fixture-tree acceptance tests end to end.
- **Whose turn = the opposite of the last message's `author.kind`** (last message human → agent's turn). The spec line "the `author.kind` of the last message" contradicts the inbox rule; fixed in the spec in this change.
- **Status:** `resolved` iff the last message has `status: resolved` (equivalent to the spec's "latest status-setter wins, later message reopens").
- **Severity:** latest message with `severity`, else `thread.md` `severity`, else `medium`.
- **Drafts:** `drafts/threads/<id>/thread.md` → draft thread (`isDraft: true`). Draft message files under `drafts/threads/<id>/` where `<id>` is a submitted thread → draft replies, shown only with `includeDrafts`. Derived values of a submitted thread use submitted messages only (state doesn't flip before submit); a draft thread's use its draft messages. If an ID exists in both trees (interrupted submit), the submitted `thread.md` wins and a draft message whose ID is already submitted is dropped.
- **Skipping:** a bad file is skipped with an `error` diagnostic; the rest loads. Bad `thread.md` (or none) → whole thread skipped. Submitted thread with no valid messages → skipped (`EMPTY_THREAD`). Draft thread with no messages → skipped silently (transient write state). Non-`.md` files ignored; `.md` with invalid name → `INVALID_FILE_NAME`. Missing `.lhr/threads` or `.lhr/rounds` → empty, no error.
- **Diagnostic codes** (stable, reused by `check()` later): `FRONTMATTER_SYNTAX` (existing), `MISSING_KEY`, `INVALID_VALUE`, `INVALID_FILE_NAME`, `AUTHOR_KIND_MISMATCH`, `MISSING_THREAD_MD`, `EMPTY_THREAD`, `EMPTY_BODY` (message body empty without `status`/`severity`). Unknown-key warnings, snapshot line count, dangling `round`, duplicate `clientId` are `check()` scope (out).
- **Types not defined by the spec:** `Anchor` = parsed `thread.md` `anchor.*` (`kind`, `path`, `side`, `commit`, `branch?`, and for line anchors `blob`, `startLine`, `endLine`, `contextBefore`, `contextAfter`) as a discriminated union on `kind`. `RoundView = { id, createdAt, verdict, author, body }`.
- **Queries:** `threads()` sorted by ID; `path` = exact `anchor.path`; `round` = thread has a message with that `round`. `inbox()` = submitted, open, `whoseTurn === 'agent'`; with `session`, keep if the latest agent message's `author.session === session` or no agent message exists. Views are deep-frozen.
- Rejected: one big `load.ts` (harder to unit-test derivation); computing state including draft replies (would show an agent-turn change before submit).

Tasks:
| id | task | files | depends | agent | model | status |
|----|------|-------|---------|-------|-------|--------|
| T1 | Public + internal types, diagnostic code constants | packages/core/src/model.ts | - | implementer | haiku | done |
| T2 | Tree reader: scan threads/drafts/rounds, validate, merge drafts, diagnostics (TDD) | packages/core/src/read.ts, packages/core/test/read.test.ts | T1 | implementer | sonnet | done |
| T3 | Pure snapshot: derived values, filters, inbox, freeze (TDD) | packages/core/src/snapshot.ts, packages/core/test/snapshot.test.ts | T1 | implementer | sonnet | done |
| T4 | Wire `load()` into `LhrTree`, exports, fixture-tree acceptance tests, spec whose-turn fix | packages/core/src/tree.ts, packages/core/src/index.ts, packages/core/test/load.test.ts, docs/spec/file-format-v2.md | T2,T3 | implementer | sonnet | done |
| R1 | Review combined diff | - | T4 | reviewer | opus | done (APPROVE after 1 fix round) |

Risks / open questions:
- Whose-turn spec fix needs PO confirmation.
- Draft-reply semantics (excluded from derived values) is a product call; easy to flip later.
