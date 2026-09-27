<!-- Managed by agent: keep sections and order; edit content, not structure. Last updated: 2026-09-25 -->

# AGENTS.md — src

<!-- AGENTS-GENERATED:START overview -->
## Overview
VS Code extension core implementation: Git diffing, SCM view, CommentController, and local markdown review store.
<!-- AGENTS-GENERATED:END overview -->

<!-- AGENTS-GENERATED:START filemap -->
## Key Files
| File | Purpose |
|------|---------|
| `src/extension.ts` | Extension lifecycle, activation, and command registration |
| `src/changedFilesProvider.ts` | SCM tree/list data provider for changed files and commit graph |
| `src/commentController.ts` | VS Code CommentController integration for inline diff review threads |
| `src/feedbackStore.ts` | File-based manager for `.review` comments in `.feedback/` |
| `src/gitService.ts` | Git CLI integration for branches, diffs, commits, and worktrees |
| `src/parser.ts` | YAML frontmatter + markdown body serializer/parser for `.review` files |
| `src/types.ts` | Core types and interfaces for reviews, comments, and severity |
| `src/test/parser.test.ts` | Unit tests for parser and comment ID generation |
<!-- AGENTS-GENERATED:END filemap -->

<!-- AGENTS-GENERATED:START golden-samples -->
## Golden Samples (follow these patterns)
| Pattern | Reference |
|---------|-----------|
| Serialization & unit testing | `src/parser.ts` |
| Store & file I/O lifecycle | `src/feedbackStore.ts` |
| SCM View & compare modes | `src/changedFilesProvider.ts` |
<!-- AGENTS-GENERATED:END golden-samples -->

<!-- AGENTS-GENERATED:START setup -->
## Setup & environment
- Install: `npm install`
- Package manager: npm
- Environment variables: See .env or .env.example
<!-- AGENTS-GENERATED:END setup -->

<!-- AGENTS-GENERATED:START commands -->
## Build & tests
- Typecheck: `npx tsc --noEmit`
- Format: `npx prettier --write .`
- Lint: `npm run lint`
- Fast unit tests: `npm run test:unit`
- All tests: `npm test`
- Build: `npm run build`
<!-- AGENTS-GENERATED:END commands -->

<!-- AGENTS-GENERATED:START code-style -->
## Code style & conventions
- Use TypeScript strict mode (`strict: true` in tsconfig)
- No `any` without explicit justification comment
- Prefer `interface` over `type` for object shapes
- Naming: `camelCase` for functions/vars, `PascalCase` for classes/types
- Async/await over raw Promises
- Prefer `const` over `let`, never use `var`
- Destructure objects and arrays when appropriate
<!-- AGENTS-GENERATED:END code-style -->

<!-- AGENTS-GENERATED:START security -->
## Security & safety
- Validate all user inputs (use zod or similar)
- Parameterized queries only (no string concatenation)
- Never use dynamic code execution with user data
- Sensitive data: never log or expose in errors
- Environment: use dotenv, never hardcode secrets
- CORS: configure explicitly, no wildcard in production
- Rate limiting: implement for public endpoints
<!-- AGENTS-GENERATED:END security -->

<!-- AGENTS-GENERATED:START checklist -->
## PR/commit checklist
- [ ] Tests pass: `npm test`
- [ ] Type check clean: `npx tsc --noEmit`
- [ ] Lint clean: `npm run lint`
- [ ] Formatted: `npx prettier --write .`
- [ ] No `any` types without justification
- [ ] API endpoints have validation
- [ ] Error responses don't leak internals
<!-- AGENTS-GENERATED:END checklist -->

<!-- AGENTS-GENERATED:START examples -->
## Patterns to Follow
> **Prefer looking at real code in this repo over generic examples.**
> See **Golden Samples** section above for files that demonstrate correct patterns.
<!-- AGENTS-GENERATED:END examples -->

<!-- AGENTS-GENERATED:START help -->
## When stuck
- Check Node.js docs: https://nodejs.org/docs
- TypeScript handbook: https://www.typescriptlang.org/docs
- Review existing patterns in this codebase
- Check root AGENTS.md for project-wide conventions
<!-- AGENTS-GENERATED:END help -->
