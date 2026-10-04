# Review Feedback Summary

A second view in the Source Control sidebar lists feedback comments grouped by file, filters them by status and severity, and jumps to a comment's line.

## Sub-features

- `summary-list`: one row per file (`app.ts`, description `1 open comment`) with one child per comment (description `Line 2`, icon coloured by severity), sorted by severity then time.
- `summary-filter`: `Filter Feedback` is a multi-select quick pick of `Status: open|acknowledged|resolved|wontfix` and `Severity: critical|high|medium|low`. Default is `Status: open` only. The filter is shared with the changed-files view.
- `summary-open`: clicking a comment row opens the plain working-tree file (not the diff) at that line.

## How to get to it (user POV)

- Source Control sidebar → `Review Feedback Summary` view (collapsed in a fresh profile).
- The view's title bar has `Filter Feedback`; the palette has `Local HITL Review: Filter Feedback`.

## Driving it with hitl.mjs

Preconditions: one comment created as in [add-comment](./add-comment.md). `S='.pane:has(> .pane-header[aria-label^="Review Feedback Summary"]) .monaco-list-row'`. Verified 2026-10-04.

- **Expand.** `$H click '.pane-header' 'Review Feedback Summary'`, `sleep 1`.
- **List.** `$H text "$S" --aria` prints `src/app.ts` and the comment row; `$H text "$S"` shows `app.ts` / `1 open comment` and `Line 2`. Capture `$H screenshot feedback-summary/list`.
- **Filter.** `$H palette "Local HITL Review: Filter Feedback"`, then `$H click '.quick-input-widget .monaco-list-row' 'Status: open'` (unticks) and `... 'Status: resolved'` (ticks), `$H key enter`. `$H text "$S"` is now empty. Repeat with the two rows swapped to restore.
- **Open.** `$H click "$S" 'Validate'`. `$H text .tab.active --aria` prints `app.ts, preview` and the status bar reads `Ln 2`. Read the status bar after `sleep 2` or from a screenshot: an immediate `$H text '.statusbar-item'` returned a stale `Ln 3, Col 1` while the screenshot showed `Ln 2, Col 1`.

## Gotchas

- Read rows only after the pane has finished expanding (`sleep 1`), and always through the pane-scoped `$S`: `.pane-body .monaco-list-row` mixes in Changes, Graph, Local HITL Review and Comments rows. An earlier run reported this view as "empty" for exactly that reason; the view itself refreshes correctly on save.
- The comment row's label is the first line of the body, which is always the author header `**human**:` — product gap, #85: every row reads `**human**:` instead of the comment text. Match rows by their aria-label, which holds the full body.
- Quick-pick rows report tick state via `.monaco-custom-toggle[aria-checked]`; `, Active` in an aria-label marks an item that is part of the current filter, not the focused one: it stayed on `Status: open` while the focus moved down two rows, and appeared on `Severity: critical` once that filter was applied and the picker reopened. It does not update while you tick items inside an open picker, so read it after reopening.
