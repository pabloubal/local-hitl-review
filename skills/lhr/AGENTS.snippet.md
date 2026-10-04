## Code review threads (lhr)

Humans leave review threads in `.lhr/`. When asked to address review feedback:

- Read the inbox (`lhr inbox --json`, or the `inbox` MCP tool). Act on threads where `whoseTurn` is `agent`.
- Reply with `lhr thread reply <handle> -` (body on stdin), resolve with `lhr thread resolve <handle>`. Via MCP: `thread_reply`, `thread_resolve`. Pass `--client-id` / `clientId` so retries are safe.
- Run the CLI with `LHR_SESSION_ID` set, or writes become human drafts.
- Never run `lhr review submit` or `lhr init`. Never edit `.lhr/` by hand.
- Full guide: `skills/lhr/SKILL.md`.
