# Review UI conventions VS Code users already know

Research for [#52](https://github.com/pabloubal/local-hitl-review/issues/52), part of the Extension UX rebuild map (#39).

**Question:** What review conventions do VS Code users already know from VS Code's built-in comments UI and from the GitHub Pull Requests and Issues extension (called "the PR extension" below)? Which should our spec follow, and where should we deliberately depart?

Vocabulary follows [GLOSSARY.md](../GLOSSARY.md): thread, message, review round, draft, verdict. The platform's own names ("comment", "pending review", "conversation") appear only when quoting a platform label.

## Sources

All claims are checked against source at these commits (read on 2026-10-01):

- **VS Code core**: `microsoft/vscode` at [`3e0a32c`](https://github.com/microsoft/vscode/tree/3e0a32c9483b40917b581b027c8f24e207e06905).
  - [`commentsEditorContribution.ts`](https://github.com/microsoft/vscode/blob/3e0a32c9483b40917b581b027c8f24e207e06905/src/vs/workbench/contrib/comments/browser/commentsEditorContribution.ts) has the commands and keybindings.
  - [`commentCommandIds.ts`](https://github.com/microsoft/vscode/blob/3e0a32c9483b40917b581b027c8f24e207e06905/src/vs/workbench/contrib/comments/common/commentCommandIds.ts) has the command IDs.
  - [`commentFormActions.ts`](https://github.com/microsoft/vscode/blob/3e0a32c9483b40917b581b027c8f24e207e06905/src/vs/workbench/contrib/comments/browser/commentFormActions.ts) has the comment form buttons and their default action.
  - [`commentsTreeViewer.ts`](https://github.com/microsoft/vscode/blob/3e0a32c9483b40917b581b027c8f24e207e06905/src/vs/workbench/contrib/comments/browser/commentsTreeViewer.ts) and [`commentsViewActions.ts`](https://github.com/microsoft/vscode/blob/3e0a32c9483b40917b581b027c8f24e207e06905/src/vs/workbench/contrib/comments/browser/commentsViewActions.ts) cover the Comments view.
  - [`comments.contribution.ts`](https://github.com/microsoft/vscode/blob/3e0a32c9483b40917b581b027c8f24e207e06905/src/vs/workbench/contrib/comments/browser/comments.contribution.ts) has the `comments.*` settings.
  - [`menusExtensionPoint.ts`](https://github.com/microsoft/vscode/blob/3e0a32c9483b40917b581b027c8f24e207e06905/src/vs/workbench/services/actions/common/menusExtensionPoint.ts) has the comment menu contribution points and says which are proposed.
  - [`vscode.d.ts`](https://github.com/microsoft/vscode/blob/3e0a32c9483b40917b581b027c8f24e207e06905/src/vscode-dts/vscode.d.ts) and `vscode.proposed.*.d.ts` define the API.
- **PR extension**: `microsoft/vscode-pull-request-github` v0.166.1 at [`74fe08d`](https://github.com/microsoft/vscode-pull-request-github/tree/74fe08d0f62da3a84c22e1328b75091a2b501dd2).
  - [`package.json`](https://github.com/microsoft/vscode-pull-request-github/blob/74fe08d0f62da3a84c22e1328b75091a2b501dd2/package.json) has the menus, keybindings, views, settings, and `enabledApiProposals`.
  - [`package.nls.json`](https://github.com/microsoft/vscode-pull-request-github/blob/74fe08d0f62da3a84c22e1328b75091a2b501dd2/package.nls.json) has the labels.
  - [`src/github/utils.ts`](https://github.com/microsoft/vscode-pull-request-github/blob/74fe08d0f62da3a84c22e1328b75091a2b501dd2/src/github/utils.ts#L134) builds threads, marks them outdated, and decides whether they start collapsed.
  - [`src/github/prComment.ts`](https://github.com/microsoft/vscode-pull-request-github/blob/74fe08d0f62da3a84c22e1328b75091a2b501dd2/src/github/prComment.ts#L180) labels drafts "Pending".
  - [`src/view/reviewCommentController.ts`](https://github.com/microsoft/vscode-pull-request-github/blob/74fe08d0f62da3a84c22e1328b75091a2b501dd2/src/view/reviewCommentController.ts#L104) puts outdated threads on the old commit.
  - [`webviews/components/timeline.tsx`](https://github.com/microsoft/vscode-pull-request-github/blob/74fe08d0f62da3a84c22e1328b75091a2b501dd2/webviews/components/timeline.tsx#L340) and [`webviews/components/comment.tsx`](https://github.com/microsoft/vscode-pull-request-github/blob/74fe08d0f62da3a84c22e1328b75091a2b501dd2/webviews/components/comment.tsx#L667) hold the forms that submit a review.
- **This extension**: [`package.json`](../package.json) (v0.18.0) and `src/extension.ts` on `main`.

Each claim is marked **[V]** (verified in the source above) or **[I]** (an inference or recommendation).

---

## 1. Starting a thread and the keys that submit it

### VS Code core

- **[V]** An extension turns commenting on for a range by setting `commentingRangeProvider` on its `CommentController`. Core then shows a `+` glyph in the gutter of that range. Clicking it opens an inline comment widget (a zone widget under the line).
- **[V]** The commands have these keybindings:

| Command (ID) | Title | Key |
|---|---|---|
| `workbench.action.addComment` | Comments: Add Comment on Current Selection | `Ctrl/Cmd+K Ctrl/Cmd+Alt+C` |
| `editor.action.submitComment` | (submit the comment editor) | `Ctrl/Cmd+Enter`, when the comment editor has focus |
| `workbench.action.hideComment` | (collapse the widget) | `Esc` or `Shift+Esc` in the comment editor; `Ctrl/Cmd+Esc` (Windows: `Alt+Backspace`) from the editor |
| `workbench.action.focusCommentOnCurrentLine` | Comments: Focus Comment on Current Line | none |
| `workbench.action.toggleCommenting` | Comments: Toggle Editor Commenting | none |

- **[V]** `Ctrl/Cmd+Enter` runs the **first** action in the `comments/commentThread/context` menu (`triggerDefaultAction` takes `this._actions[0]`). The first button is the primary-styled one, and its tooltip shows the `Ctrl+Enter` hint. **The extension decides what Ctrl+Enter does by choosing the order of that menu.**
- **[V]** The placeholder text is "Type a new comment" for a new thread and "Reply..." for a reply, unless the controller sets `options.placeHolder`.
- **[V]** By default (`comments.thread.confirmOnCollapse: whenHasUnsubmittedComments`), core asks for confirmation before it collapses a thread with unsubmitted text.

### PR extension

- **[V]** When no review round is in progress, the new-thread form shows two buttons: **Start Review** and **Add Comment** (a message posted immediately, outside any review round). The setting `githubPullRequests.defaultCommentType` (`review` by default, or `single`) chooses which one is first, and so which one `Ctrl/Cmd+Enter` runs.
- **[V]** While a review round is in progress, the form shows one button, **Add Review Comment**, which adds the message as a draft.
- **[V]** The comment editor has extra buttons: **Make Code Suggestion** (`Ctrl/Cmd+K M`) and **Upload File**. These use the proposed `comments/comment/editorActions` menu.
- **[V]** **Add File Comment** is an editor title button (`$(comment)` icon) for threads about a whole file.

### This extension today

- **[V]** The new-thread buttons are **Add Review Comment**, **Add Suggestion**, and **Cancel**, in that order. **Add Review Comment** is first, so `Ctrl/Cmd+Enter` runs it.
- **[V]** It binds `Alt+C` to `vscodeComment.createComment`. It does not reuse or mention the built-in `Ctrl/Cmd+K Ctrl/Cmd+Alt+C`.

## 2. Draft review rounds and verdicts

### VS Code core

- **[V]** Core has no idea of a review round or a verdict. It does know about drafts, through the **proposed** `commentsDraftState` API (`Comment.state = CommentState.Draft`):
  - draft glyphs in the gutter (`editorGutter.commentDraftGlyphForeground`);
  - a `comment-draft` icon in the Comments view, where a draft takes priority over unresolved, which takes priority over resolved.

### PR extension

- **[V]** A message in a draft review round gets `label = "Pending"` and `state = CommentState.Draft`. Other users can't see these messages until the round is submitted.
- **[V]** A thread that has drafts shows a **Go to Review** button next to its form, using the proposed `comments/commentThread/additionalActions` menu. It opens the PR description webview and scrolls to the review form.
- **[V]** The verdict is chosen in a **webview**, not in native UI:
  - In the description timeline, the open review round shows a summary text box and four buttons: **Cancel Review**, **Request Changes**, **Approve**, and **Submit Review** (which submits with the verdict "Comment"). There, `Ctrl/Cmd+Enter` submits with the verdict "Comment".
  - The main comment form, also in the sidebar "Active Pull Request" webview, uses a split button whose options are **Comment / Approve / Request Changes**. It remembers the last verdict used. `Ctrl/Cmd+Enter` submits with the selected verdict.
- **[V]** **Approve** is enabled even with an empty summary and no drafts. **Comment** and **Request Changes** need a summary or at least one draft. The PR author sees only **Comment**.
- **[V]** **Cancel Review** deletes the review round and its drafts.

### This extension today

- **[V]** There is no draft state. Every thread and message is saved to the feedback files right away.
- **[V]** The `changedFiles` view title has one action, **Approve / Finish Review** (`$(check-all)`). It writes `review-complete.md`, which lists open findings by severity. It never asks for a verdict, does not take a summary, and cannot be cancelled.

## 3. Listing threads and moving between them

### VS Code core

- **[V]** The **Comments** view (`workbench.panel.comments`) lists the threads of every controller, grouped by file. Each row shows:
  - an icon for the state (draft, unresolved, or resolved);
  - an "Outdated" tag when the thread is outdated;
  - the number of messages.
- **[V]** The view's title bar has a filter box and **Show Unresolved / Show Resolved** toggles. A **Sort By** submenu offers **Updated Time** or **Position in File**.
- **[V]** The setting `comments.openView` (default `firstFile`) opens the view automatically. `comments.visible` hides the threads in editors.
- **[V]** The navigation commands are:

| Command | Key |
|---|---|
| Go to Next / Previous Comment Thread (`editor.action.next/previousCommentThreadAction`) | `Alt+F9` / `Shift+Alt+F9` |
| Go to Next / Previous Commented Range | `Alt+F10` / `Shift+Alt+F10` |
| Go to Next / Previous Commenting Range | `Ctrl/Cmd+K Ctrl/Cmd+Alt+↓ / ↑` |
| Collapse All / Expand All / Expand Unresolved Comments | none |

- **[V]** `comments.collapseOnResolve` (default `true`) collapses a thread when it is resolved.

### PR extension

- **[V]** The PR extension adds **no** keybindings for moving between threads. It relies on the core ones above.
- **[V]** It reuses the core Comments view. Its only addition there is a **Refresh Pull Request Comments** title action (`view == workbench.panel.comments`).
- **[V]** It adds per-thread actions to the Comments view through the proposed `commentsView/commentThread/context` menu:
  - **Diff Comment with HEAD** (only for outdated threads);
  - **Resolve Conversation** or **Unresolve Conversation**.
- **[V]** The changed-files view ("Changes in Pull Request", `prStatus:github`) lists files, not threads.
- **[V]** The setting `githubPullRequests.commentExpandState` decides which threads start expanded: `expandUnresolved` (default), `collapseAll`, or `collapsePreexisting`. Resolved threads, and threads whose last message is your own, start collapsed.

### This extension today

- **[V]** Threads are listed in a custom tree view, **Review Feedback Summary** (`vscodeComment.feedbackSummary`), with a **Filter Feedback** action.
- **[V]** It doesn't contribute to the core Comments view, except for **Copy Agent Prompt** in that view's title bar.
- **[V]** The keybindings are `Alt+N` (next unreviewed *file*), `Alt+O`, `Alt+C`, and `Alt+M`. None of them moves between threads.

## 4. How outdated threads are shown

- **[V]** In core, a thread is either Current or Outdated (`CommentThreadApplicability`). This is a **proposed** API (`commentThreadApplicability`). Core uses it only to show the "Outdated" tag in the Comments view.
- **[V]** The PR extension does **not** draw an outdated thread on the current file. It puts the thread on a read-only `review:` URI of the **original commit** (`commit~<sha8>/path`) at the original lines, and appends `outdated` to the thread's `contextValue`. Users reach it through:
  - the Comments view (tagged "Outdated");
  - **Diff Comment with HEAD**, which opens the original against HEAD.
- **[V]** Outdated threads are not collapsed just because the last message is your own, but they still follow `commentExpandState`.
- **[V]** This extension has no outdated handling (no `outdated` or `stale` anywhere in `src/`).
- **[I]** Neither platform has anything like our **orphaned** anchor state. Core has only two values, Current and Outdated.

## 5. Title bars versus context menus

The table below lists the comment menus core provides (from `menusExtensionPoint.ts`). **Proposed** means a Marketplace extension can't use it without `enabledApiProposals`, which only works in Insiders or with special permission.

| Menu | Rendered as | Proposed? | Used by the PR extension for |
|---|---|---|---|
| `comments/commentThread/title` | Icons in the thread widget's title bar | No | Refresh, Collapse All |
| `comments/commentThread/context` | Buttons under the comment editor (no submenus). The first is primary and runs on Ctrl+Enter | No | Start Review / Add Comment / Add Review Comment |
| `comments/comment/title` | Icons on each message. `inline` shows them, other groups go to an overflow `…` | No | Apply Suggestion (inline); Edit, Delete, Copy Link (overflow) |
| `comments/comment/context` | Buttons under a message being edited | No | Save, Cancel |
| `comments/commentThread/additionalActions` | Extra buttons next to the form (submenus allowed) | **Yes** | Resolve / Unresolve, Go to Review |
| `comments/commentThread/title/context` | Right-click menu on the thread title | **Yes** | Resolve / Unresolve |
| `comments/commentThread/comment/context` | Right-click menu on one message | **Yes** | Resolve, Apply Suggestion |
| `comments/comment/editorActions` | Toolbar in the comment editor | **Yes** | Make Code Suggestion, Upload File |
| `commentsView/commentThread/context` | Inline icons and right-click menu on Comments view rows | **Yes** | Diff with HEAD, Resolve / Unresolve |

- **[V]** The PR extension's `enabledApiProposals` include `commentsDraftState`, `commentThreadApplicability`, `commentReveal`, `contribCommentThreadAdditionalMenu`, `contribCommentPeekContext`, `contribCommentEditorActionsMenu`, and `contribCommentsViewThreadMenus`.
- **[I]** The PR extension is a first-party Microsoft extension, which is why it can ship those proposals. **Much of what users see in it (drafts, outdated tags, Resolve buttons, Comments view row actions) can't be used by a Marketplace extension.** Our spec has to reach the same results with stable API:
  - `Comment.label`, which the PR extension also uses for "Pending";
  - `CommentThread.label`, `contextValue`, `state` (resolved/unresolved, which is stable), and `collapsibleState`;
  - our own tree view.
- **[V]** In the PR extension, the title bar holds the actions that apply to the whole view or editor, and actions on one item go in context menus:
  - View title bars have Refresh, View as Tree/List, Hide Viewed Files, Toggle Editor Commenting, and Create.
  - Editor titles have Mark File As Viewed and Add File Comment.
  - Rarely used actions (Open on GitHub, Checkout by Number, Configure…) go in the `overflow` group.
  - Actions on one thread or message stay on that thread or message.
  - The verdict is never a bare title-bar icon. It lives in a form that has a summary box.

## 6. How many actions each view exposes

Counts are the most icons visible at once, in `navigation` / `inline`, followed by the overflow items.

| Surface | PR extension | This extension |
|---|---|---|
| Main list view title | `pr:github`: **2** (Create, Refresh) + 3 overflow | `changedFiles`: **9**, all in `navigation`, none in overflow (Initialize, Refresh, Tree/List, Open Changes, Base Branch, Compare Mode, Copy Agent Prompt, Approve/Finish, Filter) |
| Changed-files view title | `prStatus:github`: **4** (Toggle Commenting, Refresh, Tree/List, Hide Viewed) | (same view as above) |
| Active review / summary view title | `github:activePullRequest`: **3** (Refresh, Description, Open on GitHub) | `feedbackSummary`: **1** (Filter) |
| Thread title | **2** (Refresh, Collapse All) | **0** |
| New-thread form buttons | **2** (Start Review + Add Comment), or **1** while a review round is open | **3** (Add Review Comment, Add Suggestion, Cancel) |
| Message title | **1** inline (Apply Suggestion, only on suggestions) + **3–4** overflow | **5** inline (Edit, Delete, Severity submenu, Apply Suggestion, Status submenu), shown together whenever `comment == canEdit` |
| Repository tree item (inline) | n/a | **5** (Refresh, Open All Changes, Base Branch, Compare Mode, Initialize) |
| Keybindings contributed | 6, all scoped to a narrow `when` (e.g. `commentEditorFocused`) | 4 single-modifier `Alt+letter`, active whenever the view has focus or `commentController == vscode-comment` |

- **[I]** The PR extension rarely shows more than 3–4 icons on any surface and moves the rest to overflow. Our main view shows 9 icons, and each editable message shows 5.

---

## Conventions our spec should follow

1. **Start threads the way core does.** Use the gutter `+` from a `commentingRangeProvider`, and treat `Ctrl/Cmd+K Ctrl/Cmd+Alt+C` (Add Comment on Current Selection) as the documented shortcut. **[V]** for the platform; **[I]** for the recommendation.
2. **`Ctrl/Cmd+Enter` adds the message; `Esc` collapses the thread.** Put the most common action first in `comments/commentThread/context`, since core runs whatever is first.
3. **Keep a draft review round, with two buttons in the new-thread form.** Before a review round starts, show **Start Review** and **Add Comment**. The first is the default and is chosen by a setting like `defaultCommentType`. Once a review round is open, show one button that adds a draft. Mark draft messages with `Comment.label = "Draft"` (stable API), the same way the PR extension uses "Pending".
4. **Submit the review round with exactly three verdicts: Approve, Comment, Request changes.** Also offer **Cancel**, which discards the drafts, and an optional summary. Copy the PR extension's enabling rules: Approve is always allowed; Comment and Request changes need a summary or at least one draft. Remember the last verdict as the default.
5. **Keep the review round reachable from each draft thread.** Add a "Go to Review" or "Submit Review…" entry on draft threads, using stable menus such as `comments/commentThread/title` or `comments/comment/title` overflow.
6. **Move between threads with the core keys.** Use `Alt+F9` / `Shift+Alt+F9` and the core Comments view, and don't add rival bindings. If we need our own list, add it next to the Comments view without replacing it, and have the same "next thread" semantics.
7. **Collapse what is done, expand what needs attention.** Expand unresolved threads; collapse resolved threads and threads whose last message is the reviewer's own. Consider a setting with the same values as `commentExpandState`. Follow `comments.collapseOnResolve`.
8. **Show outdated threads where they were made.** Put them on the original revision, mark them in the thread label and `contextValue` (`outdated`), and give them a "Diff with current" action. Don't silently move them onto edited code.
9. **Title bar for the view, context menus for items, overflow for the rest.** Show at most 3–4 icons per title bar and move rare actions to `overflow`. Show message actions inline only when they apply (as Apply Suggestion does), and move Edit, Delete, and Copy into overflow.
10. **Use the platform's names for its own actions:** "Resolve Conversation", "Toggle Editor Commenting", "View as Tree / List", "Mark File As Viewed", "Add File Comment", and "Collapse All Comments".
11. **Scope keybindings narrowly.** Bind only when a comment editor or our view has focus, and prefer chords (`Ctrl/Cmd+K …`) over single `Alt+letter` keys.

## Deliberate departures to consider

1. **Choose the verdict in native UI, not a webview.** We have no description webview, so "Submit Review…" could open a QuickPick with Approve / Comment / Request changes and then an input box for the summary. **[I]** This is a smaller surface than the PR extension uses, and it still works from the keyboard.
2. **Show draft and outdated state with stable API.** The proposals behind draft glyphs, the "Outdated" tag, Resolve buttons, and Comments view row actions are closed to us. We use labels, `contextValue`, our own tree view, and the stable `comments/commentThread/title` and `comments/comment/title` menus instead. **[V]** that the proposals are closed; **[I]** for the substitutes.
3. **Add an orphaned anchor state.** Core and the PR extension know only Current and Outdated. We should show orphaned threads in our list view with their saved anchor, because there is no file or line to put them on.
4. **The verdict sends a nudge to an agent session.** Submitting a review round notifies the agent session that wrote the code. Nothing on the platform does this; it is core to our product. The message should say this plainly, for example "Submitted. Agent session notified."
5. **No messages outside a review round.** We could drop the "Add Comment" path that posts immediately. A message posted that way reaches agents without a verdict or a nudge, which may confuse the agent session. Dropping it would mean every message goes through a review round. If we drop it, we should make that choice on purpose and write it down, because PR-extension users will look for it.
6. **Severity and status are ours, but should move off the message title bar.** "Won't Fix" and Critical / High / Medium / Low have no platform counterpart. They are a legitimate addition, but they should go into overflow or a single "Set…" submenu, not two inline submenus on every message.
7. **One view for files and threads.** The PR extension splits files (`prStatus:github`) from threads (the Comments view). We may keep a combined tree for the agent workflow, but its title bar should follow convention 9.
8. **Agent-facing actions (Copy Agent Prompt).** These have no counterpart on the platform. Keep them, but in overflow unless they turn out to be a primary action.
