# Comment thread actions

Once a comment exists, the reviewer can edit it, delete it, change its severity or status from the comment title bar, attach a code suggestion and apply it, and reply in the thread. Everything except Apply Suggestion rewrites the `.review` file; Apply edits the source file.

## Sub-features

- `thread-edit`: `Edit` (pencil) turns the comment into an editor with `Save`, `Cancel`, `Add Suggestion` buttons. Save rewrites the body.
- `thread-delete`: `Delete` (trash) asks `Delete this review comment?` in a modal (`Cancel` / `Delete`), then removes the `.review` file and the thread. The delete acts on the whole thread: deleting a reply also removes the first comment (see Gotchas).
- `thread-severity`: `Change Severity` (warning icon) offers `🔴 Critical`, `🟠 High`, `🟡 Medium`, `🟢 Low`. The thread header follows, e.g. `🔴 Critical — open`.
- `thread-status`: `Change Status` offers `✅ Resolved`, `❌ Won't Fix`, `🔄 Open`. A non-open thread collapses; re-expanded its header reads `✅ 🔴 Critical — resolved`, or `❌ 🔴 Critical — wontfix` for Won't Fix (the file value is `wontfix`).
- `thread-suggestion`: a body containing a fenced block ```` ```suggestion ```` (closing fence at column 0) can be applied with `Apply Suggestion`, which replaces the commented lines in the open buffer (unsaved) and toasts `Suggestion applied successfully.`; without a block it errors `No suggestion block found in this comment.`
- `thread-reply`: replying appends `___\n**human**:\n<text>` to the body and sets `status: open`.

## How to get to it (user POV)

- Comment title bar inside the inline thread: Apply Suggestion (check), Change Severity (warning), Change Status, Delete (trash), Edit (pencil).
- The reply box `Reply...` under the thread, with `Add Review Comment`, `Add Suggestion`, `Cancel`.
- A collapsed thread re-opens from its gutter glyph.

## Driving it with hitl.mjs

Preconditions: one comment created as in [add-comment](./add-comment.md), its diff open and thread expanded. `C1='.review-widget .review-comment:nth-child(1)'`. Verified 2026-10-04.

- **Severity.** `$H click '.review-widget .action-label' 'Change Severity'`, `$H click '.context-view .action-label' 'Critical'`. `$H feedback thread-actions/severity` shows `severity: critical`; `$H text '.review-widget .head'` prints `🔴 Critical — open`.
- **Status.** Same with `Change Status` → `Resolved`: `status: resolved`, the thread collapses, the changed-files badge goes from `1` back to `M`. Re-open with `$H click '.comment-range-glyph.comment-thread'` after a `sleep 2`: the glyph's class lags behind the state change, and `.comment-thread-unresolved` can show for a moment. Read the status menu with `$H eval "[...document.querySelectorAll('.context-view .action-label')].map(e=>e.textContent.trim()).join(' | ')"`, which prints `✅ Resolved | ❌ Won't Fix | 🔄 Open`; click `🔄 Open` by its full label.
- **Reply.** `$H click '.review-widget .comment-form'`, `sleep 1`, `$H eval '!!document.activeElement?.closest(".review-widget")'` prints `true`, `$H type "Also reject NaN."`, `$H key cmd+enter` (or `$H click '.review-widget .monaco-button' 'Add Review Comment'`). The body gains `___`, `**human**:`, the text; status returns to `open`.
- **Edit.** `$H click "$C1 .action-label" 'Edit'`, `$H key cmd+a`, `$H type "<new text>"`, `$H click '.review-widget .monaco-button' 'Save'`. The first body segment changes.
- **Suggestion.** Edit a comment and replace its text in one `type` call: `$H type $'Use a guard.\n```suggestion\nif (!Number.isFinite(a + b)) throw new Error("bad");\n```'`, then Save. Click that comment's `Apply Suggestion`; the tab turns dirty. Click into the editor, `$H key cmd+s`, and `git -C "$WS" diff -- src/app.ts` shows line 2 replaced. Reset with `git -C "$WS" checkout -- src/app.ts`.
- **Delete.** Use `$C1 .action-label` (or the nth-child of the comment you mean; both delete the whole thread, see Gotchas). `$H click "$C1 .action-label" 'Delete'`, `$H click '.monaco-dialog-box .monaco-button' 'Delete'`. `.feedback/` keeps only `.gitignore`, `AGENTS.md`, `review_template.md`; the Comments panel reads `There are no comments in this workspace yet.`

## Gotchas

- With several comments in a thread, scope title actions with `.review-comment:nth-child(N)`; comment 1's toolbar may not be rendered, so an unscoped `Edit` hits comment 2.
- Typing a suggestion line by line fails: Monaco auto-indents the closing fence (`  ```` `) and auto-closes backticks, and the parser then finds no block (#87). Type the whole body in one `type` call with an unindented code line: even in one call, an indented code line makes Monaco indent the closing fence too, and Apply then toasts `No suggestion block found in this comment.` (verified 2026-10-04).
- **Deleting any comment in a thread deletes the whole thread** — product wart. Every comment of a thread shares one `feedbackId` (`commentController.ts` `deleteComment` → `store.delete(comment.feedbackId)` unlinks the `.review` file), so `Delete` on a reply, behind the modal text `Delete this review comment?`, removes the first comment and the reply. Verified 2026-10-04: after deleting comment 2 of 2, `.feedback/` held no `.review` file.
- The first `Change Status` click right after re-expanding a collapsed thread, or after a failed menu lookup, can leave no menu open. `$H key escape` and click again, and check the menu exists before clicking an item. If it never opens, `stop` and `launch` again.
- `Add Suggestion` clicked with the mouse while editing does **not** insert the template — product gap, #86. The click moves focus off the comment input, so the extension falls back to copying the template to the system clipboard (`Suggestion copied — paste into your comment.`) and the edit ends. Back up the clipboard first.
- Apply Suggestion leaves the buffer unsaved; there is no file change until the user saves.
- A thread whose comment is being edited is not re-rendered by external file changes. Finish or cancel the edit before testing sync behavior.
