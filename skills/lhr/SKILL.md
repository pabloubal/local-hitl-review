---
name: lhr
description: Answer human code-review threads left in a repo's .lhr/ store. Use when the user mentions review comments, an lhr inbox, or asks you to address review feedback.
---

# lhr: answer review threads

A human reviews your code and leaves threads. You reply and resolve. You never submit a review.

## Loop

1. Read the inbox: threads where `whoseTurn` is `agent`.
2. Show one thread. Read all messages and the anchor state.
3. Fix the code if needed, then reply or resolve.
4. Repeat until the inbox is empty.

A thread leaves the inbox when an agent replies in it, not when it is read.

## With MCP tools (no shell)

Tools: `inbox`, `thread_list`, `thread_show`, `thread_reply`, `thread_resolve`, `thread_reopen`, `thread_create`.

- `inbox {}`, then `thread_show {"id":"<handle>"}`.
- `thread_reply {"id":"<handle>","body":"...","clientId":"<unique>"}`.
- `thread_resolve {"id":"<handle>","body":"Fixed in ...","clientId":"<unique>"}`. Omit `body` to resolve silently.
- Pass `clientId` on `thread_reply` and `thread_create`. A retry with the same `clientId` is ignored (`created: false`).
- Identity is fixed to agent. There is no author argument.
- Error says there is no `.lhr/`: tell the user to run `lhr init`. You cannot.

## With the CLI (shell)

Set `LHR_SESSION_ID` to your session ID. Without it `lhr` acts as the human and **saves drafts instead of writing**. Add `--json` for structured output.

```
lhr inbox --json
lhr thread show <handle> --json
lhr thread reply <handle> - --client-id <unique> <<'BODY'
Explanation in markdown.
BODY
lhr thread resolve <handle> --body "Fixed in abc123"
lhr thread create src/file.ts:10 --body "Unsure: ..." --client-id <unique>
lhr check
```

- `<handle>` is the short ID in the inbox (4 to 6 characters), a prefix, or the full ID.
- `-` reads the body from stdin. Use it for multi-line text.
- `--dry-run` previews a write. Resolving a resolved thread succeeds and does nothing.
- Exit 2 with no `.lhr/`: ask the user to run `lhr init`. Do not run it yourself.

## Rules

- Never run `lhr review submit` or touch drafts. Submitting is for the human.
- Act only on threads where `whoseTurn` is `agent`. Replying hands the turn to the human.
- Check `anchor.state`: `outdated` means the code moved, `orphaned` means the line is gone. Say so in your reply.
- Use `thread_create` only for a decision you need from the human.
- Do not edit files under `.lhr/` by hand.
