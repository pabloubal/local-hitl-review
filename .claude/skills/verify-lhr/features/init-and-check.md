# Initialize and check a review store

A human runs `lhr init` once in a repo to create `.lhr/`, the review store. `lhr check` validates the whole tree and is the way to know the store is sound. `--version` and `--help` are the entry points an agent reads first.

## Sub-features

- `init-create`: `lhr init` creates `.lhr/` at the current directory (or a given path).
- `init-idempotent`: a second `lhr init` changes nothing and says so.
- `init-dry-run`: `--dry-run` lists what would be created and writes nothing.
- `check-clean`: `lhr check` on a sound store prints `0 errors, 0 warnings` and exits 0.
- `check-corrupt`: a damaged file makes `check` print an `error <CODE> <path>:<line> <reason>` row and exit 1.
- `help-version`: `--version` prints the version; `--help` and `<group> --help` print static help; an unknown command exits 2 with `see: lhr --help`.

## How to get to it (user POV)

- `lhr init`, `lhr init <path>`, `lhr check`, `lhr --version`, `lhr --help`, `lhr thread --help`, `lhr <command> --help` in a terminal inside a git repo.

## Driving it with lhr-verify.mjs

Preconditions: baseline; a fresh session with no `.lhr/`.

- **Create.** `$V run --ev init-and-check/01-init -- init` prints `created .lhr/ in <session path>`, `[exit 0]`. `$V tree --ev init-and-check/after-init` lists exactly `.lhr/.gitignore` and `.lhr/format` (`drafts/` appears with the first draft); `git -C "$($V path)" status --short` shows `?? .lhr/` next to the fixture's own ` M src/app.ts` and `?? src/new.ts`.
- **Idempotent.** `$V run -- init` again prints `.lhr/ already exists in <path> (nothing to do)`, exit 0; `$V tree` output is unchanged.
- **Dry run.** `mkdir -p "$($V path)/sub" && $V run -- init sub --dry-run` prints `would create .lhr/ in <path>/sub`, then `.lhr/format` and `.lhr/.gitignore`, plus a `note:` that a `.lhr/` exists above; `ls "$($V path)/sub"` is empty.
- **Clean check.** `$V run --ev init-and-check/02-check -- check` prints `0 errors, 0 warnings`, exit 0. `$V run -- check --json` prints a `{"version":1,"data":...}` envelope.
- **Corrupt check.** Create and submit a thread (`$V run --stdin x -- thread create src/app.ts:2 - && sleep 1 && $V run -- review submit --verdict comment --summary s`; a draft lives under `.lhr/drafts/` and is not what we corrupt), then `echo garbage > "$($V path)/.lhr/threads/$(ls "$($V path)/.lhr/threads" | head -1)/thread.md"` (the one allowed hand-edit: deliberate corruption), then `$V run --expect 1 --ev init-and-check/03-check-corrupt -- check` prints `error FRONTMATTER_SYNTAX .lhr/threads/<id>/thread.md:1 file must start with a "---" frontmatter delimiter line` and `1 error, 0 warnings`. `doctor` now reports `check` as not ok; use a new session afterwards.
- **Help.** `$V run -- --version` prints the package version. `$V run -- thread --help` prints `Work with review threads.` and lists `list, show, create, reply, resolve, reopen`. `$V run --expect 2 -- bogus` prints `error: unknown command bogus (INVALID_INPUT)`.
- **No store.** In a session with no `.lhr/`, `$V run --expect 2 -- thread list` fails with a `NOT_A_REPO` error whose `try:` line is `lhr init --repo <path>`.

## Gotchas

- `init` is a human action: agents cannot create the store (the MCP server says so in its error). Do not use `--agent` for `init`.
- `check` deliberately exits 1 only for errors; warnings alone exit 0. Exit 2 is usage.
- `init <path>` inside an existing review root warns but still reports what it would create; do not read the `note:` as a failure.
- Writes go to the session repo, which is untracked by the real repo; nothing here touches `packages/` or the checkout's `.lhr/`.
