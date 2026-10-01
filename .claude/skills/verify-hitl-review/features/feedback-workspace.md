# Feedback workspace and handoff

The extension stores review state as files under `.feedback/` (setting `vscodeComment.feedbackDirectory`) so coding agents can read and answer it. Users initialize the workspace, copy a prompt for their agent, and finish the review. When an agent edits or deletes `.review` files, the threads update live.

## Sub-features

- `ws-init`: on activation, or through `Initialize Feedback Workspace`, the extension creates `.feedback/AGENTS.md`, `.feedback/review_template.md`, and a `.gitignore` entry.
- `ws-prompt`: `Copy Agent Prompt` puts an agent instruction prompt on the clipboard.
- `ws-finish`: `Approve / Finish Review` summarizes open comments, or reports approval when none are open.
- `ws-sync`: external edits to a `.review` file (status `acknowledged`, appended replies, deletion) re-render or remove the thread.

## How to get to it (user POV)

- Title bar of the Local HITL Review view: `Initialize Feedback Workspace`, `Copy Agent Prompt`, `Approve / Finish Review`.
- The Comments panel title bar also has `Copy Agent Prompt`.
- An agent, or any editor, changing files in `.feedback/`.

## Driving it with hitl.mjs

Preconditions: baseline. *(unverified)*

- **Init.** `ls "$WS/.feedback"` shows `AGENTS.md` and `review_template.md` right after launch, where `WS` is the `workspace` field from `launch`.
- **Copy prompt.** Run `$H palette "Copy Agent Prompt"`, then `pbpaste > "$HITL_RUN/evidence/feedback-workspace/prompt.txt"`. The clipboard is the system clipboard, so expect it to contain the review instructions.
- **Finish review.** Create one comment, run `$H palette "Approve / Finish Review"`, then `$H text '.notifications-toasts .notification-list-item-message'`. Capture the toast with `$H screenshot feedback-workspace/finish`.
- **Agent sync.** Simulate the agent: `sed -i '' 's/status: open/status: acknowledged/' "$WS"/.feedback/*.review`. Within about 1s the thread header shows `acknowledged`. Take a screenshot as proof.

## Gotchas

- `Copy Agent Prompt` writes to the real macOS clipboard, which the user shares. Save the old contents with `pbpaste > /tmp/clip.bak` and restore them afterwards.
- `ws-sync` is the one feature where editing `.review` files by hand is the correct user path, because it stands in for the agent.
- `feedbackScope: local` (multi-repo) stores feedback per repository, and the single-repo fixture does not exercise it.
