# Verify Local HITL Review

Verification harness for the Local HITL Review VS Code extension. Run this checklist after any code change to prove the change works and doesn't break existing behavior.

## Mandatory checks (every change)

Run these in order. Stop and fix if any step fails.

```bash
# 1. Type safety
npx tsc --noEmit

# 2. Unit tests (fast, no VS Code runtime)
npm run test:unit

# 3. Bundle builds successfully
npm run build

# 4. Formatting
npx prettier --check "src/**/*.ts"
```

**Paste the terminal output as proof.** Never say "tested", "verified", or "all green" without showing the output.

## Change-specific checks

After the mandatory checks, run the additional check relevant to what you changed:

| If you changed... | Also verify |
|-------------------|-------------|
| `parser.ts` or `.review` file format | Parser round-trip: `node --test out/test/parser.test.js` |
| `filterState.ts` | Filter logic: `node --test out/test/filterState.test.js` |
| `promptGenerator.ts` | Prompt output: `node --test out/test/promptGenerator.test.js` |
| `commentController.ts` | See [comment-lifecycle.md](features/comment-lifecycle.md) verification steps |
| `changedFilesProvider.ts` | See [changed-files-view.md](features/changed-files-view.md) verification steps |
| `extension.ts` command handlers | See the relevant feature file for the command you changed |
| `feedbackStore.ts` | See [review-workflow.md](features/review-workflow.md) verification steps |
| `.github/workflows/` | Validate YAML syntax: `npx yaml-lint .github/workflows/*.yml` |
| Multiple files or shared code | Run full test suite: `npm test` (requires VS Code test infrastructure) |

## Feature map

Each feature file documents sub-features, entry points, how to verify, and known gotchas. **Read the relevant feature file before claiming a change to that area is complete.**

- [changed-files-view.md](features/changed-files-view.md) — SCM tree view, multi-repo, commit graph
- [diff-viewer.md](features/diff-viewer.md) — Diff display, compare modes, base branch
- [comment-lifecycle.md](features/comment-lifecycle.md) — Create, reply, edit, save, delete comments
- [suggestions.md](features/suggestions.md) — Code suggestion blocks and apply
- [review-workflow.md](features/review-workflow.md) — Init workspace, finish review, agent prompt
- [feedback-summary.md](features/feedback-summary.md) — Summary tree view and filtering
