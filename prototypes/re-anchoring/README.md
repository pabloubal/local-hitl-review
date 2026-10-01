# PROTOTYPE, throwaway, not production

Re-anchoring prototype for issue #50 ("Re-anchoring prototype on real git repos"). It tests the planned anchor-state algorithm (current / outdated / orphaned) against real temporary git repos, and replays this repository's own history.

```sh
node prototypes/re-anchoring/reanchor.prototype.mjs
```

Plain Node 22 ESM, `child_process` + `fs` + `os` only, no npm dependencies. Every scenario runs in a fresh `mkdtemp` repo under `os.tmpdir()`; scenario 10 uses a temporary `git clone --quiet` of this repo. All temp dirs are removed at the end. Git runs with `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_NOSYSTEM=1` so user config does not change the results. Set `VERBOSE=1` to print resolver notes per scenario to stderr.

The run rewrites the block between the RESULTS markers below.

## Results

<!-- RESULTS:START -->

| # | Scenario | Expected | Actual | Method | Result | Notes |
|---|---|---|---|---|---|---|
| 1 | insert 5 lines above | current 15-17 | current 15-17 | diff | PASS |  |
| 2 | edit an anchored line | outdated 10-12 | outdated 10-12 | diff | PASS |  |
| 3a | edit far above + far below | current 10-12 | current 10-12 | diff | PASS |  |
| 3b | edit line adjacent above + below | current 10-12 | current 10-12 | diff | PASS |  |
| 3c | insert directly above + directly below | current 11-13 | current 11-13 | diff | PASS |  |
| 3d | delete adjacent line above + below | current 9-11 | current 9-11 | diff | PASS |  |
| 3e | slider: block ending "  }" inserted below | current 3-5 | current 3-5 | diff | PASS |  |
| 3f | slider: block starting like range inserted above | current 9-11 | current 9-11 | diff | PASS |  |
| 3g | slider: copy of anchored block pasted below | current 10-12 | current 10-12 | diff | PASS |  |
| 3h | slider: delete block below ending "  }" | current 3-5 | current 3-5 | diff | PASS |  |
| 4a | anchored lines deleted | orphaned | orphaned | diff | PASS |  |
| 4b | partial delete (10-14, delete 12-14) | outdated 10-11 | outdated 10-11 | diff | PASS |  |
| 4c | anchored block moved within file | current 23-25 | current 23-25 | diff+text | PASS | pure diff (no moved fallback): orphaned |
| 4d | file deleted | orphaned | orphaned | path | PASS |  |
| 5a | git mv, committed | current src/b.ts:10-12 | current src/b.ts:10-12 | diff | PASS | renamed via git diff -M (R100) |
| 5b | git mv, staged not committed | current src/b.ts:10-12 | current src/b.ts:10-12 | diff | PASS | renamed via git diff -M (R100) |
| 5c | plain mv (new name untracked) | current src/b.ts:10-12 | current src/b.ts:10-12 | diff | PASS | git diff -M: no rename; renamed via untracked-file heuristic (score 3); no untracked heuristic: orphaned |
| 5d | git mv committed + anchored line edited | outdated src/b.ts:12-14 | outdated src/b.ts:12-14 | diff | PASS | renamed via git diff -M (R094) |
| 5e | git mv committed + edit elsewhere | current src/b.ts:12-14 | current src/b.ts:12-14 | diff | PASS | renamed via git diff -M (R094) |
| 5f | plain mv + anchored line edited | outdated src/b.ts:12-14 | orphaned | path | FAIL | git diff -M: no rename; untracked heuristic: no candidate |
| 6a | duplicate fn, 6 lines above (diff) | current 18-21 | current 18-21 | diff | PASS |  |
| 6b | duplicate fn, 6 lines above (text) | current 18-21 | current 18-21 | text-search | PASS | naive closest (no ctx rank): current 10-13 |
| 6c | copy inserted ABOVE original (diff) | current 16-20 | current 16-20 | diff | PASS |  |
| 6d | copy inserted ABOVE original (text) | current 16-20 | current 16-20 | text-search | PASS | naive closest: current 8-12 |
| 7a | blob gc'd, 4 lines above | current 14-16 | current 14-16 | text-search | PASS | cat-file -e fails after gc |
| 7b | blob gc'd, anchored line edited | outdated 14-16 | outdated 14-16 | text-search | PASS | cat-file -e fails after gc |
| 7c | blob gc'd, anchored + context line edited | outdated 14-16 | orphaned | text-search | FAIL | cat-file -e fails after gc |
| 8a | feature-only lines viewed on main | orphaned [from branch feature] | orphaned [from branch feature] | diff | PASS |  |
| 8b | shared lines viewed on main | current 16-18 [from branch feature] | current 16-18 [from branch feature] | diff | PASS |  |
| 8c | feature-only lines after merge --no-ff | current 11-13 | current 11-13 | diff | PASS |  |
| 8d | shared lines after merge --no-ff | current 20-22 | current 20-22 | diff | PASS |  |
| 8e | shared lines after SQUASH merge | current 20-22 | current 20-22 [from branch feature] | diff | FAIL |  |
| 9a | 10k lines, 300 edits, thread near end | current 10097-10099 | current 10097-10099 | diff | PASS | diff 43.4 ms / 4 git procs; text 9.3 ms / 1 procs -> current 10097-10099 |
| 9a | 100k lines, 300 edits, thread near end | current 100075-100077 | current 100075-100077 | diff | PASS | diff 89.0 ms / 4 git procs; text 16.6 ms / 1 procs -> current 100075-100077 |
| 9b | 200 threads / 20 files, cache vs none | same verdicts | same verdicts | - | PASS | no cache 8622.4 ms / 1000 procs / 200 diffs; cache 1062.1 ms / 121 procs / 40 diffs; {"outdated":13,"current":185,"orphaned":2}; slider normalisation changed 0/200 verdicts |
| 10 | replay own history, 50 samples | (measure) | agree 36/50 (state 37/50) | - | INFO | diff {"current":37,"outdated":13}; text {"current":39,"orphaned":11}; 7 outdated extents > 3x anchored size; slider changed 0 |

