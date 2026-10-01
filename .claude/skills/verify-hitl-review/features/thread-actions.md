# Comment thread actions

Once a comment exists, the reviewer can edit it, delete it, change its severity or status from the comment title bar, attach a code suggestion and apply it, and reply in the thread. Everything except Apply Suggestion rewrites the `.review` file; Apply edits the source file.

## Sub-features

- `thread-edit`: `Edit` (pencil) turns the comment into an editor with `Save`, `Cancel`, `Add Suggestion` buttons. Save rewrites the body.
- `thread-delete`: `Delete` (trash) asks `Delete this review comment?` in a modal (`Cancel` / `Delete`), then removes the `.review` file and the thread.
- `thread-severity`: `Change Severity` (warning icon) offers `🔴 Critical`, `🟠 High`, `🟡 Medium`, `🟢 Low`. The thread header follows, e.g. `🔴 Critical — open`.
- `thread-status`: `Change Status` offers `✅ Resolved`, `❌ Won't Fix`, `🔄 Open`. A non-open thread collapses; re-expanded its header reads `✅ 🔴 Critical — resolved`.
- `thread-suggestion`: a body containing a fenced block ```` ```suggestion ```` (closing fence at column 0) can be applied with `Apply Suggestion`, which replaces the commented lines in the open buffer (unsaved) and toasts `Suggestion applied successfully.`; without a block it errors `No suggestion block found in this comment.`
- `thread-reply`: replying appends `___\n**human**:\n<text>` to the body and sets `status: open`.

## How to get to it (user POV)

- Comment title bar inside the inline thread: Apply Suggestion (check), Change Severity (warning), Change Status, Delete (trash), Edit (pencil).
- The reply box `Reply...` under the thread, with `Add Review Comment`, `Add Suggestion`, `Cancel`.
- A collapsed thread re-opens from its gutter glyph.

## Driving it with hitl.mjs

Preconditions: one comment created as in [add-comment](./add-comment.md), its diff open and thread expanded. `C1='.review-widget .review-comment:nth-child(1)'`. Verified 2026-10-02.

- **Severity.** `$H click '.review-widget .action-label' 'Change Severity'`, `$H click '.context-view .action-label' 'Critical'`. `$H feedback thread-actions/severity` shows `severity: critical`; `$H text '.review-widget .head'` prints `🔴 Critical — open`.
- **Status.** Same with `Change Status` → `Resolved`: `status: resolved`, the thread collapses, the changed-files badge goes from `1` back to `M`. Re-open with `$H click '.comment-range-glyph.comment-thread'`.
- **Reply.** `$H click '.review-widget .comment-form'`, `$H type "Also reject NaN."`, `$H key cmd+enter` (or `$H click '.review-widget .monaco-button' 'Add Review Comment'`). The body gains `___`, `**human**:`, the text; status returns to `open`.
- **Edit.** `$H click "$C1 .action-label" 'Edit'`, `$H key cmd+a`, `$H type "<new text>"`, `$H click '.review-widget .monaco-button' 'Save'`. The first body segment changes.
- **Suggestion.** Edit a comment and replace its text in one `type` call: `$H type $'Use a guard.\n```suggestion\nif (!Number.isFinite(a + b)) throw new Error("bad");\n```'`, then Save. Click that comment's `Apply Suggestion`; the tab turns dirty. Click into the editor, `$H key cmd+s`, and `git -C "$WS" diff -- src/app.ts` shows line 2 replaced. Reset with `git -C "$WS" checkout -- src/app.ts`.
- **Delete.** `$H click '.review-widget .action-label' 'Delete'`, `$H click '.monaco-dialog-box .monaco-button' 'Delete'`. `.feedback/` keeps only `.gitignore`, `AGENTS.md`, `review_template.md`; the Comments panel reads `There are no comments in this workspace yet.`

## Gotchas

- With several comments in a thread, scope title actions with `.review-comment:nth-child(N)`; comment 1's toolbar may not be rendered, so an unscoped `Edit` hits comment 2.
- Typing a suggestion line by line fails: Monaco auto-indents the closing fence (`  ```` `) and auto-closes backticks, and the parser then finds no block (#87). Type the whole body in one `type` call with an unindented code line.
- `Add Suggestion` clicked with the mouse while editing does **not** insert the template — product gap, #86. The click moves focus off the comment input, so the extension falls back to copying the template to the system clipboard (`Suggestion copied — paste into your comment.`) and the edit ends. Back up the clipboard first.
- Apply Suggestion leaves the buffer unsaved; there is no file change until the user saves.
- A thread whose comment is being edited is not re-rendered by external file changes. Finish or cancel the edit before testing sync behavior.
