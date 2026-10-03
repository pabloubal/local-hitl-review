---
status: accepted
---

# The `lhr` CLI is built for agents first, and polished for humans

`lhr` is used by coding agents as much as by people, so it follows the principles of the `cli-for-agents` skill: resource + verb commands, structured output, idempotent writes, `--dry-run`, and help with copyable examples. In Phase 2A a bare `lhr` prints the top-level help; a polished interactive interface for a human in a real terminal is Phase 4. `lhr` never prompts: it fails immediately with a correct example command.

- **Resource + verb:** Phase 2A: `lhr init`, `lhr thread list|show|create|reply|resolve|reopen`, `lhr inbox`, `lhr check`, `lhr review submit`, `lhr mcp`. Later: `lhr review push` (Phase 4), `lhr session list|send|resume` and `lhr doctor` (Phase 3). `review start` and `migrate` are dropped. A bare `lhr` prints the top-level help.
- **Review root discovery:** `lhr` works on the nearest directory holding `.lhr/`, found by walking up from `--repo`, then `LHR_REPO`, then the current directory. `lhr init [path]` is the only command that creates `.lhr/`. With no `.lhr/` found, commands exit 2 with an example `lhr init` instead of reporting an empty tree.
- **Stdin for message bodies:** `lhr thread reply <id> -` reads markdown from stdin, so agents never have to put multi-line text inside shell quotes.
- **Structured output:** `--json` on every command. Success returns IDs, `file:line` and status. Exit codes are documented, so `lhr check` works in CI.
- **Idempotent:** resolving something already resolved succeeds and does nothing. `review push` records GitHub's IDs and never posts twice. `thread create`, `thread reply` and `review submit` accept `--client-id`, so a retried write is ignored.
- **`--dry-run`** on every command with side effects: `review push` prints the GitHub payload, `session resume` prints the exact command it would run, `init`, `thread create|reply|resolve|reopen` and `review submit` print what they would write.
- **Help at each level with examples:** `lhr --help` lists the command groups; each subcommand's help has examples an agent can copy.
- **One program:** `lhr mcp` runs the MCP server, so users install one thing.

## Exception to `--yes`

`lhr session resume` starts a headless agent. It needs confirmation in a real terminal, or a setting the user turns on explicitly (`allowAgentResume: true`). `--yes` doesn't skip that, and the MCP server doesn't offer the command. Agents must not be able to start other agents on their own (see ADR 0001).
