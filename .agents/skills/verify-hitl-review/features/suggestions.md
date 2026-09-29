# Suggestions

## Sub-features

- `suggestion.create` — Create a comment pre-filled with \`\`\`suggestion block containing original source lines
- `suggestion.insert` — Insert suggestion template into an existing comment being edited
- `suggestion.apply` — Apply the suggestion diff to the source file

## Entry points

- Comment thread toolbar → "Add Suggestion" button (`vscodeComment.createCommentWithSuggestion`)
- Comment editing toolbar → "Insert Suggestion" button (`vscodeComment.insertSuggestionIntoComment`)
- Comment context menu → "Apply Suggestion" (`vscodeComment.applySuggestion`)

## How to verify

1. Select a line range, click "Add Suggestion" → verify template contains original source lines from the target document
2. Edit the suggestion block, save → verify `.review` file contains the \`\`\`suggestion block
3. Click "Apply Suggestion" → verify source file is edited with the suggestion text
4. Check the line range replacement — `parseLineRange` converts 1-indexed to `Range(start-1, 0, end, 0)`

## Gotchas

- The `end` line in `edit.replace` is exclusive (range goes to `end, 0`), meaning the replacement includes line `end`. Off-by-one errors here silently corrupt the file.
- `insertSuggestionIntoComment` falls back to the clipboard if the active editor isn't a comment input (`commentinput` scheme). This is a workaround for VS Code API limitations, not reliable.
- If the original file cannot be read, the template defaults to `// Could not read source lines`.

## Source files

- [`commentController.ts`](file:///Users/pablo/code/vscode-comment/src/commentController.ts) — Suggestion logic (lines 118-174, 266-331)
- [`extension.ts`](file:///Users/pablo/code/vscode-comment/src/extension.ts) — Command registrations (lines 724-740, 770-776)
