# Comment thread actions

Once a comment exists, the reviewer can edit it, delete it, change its severity or status from the comment title bar, attach a code suggestion and apply it, and reply in the thread. Each action rewrites the `.review` file.

## Sub-features

- `thread-edit`: `Edit` (pencil) switches the comment into an editor, and `Save` or `Cancel` ends editing.
- `thread-delete`: `Delete` (trash) removes the thread and its `.review` file.
- `thread-severity`: the severity menu offers `🔴 Critical`, `🟠 High`, `🟡 Medium`, `🟢 Low`.
- `thread-status`: the status menu offers `🔄 Open`, `✅ Resolved`, `❌ Won't Fix`.
- `thread-suggestion`: `Add Suggestion` in the widget or while editing, and `Apply Suggestion` writes the suggested code into the file.
- `thread-reply`: replying appends `___\n**human**:\n<text>` to the body and reopens the thread.

## How to get to it (user POV)

- Icons on the comment title bar inside the inline thread (shown in `add-comment/03` screenshots): check, warning, suggestion, trash, pencil.
- The thread's reply box `Type a new comment`, plus the `Add Suggestion` and `Add Review Comment` buttons.

## Driving it with hitl.mjs

Preconditions: one comment created as in [add-comment](./add-comment.md), with its thread expanded. *(unverified)*

- **Find the actions.** `$H text '.review-widget .action-label' --aria` lists the title-bar action names. Use those exact names with `$H click '.review-widget .action-label' '<name>'`.
- **Severity.** Click the severity action, then `$H text '.context-view .action-label' --aria`, then `$H click '.context-view .action-label' 'Critical'`. Afterwards `$H feedback thread-actions/severity` shows `severity: critical` and the header shows `🔴 Critical`.
- **Status.** Do the same with the status action and choose `Resolved`. The `.review` file shows `status: resolved`.
- **Reply.** Click the reply box (`$H click '.review-widget .monaco-editor' 'Type a new comment'`), type text, and press `cmd+enter`. The body gains a `___` separator followed by `**human**:` and the reply.
- **Delete.** Click `Delete`. The `.review` file disappears from `$H feedback`, and the Comments panel count drops.

## Gotchas

- These menus are context menus (`.context-view`), not quick picks. Press `escape` to close one you opened by mistake.
- Applying a suggestion edits the fixture file. Run `git -C "$WS" diff` as proof, then `git -C "$WS" checkout -- .` to reset.
- A thread whose comment is being edited is not re-rendered by external file changes. Finish or cancel the edit before testing sync behavior.