Totals: {"PASS":32,"FAIL":3,"INFO":1}; 2477 git processes; 22.8 s; git git version 2.50.1 (Apple Git-155); node v22.21.1

```text
Scenario 10 disagreements (14/50); diff verdicts {"current":37,"outdated":13}, text verdicts {"current":39,"orphaned":11}; 22 draws skipped because the file was unchanged at HEAD

[1] c4b85ec src/extension.ts:78-78
    anchored: "title: 'Base Branch',"
    diff: outdated 329-332           "const picked = await vscode.window.showQuickPick(items, {" / "placeHolder: \"Select the base branch to compare against\","   {touching hunks: -76,4 +329,4}
    text: orphaned                   (none)   {anchored lines and context pair not found}
[2] 95fb068 src/extension.ts:179-180
    anchored: "let title = path.basename(filePath);" / "if (f.status === 'A') title = `${title} (Added)`;"
    diff: outdated 490-535           "vscode.commands.registerCommand(" / "\"vscodeComment.openAllChanges\","   {touching hunks: -163,31 +490,46}
    text: orphaned                   (none)   {anchored lines and context pair not found}
[3] 664e88d src/extension.ts:177-177
    anchored: "]);"
    diff: outdated 490-535           "vscode.commands.registerCommand(" / "\"vscodeComment.openAllChanges\","   {touching hunks: -149,34 +490,46}
    text: orphaned                   (none)   {anchored lines and context pair not found}
[4] eabecc8 src/extension.ts:274-276
    anchored: ");" / "" / ...
    diff: current 739-741            ");" / ""
    text: current 159-161            ");" / ""   {16 exact matches, picked line 159 (ctx 0, dist 115)}
[5] b9a067c src/extension.ts:280-283
    anchored: "const filePath = f.path;" / "const originalPath = f.originalPath ?? filePath;" / ...
    diff: outdated 490-535           "vscode.commands.registerCommand(" / "\"vscodeComment.openAllChanges\","   {touching hunks: -270,32 +490,46}
    text: orphaned                   (none)   {anchored lines and context pair not found}
[6] ec07ee0 src/feedbackStore.ts:151-156
    anchored: "} catch {" / "// AGENTS.md doesn't exist, create it from the template" / ...
    diff: outdated 226-228           "const dirs = this.getAllFeedbackDirs();" / "for (const dir of dirs) {"   {touching hunks: -145,32 +226,3}
    text: orphaned                   (none)   {anchored lines and context pair not found}
[7] 067207f src/extension.ts:113-116
    anchored: "const gitExtension = vscode.extensions.getExtension('vscode.git');" / "if (gitExtension) {" / ...
    diff: outdated 193-198           "const gitExtension = vscode.extensions.getExtension(\"vscode.git\");" / "if (gitExtension) {"   {touching hunks: -113,1 +193,1 -116,1 +196,3}
    text: orphaned                   (none)   {anchored lines and context pair not found}
[8] c4b85ec src/gitService.ts:116-117
    anchored: "return this.parseNameStatus(stdout);" / "}"
    diff: outdated 150-166           "const { stdout: diffStdout } = await this.git('diff', '--name-status'," / "const files = this.parseNameStatus(diffStdout);"   {touching hunks: -115,2 +150,16}
    text: current 135-136            "return this.parseNameStatus(stdout);" / "}"   {2 exact matches, picked line 135 (ctx 2, dist 19)}
[9] eabecc8 src/test/suite/feedbackStore.test.ts:23-24
    anchored: "});" / ""
    diff: outdated 22-93             "feedbackDir = store.getFeedbackDirForRepo((store as any).workspaceRoot" / "test('saves correctly with local scope', async function () {"   {touching hunks: -22,2 +22,71}
    text: current 99-100             "});" / ""
[10] f3e0e0b src/extension.ts:253-255
    anchored: "}" / ")" / ...
    diff: outdated 694-711           "let title = `${path.basename(filePath)} (${changedFilesProvider.getCom" / "if (commitHash) {"   {touching hunks: -252,3 +694,17}
    text: orphaned                   (none)   {anchored lines and context pair not found}
[11] ef10fa4 src/extension.ts:263-264
    anchored: "await vscode.env.clipboard.writeText(text);" / "vscode.window.showInformationMessage(`Copied to clipboard: ${text}`);"
    diff: outdated 419-485           "vscode.commands.registerCommand(" / "\"vscodeComment.copyAgentPrompt\","   {touching hunks: -259,7 +419,67}
    text: orphaned                   (none)   {anchored lines and context pair not found}
[12] 664e88d src/commentController.ts:38-40
    anchored: "const changedPaths = this.getChangedFilePaths();" / "if (!changedPaths.includes(relativePath)) {" / ...
    diff: outdated 39-41             "const changedPaths = this.getChangedFilePaths();" / "if (!changedPaths.includes(relInfo.relativePath)) {"   {touching hunks: -39,1 +40,1}
    text: orphaned                   (none)   {anchored lines and context pair not found}
[13] 664e88d src/changedFilesProvider.ts:231-234
    anchored: "const parts = relativePath.split('/');" / "" / ...
    diff: outdated 510-518           "if (parentPrefix && !file.path.startsWith(parentPrefix + \"/\")) continu" / ""   {touching hunks: -227,5 +510,6}
    text: orphaned                   (none)   {anchored lines and context pair not found}
[14] ea21670 src/changedFilesProvider.ts:234-238
    anchored: "}" / "" / ...
    diff: outdated 448-452           "}" / ""   {touching hunks: -237,1 +451,1}
    text: orphaned                   (none)   {anchored lines and context pair not found}
```

<!-- RESULTS:END -->

## Findings

### What held up

- **Diff-based mapping is solid.** Lines inserted, edited or deleted above, below and directly next to the range (1, 3a-3d) keep the thread current and move it correctly. Editing an anchored line gives outdated (2). Deleting the anchored lines gives orphaned (4a). A partial deletion gives outdated over the surviving lines (4b).
- **Adjacent edits and diff "sliders" are not a problem in practice.** With `--histogram` plus git's default indent heuristic, git put every ambiguous insertion or deletion on the boundary, not inside the range (3e-3h, including a copy of the anchored block pasted directly below it). The slider normalisation I added never changed a verdict: 0 of 8 targeted cases, 0 of 200 random threads (9b), 0 of 50 real-history samples (10).
- **Renames:** `git diff -M --name-status <anchor.commit>` (commit compared with the working tree) catches committed renames and staged `git mv`, including rename plus edit (5a, 5b, 5d, 5e).
- **Branch label:** `merge-base --is-ancestor` gives "from branch feature" on main and clears it after a real merge (8a-8d). The state is still computed from the content, as intended.
- **Blob GC:** an anchor on uncommitted content is really pruned by `reflog expire` + `gc --prune=now` (`cat-file -e` fails). Text search then recovers both moves (7a) and anchored-line edits (7b).
- **Duplicates:** diff mode always picks the right copy, even when a copy is inserted above the original (6a, 6c).
- **Performance is fine; process spawns dominate.** One `git diff` on a 100k-line file with 300 edits takes about 85 ms (10k lines: about 40 ms). The diff itself is cheap; each git process costs about 9 ms on this machine. With the per-(blob, file) cache, 200 threads on 20 files go from 1000 processes / 8.8 s to 121 processes / 1.1 s with the same verdicts.

### What broke (kept failing on purpose)

- **5f: uncommitted plain `mv` plus an edit to the anchored lines -> orphaned.** `git diff -M` cannot see untracked files. My untracked-file heuristic only finds the new name when the content is identical or the anchored lines are intact.
- **7c: text search needs both context blocks to match exactly.** If the anchored line *and* an adjacent context line are edited, text search says orphaned while the truth is outdated. In the real-history replay this was the main source of disagreement: 11 of the 13 samples that diff mode called outdated, text search called orphaned (for example after prettier changed `'` to `"` across a whole file). So once blobs are pruned, text search turns outdated threads into orphaned ones.
- **8e: squash merge keeps the label forever.** After `merge --squash`, `anchor.commit` is never an ancestor of HEAD, so a thread made on feature keeps "from branch feature" on main. Rebase and cherry-pick behave the same way (not run, same mechanism).
- **Outdated extents can be huge.** The brief's rule "new range = mapped extent" takes the whole replacement side of every hunk that touches the range. In the replay, 7 of 13 outdated results were more than 3 times the anchored size. For example, a 1-line anchor became a 46-line range (`-163,31 +490,46`).
- **Moved code (4c) is orphaned under pure diff.** Moving an unchanged block shows up as a delete plus an insert. By the glossary ("unchanged, even if it has moved") it is current. The prototype needs an exact-text fallback to get that.
- **Short, generic anchors break text search.** An anchor on `);` / `` (replay case 4) had 16 exact matches, no context match, and text search picked one 580 lines away from where diff mode put it.

### Surprises

- **Naive "closest match to the old line wins" is wrong in both duplicate tests** (6b: picks 10-13, 6d: picks the inserted copy at 8-12). Ranking candidates by how many context lines match, then by distance, fixes both.
- **Formatting-only commits** (quote style, reflow) make threads outdated. That is correct by the definition, but it will be noisy after a formatter run.
- **Blob pruning has a grace period.** `gc` only prunes unreachable loose objects older than `gc.pruneExpire` (2 weeks by default). So the text-search fallback is the normal path for any thread on uncommitted content older than about two weeks, and its weaknesses (7c, short anchors) matter more than "rare fallback" suggests.

### Recommended changes to the ADR

1. Keep diff mapping (`git diff --no-index -U0 --histogram`) as the primary method. Slider handling is not needed; git's indent heuristic already handles it.
2. Add a "moved" rule: if diff mode says orphaned, a single exact match of the anchored lines elsewhere in the file makes the thread current (4c).
3. Bound the outdated range: clamp the result to the surviving anchored lines plus at most the anchored length of replacement lines, instead of the full hunk extent.
4. Text search: rank by context match before distance. Accept *either* context block (not both) to call outdated. Treat several equally good matches of a short or generic anchor (blank lines, `}`, `);`) as ambiguous rather than current.
5. Consider keeping anchor blobs reachable, for example a ref under `refs/lhr/` that points at a tree of anchor blobs. Then diff mode stays the normal path and text search is only the fallback for v1 threads. If not, document that text search is the normal path after about 2 weeks.
6. Branch label: make the ancestor rule also cover squash and rebase merges. Options: drop the label when the anchored content is current on HEAD, or when `anchor.branch` no longer exists or is merged by patch-id (`git cherry`). Or document it as a known limitation.
7. Renames: committed and staged renames work. Untracked renames need a content heuristic or should be documented as "orphaned until `git add`".
8. Performance: reuse a long-lived `git cat-file --batch` process for blob existence checks and reads, keep one diff per (blob, file content), and key the cache by content hash, not by mtime.

### Deviations from the brief's algorithm

- `hash-object -w --no-filters`, so the blob holds raw working-tree bytes and the diff against the raw file is not distorted by autocrlf or clean filters. Scenario 10 blobs come from commits, so they are filtered (fine in this repo, which uses LF).
- Slider normalisation for pure insertions and deletions touching the range (on by default; never changed a verdict).
- Moved-block fallback after a diff-mode orphaned verdict (needed for 4c).
- Text search ranks matches by context-line matches, then by distance (needed for 6b and 6d).
- Untracked-rename heuristic: an untracked file with identical content, or one containing the anchored lines; same basename wins ties (needed for 5c).
- Text-search outdated needs *both* context blocks, at most anchored length + 50 lines apart. Context found with nothing between them means orphaned.
- 6b uses `forceTextSearch` instead of pruning a committed blob (a committed blob cannot be pruned). Real pruning is tested in 7.
- Scenario 10 only samples (commit, file) pairs where the file changed before HEAD (draws with an unchanged file are skipped and counted), and only range starts on non-blank lines.
- Cache key is blob + path + size + mtime (no `crypto` allowed). Production should use a content hash.
- The no-cache run in 9b memoises nothing, so it also reads each blob twice (existence check + read). That inflates its process count a little.
