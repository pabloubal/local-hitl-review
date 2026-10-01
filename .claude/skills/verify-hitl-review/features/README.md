# Local HITL Review verification map

This directory is the maintained source for verifying what users see and do in the Local HITL Review extension. Read this index before driving the app, then follow the matching feature file as the recipe.

## Baseline preconditions

- `HITL_RUN` points at a fresh run dir, and `H=.claude/skills/verify-hitl-review/scripts/hitl.mjs`.
- `$H launch` printed `"ready":true` and `$H doctor` exits 0.
- The fixture is on `feature/review-me` against `main`. The changed files are `M src/app.ts` and `A src/new.ts`.
- The Source Control sidebar shows the `Local HITL Review` view expanded with title `vs main`.
- `.feedback/` contains only `AGENTS.md` and `review_template.md`. The extension creates both on activation.

## Driving conventions

- Start every recipe from the baseline unless it lists other preconditions.
- Act through the palette (`$H palette`), clicks (`$H click`), and keys (`$H key`). Use `$H eval` only to read state.
- Chain steps with `&&`. A failed lookup followed by `type` writes into the editor.
- Command titles are matched by prefix and are case-insensitive. Copy them exactly as written.

## Proof and skip reporting

- Save screenshots in `evidence/<feature-id>/`, numbered by step.
- Every comment mutation needs `$H feedback <feature-id>/feedback` output showing the changed `.review` frontmatter or body.
- Read the result back from a second surface, such as the Comments panel, a tree row badge, or the thread re-rendered after a reopen.
- Record which entry point you used. If you could only reach a feature through the palette, do not report its title-bar button as verified.
- A recipe marked *(unverified)* has not been run end to end yet. Run it, fix it, and remove the marker.

## Feature entry contract

Each feature file has an H1, one paragraph, then exactly these H2s in order: `Sub-features`, `How to get to it (user POV)`, `Driving it with hitl.mjs`, `Gotchas`.

## Features

- [Add a review comment](./add-comment.md): open a diff, comment on a line, submit with Cmd+Enter or the button, set severity with a shorthand. **Verified.**
- [Changed files view](./changed-files.md): tree and list toggle, open a diff, mark as viewed, base branch, compare mode. *(unverified)*
- [Comment thread actions](./thread-actions.md): edit, delete, severity and status menus, suggestions, replies. *(unverified)*
- [Feedback workspace and handoff](./feedback-workspace.md): `.feedback/` initialization, Copy Agent Prompt, Approve / Finish Review, reacting to agent edits. *(unverified)*
- [Review Feedback Summary](./feedback-summary.md): the summary tree and its filter. *(unverified; see the empty-view gotcha)*
