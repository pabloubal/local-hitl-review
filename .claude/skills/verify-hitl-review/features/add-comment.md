# Add a review comment

A reviewer opens a changed file's diff from the Local HITL Review view, starts a comment on a line of the modified side, types feedback, and submits it. The extension shows the thread inline with a severity and status header, lists it in the Comments panel, and writes a `.review` file to `.feedback/`.

## Sub-features

- `comment-open`: open the comment widget on a line of a changed file.
- `comment-submit-key`: submit with Cmd+Enter (Ctrl+Enter on Linux and Windows).
- `comment-submit-button`: submit with the `Add Review Comment` button.
- `comment-severity`: a `#critical`, `#high`, `#medium`, `#low`, or `#severity:<level>` shorthand in the text sets the severity and is removed from the body.
- `comment-persist`: a `.review` file appears with `status: open`, the file path, and the line number.

## How to get to it (user POV)

- Click a file in Local HITL Review to open its diff, put the cursor on a line, and run `Comments: Add Comment on Current Selection` (Cmd+K Opt+Cmd+C).
- Hover the gutter of the modified side and click the `+` comment glyph.
- Submit with Cmd+Enter while the comment box has focus, or click `Add Review Comment`.

## Driving it with hitl.mjs

Preconditions: baseline, and `.feedback/` contains no `.review` files.

- **Open the diff.** Click the changed file: `$H click '.pane-body .monaco-list-row' 'M src/app.ts'` (unique enough unscoped; see SKILL.md for pane-scoped rows). Then `$H text .tab --aria` shows `app.ts (vs main ↔ Working)`. On a freshly launched instance the diff can take longer than `click`'s 5s lookup to render its lines, so `sleep 3` here (a later `click` on `TODO validate` otherwise exits with "no visible element").
- **Place the cursor.** `$H click '.editor-instance .view-line' 'TODO validate'`. The status bar reads `Ln 2`.
- **Open the widget.** `$H palette "Comments: Add Comment on Current Selection"`. Then `$H eval '!!document.activeElement?.closest(".review-widget")'` prints `true`.
- **Type and capture the draft.** `$H type "Validate both inputs are finite numbers. #high"` then `$H screenshot add-comment/01-draft`.
- **Submit with the keyboard.** `$H key cmd+enter`, then `$H screenshot add-comment/02-submitted`. The thread header reads `🟠 High — open`, and the Comments panel lists `human · Validate both inputs are finite numbers.[Ln 2]`.
- **Check persistence.** Run `$H feedback add-comment/feedback`. It prints one `<timestamp>-<hash>.review` with `severity: high`, `status: open`, `file: src/app.ts`, `lines: 2`, and the body `**human**:` followed by the text, with `#high` removed. The removal does not trim, so the body line ends with a trailing space (`...numbers. `); allow for it in an exact-match check.
- **Read it back.** `$H text '.review-widget .review-comment'` prints `human🟠 High` and the comment text.

## Gotchas

- The palette command `Add Review Comment` is the widget's **submit** action, which expects a comment reply. Run from the palette it silently does nothing (it throws on `reply.thread`). Its Alt+C keybinding never fires either: its when-clause does not match from the editor or the view (product gap, #84). Open the widget with `Comments: Add Comment on Current Selection` instead.
- `Comments: Add Comment on Current Selection` is only offered once the extension has registered commenting ranges for the freshly opened diff; `palette` retries for that.
- Commenting is only allowed on files in the changed set, but on any line of such a file, not only changed lines. In the fixture, `README.md` has no comment ranges.
- Cmd+Enter submits only when focus is inside the widget's text area (`commentEditorFocused`). It works for new threads and replies in the disposable profile, which has no keymap extensions; #56 tracks cases where it does not.
- On the first thread after a `stop` and `launch`, Cmd+Enter once left the typed draft in the box (no file written). The widget button submits it: `$H click '.review-widget .monaco-button' 'Add Review Comment'`. Check `.feedback/` for the new `.review` file before assuming the submit happened.
- Monaco renders spaces as non-breaking spaces in `.view-line`. The helper normalizes them, but your own `eval` code has to do the same.
