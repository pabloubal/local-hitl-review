# Diff Viewer

## Sub-features

- `diff.branch-mode` — All changes vs merge-base in a single diff view
- `diff.commits-mode` — Individual commit diffs vs parent commit
- `diff.open-single` — Open diff for one file
- `diff.open-all` — Open all changes in multi-file diff editor (`vscode.changes`)
- `diff.open-commit` — Open all changes for a specific commit in multi-file diff editor
- `diff.added-files` — New files open directly (no base to diff against, `empty:empty` URI)
- `diff.deleted-files` — Deleted files show the old version only
- `diff.renamed-files` — Renames show diff with original path as base

## Entry points

- Click a file in Changed Files view → `vscodeComment.openDiff`
- Commit node context menu → `vscodeComment.openCommitChanges`
- Command Palette → `Local HITL Review: Open All Changes`
- Command Palette → `Local HITL Review: Select Compare Mode` (branch vs commits)
- Command Palette → `Local HITL Review: Select Base Branch`
- Command Palette → `Local HITL Review: Next Unreviewed File`

## How to verify

1. Create a branch with modified, added, deleted, and renamed files
2. Open diff for each type — verify correct base/right URIs and titles
3. Switch compare mode to "commits" — verify diff titles update to show commit hash
4. Select a different base branch — verify merge-base recalculates and diffs update
5. Open "All Changes" — verify multi-file diff editor opens containing all files
6. Check `UNCOMMITTED` changes diff vs HEAD

## Gotchas

- `createGitUri` depends on VS Code's built-in git extension registering the `git:` content provider. If git extension is disabled, diffs fail silently.
- For commit diffs, the base is `${hash}~1` — first commits in a repo have no parent and will error.
- Multi-file diff editor (`vscode.changes`) requires an array of tuples `[currentUri, baseUri, rightUri]`.
- Empty URIs must be exactly `vscode.Uri.parse('empty:empty')` for added/deleted files in multi-file diff.

## Source files

- [`extension.ts`](file:///Users/pablo/code/vscode-comment/src/extension.ts) — Command handlers (lines 308-389, 489-711, 887-898)
- [`gitService.ts`](file:///Users/pablo/code/vscode-comment/src/gitService.ts) — Git CLI wrapper providing file paths and commit hashes
