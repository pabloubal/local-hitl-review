# Changed files view

The Local HITL Review view in the Source Control sidebar lists files changed against a base branch, either as a tree or a flat list. Users open diffs from it, mark files as viewed, switch the base branch, and switch between comparing the whole branch and individual commits.

## Sub-features

- `files-list`: rows show status letters (`M`, `A`, `D`) and comment counts, and the header shows `vs <base>`.
- `files-layout`: `View as Tree` and `View as List` toggle the layout.
- `files-open`: clicking a row opens a `<file> (vs <base> ↔ Working)` diff. `Open Changes` (Alt+O) opens every diff.
- `files-viewed`: `Mark as Viewed` (Alt+M, or the inline check) and `Unmark as Viewed`. `Next Unreviewed File` (Alt+N).
- `files-base`: `Select Base Branch` opens a quick pick of local branches.
- `files-mode`: `Compare Mode` switches between `branch` and `commits`. In commits mode, the commit graph rows have an `Open Changes` action.

## How to get to it (user POV)

- Source Control sidebar → `Local HITL Review` view (title-bar icons: refresh, tree or list, open changes, base branch, compare mode).
- Command palette: `Local HITL Review: Refresh Changed Files`, `Local HITL Review: View as List`, `Local HITL Review: Select Base Branch`, `Local HITL Review: Compare Mode`.
- Keybindings Alt+N, Alt+O, and Alt+M while the view or a review diff has focus.

## Driving it with hitl.mjs

Preconditions: baseline. *(unverified: run it once and fix any step that fails)*

- **List.** `$H text '.pane-body .monaco-list-row' --aria` includes `M src/app.ts, has actions` and `A src/new.ts, has actions`.
- **Layout.** `$H palette "Local HITL Review: View as List"`, then read the rows again. `src` is no longer a parent row. Run `View as Tree` to restore it.
- **Open a diff.** `$H click '.pane-body .monaco-list-row' 'A src/new.ts'`. The tab aria-label contains `new.ts`.
- **Viewed.** With the row selected, `$H key alt+m`. The row shows a check, and `$H screenshot changed-files/viewed` captures it. Unmark it with the inline action.
- **Base branch.** `$H palette "Local HITL Review: Select Base Branch"`, then `$H text '.quick-input-widget .monaco-list-row' --aria` lists `main` but not the current branch. Press `escape`.
- **Compare mode.** `$H palette "Local HITL Review: Compare Mode"`, pick the commits option, and confirm the tree shows the commit `feature work`.

## Gotchas

- The extension activates only after this view becomes visible. `launch` expands it, but collapsing it and reloading means expanding it again.
- The Alt keybindings only fire when the view or a review comment controller has focus. Click a row first.
- The fixture has a single feature commit. To test commit-mode ordering, add commits to the fixture with `git -C "$WS" commit` and then run `Refresh Changed Files`.
