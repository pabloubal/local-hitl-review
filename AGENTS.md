<!-- FOR AI AGENTS - Human readability is a side effect, not a goal -->
<!-- Managed by agent: keep sections and order; edit content, not structure -->
<!-- Last updated: 2026-09-25 | Last verified: 2026-09-25 -->

# AGENTS.md

**Precedence:** the **closest `AGENTS.md`** to the files you're changing wins. Root holds global defaults only.

## Commands (verified ✓)
> Source: CI (github-actions) — CI-sourced commands are most reliable

<!-- AGENTS-GENERATED:START commands -->
| Task | Command | ~Time |
|------|---------|-------|
| Typecheck | npx tsc --noEmit | ~2s |
| Lint | npm run lint | ~2s |
| Format | npx prettier --write . | ~2s |
| Test (single) | npm run test:unit | ~1s |
| Test (all) | npm test | ~30s |
| Build | npm run build | ~2s |
<!-- AGENTS-GENERATED:END commands -->

> If commands fail, verify against Makefile/package.json/composer.json or ask user to update.

## Response Style
- Answer first, elaborate only if needed. No sycophantic openers ("Great question!", "Absolutely!").
- For yes/no or status questions, lead with the answer.
- Skip preamble. Match response length to task complexity.

## Workflow
1. **Before coding**: Read nearest `AGENTS.md` + check Golden Samples for the area you're touching
2. **Test-Driven Development (TDD)**: Write failing tests for the bug or feature *before* writing the implementation.
3. **After each change**: Run the smallest relevant check (lint → typecheck → single test)
4. **Before committing**: Run full test suite if changes affect >2 files or touch shared code
5. **Before claiming done**: Run verification and **show output as evidence** — never say "try again", "should work now", "tested", "verified", or "all green" without pasted command output in the same turn

## Agent skills

### Issue tracker

GitHub issues via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context layout (`CONTEXT.md` and `docs/adr/` at repo root). See `docs/agents/domain.md`.

## File Map
<!-- AGENTS-GENERATED:START filemap -->
```
src/             → application source code
assets/          → static assets (images, fonts)
docs/            → documentation and agent guidelines
```
<!-- AGENTS-GENERATED:END filemap -->

## Golden Samples (follow these patterns)
<!-- AGENTS-GENERATED:START golden-samples -->
| For | Reference | Key patterns |
|-----|-----------|--------------|
| Pure parsing & logic | `src/parser.ts` | Clean parsing/serialization, robust error handling, unit-tested |
| Storage & workspace state | `src/feedbackStore.ts` | File-based storage, multi-repo and global/local review support |
| Tree view & UI state | `src/changedFilesProvider.ts` | SCM view provider, Git integration, compare modes |
<!-- AGENTS-GENERATED:END golden-samples -->

## Heuristics (quick decisions)
<!-- AGENTS-GENERATED:START heuristics -->
| When | Do |
|------|-----|
| Committing | Use Conventional Commits (feat:, fix:, docs:, etc.) |
| Merging PRs | Squash and merge |
| Adding dependency | Ask first - we minimize deps |
| Unsure about pattern | Check Golden Samples above |
<!-- AGENTS-GENERATED:END heuristics -->

## Repository Settings
<!-- AGENTS-GENERATED:START repo-settings -->
- **Default branch:** `main`
- **Merge strategy:** squash, merge, rebase
<!-- AGENTS-GENERATED:END repo-settings -->

<!-- AGENTS-GENERATED:START ci-rules -->
## CI/Quality Gates
> Platform: github-actions
<!-- AGENTS-GENERATED:END ci-rules -->

## Boundaries

### Always Do
- Use Test-Driven Development (TDD): write failing tests before implementing the fix or feature
- Run pre-commit checks before committing
- Add tests for new code paths
- Use conventional commit format: `type(scope): subject`
- Use **atomic commits** (one logical change per commit); preserve signatures, keep bisection useful
- **Show test output as evidence before claiming work is complete** — never say "try again", "should work now", "tested", "verified", or "all green" without pasted command output
- Before any edit, verify `pwd` resolves inside the intended repo worktree — not `.bare/`, not `~/.claude/skills/…`, not `~/.claude/plugins/cache/…` (those are read-only caches that get clobbered on update)
- For upstream dependency fixes: run **full** test suite, not just affected tests
- Force-push only with `--force-with-lease`
- Use TypeScript strict mode with proper type annotations

### Ask First
- Adding new dependencies
- Modifying CI/CD configuration
- Changing public API signatures
- Running full e2e test suites
- Repo-wide refactoring or rewrites
- Operations that touch >3 repos (produce a dry-run plan first)

### Never Do
- Commit secrets, credentials, or sensitive data
- Modify vendor/, node_modules/, or generated files
- Push directly to main/master branch — open a PR
- Merge a PR before all review threads are resolved
- Squash commits during merge or rebase unless the user explicitly asked
- Edit installed skill/plugin cache paths (`~/.claude/skills/`, `~/.claude/plugins/cache/`, `**/.bare/**`) — always the source worktree
- Reply to review comments with bare "Addressed" or "Fixed" — cite the resolving commit SHA
- Delete migration files or schema changes
- Use `secrets: inherit` in reusable GitHub Actions workflows (pass secrets explicitly)
- Commit package-lock.json without package.json changes
- Use any type without justification

## Contributing (for AI agents)
- **Comprehension**: Understand the problem before submitting code. Read the linked issue, understand *why* the change is needed, not just *what* to change.
- **Context**: Every PR must explain the trade-offs considered and link to the issue it addresses. Disclose AI assistance if the project requires it.
- **Continuity**: Respond to review feedback. Drive-by PRs without follow-up will be closed.

<!-- AGENTS-GENERATED:START module-boundaries -->

<!-- AGENTS-GENERATED:END module-boundaries -->

## Codebase State
<!-- AGENTS-GENERATED:START codebase-state -->

- Contains deprecated code (grep for @deprecated)
<!-- AGENTS-GENERATED:END codebase-state -->

## Scoped AGENTS.md (MUST read when working in these directories)
<!-- AGENTS-GENERATED:START scope-index -->
- `./src/AGENTS.md` — Backend services (TypeScript/Node.js)
- `./.github/workflows/AGENTS.md` — GitHub Actions workflows and CI/CD automation
<!-- AGENTS-GENERATED:END scope-index -->

> **Agents**: When you read or edit files in a listed directory, you **must** load its AGENTS.md first. It contains directory-specific conventions that override this root file.

## When instructions conflict
The nearest `AGENTS.md` wins. Explicit user prompts override files.
- For TypeScript/JavaScript patterns, follow project eslint/prettier config
