# Anchors

A thread remembers the code it was started on. When the file changes, `lhr` re-finds the lines (`current`, possibly at a new line number), marks the thread `outdated` if the text no longer matches, or `orphaned` if the file is gone. Threads can also point at the old side of a diff (`--side old --base-commit`) or at a whole file.

## Sub-features

- `anchor-current`: the commented lines are unchanged: `state: current`, `method: diff`.
- `anchor-moved`: lines were inserted above: the location follows (`src/app.ts:2-3` becomes `src/app.ts:3-4`) and the state stays `current`.
- `anchor-outdated`: the commented text was edited: `state: outdated` (shown as `moved` in text output), the original location and a saved snapshot remain.
- `anchor-orphaned`: the file was deleted: `state: orphaned`, `method: path`.
- `anchor-old-side`: `--side old` requires `--base-commit <sha>`.
- `anchor-file`: a thread with no line is a file-level anchor (`kind: file`).

## How to get to it (user POV)

- `lhr thread create path:line-end`, then edit the code and run `lhr thread list`, `lhr thread show <handle>`, or `lhr inbox`.

## Driving it with lhr-verify.mjs

Preconditions: baseline, `init`, one submitted thread on a two-line range: `$V run --stdin "Validate." -- thread create src/app.ts:2-3 - && sleep 1 && $V run -- review submit --verdict comment --summary s`. `S=$($V path)`. Read the anchor with `$V run -- thread list --status all --json | grep -o '"anchor":{[^}]*}'`.

- **Current.** Unchanged fixture: `"startLine":2,"endLine":3,"state":"current","method":"diff"`; the ANCHOR column of `thread list` is blank.
- **Moved.** `printf 'export const a = 1;\n// added\n// TODO validate input\nexport function add(a, b) {\n  return a + b;\n}\n' > "$S/src/app.ts"`; location is `src/app.ts:3-4`, `"state":"current"`. `$V run -- thread show <T>` marks line 3 with `>`.
- **Outdated.** `printf 'export const a = 1;\n// totally different\nfoo();\n' > "$S/src/app.ts"`; `"startLine":2,"endLine":3,"state":"outdated","method":"diff"`.
- **Orphaned.** `rm "$S/src/app.ts"`; `"state":"orphaned","method":"path"` and no line numbers; the ANCHOR column reads `orphaned`.
- **Old side.** Restore the file (`git -C "$S" checkout -- src/app.ts`). `$V run --expect 2 -- thread create src/app.ts:1 --side old --body x` prints `--side old needs --base-commit <sha> (INVALID_INPUT)`. With `--base-commit "$(git -C "$S" rev-parse HEAD)"` it saves a draft (`draft saved; ...`, `thread <handle>`).
- **File level.** `$V run -- thread create README.md --body "file level"` saves a draft; after submit, its JSON anchor has `"kind":"file"`.

## Gotchas

- Edits to the fixture's source files are the only allowed direct writes; do them with `printf`/`rm` as above and restore afterwards.
- Each state comes from the fixture file at that moment: run the four anchor states in order on one thread, restoring the file between, or start a new session per state.
- Anchoring runs against the working tree, not a commit, and consults `git`; a session whose git repo was damaged fails with `GIT_FAILED` (exit 5), not an anchor state.
- A dry-run `thread create` validates input and thread existence but never captures anchors (documented in `thread create --help`); it cannot prove an anchor.
