---
status: accepted
---

# Anchor state is calculated from a saved anchor, by diff first and text search second

A thread is attached to code that keeps changing after the comment is written. Reviewers need to know whether the code they commented on is still there, moved, edited, or gone. The anchor is saved once in `thread.md` and never rewritten (ADR 0003), so the thread's current position has to be calculated each time it's shown. The fields are in [`docs/spec/file-format-v2.md`](../spec/file-format-v2.md) and the call is `lhr.anchors()` in [`docs/spec/core-api.md`](../spec/core-api.md). The evidence is the [re-anchoring prototype](https://github.com/pabloubal/local-hitl-review/issues/50): 32 of 35 scenarios on temporary git repos, plus a replay of 50 anchors from this repo's history.

- **Three anchor states.** **Current:** the anchored code is unchanged; the thread follows it to its new lines. **Outdated:** the anchored lines themselves were edited. Edits elsewhere in the file, even right next to the range, don't count. **Orphaned:** the anchored code or its file is gone. Status tells the rest: outdated and resolved is the normal outcome of a fix, and outdated and still open needs attention.
- **The saved anchor** is the file, line range, side, commit, branch, the blob of the file's content at creation (`git hash-object -w --no-filters`, so it holds the raw working-tree bytes, including uncommitted edits), and a snapshot of the anchored lines with up to 3 lines of context on each side.
- **The current position is calculated, never written back.** Writing it would add a git change and a possible conflict on every edit. In the extension, unsaved editor text is passed as an override, so threads move as you type.
- **Diff first.** When the blob is still in the object store, map lines with `git diff --no-index -U0 --histogram` from the blob to the current file. A hunk that touches the anchored lines makes the thread outdated. Renames come from `git diff -M` (committed and staged). An untracked file is accepted as the new name when its content is identical or it still contains the anchored lines.
- **Moved code stays current.** When the diff says the anchored lines were deleted, look for the exact anchored text elsewhere in the file. If it's found, the thread follows it and stays current. Moving a block shows up as a delete plus an insert, but the glossary calls moved code current.
- **Text search is a normal path, not a rare fallback.** Git prunes unreachable blobs after about two weeks, and a blob saved from uncommitted content never reaches a teammate's clone. So text search against the snapshot runs whenever the blob is missing. It ignores whitespace and quote style, ranks matches by how much surrounding context matches first and by distance from the old position second, and counts one matching context side as enough to call a thread outdated.
- **An outdated range keeps its original size.** It starts at the mapped start line and keeps the anchor's line count. The "changes since comment" diff shows the rest. Without this, a 1-line anchor grew to 46 lines.
- **The branch label shows only while the branch exists.** A thread shows "from branch X" when X exists locally, HEAD isn't on X, and `anchor.commit` isn't an ancestor of HEAD. A thread viewed from another branch is labelled, not marked outdated. After a squash merge and branch deletion the label goes away.
- **`old`-side threads are pinned.** They comment on the base of a diff, which doesn't move. They keep their saved lines against `anchor.commit` and report current. If the commit is unreachable and the snapshot can't be found, they report orphaned.
- **File threads** are current while their file exists (after following renames), otherwise orphaned.

## Implementation notes

- Run one diff per (blob, file) pair and share it across every thread on that file. 200 threads across 20 files took 1.1 s this way, against 8.6 s with a diff per thread.
- Read blobs through one long-lived `git cat-file --batch` process. The timings depend on how many git processes start, not on the diff itself (43 ms for a 10k-line file, 89 ms for 100k lines).
- Diffing uses git only; no new dependency.

## Considered options

- **Writing the current position back to the thread:** simpler reads, but it rewrites files on every edit, which breaks ADR 0003 and causes merge conflicts.
- **Pinning anchor blobs under `refs/lhr/`** so the diff stays the normal path: it adds hidden refs that teammates would have to fetch and that grow forever. Text search is good enough once it tolerates formatting changes.
- **Text search only:** no git dependency, but it turned 11 of 13 outdated threads in the replay into orphaned ones (mostly prettier quote rewrites) and misplaces short anchors like `);`.
- **Diff only:** moved code comes out orphaned, and every thread on pruned or uncommitted content is lost.
- **"Closest match to the old line wins" for text search:** it picked the wrong copy in both duplicated-code tests. Ranking by context first fixes them.
- **Branch label from `anchor.commit` ancestry alone:** after a squash merge, rebase or cherry-pick the commit is never an ancestor, so the label would stay forever.

## Consequences

- **Accepted limitation:** a plain `mv` (new name untracked) combined with an edit to the anchored lines comes out orphaned, because `git diff -M` can't see untracked files and the content no longer matches. It resolves once the rename is staged. The extension sees renames as they happen through workspace events.
- Text search still guesses when an anchor is short and generic and its context was also edited. Such threads may come out orphaned, or land on the wrong copy, instead of outdated.
- Anchor state depends on the local checkout, so two people can see different states for the same thread. That is intended: the state describes the code in front of you.
