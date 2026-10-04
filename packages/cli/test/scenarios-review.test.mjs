// End-to-end scenarios against the built binary: the flows in
// .claude/skills/verify-lhr/features/*.md as assertions. Keep recipe and scenario in step.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT, handle, nextSecond, ok, run, session, threads } from './scenario-helper.mjs';

test('init-and-check: init is idempotent and check is clean', () => {
  const { dir } = session();
  assert.match(ok(run(dir, ['init'])).stdout, /already exists.*nothing to do/);
  assert.match(ok(run(dir, ['check'])).stdout, /0 errors, 0 warnings/);
  const dry = ok(run(dir, ['init', '--dry-run']));
  assert.match(dry.stdout, /\.lhr\/ already exists|would create/);
});

test('init-and-check: check fails on a corrupt thread file', () => {
  const { dir } = session();
  const T = handle(ok(run(dir, ['thread', 'create', 'src/app.ts:2', '--body', 'x'])));
  nextSecond();
  ok(run(dir, ['review', 'submit', '--verdict', 'comment', '--summary', 's']));
  const id = threads(dir)[0].id;
  assert.ok(T);
  writeFileSync(join(dir, '.lhr/threads', id, 'thread.md'), 'garbage\n');
  const r = run(dir, ['check']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /error FRONTMATTER_SYNTAX .*thread\.md:1/);
  assert.match(r.stdout, /1 error, 0 warnings/);
});

test('human-review: drafts are private until review submit', () => {
  const { dir } = session();
  const T = handle(
    ok(
      run(dir, ['thread', 'create', 'src/app.ts:2', '--severity', 'high', '-'], {
        input: 'Validate both inputs.',
      }),
    ),
  );
  assert.match(ok(run(dir, ['thread', 'list'])).stdout, new RegExp(`${T}\\s+high\\s+draft`));
  assert.match(ok(run(dir, ['inbox'], { env: AGENT })).stdout, /0 threads in the inbox/);
  assert.equal(run(dir, ['thread', 'show', T], { env: AGENT }).status, 3);

  nextSecond();
  ok(run(dir, ['review', 'submit', '--verdict', 'request-changes', '--summary', 'fix']));
  const inbox = JSON.parse(ok(run(dir, ['inbox', '--json'], { env: AGENT })).stdout).data.threads;
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].whoseTurn, 'agent');
  assert.equal(inbox[0].isDraft, false);
  assert.equal(inbox[0].severity, 'high');
  assert.deepEqual(inbox[0].reviewer, { kind: 'human', name: 'Test Human' });
  assert.match(ok(run(dir, ['thread', 'show', T])).stdout, /> 2 │ export function add/);
});

test('human-review: submit is idempotent with --client-id, create rejects it, agents cannot submit', () => {
  const { dir } = session();
  ok(run(dir, ['thread', 'create', 'README.md', '--body', 'file level']));
  nextSecond();
  const first = ok(
    run(dir, ['review', 'submit', '--verdict', 'comment', '--summary', 's', '--client-id', 'sub1']),
  );
  assert.match(first.stdout, /^submitted round/);
  nextSecond();
  const again = ok(
    run(dir, ['review', 'submit', '--verdict', 'comment', '--summary', 's', '--client-id', 'sub1']),
  );
  assert.match(again.stdout, /^round already submitted/);
  assert.equal(threads(dir, ['--status', 'all'])[0].anchor.kind, 'file');

  const bad = run(dir, ['thread', 'create', 'README.md', '--body', 'x', '--client-id', 'c1']);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /INVALID_INPUT/);
  const agent = run(dir, ['review', 'submit', '--verdict', 'approve'], {
    env: AGENT,
  });
  assert.equal(agent.status, 2);
  assert.match(agent.stderr, /agent mode cannot submit/);
});

test('human-review: --dry-run writes nothing', () => {
  const { dir } = session();
  const files = () => run(dir, ['check', '--json']).stdout;
  const before = files();
  assert.match(
    ok(run(dir, ['thread', 'create', 'src/app.ts:1', '--body', 'x', '--dry-run'])).stdout,
    /^dry run: would save a draft/,
  );
  assert.equal(files(), before);
  assert.equal(threads(dir).length, 0);
});
