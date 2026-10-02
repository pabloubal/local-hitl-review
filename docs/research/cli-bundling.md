# Bundling and Node version floor for `packages/cli`

Research for issue #96 (map #91). Facts only: no option is chosen here. Adding a dependency needs maintainer approval.

Measured on 2026-10-02 with Node 22.21.1, npm 11.7.0, in a scratch project (`/tmp`, not in the repo) that copies `packages/core` unchanged and adds a prototype entry (`#!/usr/bin/env node`, `util.parseArgs`, `McpServer` + `StdioServerTransport` from `@modelcontextprotocol/sdk` 1.31.0, `zod` 4.6.5, `import * as core` from the core source). Every bundle was run with `--json </dev/null` and exited 0. Nothing was run on Node 18 or 20.

## Current state in the repo

- Core: `@pablou/lhr-core`, private, no `"type"` (so CommonJS output), `main: out/src/index.js`. Built with `tsc`: `target ES2022`, `module Node16`, `moduleResolution Node16`, `resolveJsonModule`, source maps on. Source imports use `.js` suffixes. No runtime dependencies. Only `node:` built-ins are imported (`child_process`, `crypto`, `fs/promises`, `os`, `path`).
- Core imports its four JSON schemas as modules (`packages/core/src/schemaCheck.ts`, "imported as JSON modules, so bundlers inline them"), so nothing is read from disk at runtime.
- `packages/vscode/esbuild.mjs` already bundles with esbuild: `bundle, platform node, format cjs, target node18, sourcemap`. `esbuild ^0.25.5` is already a devDependency of `packages/vscode`; the root and `packages/core` have none.
- CI uses `node-version: '20'` (`.github/workflows/ci-cd.yml`).
- ADR 0004: "esbuild bundles [the core] into the CLI and the extension"; one lockstep version; npm trusted publishing.

## Node version floor

| Piece | Minimum | Source |
|---|---|---|
| `util.parseArgs` | added v18.3.0 (and v16.17.0). `tokens` v18.7.0; default values v18.11.0; stable (no longer experimental) v20.0.0; `allowNegative` v20.16.0 / v22.4.0 | https://github.com/nodejs/node/blob/main/doc/api/util.md (section `util.parseArgs`, YAML history) |
| `@modelcontextprotocol/sdk` 1.31.0 | `engines.node: ">=18"`; ESM package (`"type": "module"`) | `npm view @modelcontextprotocol/sdk engines type`; https://www.npmjs.com/package/@modelcontextprotocol/sdk |
| Core runtime APIs | `fs/promises` `rm` v14.14.0, `crypto.randomUUID` v15.6.0, `mkdir {recursive}` older still. No API newer than Node 16 found in `packages/core/src` | https://github.com/nodejs/node/blob/main/doc/api/fs.md, https://github.com/nodejs/node/blob/main/doc/api/crypto.md |
| Core compile target | ES2022 syntax (tsconfig). Not mapped to a Node version from a primary source | `packages/core/tsconfig.json` |

Floor implied by the three pieces: Node 18 (the highest of 18.3 / 18 / ≤16). Node 18.11 if default values in `parseArgs` are used; Node 20.0 if the `parseArgs` API must be non-experimental (on 18 it works but, per the Node 20 history entry, was experimental).

