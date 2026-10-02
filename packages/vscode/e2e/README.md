# End-to-end scenarios

Each test launches a fresh VS Code (isolated profile, scratch git fixture, the extension loaded from this package), drives it the way a user would, and records named checkpoints: visible text, `.feedback/` files, `git diff`. The checkpoints are compared against `approved/<spec>/<test>.md`. Screenshots are diagnostics, never compared.

## Run

```sh
npm run test:e2e                              # all scenarios (from the repo root)
npm run test:e2e -- thread-actions            # one spec file
npm run test:e2e -- -g "reply in a thread"    # one test
npm run test:e2e -- --update-snapshots        # accept current output as approved
```

On Linux without a display, prefix with `xvfb-run -a`. The first run downloads VS Code into `.vscode-test/`.

## Read results

Everything lands in `packages/vscode/e2e-results/` (gitignored; CI uploads it as the `e2e-results` artifact):

- `summary.json`, `junit.xml`, `html/`: the whole run.
- `artifacts/<spec>-<test>/` for each failed test:
  - `*-actual.md` / `*-expected.md`: the checkpoint mismatch, if that is what failed.
  - `error-context.md`: the failing step, its call log, and the page's accessibility tree at that moment.
  - `trace.zip`: a screenshot and DOM snapshot per action. Open it with `npx playwright show-trace <path>`.
  - `logs/`: extension output channel, extension host, renderer.
  - `fixture/`: the workspace as the test left it.

## Triage a failure

- **Approved file differs, behaviour is right** (an intended change): rerun that test with `--update-snapshots` and review the approved diff in the PR.
- **Approved file differs, behaviour is wrong**: product regression. Fix the product, never the approved file.
- **A step timed out**: read `error-context.md` and the trace. Usually a selector or timing drift in the scenario; fix the scenario or the helper in `vscode.ts`.

## Write a scenario

Use the fixture `vscode` from `./vscode`: `palette`, `type`, `addComment`, `editComment`, `changedFile`, `changedFiles`, `texts`, `reviewFiles`, `feedbackDir`, and `checkpoint(name, parts)`. Wait for state with `expect(...)` or `expect.poll(...)` before recording a checkpoint. A value read too early gets approved as truth. Keep checkpoints to what a reviewer should judge; `checkpoint` already replaces ids, timestamps, shas and the workspace path with placeholders.
