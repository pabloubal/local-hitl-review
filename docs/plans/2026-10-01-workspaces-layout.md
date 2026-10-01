# Move the extension into the npm-workspaces layout (#66)
Goal: move today's extension into `packages/vscode/` under an npm-workspaces root (ADR 0004) with no behaviour change.

Acceptance criteria:
- [x] `git log --follow` works for moved files (moves committed without content edits)
- [x] `npm ci`, `npm run lint`, `npx tsc --noEmit`, `npm test`, `npm run build` pass from the repo root
- [x] The built `.vsix` has the same extension payload as before the move (see design note)
- [x] A semantic-release dry run still computes the next version

Design:
- Moved with `git mv`: `src/`, `assets/`, `package.json`, `tsconfig.json`, `esbuild.mjs`, `.vscodeignore`, `.vscode-test.mjs`. The pure move is its own commit.
- `README.md` and `CHANGELOG.md` stay at the root: the README is the GitHub landing page and semantic-release writes the changelog there. The release job copies both into `packages/vscode/` right before `vsce package` (copies are gitignored, never committed). vsce 4 rejects `--readme-path ../../README.md` ("readme file could not be found"), so the path flags were tried and dropped. The README hero image path becomes `packages/vscode/assets/hero.jpeg`; vsce rewrites it to `raw/HEAD/packages/vscode/assets/hero.jpeg`.
- New root `package.json`: `private`, named `local-hitl-review-monorepo` (npm forbids the extension's name twice), `workspaces: ["packages/*"]`, scripts delegating with `--workspaces --if-present`. CI keeps running `npm ci` and `npm test` from the root unchanged.
- Root `tsconfig.json` extends `packages/vscode/tsconfig.json` so a bare `npx tsc --noEmit` from the root really type-checks (a references-only file would pass while checking nothing).
- Release: `@semantic-release/npm` gets `pkgRoot: packages/vscode` (it bumps the extension and its lockfile entry); exec then runs `npm version --workspaces --include-workspace-root --allow-same-version` so the root version moves too (one version, ADR 0004). The `.vsix` is built in `packages/vscode` with `--no-dependencies` (vsce's dependency scan trips over the workspaces root; the extension has no runtime deps, esbuild bundles it). The GitHub asset path follows it; publish uses `--packagePath` so the published file is the released one.
- `.vsix` listing: the old package shipped repo-level files by accident (`.github/`, `docs/`, `AGENTS.md`, `GLOSSARY.md`, `.releaserc.json`). Packaging from `packages/vscode` drops them. The extension payload (`out/extension.js[.map]`, `assets/*`, `package.json`, `readme.md`, `changelog.md`, and `.vscode-test.mjs`, which moved with the package and still ships as before) is byte-identical apart from the hero image URL.
- Rejected: moving README/CHANGELOG into the package (breaks the GitHub landing page and changelog location); vsce `--readme-path`/`--changelog-path` (vsce 4 cannot read files outside the package).

Tasks:
| id | task | files | depends | agent | model | status |
|----|------|-------|---------|-------|-------|--------|
| T1 | Pure `git mv` into packages/vscode | (moves only) | - | tech lead | - | done (293b6f6) |
| T2 | Workspaces root, root tsconfig, lockfile, .vscode configs, README image, AGENTS.md paths | package.json, tsconfig.json, package-lock.json, .vscode/*, README.md, AGENTS.md | T1 | implementer | sonnet | done (8c420f6, 1dd6efe) |
| T3 | Release config for the new layout; vsix payload diff; semantic-release dry run | .releaserc.json, (.github/workflows/ci-cd.yml only if needed) | T2 | implementer | sonnet | done (6ab0c64) |
| T4 | Review combined diff | - | T3 | reviewer | opus | done; findings fixed (daa0a86) |

Risks / open questions:
- Resolved: `npm version` inside the workspace updates the lockfile's `packages/vscode` entry but not the root; the exec bump covers the root.
- Resolved: integration tests pass with `workspaceFolder` resolving to `packages/vscode`; `.vscode-test.mjs` unchanged.
- Local only: `npm test` fails in deep worktree paths (macOS ~103-char IPC socket limit); CI on ubuntu is unaffected.
- The Marketplace README hero URL resolves only once this layout is on `main`.
