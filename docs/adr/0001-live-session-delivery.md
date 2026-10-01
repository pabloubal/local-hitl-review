---
status: accepted
---

# Deliver submitted feedback to the agent session that wrote the code

When a review round is submitted, LHR tells the agent session that wrote the code about it, rather than starting a new agent. That session already knows why the code looks the way it does, and it won't collide with a second agent editing the same files. Delivery is a **nudge**: a short notice pointing at `lhr inbox`, never the feedback itself. The threads on disk stay the only source of truth, so a duplicate or lost nudge does no harm.

## How LHR knows about agent sessions

- A `SessionStart` hook from the LHR plugin registers **main** agent sessions only (not subagents) in a per-user registry: `~/.lhr/sessions/<session_id>.json`, file mode 0600, never inside the repo. Each entry holds the session ID, cwd, worktree root, inbox socket path and token, the agent's version, and a status.
- Status: `busy` (set by `UserPromptSubmit`), `idle` (set by `Stop`), `closed` (set by `SessionEnd`). Closed entries are kept so the last agent session can be resumed.
- On `SessionStart`, entries **in the same worktree** that are closed or whose socket no longer accepts a connection are pruned. The latest closed entry per worktree is kept. Live sessions in other terminals or worktrees are never touched.
- The branch is looked up when sending, not stored, because it can change during an agent session.

## Which agent session gets the nudge

1. The agent session that wrote the latest agent message in the thread, if it's live.
2. Otherwise, live agent sessions in the same worktree. If there's more than one, the user picks.
3. Otherwise, the most recent closed agent session in the worktree, offered for **headless resume**.
4. Otherwise, a new agent, or the copied prompt.

## How the nudge is sent

- **Live agent session:** one JSON line on the session's inbox socket (Claude Code cross-session messaging). A prototype (branch `prototype/session-inbox`, Claude Code 2.1.286, macOS) showed that a process that isn't a child of the session can post there. Prompting sessions receive it directly. Sessions that skip permission prompts hold it until the user approves. Nothing comes back on the socket, so delivery is fire-and-forget. A thread shows `sent` until the agent replies in it.
- The message format isn't documented, so it lives in a single adapter that checks the agent's version. Above the highest tested version, the adapter falls back to the inbox.
- Before sending, LHR reads `crossSessionInbound` from the Claude Code settings. With `refuse` it skips the socket. With `hold`, or when the session skips permission prompts, it tells the user in advance that approval will be needed.
- **LHR never claims a permission mode it doesn't have** to avoid the hold. That would get around a safety control.
- **Safety net:** the `Stop` hook runs `lhr inbox --session <id>`. If submitted feedback is unread, the agent is told to continue and address it.

## Headless resume

When nothing is live, LHR can resume the last agent session headlessly (`claude --resume <id> -p <nudge>`) in the cwd that was recorded. It happens only when the user asks; it's never automatic and never available to agents. It refuses if that agent session is already live. It never skips permission prompts by default: it uses edit-accepting mode with a limited tool allowlist. It shows the run's output as it happens and can be stopped.

## Considered options

- **Start a new agent for every round:** rejected. It loses the reasoning behind the code and risks two agents editing at once.
- **Channels (an MCP server pushing into the session):** this solves "which session" by construction, but it's a research preview that needs launch flags and allowlists. Kept as an experimental option.
- **Put the full feedback in the socket message:** rejected. The format is undocumented and there's no delivery confirmation, so the socket carries only a nudge.
