# GitHub review API requirements for the thread schema

Research for [#47](https://github.com/pabloubal/local-hitl-review/issues/47) (map [#38](https://github.com/pabloubal/local-hitl-review/issues/38)).

**Question:** what must a thread record so that a submitted review round can be pushed to a GitHub pull request with `gh api`, and later imported back?

Researched 2026-10-01 against the GitHub REST docs (API version `2026-03-10`), the live GraphQL schema (introspected with `gh api graphql`), GitHub's help docs, and `gh` 2.96.0.

Labels used below:

- **[Verified]**: stated in a primary source, quoted or linked.
- **[Inference]**: my reading of the sources, or widely observed behavior that GitHub doesn't document. Confirm these with a throwaway PR before relying on them.

## Sources

| Key | Source |
|-----|--------|
| R-reviews | REST: pull request reviews, https://docs.github.com/en/rest/pulls/reviews |
| R-comments | REST: pull request review comments, https://docs.github.com/en/rest/pulls/comments |
| GQL | Live GraphQL schema, introspected with `gh api graphql` (`__type` queries for `DraftPullRequestReviewThread`, `AddPullRequestReviewInput`, `AddPullRequestReviewThreadInput`, `AddPullRequestReviewThreadReplyInput`, `SubmitPullRequestReviewInput`, `PullRequestReviewThread`, `PullRequestReviewComment`, `PullRequestReview`, `ResolveReviewThreadInput`, `DiffSide`, `PullRequestReviewEvent`, `PullRequestReviewState`). Reference pages: https://docs.github.com/en/graphql/reference/objects#pullrequestreviewthread, https://docs.github.com/en/graphql/reference/mutations#addpullrequestreview |
| H-review | Help: reviewing proposed changes, https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/reviewing-proposed-changes-in-a-pull-request |
| H-comment | Help: commenting on a pull request, https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/commenting-on-a-pull-request |
| H-feedback | Help: incorporating feedback, https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/incorporating-feedback-in-your-pull-request |
| gh | `gh api --help` (gh 2.96.0) |

## Vocabulary mapping

| Local HITL Review (GLOSSARY.md) | GitHub |
|---|---|
| Review round | Pull request review (`PullRequestReview`, REST `/reviews`) |
| Verdict: approve / comment / request changes | `event`: `APPROVE` / `COMMENT` / `REQUEST_CHANGES`; resulting `state`: `APPROVED` / `COMMENTED` / `CHANGES_REQUESTED` |
| Draft | A review in state `PENDING`, and the comments inside it |
| Thread | `PullRequestReviewThread` (GraphQL only). In REST a thread is just a top-level review comment plus the comments whose `in_reply_to_id` points at it |
| Message | Review comment (`PullRequestReviewComment`). The first message of a thread is the top-level comment |
| Anchor | `path` + `line`/`side` (+ `start_line`/`start_side`) against a `commit_id`, or `subject_type: file` |
| Anchor state: outdated | `isOutdated` (thread) / `outdated` (comment), REST `position: null` |

## Findings

### 1. Fields each review comment needs

**[Verified] REST, single comment** (`POST /repos/{owner}/{repo}/pulls/{pull_number}/comments`, R-comments):

- `body` (required).
- `commit_id` (required): "The SHA of the commit needing a comment. Not using the latest commit SHA may render your comment outdated if a subsequent commit modifies the line you specify as the position."
- `path` (required): "The relative path to the file that necessitates a comment."
- `line`: "Required unless using subject_type:file. The line of the blob in the pull request diff that the comment applies to. For a multi-line comment, the last line of the range."
- `side`: `LEFT` or `RIGHT`. "Use LEFT for deletions that appear in red. Use RIGHT for additions that appear in green or unchanged lines that appear in white and are shown for context. For a multi-line comment, side represents whether the last line of the comment range is a deletion or addition."
- `start_line`, `start_side`: "Required when using multi-line comments unless using in_reply_to." `start_line` is the first line of the range.
- `position`: "This parameter is closing down. Use line instead." It's an offset counted from the first `@@` hunk header, not a file line number. **Don't use it.**
- `in_reply_to`: ID of the comment to reply to; "When specified, all parameters other than body in the request body are ignored."
- `subject_type`: `line` or `file`.

**[Verified] REST, batched review** (`POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews`, R-reviews): top-level `commit_id` (optional, "Defaults to the most recent commit in the pull request"), `body` ("Required when using REQUEST_CHANGES or COMMENT"), `event`, and `comments[]` with `path` (required), `body` (required), `line`, `side`, `start_line`, `start_side`, `position`. **The `comments[]` item schema doesn't list `subject_type` or `in_reply_to`.**

**[Verified] GraphQL** (GQL): `addPullRequestReview(input: AddPullRequestReviewInput)` takes `pullRequestId` (node ID), `commitOID`, `body`, `event`, and `threads: [DraftPullRequestReviewThread]`. Each thread has `path`, `line`, `side`, `startLine`, `startSide`, `body`. The older `comments` argument (diff-relative `position`) is marked "will be removed. use the `threads` argument instead". **`DraftPullRequestReviewThread` has no `subjectType` field.**

**What this means for the anchor:**

- **[Verified]** `line` and `start_line` are line numbers in the file ("line of the blob"), on the side named by `side`/`start_side`. `RIGHT` means the PR head version of the file, `LEFT` the base version. A thread anchored to working-tree lines must be mapped to lines in the pushed `commit_id`.
- **[Inference]** Local Review threads are anchored to the current file, so they're almost always `RIGHT`. `LEFT` is needed only for threads on deleted lines, which a local diff view can show. The schema should still record the side so that a thread imported from GitHub on a deleted line keeps its meaning.
- **[Inference]** The anchor must record the commit the line numbers refer to. If the working tree has uncommitted changes, or the local HEAD isn't the PR's head commit, the line numbers don't match GitHub's diff. The push step must re-anchor against the PR head commit, or refuse.

### 2. File-level comments (`subject_type: file`)

- **[Verified]** REST single comment: `subject_type: "file"` makes `line` optional (R-comments).
- **[Verified]** GraphQL `addPullRequestReviewThread` takes `subjectType: LINE | FILE` along with `pullRequestReviewId`, so a file-level thread can be added to a pending review (GQL). `PullRequestReviewThread.subjectType` and `PullRequestReviewComment.subjectType` report it on import.
- **[Verified]** Neither batched-review input (REST `comments[]` and GraphQL `DraftPullRequestReviewThread`) documents a file-level option.
- **[Inference]** A review round that has file-level threads can't be sent in a single `POST .../reviews` call. The reliable route is:
  1. Create a pending review (REST `POST .../reviews` with no `event`, or GraphQL `addPullRequestReview` with no `event`), including the line threads.
  2. Add each file-level thread with GraphQL `addPullRequestReviewThread(subjectType: FILE, pullRequestReviewId: …)`.
  3. Submit with the verdict (REST `POST .../reviews/{id}/events` or GraphQL `submitPullRequestReview`).
- **[Inference]** The file must be one of the PR's changed files. A thread on an unchanged file can't be posted as a review comment at all (see §3).
- So the thread schema needs an explicit **anchor kind** (`line` | `file`), not just "line is missing".

### 3. Comments on lines outside the PR diff

- **[Verified]** The docs define `line` as "The line of the blob **in the pull request diff**" and `start_line` as "the first line **in the pull request diff**" (R-comments). Review comments are "comments made on a portion of the unified diff" (R-comments, About).
- **[Inference, widely observed but undocumented]** A line that isn't in a diff hunk (changed or context line) on the given side is rejected with `422 Unprocessable Entity`. The message is along the lines of "Pull request review thread line must be part of the diff" / "could not be resolved". In a batched review, one bad comment fails the whole request, so nothing is posted.
- **[Inference]** For multi-line comments, the whole range (`start_line` through `line`) must be inside a single hunk.
- **Consequence:** the push step needs to read the PR diff (`gh api repos/{owner}/{repo}/pulls/{n}` with `Accept: application/vnd.github.v3.diff`, or `.../pulls/{n}/files` for per-file `patch`) and sort each thread into one of these:
  - postable as a line thread;
  - degradable to a file-level thread (file is in the PR, line isn't), quoting the anchored lines in the body;
  - unpostable (file not in the PR). Put it in the review body, or skip it and report that.

  Record which treatment was used so a re-push is consistent.

### 4. Suggested changes (` ```suggestion ` blocks)

- **[Verified]** Reviewers can "suggest a specific change to the line or lines" by editing "the text within the suggestion block" (H-comment). The block is written as a fenced code block with the `suggestion` info string inside a review comment's body (H-review: "You can add a comment above the line containing ```` ```suggestion ```` to explain your suggested change").
- **[Verified]** Authors with write access can apply a suggestion, alone or in a batch. Applying "creates a single commit on the compare branch". "Each person who suggested a change included in the commit will be a co-author of the commit" (H-feedback).
- **[Inference]** There's no separate API field: a suggestion is just body Markdown. Its contents replace the anchored line range (`start_line`..`line`, or `line` alone) on the `RIGHT` side. So it's only meaningful on a line thread, and only if the anchored range is exactly the range being replaced. An empty suggestion block deletes the lines.
- **Consequence:** if a message can carry a proposed replacement, store it as structured data (replacement text plus the range it replaces) rather than only as Markdown. Then the push step can render a ` ```suggestion ` fence. Import can parse the fence back out of `body`.

### 5. You can't approve or request changes on your own PR

- **[Verified]** "Pull request authors cannot approve their own pull requests." (H-review)
- **[Inference, widely observed]** The API also rejects `REQUEST_CHANGES` from the PR author with a 422 ("Can not request changes on your own pull request"). Only `COMMENT` works on your own PR. This matters a lot here: in the main use case, the human reviews an agent's work, and the PR is usually opened by the human's own account (agents push with the user's `gh` credentials).
- **[Verified]** Submitting with a missing `event` returns 422 and leaves the review `PENDING` (R-reviews, Submit).
- **Consequence:** the push step must compare the PR author with the authenticated user (`gh api user --jq .login`). If they match, it maps the local verdict to `COMMENT`, carries the real verdict in the review body (for example "Verdict: request changes"), and records that the verdict was downgraded.

### 6. Pending reviews

- **[Verified]** Omitting `event` on create makes a `PENDING` review. Pending reviews have no `submitted_at`. Submit later with `POST .../reviews/{review_id}/events` and an `event` (R-reviews).
- **[Verified]** "Deletes a pull request review that has not been submitted. Submitted reviews cannot be deleted." (R-reviews)
- **[Verified]** GQL `PullRequestReviewState.PENDING` is "A review that has not yet been submitted". **[Inference]** Only its author can see it, so it matches the glossary's **draft**.
- **[Inference, widely observed]** A user can have only one pending review per PR. Creating a second returns 422. A crashed push can leave a pending review behind. The next push should find it (`GET .../reviews`, filter `state == "PENDING"` and `user.login == me`), then either reuse it or delete it.
- **[Verified]** Create and submit both trigger notifications, and "Creating content too quickly using this endpoint may result in secondary rate limiting" (R-reviews, R-comments). That's one more reason to batch a whole review round into one review, as the UI's "Start a review" does (H-comment: "Batching your comments avoids sending multiple notifications").

### 7. IDs returned (for idempotent pushes and later import)

| Object | REST | GraphQL | Notes |
|---|---|---|---|
| Review (review round) | `id` (int64), `node_id`, `html_url`, `state`, `commit_id`, `submitted_at` | `id` (node ID), `fullDatabaseId` (BigInt, equals REST `id`), `url`, `state`, `submittedAt` | [Verified] R-reviews, GQL |
| Comment (message) | `id` (int64), `node_id`, `pull_request_review_id`, `in_reply_to_id`, `html_url`, `created_at`, `updated_at`, `commit_id`, `original_commit_id`, `line`, `original_line`, `start_line`, `original_start_line`, `side`, `start_side`, `subject_type`, `position` (null when outdated), `diff_hunk` | `id`, `fullDatabaseId`, `url`, `replyTo`, `pullRequestReview`, `outdated`, `line`, `originalLine`, `startLine`, `subjectType`, `diffHunk`, `commit`, `originalCommit`, `state` | [Verified] R-reviews (List comments for a review), GQL |
| Thread | **No REST object or ID.** Use the root comment's `id`. | `PullRequestReviewThread.id` (node ID), `isResolved`, `resolvedBy`, `isOutdated`, `diffSide`, `startDiffSide`, `line`, `originalLine`, `startLine`, `originalStartLine`, `path`, `subjectType`, `comments` | [Verified] GQL |

Things that follow from this:

- **[Verified]** The `POST .../reviews` response contains the review but **not** the IDs of the comments it created. Get them with `GET .../reviews/{review_id}/comments`. Match them back by `path` + `line` + `body`, since order isn't guaranteed (match key is [Inference]).
- **[Verified]** Replies: `POST .../comments/{comment_id}/replies` or `in_reply_to`. "This must be the ID of a top-level review comment, not a reply to that comment. Replies to replies are not supported." (R-comments) So threads are flat: always reply to the thread's root comment ID. GraphQL `addPullRequestReviewThreadReply` takes the thread node ID and an optional pending `pullRequestReviewId`, so replies can be part of a review round.
- **[Verified]** Resolving a thread exists only in GraphQL: `resolveReviewThread(threadId)` / `unresolveReviewThread`. This needs the **thread node ID**, which REST never returns. Get it from `pullRequest.reviewThreads` (match on root comment `fullDatabaseId`).
- **[Inference]** GitHub has no idempotency key on these endpoints. Pushing twice without stored IDs posts duplicates. Defenses:
  1. Store the returned review, thread and comment IDs on the local review round, thread and message.
  2. Mark each comment body with an invisible HTML comment such as `<!-- lhr:message=<local-message-id> -->`. Then a push that crashed after the POST but before the IDs were saved locally can recover by listing comments and matching the marker.
  3. Before each push, list existing reviews and comments and skip anything already present.
- **[Verified]** Incremental import can use `GET /repos/{owner}/{repo}/pulls/{n}/comments?since=<ISO 8601>&sort=updated` (R-comments) and GraphQL `reviewThreads` for resolution state.

### 8. Notes specific to `gh api`

- **[Verified]** `-f` sends strings. `-F` converts `true`/`false`/`null`/integers to JSON types, so `-F line=42` is needed for ints. Arrays of objects use `key[][sub]=value` syntax. For a whole review round it's simpler and safer to build the JSON and send it with `--input file.json` (gh). With `--input`, any `-f`/`-F` fields go to the query string instead (gh).
- **[Verified]** `gh api graphql -f query=... -F var=...` passes every field except `query`/`operationName` as a GraphQL variable (gh).
- **[Verified]** `{owner}`/`{repo}` placeholders resolve from the current directory's repo or `GH_REPO` (gh). `--paginate` (with `--slurp`) is needed for listing comments, which default to 30 per page with a max of 100 (R-reviews).
- **[Verified]** Diff for in-diff checks: `gh api repos/{owner}/{repo}/pulls/{n} -H 'Accept: application/vnd.github.v3.diff'` (R-reviews note on Create a review).
- **[Inference]** `gh pr review` (the higher-level command) only sends a body and a verdict, with no inline comments. Pushing a review round needs `gh api`.

## Recommended push flow (inference)

1. Resolve the PR, its head SHA, its author, and the current user. Downgrade the verdict to `COMMENT` if the current user is the PR author (§5).
2. Fetch the PR diff and sort each thread: line, file-level, or unpostable (§3).
3. Look for an existing pending review by me. Reuse it or delete it (§6).
4. `POST .../reviews` with **no `event`**, `commit_id` = head SHA, and all postable line threads, sent with `--input`. Save the review `id`/`node_id`.
5. Add file-level threads and replies to existing GitHub threads through GraphQL with `pullRequestReviewId` (§2, §7).
6. Submit: `POST .../reviews/{id}/events` with the verdict and body.
7. Read back IDs (`GET .../reviews/{id}/comments`, GraphQL `reviewThreads`) and store them locally.

## Fields the thread and message schema must carry

**Review round** (or wherever pushes are recorded):

- `verdict`: `approve` | `comment` | `request_changes`.
- `body`: summary text (required by GitHub for `COMMENT` and `REQUEST_CHANGES`).
- Per push target (a review round may be pushed to a PR): `github.repo` (`owner/name`), `github.pullNumber`, `github.reviewId` (int64), `github.reviewNodeId`, `github.commitId` (head SHA the review round was pushed against), `github.state` (`PENDING` | `COMMENTED` | `APPROVED` | `CHANGES_REQUESTED` | `DISMISSED`), `github.submittedAt`, `github.url`, `github.verdictDowngraded` (boolean, for own-PR pushes).

**Thread:**

- Stable local `id`, so it can be found again on re-push and import, and embedded as a hidden marker in the posted body.
- Anchor:
  - `anchor.kind`: `line` | `file`.
  - `anchor.path`: repo-relative, `/`-separated.
  - `anchor.commit`: SHA the line numbers refer to.
  - `anchor.side`: `RIGHT` | `LEFT`, default `RIGHT`.
  - `anchor.line`: end line, 1-based file line.
  - `anchor.startLine` and `anchor.startSide`: for multi-line ranges, null for single line.
  - Anchored text or a hash, for re-anchoring and for quoting when the thread is downgraded to file-level.
- Remote link (null until pushed or imported):
  - `github.threadNodeId` (GraphQL thread ID, needed to resolve).
  - `github.rootCommentId` (int64, needed for REST replies).
  - `github.postedAs`: `line` | `file` | `review-body` | `skipped`.
  - `github.commitId` / `github.line` / `github.side` as posted, since they can differ from the local anchor after re-anchoring.
  - `github.isResolved`, `github.isOutdated` (from import).
- Resolution state (local), so it can be pushed as `resolveReviewThread` and imported from `isResolved`/`resolvedBy`.

**Message:**

- Stable local `id`.
- `author`: human or agent, plus a display name. Imported messages also need `github.authorLogin`.
- `body`: Markdown.
- `suggestion` (optional): replacement text for the thread's anchored range, rendered as a ` ```suggestion ` fence on push and parsed out on import.
- `createdAt`, `updatedAt`.
- Remote link:
  - `github.commentId` (int64).
  - `github.commentNodeId`.
  - `github.reviewId` (the review it went out in; `pull_request_review_id`).
  - `github.inReplyToId` (root comment ID; null for the first message).
  - `github.url`.
  - `github.updatedAt`: to detect remote edits on import.
- Draft flag (already in the glossary). This maps onto GitHub's `PENDING` state, since a message is a draft until its review round is submitted.
