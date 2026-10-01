# Feedback workspace and handoff

The extension stores review state as files under `.feedback/` (setting `vscodeComment.feedbackDirectory`) so coding agents can read and answer it. Users initialize the workspace, copy a prompt for their agent, and finish the review. When an agent edits or deletes `.review` files, the threads update live.

## Sub-features

- `ws-init`: on activation, or through `Initialize Feedback Workspace` (notification `Local HITL Review workspace initialized (.feedback directory created).`), the extension creates `.feedback/AGENTS.md` (name from setting `agentsFile`), `.feedback/review_template.md`, and `.feedback/.gitignore` containing `*`.
- `ws-prompt`: `Copy Agent Prompt` puts a prompt on the system clipboard and notifies `Copied agent prompt to clipboard`. With no open comments it is just `@.feedback/AGENTS.md`; otherwise `Review feedback: 0 critical, 1 high, 0 medium, 0 low — 1 open finding across 1 file`, a `- src/app.ts (1 high)` line per file, then `@.feedback/AGENTS.md`.
- `ws-finish`: `Approve / Finish Review` always writes `.feedback/review-complete.md` (`# Review Complete`, date, severity counts, `## Open Findings` with `- [high] src/app.ts:2`) and notifies `Review finished. Summary generated.` There is no separate approval message when nothing is open.
- `ws-sync`: external edits to a `.review` file (status `acknowledged`, appended replies, deletion) reload every thread. A non-open status collapses the thread; deletion removes it.

## How to get to it (user POV)

- Title bar of the Local HITL Review view: `Initialize Feedback Workspace`, `Copy Agent Prompt`, `Approve / Finish Review`. The palette shows them prefixed `Local HITL Review: `.
- The Comments panel title bar also has `Copy Agent Prompt`.
- An agent, or any editor, changing files in `.feedback/`.

## Driving it with hitl.mjs

Preconditions: baseline; clipboard backed up (`pbpaste > "$HITL_RUN/clip.bak"`). `WS` is the `workspace` field from `launch`, `E="$HITL_RUN/evidence/feedback-workspace"`. Verified 2026-10-02.

- **Init.** `ls -A "$WS/.feedback"` shows `.gitignore AGENTS.md review_template.md` right after launch. `$H palette "Local HITL Review: Initialize Feedback Workspace"` is idempotent.
- **Copy prompt.** `$H palette "Local HITL Review: Copy Agent Prompt"`, `sleep 0.5`, `pbpaste > "$E/prompt.txt"`. Compare with the shapes above (empty vs. one open comment from [add-comment](./add-comment.md)).
- **Finish review.** `$H palette "Local HITL Review: Approve / Finish Review"`, `sleep 1`, `cp "$WS/.feedback/review-complete.md" "$E/"`.
- **Notifications.** Toasts auto-hide before you can read them: `$H palette "Notifications: Show Notifications"`, `$H text '.notifications-center .notification-list-item-message'`, `$H key escape`.
- **Agent sync.** With one open comment: `sed -i '' 's/status: open/status: acknowledged/' "$WS"/.feedback/*.review`. Within ~1.5s the thread collapses, the changed-files badge goes back to `M`, and Copy Agent Prompt yields the bare `@.feedback/AGENTS.md`. `rm "$WS"/.feedback/*.review` removes the thread (`.review-widget .review-comment` count 0).
- **Restore the clipboard.** `pbcopy < "$HITL_RUN/clip.bak"`.

## Gotchas

- `Copy Agent Prompt` writes to the real macOS clipboard, which the user shares. Always back up and restore.
- `ws-sync` is the one feature where editing `.review` files by hand is the correct user path, because it stands in for the agent.
- `review-complete.md` dates are UTC ISO timestamps.
- `feedbackScope: local` (multi-repo) stores feedback per repository, and the single-repo fixture does not exercise it.
