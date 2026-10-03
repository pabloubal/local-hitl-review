# Human review round

A human reviewer starts threads on code (a line, a range, a file), then submits them together as a round with a verdict. Until submitted, the threads are private drafts; after submitting they are the agent's inbox.

## Sub-features

- `create-line`: `thread create <path>:<line>` starts a draft thread on a line; `<path>:<a>-<b>` on a range.
- `create-body`: the body comes from `--body` or from stdin with `-`; severity from `--severity` (default `medium`).
- `create-file`: `thread create README.md` with no line comments on the whole file.
- `drafts-private`: drafts show `TURN draft` to the human and are invisible to agents.
- `list-filters`: `thread list` filters by `--status`, `--whose-turn`, `--path`, `--round`.
- `show`: `thread show <handle>` prints the thread with a code excerpt, `>` marking the commented line, then each message.
- `submit`: `review submit --verdict approve|comment|request-changes` publishes all drafts as a round; `--summary` or stdin supplies the summary.
- `idempotent-submit`: a repeated `review submit --client-id X` returns `round already submitted <id>` and writes no second round. Human `thread create`/`reply` take no `--client-id` (drafts have no idempotency key); that flag is for agent writes.
- `dry-run`: `--dry-run` validates and prints `dry run: would ...` without writing.
- `submit-agent-refused`: agent mode cannot submit.

## How to get to it (user POV)

- `lhr thread create src/auth/session.ts:42-47 --severity high -` (body on stdin), `lhr thread list`, `lhr thread show k3m9`, `lhr review submit --verdict request-changes -`.

## Driving it with lhr-verify.mjs

Preconditions: baseline plus `$V run -- init`.

- **Create.** `T=$($V run --ev human-review/01-create --stdin "Validate both inputs." -- thread create src/app.ts:2 --severity high - | sed -n 's/^thread //p')` prints `draft saved; run lhr review submit to send it` then `thread <handle>`. `echo "$T"` is 4 characters.
- **Draft is private.** `$V run -- thread list` shows one row with `TURN draft`, `SEV high`, `LOCATION src/app.ts:2`. `$V run --agent --ev human-review/02-agent-sees-nothing -- inbox` prints `0 threads in the inbox`, and `$V run --agent --expect 3 -- thread show "$T"` exits 3 with `THREAD_NOT_FOUND`.
- **Variants.** `$V run -- thread create src/app.ts:2-3 --body "range"`, `$V run -- thread create README.md --body "file level"`. `$V run -- thread list --json` shows `"anchor":{"kind":"line","startLine":2,"endLine":3,...}` for the range and `"kind":"file"` for the README.
- **Submit.** `sleep 1 && $V run --ev human-review/03-submit -- review submit --verdict request-changes --summary "please fix"` prints `submitted round <id> (request-changes): N threads, N messages`. Save the round id. `$V tree --ev human-review/after-submit` now has `.lhr/rounds/<round>.md` and each thread's message file.
- **Agent now sees it.** `$V run --agent --ev human-review/04-inbox -- inbox` lists the threads with `TURN agent`. `$V run -- thread list --whose-turn agent` agrees. `$V run -- thread list --status all --round <round id>` lists only that round's threads; `--path README.md` only the file-level one.
- **Show.** `$V run -- thread show "$T"` prints the header `<id>  open  high  turn: agent  reviewer: Test Human`, `src/app.ts:2`, a `working tree` excerpt with `> 2 │ // TODO validate input`, and the message `Test Human (human)  <date>  <round id>, severity: high` followed by `Validate both inputs.`.
- **Idempotent submit.** Create a draft, `sleep 1`, then `$V run -- review submit --verdict comment --summary s2 --client-id sub1` prints `submitted round <id> (comment): ...`; after `sleep 1` the identical call prints `round already submitted <same id> (comment): ...`, exit 0, and `ls "$($V path)/.lhr/rounds"` gains only one file. `$V run --expect 2 --stdin x -- thread create README.md --client-id c1 -` prints `--client-id applies to immediate agent writes; human mode saves drafts, which have no idempotency key (INVALID_INPUT)`.
- **Human follow-ups are drafts too.** `sleep 1 && $V run -- thread reply <T> --body "more"` prints `draft saved; run lhr review submit to send it` and `message <ts>-human-<rand>`; `$V run --agent -- thread show <T>` does not show it until the next `review submit`. An approve with no drafts is allowed: `submitted round <id> (approve): 0 threads, 0 messages`.
- **Dry run.** `B=$(find "$($V path)/.lhr" -type f | wc -l)`, `$V run -- thread create src/app.ts:1 --body x --dry-run` prints `dry run: would save a draft thread on src/app.ts:1`, and the file count afterwards equals `$B`.
- **Agent cannot submit.** `$V run --agent --expect 2 -- review submit --verdict approve` prints `review submit is for human reviewers; agent mode cannot submit a round (INVALID_INPUT)` and `try: lhr review submit --verdict approve --as human`.
- **Bad input.** `$V run --expect 2 -- thread create` (no body) says `a body is required`; `$V run --expect 2 -- thread create ../outside.ts:1 --body x` says `path "../outside.ts" is outside the review root`.

## Gotchas

- A human `thread reply`, `resolve` or `reopen` also saves a **draft** (`draft saved; run lhr review submit to send it`, or `message <id>` for a reply); nothing the agent can see changes until the next `review submit`. Verify that, do not assume `thread list` for the agent moves.
- `sleep 1` between `thread create` and `review submit`, and between submits: IDs are second-resolution (#155).
- Without `--client-id`, retrying `review submit` writes a second round; human `create`/`reply` have no idempotency at all. Documented behavior, not a bug.
- The ANCHOR column of `thread list` is blank for a current anchor and shows `moved` (outdated) / `orphaned` otherwise (see [anchors](./anchors.md)).
- Handles are only unique among the threads visible to the current mode; draft handles are human-only.
