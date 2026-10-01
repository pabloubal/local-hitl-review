# LHR file format v2

The field-level contract for the `.lhr/` tree. ADR 0003 decides the layout and ADR 0005 the encoding; this file lists every field and every check. Terms follow `GLOSSARY.md`.

## Tree

```
.lhr/
  format                                   the text `2` and a newline
  threads/<thread-id>/
    thread.md                              anchor + snapshot, written once
    <message-id>.md                        one file per message
  rounds/<round-id>.md                     one file per submitted review round
  pushes/<push-id>.md                      one file per `review push`
  drafts/                                  gitignored; same layout as threads/
    threads/<thread-id>/thread.md          a new draft thread
    threads/<thread-id>/<message-id>.md    a draft message (new or existing thread)
```

No file outside `drafts/` is rewritten or deleted by our tools after it is created. Draft files may be rewritten and deleted freely.

## IDs and file names

- **ID:** `<YYYYMMDDTHHMMSSZ>-<random>`, where the timestamp is UTC and `<random>` is 6 characters from `[a-z2-7]`. Thread, round and push IDs use this form.
- **Message file name:** `<YYYYMMDDTHHMMSSZ>-<human|agent>-<random>.md`. The **message ID** is the file name without `.md`.
- **Timestamps are never stored in frontmatter.** A thread's, message's, round's or push's creation time is the timestamp in its ID. Sorting names sorts by time.

## Frontmatter syntax

Every file starts with frontmatter between two `---` lines, followed by a markdown body. The frontmatter is a restricted subset of YAML, so any YAML parser reads it, and agents can write it by hand:

- One `key: value` per line. Blank lines are ignored. No comments, nesting, lists or multi-line values.
- **Keys** match `^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)*$`. Dots group related keys (`anchor.path`).
- **Values** are an integer (`^-?[0-9]+$`, from -9007199254740991 to 9007199254740991 so every reader gets the exact value), `true`, `false`, or a string. A string must be double-quoted, with `\"` and `\\` escapes, when it is empty, starts or ends with a space or tab, ends with `:`, contains `: `, `:` followed by a tab, ` #` or a tab followed by `#`, starts with one of ``-?:,[]{}#&*!|>'"%@` ``, or would otherwise read as an integer or boolean.
- Values can't contain control characters other than tab, or the line separators U+0085, U+2028 and U+2029.
- A list, when needed, is a comma-separated string.
- **Unknown keys** are kept by readers and ignored; `lhr check` warns about them.

## `thread.md`

| Key                    | Required    | Values                              | Meaning                                                                                                      |
| ---------------------- | ----------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `anchor.kind`          | yes         | `line`, `file`                      | Line-range thread or file-level thread                                                                       |
| `anchor.path`          | yes         | repo-relative POSIX path            | The file the thread is on                                                                                    |
| `anchor.side`          | yes         | `new`, `old`                        | Side of a diff (mapped to GitHub `RIGHT`/`LEFT` on push)                                                     |
| `anchor.commit`        | yes         | full commit SHA                     | `HEAD` when the thread was created; for the `old` side, the base commit compared against                     |
| `anchor.branch`        | no          | branch name                         | Branch checked out at creation; absent when detached                                                         |
| `anchor.blob`          | `line` only | git object ID                       | `git hash-object -w --no-filters` of the file content the line numbers refer to (includes uncommitted edits) |
| `anchor.startLine`     | `line` only | integer ≥ 1                         | First anchored line, 1-based                                                                                 |
| `anchor.endLine`       | `line` only | integer ≥ `startLine`               | Last anchored line, inclusive                                                                                |
| `anchor.contextBefore` | `line` only | integer ≥ 0                         | Snapshot lines before `startLine` (normally 3, fewer at the top of a file)                                   |
| `anchor.contextAfter`  | `line` only | integer ≥ 0                         | Snapshot lines after `endLine`                                                                               |
| `severity`             | no          | `critical`, `high`, `medium`, `low` | Starting severity; default `medium`                                                                          |

**Body:** for a `line` thread, exactly one fenced code block holding the snapshot: `contextBefore` lines, the anchored lines, then `contextAfter` lines, byte for byte. The fence is longer than any backtick run in the snapshot; the info string may name the language. For a `file` thread the body is empty.

The snapshot exists because git may garbage-collect `anchor.blob`. Anchoring then searches for the snapshot text instead (see [ADR 0006](../adr/0006-comment-anchoring.md)).

## Message file

| Key                  | Required | Values                              | Meaning                                                                                                    |
| -------------------- | -------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `author.kind`        | yes      | `human`, `agent`                    | Must match the kind in the file name                                                                       |
| `author.name`        | yes      | string                              | Git `user.name` for a human; the agent product (`claude-code`) for an agent                                |
| `author.session`     | no       | string                              | Agent session ID; used to route nudges (ADR 0001)                                                          |
| `author.githubLogin` | no       | string                              | Set only on messages imported from GitHub                                                                  |
| `round`              | no       | round ID                            | The review round that submitted this message; absent for agent messages and messages added outside a round |
| `status`             | no       | `open`, `resolved`                  | Changes the thread's status                                                                                |
| `severity`           | no       | `critical`, `high`, `medium`, `low` | Changes the thread's severity                                                                              |
| `clientId`           | no       | string                              | Caller-chosen ID, unique within the thread; a write with a `clientId` the thread already has does nothing  |

