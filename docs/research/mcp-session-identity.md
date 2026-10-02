# How an MCP server learns the calling agent's session

Research for ticket #95 (map #91). Question: what do the MCP protocol and `@modelcontextprotocol/sdk` give a stdio server to identify the calling client and its session, and can `lhr mcp` reliably record a `session` per agent session?

Researched 2026-10-02 against MCP spec 2025-06-18, `@modelcontextprotocol/sdk` 1.31.0, Claude Code 2.1.28x docs.

## Answer

- **The MCP protocol gives a stdio server no session ID.** It gives a client *product* identity only (`clientInfo.name`/`version`).
- **Claude Code does give one, out of band.** Since 2.1.154 it sets `CLAUDE_CODE_SESSION_ID` (and `CLAUDECODE=1`) in the environment of stdio MCP server subprocesses. This is the same value as `session_id` in hook input, and the same one the `SessionStart` hook registers (ADR 0001).
- **Other MCP clients provide nothing standard.** The only portable inputs are `clientInfo`, roots and the process environment. Streamable HTTP has an `Mcp-Session-Id`, but it is a transport session minted by the server, not the agent's session.
- **Recommendation:** `lhr mcp` takes `name` from `clientInfo`, and `session` from `CLAUDE_CODE_SESSION_ID`. When the variable is absent it records no `session` (agent-written, session unknown). It never invents a session ID.

## Findings

### MCP protocol

1. `initialize` carries `protocolVersion`, `capabilities` and `clientInfo` with `name`, optional `title`, and `version`. There is no session or instance field. Source: [Lifecycle, Initialization](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle).
2. stdio: the client launches the server as a subprocess and talks over stdin/stdout. One process serves one client connection, so process lifetime is the connection lifetime. The spec defines no session ID and no environment contract for stdio. Source: [Transports, stdio](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#stdio).
3. Streamable HTTP: the server MAY assign `Mcp-Session-Id` in the response to `initialize`, and the client MUST echo it. The ID is minted by the server, so it identifies a connection to the server, not the agent's conversation. Source: [Transports, Session Management](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#session-management). This is moot for `lhr mcp` (stdio), and an open client issue reports Claude not echoing it back anyway: [claude-code#41836](https://github.com/anthropics/claude-code/issues/41836).
4. Clients that support roots answer `roots/list`. Claude Code answers with the launch directory plus `--add-dir` directories. This gives a working directory, not a session. Source: [Claude Code MCP docs](https://code.claude.com/docs/en/mcp).

### `@modelcontextprotocol/sdk` (1.31.0, checked in the npm tarball)

- `Server.getClientVersion(): Implementation | undefined` returns the client's `name`/`version` after initialization. `getClientCapabilities()` returns its capabilities. Both are `undefined` before `initialize` completes. Source: `dist/esm/server/index.d.ts`.
- `Transport.sessionId?: string` exists on the interface and `StreamableHTTPServerTransport` generates one via `sessionIdGenerator`. `StdioServerTransport` has none. Source: `dist/esm/shared/transport.d.ts`, `dist/esm/server/streamableHttp.d.ts`.
- Request `_meta` exists (progress tokens, related-task), but the SDK defines no session key in it. Source: `dist/esm/types.d.ts`.
- The SDK stdio **client** helper `getDefaultEnvironment()` passes only a small allowlist (`PATH`, `HOME`, and similar) to servers it spawns. A client built on it would not forward a session variable unless configured. Source: `dist/esm/client/stdio.js`.

### Claude Code

1. Stdio MCP subprocesses receive `CLAUDE_CODE_SESSION_ID` and `CLAUDECODE=1`. Source: [Claude Code CHANGELOG, 2.1.154](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md): "Stdio MCP server subprocesses now receive `CLAUDE_CODE_SESSION_ID` and `CLAUDECODE=1` in their environment". 2.1.163 adds: "stdio MCP servers now receive the same `CLAUDE_CODE_SESSION_ID` as hooks/Bash on `--resume`".
2. **Documentation gap.** The [env-vars reference](https://code.claude.com/docs/en/env-vars) lists stdio MCP subprocesses for `CLAUDECODE`, but its `CLAUDE_CODE_SESSION_ID` entry lists only Bash/PowerShell tools and hook commands. The [MCP page](https://code.claude.com/docs/en/mcp) documents only `CLAUDE_PROJECT_DIR`. Tracked as [claude-code#63305](https://github.com/anthropics/claude-code/issues/63305). The only first-party statement is the changelog, so the contract is real but thinly documented.
3. The value matches `session_id` in hook input. Hooks receive `session_id` as JSON on stdin, not as an environment variable. Source: [Hooks reference](https://code.claude.com/docs/en/hooks). The ID is regenerated on `/clear` (env-vars reference), so a long-lived MCP process started before `/clear` may hold a stale value. Whether the MCP subprocess is restarted on `/clear` is not documented and was not tested.
4. `CLAUDE_PROJECT_DIR` is also set for stdio servers: [MCP docs](https://code.claude.com/docs/en/mcp).
5. `CLAUDE_ENV_FILE` is available only to `SessionStart`, `Setup`, `CwdChanged` and `FileChanged` hooks, and it persists variables for later **Bash tool** commands. It does not reach MCP servers. Source: [Hooks reference](https://code.claude.com/docs/en/hooks). So the plugin's `SessionStart` hook can export an LHR variable for the CLI (Bash) path, but not for `lhr mcp`.
6. `.mcp.json` supports `${VAR}` expansion in `command`, `args`, `env`, `url` and `headers`, but it expands from Claude Code's own environment, which does not contain the session ID, so it is no workaround. Source: [MCP docs](https://code.claude.com/docs/en/mcp).
7. `clientInfo` from Claude Code is a product name and version, not per-session (for claude.ai it is a constant `claude-ai` / `0.1.0`: [claude-code#41836](https://github.com/anthropics/claude-code/issues/41836)).

### Other MCP clients

Not verified product by product. From the spec, an "other MCP client" is only guaranteed to send `clientInfo`, and optionally roots. Some clients may put a conversation ID in request `_meta` under a vendor key (one commenter on #41836 reports this for one client), but that is vendor-specific and not covered by the spec. Treat anything beyond `clientInfo` as absent unless a client is individually confirmed.

## Implications for lhr

- `docs/spec/core-api.md` § Who writes as whom says MCP `session` "comes from the MCP client". More accurate: `name` from `clientInfo`, `session` from the agent-session environment variable when the client provides it.
- The two paths read different variables: the plugin's `SessionStart` hook and the CLI use the LHR-defined variable, while `lhr mcp` reads `CLAUDE_CODE_SESSION_ID`. One resolver should accept both in a fixed order (LHR variable first, then `CLAUDE_CODE_SESSION_ID`) so a session recorded by either path matches the registry key (`~/.lhr/sessions/<session_id>.json`, ADR 0001).
- Without a session, nudge routing falls to ADR 0001 rule 2 (live sessions in the same worktree, user picks). Agent authorship is unaffected because MCP always writes as an agent.
- Stale ID after `/clear` is open. Test it against a real Claude Code before the spec states a guarantee. Reading the variable per write does not help if the environment is fixed at spawn, which is the likely case.

## Fallback when the client provides no session

Record the write with `author.kind = agent`, `name` from `clientInfo` (or `unknown` if missing), and **no `session`**. Do not derive a pseudo-session from the server's PID, the `Mcp-Session-Id`, or a random UUID. A fabricated ID would look like an unregistered session and could mis-route a nudge, while an absent one cleanly triggers the same-worktree selection.
