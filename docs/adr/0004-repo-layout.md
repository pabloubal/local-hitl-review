---
status: accepted
---

# One npm-workspaces monorepo, a private core, and one version for everything

The extension, the `lhr` CLI (which includes `lhr mcp`) and the Claude Code plugin all share one core library. They live in one repo as npm workspaces, and the core is bundled into each client instead of being published.

```
packages/core     file format, anchoring, git access, review rounds; never imports vscode
packages/cli      the `lhr` binary, including `lhr mcp`; published to npm
packages/vscode   the extension (today's src/, minus what moves to core); published as a .vsix
plugin/           Claude Code plugin: skill, hooks, MCP config (plain files, not an npm package)
skills/           SKILL.md, AGENTS.md snippet, Cursor rules (plain files)
```

- **The core is private.** esbuild bundles it into the CLI and the extension. The public contract is the file format (ADR 0003), not our library, so the core's API can change freely until it settles. Publishing it later needs no restructuring.
- **One version for everything.** A single semantic-release run versions every package together and publishes both the `.vsix` and the CLI. Clients that share a version also share a file format version, so the number alone tells users which clients work together.
- **CLI package name:** `lhr` if npm lets us claim it (it was unpublished in 2020), otherwise `local-hitl-review`. The binary is `lhr` either way.
- **Dependencies:** `@modelcontextprotocol/sdk` (and the `zod` it requires) for `lhr mcp`. Arguments are parsed with Node's built-in `util.parseArgs`, and git is called as the `git` binary, as `gitService.ts` already does. No prompt library until the interactive mode for a bare `lhr` is designed.
- **Tests:** each package has its own `test/` folder. Core and the CLI use `node:test`. Core provides a helper that creates a real temporary git repo for anchoring tests. The CLI has end-to-end tests that run the built binary. `vscode-test` integration tests stay in `packages/vscode`.
- **The move comes first.** One PR moves today's code into this layout with `git mv` and changes no behaviour. v2 work starts after it merges.

## Considered options

- **pnpm workspaces, Turborepo or Nx.** These add tooling we don't need at four packages, and the project keeps dependencies to a minimum.
- **Extension stays at the repo root, with `packages/` beside it.** Less to move, but it keeps the extension looking like the main product rather than one client among several (see the decision on one extension or a set of tools).
- **Publish the core as its own package.** This would let third parties build clients on it, but it would freeze an API that isn't designed yet. Third parties can already build on the file format.
- **Independent versions per package.** These need multi-semantic-release or changesets, and they make compatibility between clients harder to tell.

## Consequences

- CI needs an `NPM_TOKEN` secret and an npm publish step for `packages/cli`.
- The `.vscodeignore`, esbuild entry points, `tsconfig` and `.vscode-test.mjs` paths all move with the extension.
