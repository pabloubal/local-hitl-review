---
name: verify-hitl-review
description: Drive the Local HITL Review VS Code extension in a real, disposable VS Code window (SCM view, diff editor comment threads, .feedback/*.review files) and capture proof. Use to verify a change to this extension works the way a user experiences it, beyond unit and integration tests.
---

# Verify Local HITL Review

The product is a VS Code extension. Users interact with two views in the Source Control sidebar ("Local HITL Review" and "Review Feedback Summary"), with comment threads inside diff editors, and with the `.feedback/` directory the extension writes. This skill launches a throwaway VS Code with the extension loaded from this checkout, then drives its renderer over the Chrome DevTools Protocol (CDP) with `scripts/hitl.mjs`. The helper has no dependencies and needs Node 22 or later.

The secondary surface is the `.review` file format that agents read and write. When you change it, check it through the files, since the extension watches them and re-renders threads.

## Helper

All commands below are relative to the repo root. `H` refers to the helper path:

```bash
H=.claude/skills/verify-hitl-review/scripts/hitl.mjs
export HITL_RUN="$TMPDIR/verify-hitl-review/$(date +%s)"   # one dir per run; defaults to .../current
```

| Command | Does |
|---|---|
| `$H launch` | Build `packages/vscode/out/extension.js` (`npm run build -w local-hitl-review`), create the fixture repo, start VS Code, open Source Control, expand the view, wait for activation. Prints `{"ready":true,...}` JSON. |
| `$H doctor` | Read-only health check. Prints JSON and exits 0 only when the instance is safe to drive. |
| `$H palette "<command title>"` | F1, type the title, pick the row whose label **starts with** it, Enter. |
| `$H click <css> [text]` / `$H dblclick <css> [text]` | Real mouse click at the centre of the first visible match (aria-label or text contains `text`). |
| `$H key <combo>...` | Key presses, e.g. `escape`, `enter`, `cmd+enter`, `alt+c`, `ctrl+shift+g`. |
| `$H type "<text>"` | Insert text at the focused element. |
| `$H text <css> [--aria]` | Print innerText (or aria-label) of visible matches. Use it to read state. |
| `$H eval "<js>"` | Evaluate JavaScript in the workbench renderer. Use it only to read state, never to act. |
| `$H screenshot <name>` | PNG saved to `$HITL_RUN/evidence/<name>.png`. |
| `$H feedback [name]` | Copy the fixture's `.feedback/` to `evidence/<name>/` and print every `.review` file. |
| `$H logs` | Tail the extension host log and the "Local HITL Review" output channel. |
| `$H stop` | Kill the VS Code instance this run started, keep its logs in evidence, delete instance state. |

## Launch

```bash
$H launch && $H doctor
```

- **Fixture.** A new git repo at `$HITL_RUN/instance/fixture`. Branch `main` has `README.md` and `src/app.ts`. The checked-out branch `feature/review-me` modifies `src/app.ts` (adds `// TODO validate input` on line 2) and adds `src/new.ts`. The extension auto-detects `main` as the base.
- **Extension under test.** The repo is an npm-workspaces monorepo. `launch` loads `packages/vscode` via `--extensionDevelopmentPath`; `packages/core` is not used by the extension. `node_modules/` and `.vscode-test/` stay at the repo root. A stale root-level `out/` from before the move is ignored.
- **VS Code binary.** `@vscode/test-electron` downloads the latest stable release into `.vscode-test/` (about 300 MB on first run, cached after that). To use a specific build, set `HITL_CODE=/path/to/Code`.
- **Ready.** `launch` prints `"ready":true` once the extension host log shows `ExtensionService#_doActivateExtension pablou.local-hitl-review`. Activation is lazy (`onView:vscodeComment.changedFiles`), so `launch` expands the "Local HITL Review" view the way a user would.
- **Launch is one-shot.** It returns once the instance is ready, and the window keeps running between commands. If you rebuild, `doctor` reports `buildFresh: false`. Run `stop` and then `launch` to load the new build.

## Doctor

Run `$H doctor` first whenever anything looks off. It requires all of the following:

- `pidAlive`: the process this run spawned is still alive.
- `cdp` and `workbenchPage`: the CDP port answers and a workbench page exists. `windowTitle` should read `[Extension Development Host] fixture`.
- `extensionActivated`: the extension host logged activation of `pablou.local-hitl-review`.
- `fixtureBranch`: `feature/review-me`.

If `ok` is false, run `$H logs`, then `$H stop` and `$H launch`. Never point the helper at a VS Code window it did not start.

## Isolation

Each run has its own `--user-data-dir` (a short `$TMPDIR/hitl-XXXXXX`, because macOS limits IPC socket paths to 103 characters), its own `--extensions-dir`, its own fixture repo and its own free CDP port. Runs with different `HITL_RUN` values can therefore execute side by side and never touch the user's own VS Code profile. The profile also sets `window.menuStyle` and `window.dialogStyle` to `custom`: on macOS VS Code otherwise shows native context menus and confirm dialogs, which CDP can neither see nor click (the window then sits behind an invisible modal until `stop`). `--disable-extensions` turns off installed extensions, but the extension under development still loads. `launch` refuses to start when the same `HITL_RUN` already has a live instance.

## Drive

Rules that keep runs honest:

- **Chain steps with `&&` or `set -e`.** If `palette` or `click` finds no match, it exits non-zero after pressing Escape. A following `type` would then insert text into whatever has focus, usually the editor, which dirties a fixture file. If that happens, run `$H palette "File: Revert File"`.
- **Act through user paths only:** the palette, clicks on view rows, title-bar actions, keybindings. `eval` is for reading state.
- **Read before you act.** `$H text '.pane-body .monaco-list-row' --aria` lists rows of *every* expanded pane (Changes, Graph, Local HITL Review, Review Feedback Summary, Comments). Scope to one view with `:has()`, as in the table below.
- **Lookups wait, keys don't.** `click`/`dblclick` poll up to 5s for their target and `palette` retries up to 4 times, because diffs and context-dependent commands appear a beat late. `type` waits 500ms after inserting so a following `cmd+enter` sees the text. `key` and `eval` never wait; add `sleep` before reading results of an async action.
- **The system clipboard is shared.** `Copy Agent Prompt` and the `Add Suggestion` fallback overwrite the user's real clipboard. Back it up first (`pbpaste > "$HITL_RUN/clip.bak"`) and restore it after (`pbcopy < "$HITL_RUN/clip.bak"`).
- **Stable handles:**

| Element | Selector and text |
|---|---|
| View headers | `.pane-header` with text `Local HITL Review`, `Review Feedback Summary` (aria-label ends in ` Section`, `aria-expanded` says whether it is open) |
| Changed file rows | `.pane:has(> .pane-header[aria-label^="Local HITL Review"]) .monaco-list-row` with text `M src/app.ts` |
| Summary rows | `.pane:has(> .pane-header[aria-label^="Review Feedback Summary"]) .monaco-list-row` |
| Row inline actions | `<row selector>[aria-label^="M src/app.ts"] .action-label` with text `Mark as Viewed` |
| Code line in the open editor | `.editor-instance .view-line` with text from the line (the helper normalizes non-breaking spaces) |
| Comment widget | `.review-widget`. When focus is inside it, `document.activeElement.closest('.review-widget')` is truthy |
| Rendered comments | `.review-widget .review-comment`; one comment is `.review-comment:nth-child(N)` |
| Comment title actions | `.review-widget .review-comment:nth-child(N) .action-label` with text `Edit`, `Delete`, `Change Severity`, `Change Status`, `Apply Suggestion`. The first comment's toolbar may not be rendered, so an unscoped click lands on comment 2 |
| Severity / status menu items | `.context-view .action-label` with text `Critical`, `Resolved`, … |
| Reply box | `.review-widget .comment-form` (shows `Reply...` collapsed, `Type a new comment` expanded) |
| Widget buttons | `.review-widget .monaco-button` with text `Add Review Comment`, `Save`, `Cancel`, `Add Suggestion` |
| Confirm dialog | `.monaco-dialog-box .monaco-button` with text `Delete` / `Cancel` |
| Thread gutter glyph | `.comment-range-glyph.comment-thread` (click to re-expand a collapsed thread) |
| Notifications | Toasts auto-hide; run `$H palette "Notifications: Show Notifications"` then read `.notifications-center .notification-list-item-message` |
| Editor tabs | `.tab` (aria-label `app.ts (vs main ↔ Working) (app.ts), preview`) |

The recipes for each feature are in [`features/`](features/README.md). Read the index before driving.

## Evidence

Everything goes to `$HITL_RUN/evidence/`. Put each feature's artifacts in a subfolder named after the feature, for example `evidence/add-comment/01-draft.png`.

- **Show the action and the result.** Capture a screenshot before the triggering action and one after it.
- **Check side effects on disk, not only on screen.** Every comment mutation must show up in `.feedback/*.review`, so run `$H feedback <feature>/feedback`. Its frontmatter (`severity`, `status`, `file`, `lines`) and body are the durable proof.
- **Use a second view where one exists.** After a mutation, read it back from another surface, such as the Comments panel (`.comments-panel`) or the changed-files row badge.
- **No shortcuts.** Do not call extension commands with synthetic arguments through `eval`, and do not hand-write `.review` files to stand in for UI actions. External edits to `.review` files are only valid when the feature under test is "extension reacts to agent edits".

## Cleanup

```bash
$H stop
ls "$HITL_RUN/evidence"   # proof survives
```

`stop` acts only on the instance recorded in `state.json`, never by process name. It first asks VS Code to quit over CDP (`Browser.close`), then sends SIGTERM to the main pid alone, and SIGKILLs the process group only as a last resort, printing a warning when it does. Do not signal the whole group yourself: if the renderer dies before the main process, VS Code shows a "terminated" dialog and stays open. It copies `exthost.log` and the `Local HITL Review` output log into `evidence/logs/`, then deletes the profile dir and `instance/` (fixture included). Run `stop` after every failed attempt too. The evidence directory is never deleted; remove it yourself when you no longer need it.
