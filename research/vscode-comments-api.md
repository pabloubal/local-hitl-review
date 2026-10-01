# VS Code comments API support for anchored threads

Research for [#46](https://github.com/pabloubal/local-hitl-review/issues/46). It feeds the anchoring ADR ([#41](https://github.com/pabloubal/local-hitl-review/issues/41)).

- **Date:** 2026-10-01
- **Our floor:** `engines.vscode ^1.100.0` (`package.json`)
- **VS Code source read at:** `microsoft/vscode` `main` @ [`3e0a32c`](https://github.com/microsoft/vscode/tree/3e0a32c9483b40917b581b027c8f24e207e06905). Line numbers below refer to that commit.
- **Minimum versions** come from the published `@types/vscode` typings for each release (fetched from unpkg), the VS Code 1.36.0 source tag, and the release notes. Anything not checked against one of these is marked as an inference.

Labels used below:

- **[Verified]**: read directly in a primary source (typings, VS Code source, official docs, release notes).
- **[Inference]**: our conclusion from verified facts. It has not been tested in a running VS Code.

## Summary

| Question | Short answer |
|---|---|
| 1. Do thread ranges follow edits, and does the extension see it? | Only partly, and the extension never sees it. VS Code shifts the thread's gutter glyph and widget while the file is open in an editor, but it keeps that shifted range on the renderer side. `CommentThread.range` in the extension host keeps the value we set. The extension must track edits itself and reassign `thread.range`. |
| 2. How do we show "Outdated", "Orphaned", "from branch X"? | Use `CommentThread.label` (free text header, stable since ≤1.35) and/or `Comment.label` (free text next to the author, ≤1.35). Use `contextValue` (≤1.35) to drive per-state actions. `CommentThread.state` (1.75) only means resolved or unresolved. VS Code's built-in "Outdated" badge needs the proposed `commentThreadApplicability` API, which a Marketplace extension cannot use. |
| 3. Can a thread show the original anchored code? | Yes. Put a fenced code block in a message body (`MarkdownString`, ≤1.35), or add a thread action (`comments/commentThread/title`, ≤1.36) that opens a diff of the anchor snapshot against the current file with `vscode.diff` and a `TextDocumentContentProvider`. All of this works on our 1.100 floor. |

## 1. Does a thread's range follow edits?

### What the API says

- **[Verified]** `CommentThread.range: Range | undefined` is a plain read/write property: "The range the comment thread is located within the document. The thread icon will be shown at the last line of the range." No event reports range changes. `CommentController` has no range-change callback either. Source: [`vscode.d.ts`, `interface CommentThread`](https://github.com/microsoft/vscode/blob/3e0a32c9483b40917b581b027c8f24e207e06905/src/vscode-dts/vscode.d.ts).

### What VS Code does internally

- **[Verified]** **Extension host side.** `ExtHostCommentThread.range` stores the value and marks it as modified only when the extension assigns it. Only modified fields are sent to the renderer (`extHostComments.ts` lines 302-306 and 501-502). The renderer sends a range back to the extension host for *template* threads only, which are new, still-empty threads the user is typing into (`$updateCommentThreadTemplate`, lines 729-733). An existing thread never receives one. Source: [`src/vs/workbench/api/common/extHostComments.ts`](https://github.com/microsoft/vscode/blob/3e0a32c9483b40917b581b027c8f24e207e06905/src/vs/workbench/api/common/extHostComments.ts).
- **[Verified]** **Renderer side.** For each open editor, `CommentThreadZoneWidget.display()` creates a `CommentGlyphWidget`. That widget holds a one-line editor decoration on the **last line** of the range. When the decoration moves, `onDidChangeLineNumber` fires. The zone widget then shifts the renderer copy of the range by the same number of lines: `start + shift`, `end + shift` (`commentThreadZoneWidget.ts` lines 420-432). Sources: [`commentThreadZoneWidget.ts`](https://github.com/microsoft/vscode/blob/3e0a32c9483b40917b581b027c8f24e207e06905/src/vs/workbench/contrib/comments/browser/commentThreadZoneWidget.ts), [`commentGlyphWidget.ts`](https://github.com/microsoft/vscode/blob/3e0a32c9483b40917b581b027c8f24e207e06905/src/vs/workbench/contrib/comments/browser/commentGlyphWidget.ts) lines 44-50.
- **[Verified]** The renderer's `MainThreadCommentThread.range` setter only stores the value. It does not call back into the extension host (`mainThreadComments.ts` lines 87-89). Source: [`src/vs/workbench/api/browser/mainThreadComments.ts`](https://github.com/microsoft/vscode/blob/3e0a32c9483b40917b581b027c8f24e207e06905/src/vs/workbench/api/browser/mainThreadComments.ts).
- **[Verified]** The glyph decoration is created with `collapseOnReplaceEdit: true` (`commentGlyphWidget.ts` lines 65-75). If an edit replaces the text around it, the decoration collapses to the edit boundary.
- **[Verified]** When a file changes on disk and VS Code reloads it, the open model is updated through `ModelService.updateModel`. That method computes **a single replace edit**: everything between the common prefix lines and the common suffix lines (`modelService.ts` lines 412-438, called from `textEditorModel.ts` line 225). Sources: [`modelService.ts`](https://github.com/microsoft/vscode/blob/3e0a32c9483b40917b581b027c8f24e207e06905/src/vs/editor/common/services/modelService.ts), [`textEditorModel.ts`](https://github.com/microsoft/vscode/blob/3e0a32c9483b40917b581b027c8f24e207e06905/src/vs/workbench/common/editor/textEditorModel.ts).

### What this means for us

- **[Inference]** **The extension does not learn the new range.** After unsaved edits, `thread.range` (and `reply.thread.range` in command handlers) still holds the range we set. `src/commentController.ts` reads `reply.thread.range` / `comment.parent.range` to compute `lines` for new messages and suggestions (around lines 89, 122 and 301). After edits above a thread, it may record or replace the wrong lines.
- **[Inference]** **The built-in tracking is visual only and limited:**
  - It tracks only the *end line* and moves the whole range by the same offset. Inserting lines *inside* a multi-line range moves its start too. It never grows or shrinks the range.
  - It runs only while an editor shows the file. Edits made while the file is not open, such as an agent writing to disk with no tab open, are not tracked.
  - When an agent rewrites a block on disk while the file is open, the reload is one big replace edit. A thread inside that block collapses to the block's edge instead of following its code.
  - The shifted range lives only in the renderer's copy. If we reassign `thread.range` or recreate the thread, our value wins.
- **[Inference]** **Recommendation:** treat the anchor in the `.review` file as the source of truth. Re-anchor in the extension:
  - Listen to `workspace.onDidChangeTextDocument` for unsaved edits. Each `TextDocumentContentChangeEvent` carries `range` and `text`, so we can shift or resize ranges per edit.
  - Run the content-based match from the anchoring ADR when a file is opened, saved or changed on disk.
  - Then assign `thread.range`. This also gives us the anchor state (current/outdated/orphaned), which VS Code has no notion of in the stable API.
  - `onDidChangeTextDocument` and `TextDocumentContentChangeEvent` are long-standing stable APIs, well below our floor.

## 2. Showing "Outdated", "Orphaned" and "from branch X"

| Mechanism | What it renders | Can carry our anchor state? | Minimum VS Code |
|---|---|---|---|
| `CommentThread.label?: string` | Plain text in the thread widget header. The renderer sets it as `textContent` (no markdown, no icons). Source: [`commentThreadHeader.ts`](https://github.com/microsoft/vscode/blob/3e0a32c9483b40917b581b027c8f24e207e06905/src/vs/workbench/contrib/comments/browser/commentThreadHeader.ts) lines 113-125. | **Yes.** Free text, e.g. `Bug — open · Outdated · from feature/x`. We already use it for severity and status. | ≤1.35 **[Verified]** (present in `@types/vscode@1.35.0`, the first typings with `createCommentController`. Absent in 1.33 and 1.34.) |
| `Comment.label?: string` | Plain text "rendered next to authorName" on one message. Source: `vscode.d.ts`; [`commentNode.ts`](https://github.com/microsoft/vscode/blob/3e0a32c9483b40917b581b027c8f24e207e06905/src/vs/workbench/contrib/comments/browser/commentNode.ts) lines 263-264. | Yes, per message, e.g. "from feature/x" on the agent's message. We currently use it for severity. | ≤1.35 **[Verified]** |
| `CommentThread.contextValue?: string` | Not visible. It sets the `commentThread` context key for `when` clauses in `comments/commentThread/*` menus. Source: `vscode.d.ts`; [`commentContextKeys.ts`](https://github.com/microsoft/vscode/blob/3e0a32c9483b40917b581b027c8f24e207e06905/src/vs/workbench/contrib/comments/common/commentContextKeys.ts) lines 59-63. | Yes, to show state-specific actions, e.g. `commentThread =~ /outdated/` shows "Show original code" or "Re-anchor". | ≤1.35 **[Verified]** |
| `Comment.contextValue?: string` | Same idea for the `comment` context key in `comments/comment/*` menus. | Per-message actions. | ≤1.35 **[Verified]** |
| `CommentThread.state?: CommentThreadState` | Only `Unresolved` / `Resolved`. Changes the glyph colour and Comments view filtering. Collapses on resolve by default (`comments.collapseOnResolve`, 1.83). | **No.** It means resolution, not anchor state. | 1.75 **[Verified]** ([release notes](https://code.visualstudio.com/updates/v1_75): "The `CommentThread` `state` API has been finalized"; present in `@types/vscode@1.75.0`, absent in 1.74.0) |
| `CommentThread2.state.applicability` (`CommentThreadApplicability.Current/Outdated`) | Built-in "Outdated" badge in the Comments view ([`commentsTreeViewer.ts`](https://github.com/microsoft/vscode/blob/3e0a32c9483b40917b581b027c8f24e207e06905/src/vs/workbench/contrib/comments/browser/commentsTreeViewer.ts) lines 284-286). No orphaned value. | Outdated only, and **not usable by us**. | **Proposed API only** (`vscode.proposed.commentThreadApplicability.d.ts`, issue [#207402](https://github.com/microsoft/vscode/issues/207402)). Proposed APIs "should not be used in published extensions" and are Insiders-only ([docs](https://code.visualstudio.com/api/advanced-topics/using-proposed-api)). **[Verified]** |
| `CommentThread.range = undefined` | File-level thread (no line). | Possible display for **orphaned** threads whose file still exists. | 1.97 **[Verified]** (`range: Range \| undefined` first in `@types/vscode@1.97.0`, `Range` in 1.96.0) |
| `canReply: boolean \| CommentAuthorInformation` | Disables replies, or shows who replies. | Can block replies on orphaned threads. | `boolean` ≤1.52, author object 1.100 **[Verified]** (first in `@types/vscode@1.100.0`, absent in 1.99.0) |

- **[Inference]** **Recommended mapping on the 1.100 floor:**
  - *Outdated* and *orphaned*: append to `thread.label`, and encode in `contextValue` (e.g. `thread:outdated`) for actions.
  - *From branch X*: a suffix in `thread.label` (thread-level), or `Comment.label` on each message (message-level).
  - Keep `state` for resolved/unresolved only.
  - An orphaned thread whose file still exists can sit at its last known lines, or become a file-level thread (`range = undefined`).
  - An orphaned thread whose file is gone cannot render in an editor at all. It can only appear in our own views (the Comments panel lists threads by URI; behaviour for a missing file is unverified).

## 3. Can a thread show the original anchored code?

- **[Verified]** `Comment.body` is `string | MarkdownString` (≤1.35). The renderer passes it to the workbench markdown renderer (`commentNode.ts` lines 206-214), which has a code-block renderer hook (`codeBlockRenderer`) for fenced blocks ([`markdownRenderer.ts`](https://github.com/microsoft/vscode/blob/3e0a32c9483b40917b581b027c8f24e207e06905/src/vs/platform/markdown/browser/markdownRenderer.ts) lines 73-76). A fenced block with a language tag (```` ```ts ````) in a message shows the anchor snapshot inline.
- **[Verified]** With `MarkdownString.isTrusted` (true, or `{ enabledCommands: [...] }`), `command:` links in a body run commands (`markdownRenderer.ts` lines 89-110; `vscode.d.ts` `MarkdownString.isTrusted`). A message can therefore carry a "Show original" link.
- **[Verified]** Custom thread actions: the `comments/commentThread/title` (thread header icons) and `comments/commentThread/context` (buttons below the reply box) menus. Also `comments/comment/title` and `comments/comment/context` per message. All four exist in the VS Code 1.36.0 source ([`menusExtensionPoint.ts@1.36.0`](https://github.com/microsoft/vscode/blob/1.36.0/src/vs/workbench/api/common/menusExtensionPoint.ts) lines 48-51) and are stable today ([`menusExtensionPoint.ts`](https://github.com/microsoft/vscode/blob/3e0a32c9483b40917b581b027c8f24e207e06905/src/vs/workbench/services/actions/common/menusExtensionPoint.ts) lines 268-307). The command receives the `CommentThread`. The repo already uses three of them in `package.json`.
- **[Verified]** These comment menus are proposed only and therefore unavailable to us: `comments/commentThread/additionalActions`, `comments/commentThread/title/context`, `comments/commentThread/comment/context`, `commentsView/commentThread/context` (same file, `proposed:` fields).
- **[Inference]** **Recommended approach**, for outdated threads:
  1. Embed the anchor snapshot as a fenced code block in a synthetic, read-only first message, or in a collapsible note at the end of the first message. Cheap, always visible, and needs no new API.
  2. Add a thread title action, shown when `commentThread =~ /outdated/`, that runs `vscode.diff`. The left side is a virtual document for the anchor snapshot, served by `workspace.registerTextDocumentContentProvider` under a custom scheme. The right side is the current file. This shows exactly what changed since the thread was created. Both `vscode.diff` and `TextDocumentContentProvider` are long-standing stable APIs.

  Keep code blocks short. Long anchors make the in-editor widget tall, so the diff action suits large anchors better.

## Open points not verified here

- Exact render behaviour of a thread whose URI points at a deleted file, in the Comments panel.
- Whether `Comment.label` is shown in the Comments panel tree, or only in the editor widget.
- Manual check in a running VS Code 1.100 of the glyph shifting described in question 1 (it was read from source only).
