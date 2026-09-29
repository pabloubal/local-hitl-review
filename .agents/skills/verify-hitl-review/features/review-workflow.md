# Review Workflow

## Sub-features

- `review.init-workspace` — Create `.feedback/` directory with `REVIEW_template.md` and `.gitignore` at global workspace level
- `review.init-repo` — Create per-repo `.feedback/` with `AGENTS.md`
- `review.finish` — Generate `review-complete.md` summary per repo
- `review.copy-prompt` — Copy agent prompt to clipboard
- `review.set-feedback-dir` — Configure custom feedback directory path in workspace settings
- `review.next-unreviewed` — Jump to next file without "viewed" mark in the changed files view

## Entry points

- Command Palette → `Local HITL Review: Initialize Feedback Workspace`
- Repo node context menu → Init Feedback
- Command Palette → `Local HITL Review: Finish Review`
- Toolbar → "Copy Agent Prompt"
- Toolbar → "Next Unreviewed File"

## How to verify

1. Run "Initialize Feedback Workspace" → verify `.feedback/` created with `.gitignore` and `REVIEW_template.md`
2. Create 3 comments (1 critical, 1 high, 1 medium), run "Finish Review" → verify `review-complete.md` has correct counts
3. "Copy Agent Prompt" → paste from clipboard, verify it references `.feedback/AGENTS.md` and lists open comments
4. Mark 2 of 3 files as viewed, run "Next Unreviewed" → verify it opens the unviewed file
5. Change feedback directory via command → verify settings.json updates and comments are read/written to new location

## Gotchas

- Global vs Local scope: By default, multi-root workspaces use global scope (`workspaceRoot/.feedback`). Overriding this to local scope per repo requires changing `vscodeComment.feedbackDirectory`.
- Finish Review overwrites `review-complete.md` silently. It groups comments by `repoRoot`.
- `Next Unreviewed` depends on the `changedFilesProvider` correctly ordering the files and `filterState` not hiding the target file.

## Source files

- [`extension.ts`](file:///Users/pablo/code/vscode-comment/src/extension.ts) — Command handlers (lines 141-159, 295-306, 392-486, 624-649)
- [`feedbackStore.ts`](file:///Users/pablo/code/vscode-comment/src/feedbackStore.ts) — Storage logic, init logic, scope resolution
- [`promptGenerator.ts`](file:///Users/pablo/code/vscode-comment/src/promptGenerator.ts) — Prompt building logic
