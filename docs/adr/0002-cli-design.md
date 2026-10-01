---
status: accepted
---

# The `lhr` CLI is built for agents first, and polished for humans

`lhr` is used by coding agents as much as by people, so it follows the cli-for-agents skill (https://github.com/cursor/plugins/tree/main/cli-for-agent). A polished interactive interface appears only when a human runs `lhr` with no arguments in a real terminal. Without a terminal, `lhr` never prompts: it fails immediately with a correct example command.

- **Resource + verb:** `lhr thread list|show|reply|resolve|reopen`, `lhr review start|submit|push`, `lhr session list|send|resume`, `lhr inbox`, `lhr check`, `lhr doctor`, `lhr migrate`.
- **Stdin for message bodies:** `lhr thread reply <id> -` reads markdown from stdin, so agents never have to put multi-line text inside shell quotes.
- **Structured output:** `--json` on every command. Success returns IDs, `file:line` and status. Exit codes are documented, so `lhr check` works in CI.
- **Idempotent:** resolving something already resolved succeeds and does nothing. `review push` records GitHub's IDs and never posts twice. Replies accept `--client-id`, so a retried reply is ignored.
- **`--dry-run`** on every command with side effects: `review push` prints the GitHub payload, `session resume` prints the exact command it would run, `migrate` lists the file changes.
- **Help at each level with examples:** `lhr --help` lists the command groups; each subcommand's help has examples an agent can copy.
- **One program:** `lhr mcp` runs the MCP server, so users install one thing.

## Exception to `--yes`

`lhr session resume` starts a headless agent. It needs confirmation in a real terminal, or a setting the user turns on explicitly (`allowAgentResume: true`). `--yes` doesn't skip that, and the MCP server doesn't offer the command. Agents must not be able to start other agents on their own (see ADR 0001).