**Body:** markdown. It may be empty only if `status` or `severity` is set. A suggested replacement for the anchored lines is a ` ```suggestion ` fence in the body, as on GitHub.

Messages can't be edited once submitted. A correction is a new message.

## Round file

| Key           | Required | Values                                  | Meaning                        |
| ------------- | -------- | --------------------------------------- | ------------------------------ |
| `verdict`     | yes      | `approve`, `comment`, `request-changes` | The reviewer's verdict         |
| `author.kind` | yes      | `human`                                 | Rounds are submitted by humans |
| `author.name` | yes      | string                                  | As on messages                 |

**Body:** the review summary in markdown, possibly empty. A round's messages are the messages whose `round` is its ID; the round file doesn't list them.

## Push record

Written by `review push`, one per push, committed so that no one posts the same round twice.

| Key                        | Required | Values                                                                           |
| -------------------------- | -------- | -------------------------------------------------------------------------------- |
| `round`                    | yes      | round ID                                                                         |
| `github.repo`              | yes      | `owner/name`                                                                     |
| `github.pullNumber`        | yes      | integer                                                                          |
| `github.reviewId`          | yes      | integer                                                                          |
| `github.reviewNodeId`      | yes      | string                                                                           |
| `github.commitId`          | yes      | SHA the review was posted against (the PR head)                                  |
| `github.state`             | yes      | `PENDING`, `COMMENTED`, `APPROVED`, `CHANGES_REQUESTED`                          |
| `github.submittedAt`       | no       | ISO 8601 string; absent while pending                                            |
| `github.url`               | yes      | string                                                                           |
| `github.verdictDowngraded` | yes      | `true` when the verdict was posted as `COMMENT` because the reviewer owns the PR |

**Body:** exactly one ` ```json ` block that maps local IDs to GitHub IDs. Tools write it, people don't:

```json
{
  "threads": {
    "<thread-id>": {
      "postedAs": "line | file | review-body | skipped",
      "rootCommentId": 123,
      "threadNodeId": "PRRT_…",
      "commitId": "<sha>",
      "side": "RIGHT",
      "startLine": 10,
      "line": 12
    }
  },
  "messages": {
    "<message-id>": {
      "commentId": 456,
      "commentNodeId": "PRRC_…",
      "inReplyToId": 123,
      "url": "https://…",
      "updatedAt": "2026-10-01T11:00:00Z"
    }
  }
}
```

For each local ID, the latest push record that mentions it wins. Every body posted to GitHub ends with `<!-- lhr:message=<message-id> -->`. Before posting, push reads the PR's existing comments for these markers, so it doesn't post twice even when a push record was lost.

GitHub's `isResolved` and `isOutdated` are fetched when needed, never stored.

## Derived values

These are calculated by the core and never written:

- **Opening message:** the thread's first message by name.
- **Reviewer:** the author of the opening message.
- **Status:** `open`, unless the latest message that sets `status` sets `resolved` and no message comes after it. A later message without `status` reopens the thread.
- **Severity:** set by the latest message that sets `severity`, otherwise by `thread.md`, otherwise `medium`.
- **Whose turn:** the `author.kind` of the last message.
- **Anchor state** (current, outdated or orphaned) and current lines: see [ADR 0006](../adr/0006-comment-anchoring.md).
- **Inbox:** open, submitted threads where it's the agent's turn (see [`core-api.md`](core-api.md)). There is no read state.
- **Nudge delivery:** kept locally, outside the shared tree.

## Submitting a review round

1. Write `rounds/<round-id>.md`.
2. For each draft message, write it into its thread with `round: <round-id>` added. For each draft thread, write `thread.md` before its messages.
3. Delete the submitted drafts.

If this is interrupted, a round may exist with only some of its messages, and running it again finishes the job. A message never points at a missing round.

## Validation

- JSON Schemas for the parsed frontmatter of each file kind (`thread`, `message`, `round`, `push`) ship in `packages/core/schema/`. They are published at `https://raw.githubusercontent.com/pabloubal/local-hitl-review/main/packages/core/schema/<kind>.schema.json`.
- **`lhr check`** validates the tree, including `drafts/`. Exit code `0` when there are no errors (warnings allowed), `1` on errors, `2` on usage errors.
  - **Errors:**
    - `.lhr/format` is missing or isn't `2`.
    - Frontmatter has a syntax error.
    - A required key is missing, or a value has the wrong type or enum.
    - A file name isn't a valid ID, or a message's `author.kind` doesn't match its file name.
    - A thread directory has no `thread.md`, or a submitted thread has no messages.
    - A line thread's snapshot line count isn't `contextBefore + (endLine - startLine + 1) + contextAfter`.
    - A message's `round` names a missing round file.
    - A thread has a duplicate `clientId`.
    - A push record names an unknown thread or message ID.
  - **Warnings:**
    - An unknown key.
    - An agent message without `author.session`.
- **`lhr doctor`** checks the environment (hooks, session registry, git) and runs `lhr check`.
