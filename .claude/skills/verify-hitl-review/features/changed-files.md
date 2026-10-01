# Changed files view

The Local HITL Review view in the Source Control sidebar lists files changed against a base branch, either as a tree or a flat list. Users open diffs from it, mark files as viewed, switch the base branch, and switch between comparing the whole branch and individual commits.

## Sub-features

- `files-list`: rows carry a decoration badge with the status letter (`M`, `A`, `D`, `R`, `C`); a file with open comments shows the open-comment count instead of the letter. The header shows `vs <base>`.
- `files-layout`: `View as Tree` and `View as List` toggle the layout. The tree has a `src` folder row; the list has none.
- `files-open`: clicking an `M`/`R`/`C` row opens a `<file> (vs <base> ↔ Working)` diff. An `A` row opens the plain file (tab `new.ts`), a `D` row the old version. `Open Changes` opens a multi-diff `All Changes (vs <base>) (N files)`.
- `files-viewed`: the inline check `Mark as Viewed` toggles to `Unmark as Viewed`. State lives in workspaceState, nothing on disk. `Next Unreviewed File` opens the next unviewed diff.
- `files-base`: `Select Base Branch` opens the quick pick `Base Branch`, listing local branches except the current one, with the current base marked `(current base)`.
- `files-mode`: `Compare Mode` offers `Entire branch` and `Commits (Graph)`. In commits mode the header reads `commits vs <base>`, rows are `<sha> - <subject>` with `By <author> (<age>)`, each with an inline `Open Changes`.

## How to get to it (user POV)

- Source Control sidebar → `Local HITL Review` view. Title bar: refresh, tree/list, open changes, base branch, compare mode, filter, Initialize Feedback Workspace, Copy Agent Prompt, Approve / Finish Review (narrow sidebars collapse some into `...`).
- Command palette: `Local HITL Review: Refresh Changed Files`, `View as List`, `View as Tree`, `Open Changes`, `Next Unreviewed File`, `Select Base Branch`, `Compare Mode`.
- Keybindings Alt+N, Alt+O, Alt+M are declared but do not fire (see Gotchas).

## Driving it with hitl.mjs

Preconditions: baseline. `P='.pane:has(> .pane-header[aria-label^="Local HITL Review"]) .monaco-list-row'`. Verified 2026-10-02.

- **List.** `$H text "$P" --aria` prints `src`, `M src/app.ts, has actions`, `A src/new.ts, has actions`; `$H text .pane-header --aria` includes `Local HITL Review - vs main Section`.
- **Layout.** `$H palette "Local HITL Review: View as List"`, `sleep 0.7`, read `$P` again: the `src` row is gone. `$H palette "Local HITL Review: View as Tree"` restores it.
- **Open.** `$H click "$P" 'A src/new.ts'`, then `$H text .tab.active --aria` prints `new.ts, preview`. `$H click "$P" 'M src/app.ts'` gives `app.ts (vs main ↔ Working) (app.ts), preview`.
- **Viewed.** `$H click "$P"'[aria-label^="M src/app.ts"] .action-label' 'Mark as Viewed'`; the row's action now reads `Unmark as Viewed`. Click that to restore.
- **Next / all.** `$H palette "Local HITL Review: Next Unreviewed File"` opens the `app.ts` diff. `$H palette "Local HITL Review: Open Changes"` opens `All Changes (vs main) (2 files)`.
- **Base branch.** `$H palette "Local HITL Review: Select Base Branch"`, then `$H text '.quick-input-widget .monaco-list-row' --aria` prints only `main, (current base)`. `$H key escape`.
- **Compare mode.** `$H palette "Local HITL Review: Compare Mode"`, `$H click '.quick-input-widget .monaco-list-row' 'Commits'`. The header becomes `commits vs main` and `$P` shows `<sha> - feature work`. Switch back with `Compare Mode` → `Entire branch`.

## Gotchas

- **Alt+N, Alt+O, Alt+M (and Alt+C) never fire** — product gap, #84. Their when-clause is `vscodeComment.changedFiles.focus || commentController == vscode-comment`; with the view focused, VS Code's keybinding trace logs `From 2 keybinding entries, no when clauses matched the context`. Alt+M would also do nothing if it fired, because `markViewed` needs a tree-item argument. Use the palette or the inline actions.
- Clicking a row opens the diff and moves focus to the editor. To focus the tree, run `$H palette "Source Control: Focus on Local HITL Review View"`.
- The extension activates only after this view becomes visible. `launch` expands it, but collapsing it and reloading means expanding it again.
- The fixture has a single feature commit. To test commit-mode ordering, add commits with `git -C "$WS" commit` and then run `Refresh Changed Files`.
