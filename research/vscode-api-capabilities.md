# VS Code API capabilities for the extension redesign

Research for [#53](https://github.com/pabloubal/local-hitl-review/issues/53) (map [#39](https://github.com/pabloubal/local-hitl-review/issues/39)), also covering the cause of [#56](https://github.com/pabloubal/local-hitl-review/issues/56).

- **Date:** 2026-10-01
- **Our target:** `engines.vscode: ^1.100.0` (`package.json`)
- **Sources:** VS Code source at `microsoft/vscode` `main` (commit `3e0a32c`, version 1.141.0) and the `1.100.0` to `1.140.0` release tags. API minimum versions come from diffing `@types/vscode` `1.40.0` to `1.100.0`, which mirrors `src/vscode-dts/vscode.d.ts` per release. Contribution points come from the extension-point schemas in the source, which back the [contribution points reference](https://code.visualstudio.com/api/references/contribution-points).
- **Legend:** **Verified** means read in source or `vscode.d.ts`. **Inference** means reasoned from verified facts but not run.

In the VS Code API a thread is a `CommentThread` and a message is a `Comment`. This document uses the project terms (thread, message, draft, review round) and keeps the API names only for API identifiers.

## Summary

| Capability                                       | Available at `^1.100`?    | Minimum version                                                      | Notes                                                                                                                                                                               |
| ------------------------------------------------ | ------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cmd+Enter submit (`editor.action.submitComment`) | Yes                       | ≤1.100 (same code at 1.100.0 and 1.141)                              | Runs the first action of the **last** group in `comments/commentThread/context`. Loses to any extension or user keybinding on Cmd+Enter whose `when` matches a focused text editor. |
| `CommentOptions.prompt` / `placeHolder`          | Yes                       | 1.46                                                                 | Set once per controller, not per thread.                                                                                                                                            |
| Tree item checkboxes                             | Yes                       | 1.80                                                                 | `TreeItem.checkboxState`, `TreeView.onDidChangeCheckboxState`, `TreeViewOptions.manageCheckboxStateManually`.                                                                       |
| Custom view container (Activity Bar / Panel)     | Yes                       | long-standing (<1.40)                                                | `contributes.viewsContainers.activitybar` / `.panel`.                                                                                                                               |
| View container in the Secondary Side Bar         | No: needs 1.106           | 1.106 (proposed only in 1.104–1.105)                                 | `contributes.viewsContainers.secondarySidebar`.                                                                                                                                     |
| Moving views between containers                  | Users only; no stable API | n/a                                                                  | Users drag views or run `workbench.action.moveView`. `vscode.moveViews` is an internal, undocumented command.                                                                       |
| Walkthroughs                                     | Yes                       | long-standing (<1.100)                                               | Open on install by default (`workbench.welcomePage.walkthroughs.openOnInstall`).                                                                                                    |
| Status bar item                                  | Yes                       | 1.57 (`id` overload); 1.59 (Markdown tooltip)                        | `window.createStatusBarItem(id, alignment, priority)`.                                                                                                                              |
| Markdown in messages                             | Yes                       | `supportHtml` 1.62, `isTrusted.enabledCommands` 1.73, `baseUri` 1.66 | The body must be a `MarkdownString`. A plain `string` renders as plain text.                                                                                                        |
| Mermaid in messages                              | No native rendering       | n/a                                                                  | Comes out as a code block. Needs a pre-rendered image or a webview.                                                                                                                 |
| Threads in normal editors                        | Yes                       | long-standing                                                        | Threads are matched by document URI, so they show in any editor of that URI, including both sides of a side-by-side diff.                                                           |

## 1. Cmd+Enter and `editor.action.submitComment`

### How the submit command picks an action (verified)

1. **Command id.** The id is `editor.action.submitComment`, not `workbench.action.submitComment`. `src/vs/workbench/contrib/comments/common/commentCommandIds.ts`: `Submit = 'editor.action.submitComment'`.
2. **Keybinding rule.** `src/vs/workbench/contrib/comments/browser/commentsEditorContribution.ts`:
   ```ts
   KeybindingsRegistry.registerCommandAndKeybindingRule({
     id: CommentCommandId.Submit,
     weight: KeybindingWeight.EditorContrib, // 100
     primary: KeyMod.CtrlCmd | KeyCode.Enter,
     when: ctxCommentEditorFocused, // 'commentEditorFocused'
     handler: (accessor) => {
       const activeCodeEditor = accessor
         .get(ICodeEditorService)
         .getFocusedCodeEditor();
       if (activeCodeEditor instanceof SimpleCommentEditor) {
         activeCodeEditor.getParentThread().submitComment();
       }
     },
   });
   ```
   This code is the same at tag `1.100.0` (line 403) and on `main`.
3. **Thread widget.** `commentThreadWidget.ts` `submitComment()`: if a message in the thread is being edited (`_body.activeComment`), that message is submitted. Otherwise, the reply editor is submitted **only if its text is not empty** (`getPendingComment()?.body.length > 0`).
4. **Reply form.** `commentReply.ts` `submitComment()` calls `this._commentFormActions.triggerDefaultAction()`. The form's actions come from `MenuId.CommentThreadActions`, which is the menu that `comments/commentThread/context` maps to (`menusExtensionPoint.ts`).
5. **Picking the default action.** In `commentFormActions.ts`:
   ```ts
   setActions(menu) {
     const groups = menu.getActions({ shouldForwardArgs: true });
     for (const group of groups) {
       const [, actions] = group;
       this._actions = actions;          // overwritten for every group
       ...
     }
   }
   triggerDefaultAction() {
     if (this._actions.length) {
       const lastAction = this._actions[0];
       if (lastAction.enabled) { return this.actionHandler(lastAction); }
     }
   }
   ```
   The default action is therefore **the first item (lowest `@order`) of the last menu group**. Groups are sorted as follows: `navigation` first, then the other groups alphabetically, then items with no group (`menuService.ts` `compareMenuItems`). The action runs only if it is `enabled`. The action is not focused or clicked, and it is the same `actionHandler` the button uses, so the arguments (`{ thread, text, $mid }`) are identical to a mouse click.
6. **Enablement is refreshed with a delay.** `MenuItemAction.enabled` is computed once, when `getActions()` runs. The form rebuilds when a precondition context key changes, but the menu's change event is debounced by `eventDebounceDelay: 50` ms (`menuService.ts`). `vscodeComment.createComment` has `enablement: "!commentIsEmpty"`. For about 50 ms after the first character is typed into an empty editor, the cached action is still disabled, and `triggerDefaultAction()` does nothing.

For our menu (`inline@1` createComment, `inline@2` createCommentWithSuggestion, `inline@3` discardNewThread, all with `when: commentController == vscode-comment`) there is one group, `inline`, so the default action is `vscodeComment.createComment`. This is correct. No built-in VS Code code contributes to `MenuId.CommentThreadActions`. Other extensions could, but only items whose `when` matches our controller's context would show up.

### Which keybindings compete for Cmd+Enter (verified)

How resolution works: `KeybindingsRegistry` sorts its items by `weight1`, then by command id, then by `weight2` (`keybindingsRegistry.ts` `sorter`). `KeybindingResolver._findCommand` walks matches **from last to first** and runs the first one whose `when` holds. So the highest weight wins, and when weights are equal, the command id that sorts last alphabetically wins. User keybindings are appended after everything else and win over all of them. Extension keybindings get weight `ExternalExtension (400) + i`, where `i` is the 1-based position of the binding in that extension's `contributes.keybindings` array, or `BuiltinExtension (300) + i` for built-in extensions (`keybindingService.ts` `_asCommandRule`).

Built-in Cmd+Enter bindings that can match inside the comment editor:

| Command                                                            | Weight              | `when`                                          | Beats submit?                                                                                                                             |
| ------------------------------------------------------------------ | ------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `editor.action.insertLineAfter` ("Insert Line Below")              | 100 (EditorContrib) | `editorTextFocus && !editorReadonly`            | **No.** Same weight, and `editor.action.insertLineAfter` sorts before `editor.action.submitComment`, so submit is checked first and wins. |
| `inlineChat2.keep`                                                 | 210                 | inline chat visible and has edits               | Only while inline chat is open. Not relevant here.                                                                                        |
| `scm.acceptInput`                                                  | 200                 | `scmRepository` (set only in the SCM input box) | No.                                                                                                                                       |
| `chatEditing.acceptAllFiles`, chat submit, chat code block actions | 100–401             | chat input or chat session context keys         | No.                                                                                                                                       |

The comment editor (`SimpleCommentEditor`) is a full `CodeEditorWidget` that sets `editorTextFocus` and registers every editor action (`_getActions()` returns `EditorExtensionsRegistry.getEditorActions()`). Any binding whose `when` is just `editorTextFocus`, from a keymap extension or the user's `keybindings.json`, therefore matches inside the comment editor and, at weight ≥ 300, beats `editor.action.submitComment` (100).

## Likely cause of the Cmd+Enter bug (#56)

**Conclusion (inference, strongly supported).** VS Code's submit logic is not at fault. With only built-in keybindings, Cmd+Enter in our comment editor resolves to `editor.action.submitComment`, which runs `vscodeComment.createComment` with the same arguments as a click. The likely cause is a **third-party keybinding on Cmd+Enter with a `when` of `editorTextFocus && !editorReadonly`**, which outranks the built-in submit binding.

**Evidence:**

1. The submit path above is verified in source. It picks `vscodeComment.createComment` for our menu, and the code is the same at 1.100.0.
2. Built-in "Insert Line Below" (`editor.action.insertLineAfter`) does **not** win. It has the same weight as submit and its id sorts earlier, so the resolver checks submit first.
3. The maintainer's machine has a third-party keymap extension installed and enabled (no globally disabled extensions in `state.vscdb`, no user `keybindings.json`). It contributes, at position 36 of its keybindings array:
   ```json
   {
     "key": "ctrl+enter",
     "mac": "cmd+enter",
     "command": "lineBreakInsert",
     "when": "editorTextFocus && !editorReadonly"
   }
   ```
   That binding has weight 400 + 36 = 436, above submit's 100. Its `when` holds inside the comment editor. `lineBreakInsert` (`src/vs/editor/browser/coreCommands.ts`, the built-in Ctrl+O on macOS) only inserts a line break into the comment editor, which matches the symptom: "nothing is created".
4. A secondary, much less likely factor: the 50 ms enablement debounce (step 6 above). Pressing Cmd+Enter within 50 ms of typing the first character into an empty editor does nothing. A person can't press that fast, but a test can (see below).

**Not yet confirmed:** that the reporter's VS Code profile was the one with this extension enabled. You can confirm it in under a minute (manual check 1 below).

### How to reproduce

**Manual check 1: definitive, no code.** Run **Developer: Toggle Keyboard Shortcuts Troubleshooting** (`workbench.action.toggleKeybindingsLog`), open a thread's comment editor, type text, and press Cmd+Enter. The Output → Log (Window) panel shows which command the key resolved to and its source (for example `lineBreakInsert` from the extension, rather than `editor.action.submitComment`).

**Manual check 2.** Launch a clean instance with only this extension, `code --extensionDevelopmentPath=. --disable-extensions`. Cmd+Enter should create the thread. Then add the competing binding to that instance's user `keybindings.json` (`{"key":"cmd+enter","command":"lineBreakInsert","when":"editorTextFocus && !editorReadonly"}`). Cmd+Enter stops creating the thread.

**Integration test (`src/test/suite`).** Extension-host tests can't send real key presses, so the test splits the bug into two halves:

1. _The submit wiring works_ (expected to pass, which shows our side is correct):
   - With `ReviewCommentController` and `getChangedFilePaths` returning the test file, open the file and put the cursor on a line in the commenting range.
   - `await vscode.commands.executeCommand('workbench.action.addComment')`. This creates a thread template and focuses its comment editor.
   - `await vscode.commands.executeCommand('type', { text: 'hello' })`. _Inference:_ `type` goes to the focused code editor, which is the comment editor at this point.
   - **Wait at least 100 ms**, so the `!commentIsEmpty` enablement refresh (50 ms debounce) has run. Without the wait the test fails because of the debounce, not because of #56.
   - `await vscode.commands.executeCommand('editor.action.submitComment')`. This is the exact handler Cmd+Enter runs.
   - Assert that the `FeedbackStore` now has a thread with message `hello`.
2. _The keybinding conflict_ (expected to fail until fixed): VS Code has no API to ask "what does this key resolve to", so assert on our contribution instead. Once a fix contributes a binding, test that `package.json` `contributes.keybindings` has a Cmd+Enter / Ctrl+Enter entry scoped to `commentEditorFocused && commentController == vscode-comment`. For an end-to-end check, run the test instance with a `--user-data-dir` whose `User/keybindings.json` holds the competing binding, and use manual check 1.

Note: `@vscode/test-cli` runs a separate VS Code with its own extensions directory, so the maintainer's keymap extension is **not** loaded in `npm run test:integration`. A plain end-to-end test would pass and hide the bug.

### Fix options (for the fix ticket; not implemented here)

- **Inference:** contributing our own keybinding `{ "key": "ctrl+enter", "mac": "cmd+enter", "command": "editor.action.submitComment", "when": "commentEditorFocused && commentController == vscode-comment" }` raises submit to extension weight. The `commentController` key is set on the thread widget's scoped context, which is the parent of the comment editor's context (`commentThreadWidget.ts`), so the `when` should match. **Caveat (verified):** extension weight is 400 + the binding's position in the array. A competing extension binding at position 36 (weight 436) still beats ours unless our binding sits at position ≥ 37, or the user removes the conflict. Ranking between extensions is fragile by design. The robust advice for users is a user keybinding, or removing the conflicting one.
- Document the conflict in the README and show the submit keybinding in the button title. VS Code already does this: `CommentFormActions` appends the `editor.action.submitComment` keybinding label to the primary button.

## 2. `CommentOptions.prompt` and `placeHolder` (verified)

- API: `CommentController.options?: CommentOptions` with `prompt?: string` and `placeHolder?: string` (`vscode.d.ts`). Available since **1.46**.
- `placeHolder`: placeholder text in the comment editor while it is empty. It applies to both new threads and replies. The defaults are "Type a new comment" and "Reply..." (`commentReply.ts` `setCommentEditorDecorations`).
- `prompt`: label and hover text of the collapsed "Reply..." button, shown on a thread that already has messages (`commentReply.ts` `createReplyButton`). A new thread opens with the editor expanded, so `prompt` is not shown there.
- Both are set **per controller**. Assigning `controller.options` again updates them live (`extHostComments.ts` sends `$updateCommentControllerFeatures`). There is no per-thread variant. **Inference:** if the wording should depend on the thread (new vs reply), the placeholder default already handles that split, and changing the text per thread would mean re-assigning the controller options on focus, which is racy.

## 3. Native checkboxes on tree items (verified)

- `TreeItem.checkboxState?: TreeItemCheckboxState | { state, tooltip?, accessibilityInformation? }`, `TreeView.onDidChangeCheckboxState: Event<TreeCheckboxChangeEvent<T>>` (gives `items: [T, TreeItemCheckboxState][]`), and `TreeViewOptions.manageCheckboxStateManually?: boolean`. All available since **1.80**.
- A checkbox renders only for items that set `checkboxState` (`treeView.ts`: `if (node.checkbox)`), so repository and commit nodes can have none.
- **Important for a file tree with folders:** by default (`manageCheckboxStateManually: false`), checking a parent checks every child that has been loaded, all children checked checks the parent, and unchecking a child unchecks the parent. To mark a single file as viewed without folder cascades, set `manageCheckboxStateManually: true`, or give checkboxes only to file items.
- The view must be created with `window.createTreeView` (not `registerTreeDataProvider`) to subscribe to `onDidChangeCheckboxState`. The provider must fire `onDidChangeTreeData` when the state changes from code.
- Today the extension marks a file viewed with `view/item/context` inline commands (`file.markViewed` / `file.unmarkViewed`). Checkboxes would replace these.

## 4. Custom sidebar section and moving views

**Verified:**

- `contributes.viewsContainers` accepts `activitybar`, `panel`, and `secondarySidebar` (`viewsExtensionPoint.ts` schema). `activitybar` and `panel` are long-standing.
- `secondarySidebar` first appears in **1.104.0**, behind the proposed API `contribSecondarySidebar` in 1.104 and 1.105. It is stable from **1.106.0**. At our `^1.100` it is not available. Using it means raising `engines.vscode` to `^1.106.0`.
- `contributes.views` can target our own container id or the built-in `explorer`, `scm`, `debug`, `test` (`remote` needs a proposed API). Our views currently live in `scm`. Per view: `when`, `visibility` (`visible`/`hidden`/`collapsed`), `initialSize`, `icon`, `contextualTitle`.
- Moving views is a **user** action: drag and drop, or `workbench.action.moveView` / `workbench.action.moveFocusedView` (interactive pickers). VS Code remembers where the user put a view. The command `vscode.moveViews({ viewIds, destinationId })` exists (`viewPaneContainer.ts`, present at 1.100.0) but is internal and undocumented, and there is no `vscode.d.ts` API to move a view.

**Inference:** for a dedicated section at `^1.100`, contribute an Activity Bar container. Users who want it on the right can drag it to the Secondary Side Bar, and VS Code remembers that. Don't call `vscode.moveViews` from the extension: it's not public API and may change.

## 5. Walkthroughs (verified)

- `contributes.walkthroughs[]`: `id`, `title`, `description`, `icon`, `when`, `featuredFor` (glob patterns), `steps[]` (`gettingStartedExtensionPoint.ts`).
- Steps: `id`, `title`, `description` (supports `command:` links. A link alone on its own line renders as a button. `command:toSide:` opens to the side), `media` (one of `image` + `altText`, with per-theme light/dark/hc/hcLight paths; `svg` + `altText`, theme color variables supported; or `markdown`), `when`, `completionEvents`.
- `completionEvents`: `onCommand:<id>`, `onLink:<url>`, `onView:<viewId>`, `onSettingChanged:<key>`, `onContext:<expr>`, `onExtensionInstalled:<id>`, `onStepSelected`. Without them, a step is checked off when any of its buttons or links is clicked, or when it is selected if it has none.
- Opening: a walkthrough opens automatically after the extension is installed in that session, when `workbench.welcomePage.walkthroughs.openOnInstall` is on (the default) and its `when` holds (`gettingStartedService.ts`). You can open it at any time with `vscode.commands.executeCommand('workbench.action.openWalkthrough', '<publisher>.<extensionName>#<walkthroughId>', false)`, or `{ category, step }` to go to a step.
- Available at `^1.100`: walkthroughs are years older than 1.100, and the `1.100.0` source has the same contribution point. The exact first version wasn't looked up because it's far below our floor.

## 6. Status bar (verified)

- `window.createStatusBarItem(id: string, alignment?, priority?)`, available since **1.57**. The `id` lets users hide or show the item individually. Also available: `name`, `text` (with `$(icon)` syntax), `tooltip: string | MarkdownString` (Markdown since **1.59**), `command` (string or `Command` with arguments), `color`, `backgroundColor` (since **1.53**, only `statusBarItem.errorBackground` / `statusBarItem.warningBackground` are honored), and `accessibilityInformation`.
- A declarative `contributes.statusBarItems` exists only as a proposed API (`vscode.proposed.contribStatusBarItems.d.ts`), so it can't be used in a Marketplace build.
- **Inference:** one item works well for review-round state ("3 drafts", or "waiting on agent") with a command that opens our view. Showing it only when a review round is active avoids clutter.

## 7. Markdown in messages, and Mermaid

**Verified:**

- `Comment.body: string | MarkdownString`. In `commentNode.ts` `updateCommentBody`, a **`string` is rendered as plain text** (`innerText`), and only a `MarkdownString` goes through the Markdown renderer. Today the extension passes strings such as `**human**:\n...` (`src/commentController.ts`), so this Markdown is shown as raw text unless it is wrapped in `new vscode.MarkdownString(...)`.
- `MarkdownString` settings and their minimum versions:
  - `isTrusted: boolean | { enabledCommands: string[] }`: `command:` links run only when this is set. The command allow-list form is available since **1.73**. Prefer `enabledCommands` over `true`.
  - `supportHtml` (since **1.62**): allows a sanitized subset of HTML. The allowed tags are `basicMarkupHtmlTags` plus `input` (`base/browser/markdownRenderer.ts` / `domSanitize.ts`), which include `img`, `details`, `div`, and tables. `script` and `svg` are **not** allowed.
  - `supportThemeIcons` (`$(icon)` syntax, since ≤1.42) and `baseUri` (since **1.66**), which resolves relative links and images.
- Image sources allowed: `http`, `https`, `data`, `file`, `vscode-file`, `vscode-remote`, `vscode-remote-resource`. Relative paths are allowed only when `baseUri` is set.
- Fenced code blocks go to the workbench's default code block renderer (syntax highlighting). There is no Mermaid support in the comments renderer. The only Mermaid code in the workbench is in the chat UI.

**Inference:** Mermaid can't render natively in a message, where a ` ```mermaid ` fence shows as a code block. The options are:

1. Render the diagram to an SVG or PNG on the extension side and embed it as `![diagram](data:image/svg+xml;base64,...)` or as a `file:` image with `baseUri`. Both are allowed media sources, and an `img` with SVG content is not the blocked `svg` tag. This needs a Mermaid renderer in the extension, which is a **new dependency**, and AGENTS.md says to ask first. It also needs a headless DOM or browser to run.
2. A "Preview diagram" link (`command:` with `enabledCommands`) that opens a **webview panel** running Mermaid. This is the only way to get interactive rendering.

## 8. Do threads appear in normal editors as well as diff views? (verified)

- The comments contribution is a normal editor contribution (`registerEditorContribution(ID, CommentController, AfterFirstRender)`), so it is attached to every code editor, including both inner editors of a diff editor.
- Each editor asks every comment controller for threads by **its model URI** (`commentsController.ts` `beginCompute` → `commentService.getDocumentComments(uri)`). Commenting ranges come from `commentingRangeProvider.provideCommentingRanges(document)` for that document.
- Our threads are created on `vscode.Uri.file(...)` (`commentController.ts` `createThread`), so they show in a **normal editor of the file** and in the **modified (working tree) side of a diff**, which also uses the `file:` URI. They do not show on a `git:` base side, which has a different URI. In the inline diff layout (`diffEditor.renderSideBySide: false`), VS Code doesn't put the gutter "+" on the original editor (`isEditorInlineOriginal`).
- Our `commentingRangeProvider` currently allows ranges only for files in the changed set, so the gutter "+" appears in normal editors of changed files too.
- **Inference:** if the redesign compares against a commit or branch, the right-hand side may not be a `file:` URI (for example a `git:` URI for a committed revision). Threads anchored on `file:` URIs would then not show on that side, and the commenting range provider would need to map those URIs back to the file.

## Proposed APIs worth watching (verified to exist on `main`; not usable in a Marketplace build)

- `commentsDraftState`: `Comment.state: Published | Draft`. Native styling for our _draft_ concept.
- `commentReveal`: `CommentThread.reveal(comment?, { focus })` and `hide()`.
- `activeComment`, `commentThreadApplicability`, `commentingRangeHint`, `contribCommentEditorActionsMenu` (`comments/comment/editorActions`), `contribCommentThreadAdditionalMenu`, `contribCommentsViewThreadMenus`.
- `treeItemMarkdownLabel`, `treeViewMarkdownMessage`, `statusBarItemTooltip`.

## Sources

- VS Code source, `microsoft/vscode` `main` @ `3e0a32c` (1.141.0):
  - `src/vs/workbench/contrib/comments/common/commentCommandIds.ts`
  - `src/vs/workbench/contrib/comments/browser/{commentsEditorContribution,commentThreadWidget,commentReply,commentFormActions,commentNode,commentsController,simpleCommentEditor}.ts`
  - `src/vs/platform/actions/common/menuService.ts`, `src/vs/platform/actions/common/actions.ts`
  - `src/vs/platform/keybinding/common/{keybindingsRegistry,keybindingResolver}.ts`, `src/vs/workbench/services/keybinding/browser/keybindingService.ts`
  - `src/vs/editor/contrib/linesOperations/browser/linesOperations.ts` (`InsertLineAfterAction`), `src/vs/editor/browser/coreCommands.ts` (`lineBreakInsert`)
  - `src/vs/workbench/services/actions/common/menusExtensionPoint.ts`
  - `src/vs/workbench/api/browser/viewsExtensionPoint.ts`, `src/vs/workbench/browser/parts/views/{viewPaneContainer,treeView}.ts`, `src/vs/workbench/browser/actions/layoutActions.ts`
  - `src/vs/workbench/contrib/welcomeGettingStarted/browser/{gettingStartedExtensionPoint,gettingStartedService,gettingStarted.contribution}.ts`
  - `src/vs/platform/markdown/browser/markdownRenderer.ts`, `src/vs/base/browser/{markdownRenderer,domSanitize}.ts`
  - `src/vscode-dts/vscode.d.ts` and `src/vscode-dts/vscode.proposed.*.d.ts`
- The same files at tags `1.100.0` (submit path, keybinding sorter, `vscode.moveViews`) and `1.104.0`–`1.140.0` (`secondarySidebar`), fetched with the GitHub contents API.
- `@types/vscode` `1.40.0`–`1.100.0` from unpkg, for the minimum versions in the summary table.
- Contribution points reference: https://code.visualstudio.com/api/references/contribution-points
- Release notes index for the versions above: https://code.visualstudio.com/updates (for example `v1_80`, `v1_106`)
- This repo: `package.json` (`contributes.menus`, `contributes.keybindings`, `engines`), `src/commentController.ts`, `src/extension.ts`, `.vscode-test.mjs`.
