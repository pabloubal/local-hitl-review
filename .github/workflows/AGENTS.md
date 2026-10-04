<!-- Managed by agent: keep sections and order; edit content, not structure. Last updated: 2026-10-04 -->

# AGENTS.md — workflows

<!-- AGENTS-GENERATED:START overview -->
## Overview
GitHub Actions workflows and CI/CD automation

### `ci-cd.yml` jobs
- **`test`**: matrix over Node 20 and 22 (`engines.node` is `>=20`), `fail-fast: false`. Runs `xvfb-run -a npm test` (unit, VS Code integration, and the CLI built-binary tests in `packages/cli/test`), then `npm run smoke:pack -w @pablou/lhr`.
- **Smoke test** (`packages/cli/scripts/smoke-pack.mjs`): builds the CLI, `npm pack`s it, installs the tarball into a temp dir outside the workspace, and runs the installed `lhr --version`, `lhr --help`, and an `lhr mcp` initialize + `tools/list` handshake over stdio. Run it locally with the same command.
- **`e2e`**: Playwright scenarios, Node 20, non-blocking (`continue-on-error`).
- **`release`**: push to `main`/`master` only, after `test`. Node 22 with npm upgraded to `^11.5.1`, `permissions: contents: write, id-token: write`. Runs semantic-release (`.releaserc.json`).

### Release and npm trusted publishing
- One version for everything: the `exec` `prepareCmd` runs `npm version <next> --workspaces --include-workspace-root`, builds, packages the `.vsix`, and fails if the built `lhr --version` differs from the release version. `scripts/check-versions.mjs` (run by `npm test` and `npm run lint`) keeps every workspace on the root version.
- The `exec` `publishCmd` publishes the `.vsix` (when `VSCE_PAT` is set), then runs `npm publish` in `packages/cli`.
- `@pablou/lhr` is published with **npm trusted publishing** (GitHub OIDC, `id-token: write`), with provenance and public access from its `publishConfig`. There is no npm token secret; do not add one. The trusted publisher on npmjs.com is bound to repository `pabloubal/local-hitl-review` and workflow file `ci-cd.yml`: renaming the file or moving the publish to another workflow breaks publishing until the npm setting is updated.
- **Failed publishes are recovered by hand against the release tag.** By publish time semantic-release has already pushed the release commit and tag, so rerunning the job will not publish again. If the `.vsix` or npm publish fails: check out `v<version>`, `npm ci`, `npm run build`, then publish the missing artifact (`cd packages/vscode && npx @vscode/vsce package --no-dependencies && npx @vscode/vsce publish --packagePath ./*.vsix`, and/or `cd packages/cli && npm publish`, logged in with the 2FA-protected maintainer account). A failed `.vsix` publish stops the chain, so the npm package then needs publishing by hand too.
<!-- AGENTS-GENERATED:END overview -->

<!-- AGENTS-GENERATED:START filemap -->
## Key Files
| File | Purpose |
|------|---------|
| `ci-cd.yml` | CI/CD |
<!-- AGENTS-GENERATED:END filemap -->

<!-- AGENTS-GENERATED:START golden-samples -->
## Workflow files
- Workflows:        1 workflow file(s)
<!-- AGENTS-GENERATED:END setup -->

<!-- AGENTS-GENERATED:START structure -->
## Directory structure
```
.github/
  workflows/
    ci.yml              → Main CI workflow (lint, test, build)
    release.yml         → Release/deploy workflow
    dependabot.yml      → Dependency updates
  actions/
    <action-name>/      → Composite actions (reusable)
      action.yml
  CODEOWNERS            → Code ownership rules
  pull_request_template.md
```
<!-- AGENTS-GENERATED:END structure -->

<!-- AGENTS-GENERATED:START code-style -->
## Workflow conventions
- **Pin action versions** with full SHA, not tags (`uses: actions/checkout@abc123...`)
- **Minimal permissions**: Use `permissions:` block, never use `permissions: write-all`
- **Reusable workflows**: Extract common patterns to `.github/workflows/reusable-*.yml`
- **Job dependencies**: Use `needs:` to express dependencies
- **Caching**: Use `actions/cache` for dependencies (npm, composer, go)

### Naming conventions
| Type | Convention | Example |
|------|------------|---------|
| Workflow file | `<purpose>.yml` | `ci.yml`, `release.yml` |
| Workflow name | Title Case | `CI Pipeline`, `Release` |
| Job ID | kebab-case | `build-and-test`, `deploy-staging` |
| Step name | Sentence case | `Install dependencies` |
| Secret | SCREAMING_SNAKE | `DEPLOY_TOKEN`, `NPM_TOKEN` |
<!-- AGENTS-GENERATED:END code-style -->

<!-- AGENTS-GENERATED:START patterns -->
## Common patterns

### Basic CI workflow
```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

permissions:
  contents: read

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
      - uses: actions/setup-node@39370e3970a6d050c480ffad4ff0ed4d3fdee5af # v4.1.0
        with:
          node-version: '20'
          cache: 'npm'
      - run: npm ci
      - run: npm test
```

### Matrix builds
```yaml
jobs:
  test:
    strategy:
      matrix:
        os: [ubuntu-latest, macos-latest]
        node: ['18', '20', '22']
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/setup-node@39370e3970a6d050c480ffad4ff0ed4d3fdee5af # v4.1.0
        with:
          node-version: ${{ matrix.node }}
```

### Reusable workflow
```yaml
# .github/workflows/reusable-test.yml
on:
  workflow_call:
    inputs:
      node-version:
        type: string
        default: '20'

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ inputs.node-version }}
```

### Conditional deployment
```yaml
jobs:
  deploy:
    if: github.ref == 'refs/heads/main' && github.event_name == 'push'
    needs: [test, build]
    environment: production
    steps:
      - name: Deploy
        run: ./deploy.sh
```
<!-- AGENTS-GENERATED:END patterns -->

<!-- AGENTS-GENERATED:START security -->
## Security & safety
- **NEVER** expose secrets in logs: use `::add-mask::` for dynamic secrets
- **Pin actions** to full commit SHA, not mutable tags
- **Minimal permissions**: Start with `contents: read`, add only what's needed
- **Environment protection**: Use environments with required reviewers for deploys
- **Secret scanning**: Enable in repository settings
- **Dependency review**: Use `actions/dependency-review-action` for PRs
- **OIDC**: Prefer OIDC over long-lived secrets for cloud providers
<!-- AGENTS-GENERATED:END security -->

<!-- AGENTS-GENERATED:START checklist -->
## PR/commit checklist
- [ ] Actions pinned to full SHA (not tags)
- [ ] Permissions block uses minimal required permissions
- [ ] Secrets are not exposed in logs
- [ ] Workflow syntax valid: `actionlint` or GitHub UI validation
- [ ] Matrix strategy covers required versions/platforms
- [ ] Caching configured for dependencies
<!-- AGENTS-GENERATED:END checklist -->

<!-- AGENTS-GENERATED:START examples -->
## Patterns to Follow
> **Prefer looking at real code in this repo over generic examples.**
> See **Golden Samples** section above for files that demonstrate correct patterns.
<!-- AGENTS-GENERATED:END examples -->

<!-- AGENTS-GENERATED:START help -->
## When stuck
- GitHub Actions docs: https://docs.github.com/en/actions
- Workflow syntax: https://docs.github.com/en/actions/reference/workflow-syntax-for-github-actions
- Action marketplace: https://github.com/marketplace?type=actions
- Use `act` for local testing: https://github.com/nektos/act
- Check existing workflows in this repo for patterns
<!-- AGENTS-GENERATED:END help -->
