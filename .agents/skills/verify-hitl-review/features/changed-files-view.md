# Changed Files View

## Sub-features

- `changed-files.tree-view` — Display changed files in SCM sidebar as a directory tree
- `changed-files.list-view` — Flat list alternative
- `changed-files.multi-repo` — Multiple git repos with lazy loading
- `changed-files.commit-graph` — Per-commit grouping in "commits" compare mode
- `changed-files.wip` — "Work in progress" node for uncommitted changes
- `changed-files.viewed-badge` — File decoration showing reviewed/unreviewed state
- `changed-files.auto-refresh` — Debounced refresh on git state changes (1s debounce)

## Entry points

- SCM sidebar → "Local HITL Review" view (appears on extension activation)
- Command Palette → `Local HITL Review: Refresh Changed Files`
- Command Palette → `Local HITL Review: View as Tree` / `View as List`
- Tree view toolbar → refresh icon, tree/list toggle icons
- Per-repo context menu → Select Base Branch, Select Compare Mode, Open All Changes, Init Feedback

## How to verify

1. Open a workspace with a git repo that has a feature branch with changes
2. Check SCM sidebar — "Local HITL Review" view should appear
3. Verify files show with correct status icons (M, A, D, R)
4. Toggle tree/list view — verify files regroup correctly
5. Make a git commit — verify view auto-refreshes within ~1 second
6. Mark a file as viewed → verify decoration badge changes
7. For multi-repo: open a workspace with multiple repos, verify each repo appears as a collapsible group

## Gotchas

- First load of multi-repo workspaces is lazy. Repos don't appear until the provider triggers `loadAllRepos()`.
- The auto-refresh debounce is 1 second. Rapid git operations may show stale state briefly.
- File paths use forward slashes internally (`replace(/\\\\/g, '/')`), even on Windows. Path comparison bugs hide on macOS/Linux CI.
- `getNextUnreviewedFile` depends on the viewed state stored in `ExtensionContext.workspaceState` — this state doesn't persist across test runs.

## Source files

- [`changedFilesProvider.ts`](file:///Users/pablo/code/vscode-comment/src/changedFilesProvider.ts) — Main provider
- [`extension.ts`](file:///Users/pablo/code/vscode-comment/src/extension.ts) — Command registrations (lines 72-185, 279-291)
