# Review Feedback Summary

A second view in the Source Control sidebar groups all feedback comments, for example by file or severity, and lets the user filter them by status and severity and jump to a thread.

## Sub-features

- `summary-list`: every `.review` comment appears as a row.
- `summary-filter`: `Filter Feedback` limits rows by status or severity. The same filter applies to the changed-files view.
- `summary-open`: clicking a row reveals the thread in its diff.

## How to get to it (user POV)

- Source Control sidebar → `Review Feedback Summary` view (collapsed by default).
- The view's title bar has `Filter Feedback` and collapse-all.

## Driving it with hitl.mjs

Preconditions: one comment created as in [add-comment](./add-comment.md). *(unverified)*

- **Expand.** `$H click '.pane-header' 'Review Feedback Summary'`.
- **List.** `$H text '.pane-body .monaco-list-row' --aria` should include a row for the comment. Capture `$H screenshot feedback-summary/list`.
- **Filter.** `$H palette "Local HITL Review: Filter Feedback"` opens a quick pick. Choose a status that excludes the comment, and the row disappears.

## Gotchas

- During the first verification run (2026-10-01), the view stayed **empty** after a comment was saved, while the Comments panel and the `.review` file both showed the comment. Find out whether it needs a refresh or this is a bug before treating "empty" as a pass or a failure.
