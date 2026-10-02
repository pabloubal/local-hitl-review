# AGENTS.md — e2e

UI scenarios that drive a real VS Code and compare checkpoints against `approved/`. How to run, read results and write scenarios: [README.md](./README.md).

## Rules

- **Approved files are the spec.** Never edit them by hand, and never run `--update-snapshots` just to turn a failure green. First decide whether the new output is correct behaviour. If it is a regression, fix the product, not the approved file.
- **Justify every approved diff.** A PR that changes `approved/` says, per file, why the new output is right.
- **Settle before you record.** Wait for the expected state with `expect(...)` or `expect.poll(...)` before `checkpoint(...)`, never a fixed sleep. A value read too early gets approved as truth.
- **Fix timing in `vscode.ts`.** Retries and waits belong in the shared helpers, not scattered through specs. A fixed pause needs a comment saying why no DOM signal works.
- **Don't raise timeouts to hide flakiness.** Find the cause. Raise them on purpose only when the suite grows, in both `playwright.config.ts` and the CI job.
- **Narrow first.** Run `npm run test:e2e -- -g "<test>"`, then the full suite before committing. Show the pass/fail summary as evidence.
- **Triage from artifacts.** On failure, read `e2e-results/artifacts/<test>/error-context.md` first, then the `*-actual.md`/`*-expected.md` diff, then the trace and logs. Don't re-drive by hand to find out what happened.
