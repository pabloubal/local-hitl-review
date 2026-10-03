// End-to-end scenarios against the built binary: the flows in
// .claude/skills/verify-lhr/features/*.md as assertions. Keep recipe and scenario in step.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpDir } from './helper.mjs';
import { BASE, nextSecond, ok, run, session, threads } from './scenario-helper.mjs';

test('anchors: current, moved, outdated, orphaned', () => {
  const { dir, git } = session();
  ok(
    run(dir, ['thread', 'create', 'src/app.ts:2-3', '-'], {
      input: 'Validate.',
    }),
  );
  nextSecond();
  ok(run(dir, ['review', 'submit', '--verdict', 'comment', '--summary', 's']));
  const anchor = () => threads(dir, ['--status', 'all'])[0].anchor;
  const app = join(dir, 'src/app.ts');

  assert.deepEqual([anchor().state, anchor().startLine, anchor().endLine], ['current', 2, 3]);
  writeFileSync(app, `export const a = 1;\n// added\n${BASE.split('\n').slice(1).join('\n')}`);
  assert.deepEqual([anchor().state, anchor().startLine, anchor().endLine], ['current', 3, 4]);
  writeFileSync(app, 'export const a = 1;\n// totally different\nfoo();\n');
  assert.equal(anchor().state, 'outdated');
  assert.match(ok(run(dir, ['thread', 'list'])).stdout, /moved/);
  rmSync(app);
  assert.deepEqual([anchor().state, anchor().method], ['orphaned', 'path']);
  assert.match(ok(run(dir, ['thread', 'list'])).stdout, /orphaned/);

  git('checkout', '-q', '--', 'src/app.ts');
  const old = run(dir, ['thread', 'create', 'src/app.ts:1', '--side', 'old', '--body', 'x']);
  assert.equal(old.status, 2);
  assert.match(old.stderr, /--side old needs --base-commit/);
  const sha = git('rev-parse', 'HEAD').stdout.trim();
  assert.match(
    ok(
      run(dir, [
        'thread',
        'create',
        'src/app.ts:1',
        '--side',
        'old',
        '--base-commit',
        sha,
        '--body',
        'x',
      ]),
    ).stdout,
    /^draft saved/m,
  );
});

test('errors: unknown handle, missing body, path outside the root, no store', () => {
  const { dir } = session();
  const nf = run(dir, ['thread', 'show', 'nope']);
  assert.equal(nf.status, 3);
  assert.match(nf.stderr, /THREAD_NOT_FOUND/);
  assert.equal(run(dir, ['thread', 'create']).status, 2);
  assert.equal(run(dir, ['thread', 'create', '../outside.ts:1', '--body', 'x']).status, 2);
  const bare = tmpDir('lhr-nostore-');
  spawnSync('git', ['init', '-q'], { cwd: bare });
  const ns = run(bare, ['thread', 'list']);
  assert.equal(ns.status, 2);
  assert.match(ns.stderr, /NOT_A_REPO/);
});
