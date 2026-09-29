# Feedback Summary View & Filtering

## Sub-features

- `summary.tree` — Tree view showing comments grouped by file
- `summary.severity-filter` — Filter by severity (Critical, High, Medium, Low)
- `summary.status-filter` — Filter by status (Open, Acknowledged, Resolved, Wontfix)
- `summary.navigate` — Click to jump to comment location
- `filter.multi-select` — QuickPick with `canPickMany: true`
- `filter.empty-passthrough` — If no filters selected for a category, show all

## Entry points

- SCM sidebar → "Review Feedback Summary" view
- Command Palette → `Local HITL Review: Filter Feedback`
- Filter icon in feedback summary toolbar

## How to verify

1. Create comments with different severities and statuses across multiple files
2. Verify Feedback Summary view groups them correctly under file nodes
3. Click a comment node → verify the file opens to the correct line range
4. Open filter, select only "critical" + "open" → verify only matching comments shown in view
5. Deselect all → verify all comments shown (empty = no filter)
6. Verify filtering applies to BOTH the Changed Files view decorations and the Feedback Summary view

## Gotchas

- Filter states are kept in memory (`FilterState` singleton) and do not persist across VS Code reloads.
- A filter applies if `severities.has()` OR `statuses.has()` match, but if a category is empty (e.g., no severities selected), it acts as a wildcard for that category.
- When clicking a comment node to navigate, it opens the absolute file path. If the file is only available via git history (e.g., deleted), navigation fails.

## Source files

- [`feedbackSummaryProvider.ts`](file:///Users/pablo/code/vscode-comment/src/feedbackSummaryProvider.ts) — Tree view provider
- [`filterState.ts`](file:///Users/pablo/code/vscode-comment/src/filterState.ts) — Filter logic singleton
- [`extension.ts`](file:///Users/pablo/code/vscode-comment/src/extension.ts) — Command handlers (lines 58-70, 234-277)
