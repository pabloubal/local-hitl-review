# Comment Lifecycle

## Sub-features

- `comment.create` — Create a new review comment on a line range
- `comment.reply` — Reply to an existing thread (re-opens the issue, appends delimited body)
- `comment.edit` — Switch to editing mode
- `comment.save` — Save edited comment (handles both draft and existing)
- `comment.delete` — Delete with confirmation dialog
- `comment.cancel-edit` — Revert to saved body
- `comment.discard-draft` — Dispose empty reply thread without saving
- `comment.severity-shorthand` — Parse `/critical`, `/high`, `/medium`, `/low` prefix from body
- `comment.thread-sync` — Bi-directional sync between `.review` files and VS Code comment threads
- `comment.active-edit-guard` — Skip sync for threads with unsaved edits to prevent data loss

## Entry points

- Right-click a line in a diff view → "Add Comment" (VS Code native commenting range)
- Comment thread toolbar → Create, Reply, Edit, Save, Cancel, Delete buttons
- Context menu on comment → Set Severity (Critical/High/Medium/Low), Set Status (Open/Resolved/Wontfix)

## How to verify

1. Open a diff, select a line range, type a comment → verify `.review` file created in `.feedback/`
2. Open the `.review` file → verify YAML frontmatter has correct severity, status, file, lines
3. Reply to the comment → verify `___` delimiter appended to body, status reset to `open`
4. Edit and save → verify `.review` file updated
5. Delete → verify `.review` file removed, thread disposed
6. Externally edit the `.review` file (simulating an agent) → verify thread updates in real-time
7. Type `/critical This is a test` — verify severity is set correctly and the prefix is removed from the body

## Gotchas

- **Known bug (bug_issue.md):** Deleting a reply deletes the entire thread, not just the reply.
- Thread sync skips threads with `isDraft` or `CommentMode.Editing` to avoid destroying unsaved input.
- `getRelativePath` does longest-prefix matching for nested repos. If repo roots overlap incorrectly, comments land in the wrong `.feedback/` directory.
- `comment.lines` converts VS Code's 0-indexed ranges to 1-indexed for the `.review` file frontmatter.

## Source files

- [`commentController.ts`](file:///Users/pablo/code/vscode-comment/src/commentController.ts) — VS Code Comment API implementation
- [`extension.ts`](file:///Users/pablo/code/vscode-comment/src/extension.ts) — Command handlers (lines 714-858)
- [`parser.ts`](file:///Users/pablo/code/vscode-comment/src/parser.ts) — Frontmatter and range parsing
