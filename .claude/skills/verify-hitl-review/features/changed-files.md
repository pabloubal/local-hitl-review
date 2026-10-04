# Changed files view

The Local HITL Review view in the Source Control sidebar lists files changed against a base branch, either as a tree or a flat list. Users open diffs from it, mark files as viewed, switch the base branch, and switch between comparing the whole branch and individual commits.

## Sub-features

- `files-list`: rows carry a decoration badge with the status letter (`M`, `A`, `D`, `R`, `C`); a file with comments that pass the Filter Feedback filter (open only by default) shows their count instead of the letter, and goes back to the letter when the last one is resolved. The header shows `vs <base>`.
- `files-layout`: `View as Tree` and `View as List` toggle the layout. The tree has a `src` folder row; the list has none.
- `files-open`: clicking an `M`/`R`/`C` row opens a `<file> (vs <base> ↔ Working)` diff. An `A` row opens the plain file (tab `new.ts`), a `D` row the old version. `Open Changes` opens a multi-diff `All Changes (vs <base>) (N files)`.
- `files-viewed`: in the tree layout the inline check `Mark as Viewed` toggles to `Unmark as Viewed` (the list layout does not, see Gotchas). State lives in workspaceState, nothing on disk. `Next Unreviewed File` opens the next unviewed diff.
- `files-base`: `Select Base Branch` opens the quick pick `Base Branch`, listing local branches except the current one, with the current base marked `(current base)`.
- `files-mode`: `Compare Mode` offers `Entire branch` and `Commits (Graph)`. In commits mode the header reads `commits vs <base>`, rows are labelled `<sha> - <subject>` with `By <author> (<age>)` (that is the aria-label; the visible row is the subject plus `<author> • <age>`), each with an inline `Open Changes`.

## How to get to it (user POV)

- Source Control sidebar → `Local HITL Review` view. Title bar: refresh, tree/list, open changes, base branch, compare mode, filter, Initialize Feedback Workspace, Copy Agent Prompt, Approve / Finish Review (narrow sidebars collapse some into `...`).
- Command palette: `Local HITL Review: Refresh Changed Files`, `View as List`, `View as Tree`, `Open Changes`, `Next Unreviewed File`, `Select Base Branch`, `Compare Mode`.
- Keybindings Alt+N, Alt+O, Alt+M are declared but do not fire (see Gotchas).

## Driving it with hitl.mjs

Preconditions: baseline. `P='.pane:has(> .pane-header[aria-label^="Local HITL Review"]) .monaco-list-row'`. Verified 2026-10-04.

- **List.** `$H text "$P" --aria` prints `src`, `M src/app.ts, has actions`, `A src/new.ts, has actions`; `$H text .pane-header --aria` includes `Local HITL Review - vs main Section`.
- **Layout.** `$H palette "Local HITL Review: View as List"`, `sleep 0.7`, read `$P` again: the `src` row is gone. `$H palette "Local HITL Review: View as Tree"` restores it.
- **Open.** `$H click "$P" 'A src/new.ts'`, then `$H text .tab.active --aria` prints `new.ts, preview`. `$H click "$P" 'M src/app.ts'` gives `app.ts (vs main ↔ Working) (app.ts), preview`.
- **Viewed (tree layout).** The inline action is hidden until the row has focus, so click the row first: `$H click "$P" 'M src/app.ts'`, `sleep 1`, then `$H click "$P"'[aria-label^="M src/app.ts"] .action-label' 'Mark as Viewed'`. The action's aria-label reads `Mark as Viewed (⌥M)` before and `Unmark as Viewed` after; click that to restore.
- **Next / all.** `$H palette "Local HITL Review: Next Unreviewed File"` opens the `app.ts` diff. `$H palette "Local HITL Review: Open Changes"` opens `All Changes (vs main) (2 files)`.
- **Base branch.** `$H palette "Local HITL Review: Select Base Branch"`, then `$H text '.quick-input-widget .monaco-list-row' --aria` prints only `main, (current base)`. `$H key escape`.
- **Compare mode.** `$H palette "Local HITL Review: Compare Mode"`, `$H click '.quick-input-widget .monaco-list-row' 'Commits'`. The header becomes `commits vs main` and `$H text "$P" --aria` shows `<sha> - feature work` / `By verify (<age>)`; the visible text is `feature work` and `verify • <age>`. Switch back with `Compare Mode` → `Entire branch`.

## Gotchas

- **Alt+N, Alt+O, Alt+M (and Alt+C) never fire** — product gap, #84. Their when-clause is `vscodeComment.changedFiles.focus || commentController == vscode-comment`; with the view focused, VS Code's keybinding trace logs `From 2 keybinding entries, no when clauses matched the context`. Alt+M would also do nothing if it fired, because `markViewed` needs a tree-item argument. Use the palette or the inline actions.
- **Mark as Viewed does nothing visible in the list layout** — product gap. `markViewed` stores the state under the key `commitHash || "UNCOMMITTED"` (`extension.ts` `vscodeComment.file.markViewed`), the tree reads that key, but list rows in branch mode read `repo.compareRef` (`changedFilesProvider.ts`), so the action stays `Mark as Viewed (⌥M)` even after a Refresh. Verified live 2026-10-04: after `Mark as Viewed` in the list layout the row still read `Mark as Viewed (⌥M)` (also after `Refresh Changed Files`), but switching to the tree layout showed the same file as `Unmark as Viewed`, so the state was written and only the list does not read it. Drive the viewed state in the tree layout. `Next Unreviewed File` reads `compareRef` too (`changedFilesProvider.ts`), so by the source it ignores marks made through the inline action; that part is *(unverified live)* because the app.ts diff was already the open file when it was tried.
- The inline row actions (`Mark as Viewed`) only render once the row has focus; before that the lookup reports no visible element.
- Clicking a row opens the diff and moves focus to the editor. To focus the tree, run `$H palette "Source Control: Focus on Local HITL Review View"`.
- The extension activates only after this view becomes visible. `launch` expands it, but collapsing it and reloading means expanding it again.
- The fixture has a single feature commit. To test commit-mode ordering, add commits with `git -C "$WS" commit` and then run `Refresh Changed Files`.
