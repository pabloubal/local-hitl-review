# Core scaffold: openTree, errors, frontmatter and IDs (#67)

Goal: create `packages/core` with the pieces every other core ticket (#68–#72) builds on.

Spec: `docs/spec/core-api.md` § Opening a tree, § Errors; `docs/spec/file-format-v2.md` § Tree, § IDs and file names, § Frontmatter syntax; ADR 0004, ADR 0005.

Acceptance criteria:
- [ ] Tests written first, covering parser round-trip, every syntax-error case, ID generation with pinned `now`/`random`, and format detection.
- [ ] `dispose()` ends the git child process (asserted in a test).
- [ ] Root `npm test` runs the core tests.
- [ ] Core never imports `vscode` (asserted in a test).

Design:
- **Package:** `packages/core`, name `@pablou/lhr-core`, `private: true`, CommonJS, tsc with the same compiler options as `packages/vscode` (Node16, ES2022, strict) but `types: ["node"]`. `rootDir: "."`, sources in `src/`, tests in `test/` (ADR 0004), output in `out/`. Scripts: `lint` = `tsc --noEmit`, `test:unit` = `tsc && node --test out/test/*.test.js`, `test` = `npm run test:unit`. The root `--workspaces` scripts pick it up; no root or CI change. devDependencies `typescript` and `@types/node` at the same ranges as `packages/vscode` (already in the lockfile, no new deps).
- **Errors (`src/errors.ts`):** `LhrErrorCode` union of the nine spec codes, `class LhrError extends Error { code }`, `Diagnostic` verbatim from the spec.
- **Frontmatter (`src/frontmatter.ts`):** `parseFrontmatter(text, path) → { data, body, diagnostics }`, `serializeFrontmatter(data, body) → string`. Values are `string | number | boolean`. Every syntax error is a `Diagnostic` with code `FRONTMATTER_SYNTAX` (the spec has one rule, "Frontmatter has a syntax error"), `severity: "error"`, and a 1-based line. A bad line is skipped and the other lines are kept; the reader (#68) decides what to do with a file that has errors. Parsing never throws. Accepts CRLF; the serializer writes LF. The serializer quotes what the spec requires plus YAML-special scalars (`null`, `~`, floats, `yes`/`no`/`on`/`off`, case variants of `true`/`false`) so any YAML parser reads a string; it throws `LhrError("INVALID_INPUT")` for bad keys, non-safe-integer numbers or strings containing a newline (caller input, not content).
- **IDs (`src/ids.ts`):** pure functions taking `Date` + random string: `formatTimestamp`, `createId`, `createMessageFileName(now, kind, random)`, `parseId`, `parseMessageId`, `parseMessageFileName`, `defaultRandom` (crypto, `[a-z2-7]{6}`). Parsers return `undefined` on invalid input, including impossible dates.
- **Tree (`src/format.ts`, `src/git.ts`, `src/tree.ts`):** `openTree(host)` resolves host defaults, requires `root` to be the toplevel of a git work tree (realpath compare, else `NOT_A_REPO`; git missing or failing → `GIT_FAILED`), checks `.lhr/format` (missing → `FORMAT_MISSING`, content other than `2` with optional trailing newline → `FORMAT_VERSION`), then spawns `git cat-file --batch`. `GitBatch.read(rev)` serialises requests and returns `{ type, size, content } | undefined`. `LhrTree` exposes `root`, `newId()`, `newMessageFileName(kind)`, `dispose()` (idempotent, ends stdin, waits for exit, kills after a timeout).
- **Test helper (`test/helpers/tempRepo.ts`):** creates a real temporary git repo (ADR 0004) with optional `.lhr/format` content; `cleanup()` removes it.

Rejected: a YAML dependency (ADR 0005); throwing on parse errors (spec: broken content never throws); a separate error code per syntax-error case (the spec defines one rule).

Tasks:
| id | task | files | depends | agent | model | status |
|----|------|-------|---------|-------|-------|--------|
| T1 | Package scaffold, errors, temp-repo helper, no-vscode test | packages/core/{package.json,tsconfig.json,src/errors.ts,src/index.ts,test/helpers/tempRepo.ts,test/scaffold.test.ts}, package-lock.json | - | implementer | sonnet | done |
| T2 | IDs and file names | packages/core/src/ids.ts, test/ids.test.ts | T1 | implementer | sonnet | todo |
| T3 | Frontmatter parser and serializer | packages/core/src/frontmatter.ts, test/frontmatter.test.ts | T1 | implementer | sonnet | todo |
| T4 | Format detection, GitBatch, openTree/LhrTree | packages/core/src/{format,git,tree}.ts, test/{format,tree}.test.ts | T2 | implementer | sonnet | todo |
| T5 | index.ts exports, full verification | packages/core/src/index.ts | T2–T4 | tech lead | - | todo |
| T6 | Review of combined diff | - | T5 | reviewer | opus | todo |

Risks / open questions:
- Diagnostic code names are not in the spec; `FRONTMATTER_SYNTAX` may need renaming when #72 (`check()`) settles the code list.
- T2/T3 run in parallel in the same package, so a `tsc` failure can come from the other task's in-progress file.