Node release status (https://github.com/nodejs/Release/blob/main/schedule.json): v18 end of life 2025-04-30; v20 end of life 2026-04-30; v22 end of life 2027-04-30 (maintenance from 2025-10-21); v24 active LTS from 2025-10-28, maintenance from 2026-10-20, end of life 2028-04-30. As of today Node 18 and 20 are both past end of life.

## Options compared

Sizes are for the prototype entry. "No MCP" = same entry without the SDK and zod (core + `parseArgs` only).

| | tsc only | esbuild | tsup | rollup |
|---|---|---|---|---|
| New devDependencies | none (typescript already in core) | none in the workspace: `esbuild ^0.25.5` already a devDependency of `packages/vscode` (hoisted by workspaces); version 0.28.2 is current, `engines node >=18` | `tsup` 8.5.1 (`engines node >=18`; 16 direct dependencies including `esbuild`, `rollup`, `postcss-load-config`, `chokidar`, `sucrase`); peer deps `typescript`, optional `@swc/core`, `postcss`, `@microsoft/api-extractor` | `rollup` 4.63.6 plus `@rollup/plugin-node-resolve`, `-commonjs`, `-json` (not needed for core, which is TS-imported JSON; zod-to-json-schema etc. needed commonjs/resolve), `-typescript` (+ `tslib`). 5 to 6 packages |
| Output shape | `out/cli/src/main.js` + `out/core/src/*.js` (many files; layout follows `rootDir`). Runtime `dependencies` of the cli package must list the SDK and zod, so `npm i -g` installs 345 prod packages (`npm ls --prod --all`; SDK 6 MB, zod 8 MB on disk) | One file. ESM 1,579,881 B; CJS 1,462,762 B; ESM minified 795,899 B (192,114 B gzip; unminified 266,035 B gzip); No MCP 115,954 B | One file `main.mjs` (extension `.mjs` because the package is not `"type": "module"`). With `noExternal: [/.*/]`: 1,582,692 B. Default (no config): `dependencies` from `package.json` are left external: 116,119 B and `import` statements for the SDK/zod stay | One file. 1,098,898 B (rollup tree-shakes more than esbuild: -30% vs esbuild ESM, unminified) |
| ESM / CJS | Whatever `module` is set to. `Node16` + no `"type"` emits CJS, which can `require` neither the ESM-only SDK without dynamic `import()` nor be imported cleanly; with `"type": "module"` it emits ESM. Prototype with Node16/CJS output built and ran (TS compiled the SDK imports as `require`, they resolved through the SDK's `exports` map) | `--format=esm` or `cjs`, both built and ran. ESM output wraps CJS-origin code with a `__commonJS` helper and ends `export default require_main()` | `format: ['esm']`, `['cjs']`, or both; ran as ESM | `format: 'esm'` or `'cjs'`. Ran as ESM. Needs `module: ESNext` + `moduleResolution: Bundler` overrides for the TS plugin: with the repo's `module Node16` and no `"type"` the plugin emitted CJS and the bundle crashed with `exports is not defined` |
| Source maps | `sourceMap: true` already set (per-file `.js.map`, no bundling) | `--sourcemap` (2.56 MB map for ESM; `.map` file beside output) | `sourcemap: true` (2.49 MB) | `output.sourcemap: true` (2.13 MB) |
| Shebang / `bin` | Preserved by tsc when the source's first line is `#!/usr/bin/env node`. File mode is not set (`-rw-r--r--`) | Preserved. Output was written `-rwxr-xr-x` | Preserved, written `-rwxr-xr-x` | Preserved at the top of the entry (output `-rw-r--r--`; no exec bit) |
| Bundling the workspace core | Not bundled. Either (a) widen `rootDir` to `..` so `core/src` compiles into the cli's `out/` (what the prototype did; a relative `../../core/src` import), or (b) ship core as a dependency, which means publishing it (contradicts ADR 0004's private core) or `bundledDependencies`/`npm pack` of the workspace | Follows `import`s and bundles any file or workspace symlink. Works with the existing `.js`-suffix imports (esbuild maps `.js` to `.ts`) and inlines the JSON schema imports | Same as esbuild (esbuild-based). Note default externalisation: a workspace package listed in `dependencies` stays external unless matched by `noExternal` | Needs `@rollup/plugin-typescript` for `.js`-to-`.ts` resolution and node-resolve for `node_modules`; JSON via `@rollup/plugin-json` (or the TS plugin's `resolveJsonModule`; the prototype used both) |
| Declaration files | Yes (`declaration`) | No (not needed for a binary) | Optional `dts` (uses rollup + api-extractor) | Optional via TS plugin |
| Maintenance note | n/a | Active, Node >=18 | README header: "This project is not actively maintained anymore. Please consider using tsdown instead." (https://github.com/egoist/tsup) | Active, Node >=18 |
| Build speed (prototype, warm) | not measured | not measured (tens of ms) | 95 ms | 1.6 s |

## Facts that apply across bundlers

- The SDK is ESM-only and pulls 17 direct runtime dependencies (`express`, `hono`, `ajv`, `jose`, `cross-spawn`, `zod-to-json-schema`, ...; `npm view @modelcontextprotocol/sdk dependencies`). Importing only `server/mcp.js` and `server/stdio.js` and bundling leaves a 1.1 to 1.6 MB bundle versus 116 KB without it, so the SDK + zod account for about 93% of the bundle. Minified esbuild output is 796 KB.
- `zod` is a peer dependency of the SDK (`^3.25 || ^4.0`) and also a direct dependency listing; `@cfworker/json-schema` is an optional peer.
- Bundles are built with `platform: node`, `target: node18`; esbuild/tsup/rollup keep `node:` built-ins external.
- npm trusted publishing (https://docs.npmjs.com/trusted-publishers) is a CI concern, not a bundler one; its npm CLI / Node runner requirements were not verified here (the page's CircleCI example uses Node 22.14).

## Not verified

- Behaviour on Node 18 and 20 (all runs were Node 22).
- tsup/esbuild minified-output correctness for the SDK (only ran the unminified ones plus a minified build for size, not executed).
- Exact Node version for ES2022 syntax support.

## Sources

- https://github.com/nodejs/node/blob/main/doc/api/util.md
- https://github.com/nodejs/node/blob/main/doc/api/fs.md
- https://github.com/nodejs/node/blob/main/doc/api/crypto.md
- https://github.com/nodejs/Release/blob/main/schedule.json
- https://www.npmjs.com/package/@modelcontextprotocol/sdk (engines, dependencies via `npm view`)
- https://esbuild.github.io/api/ , https://www.npmjs.com/package/esbuild
- https://github.com/egoist/tsup (README)
- https://rollupjs.org , https://github.com/rollup/plugins
- https://docs.npmjs.com/trusted-publishers
