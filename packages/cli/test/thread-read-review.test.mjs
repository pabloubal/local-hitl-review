// Review follow-ups for thread list/show: candidate cap and cwd-relative --path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lhr, mkRepo } from './helper.mjs';
import {
  fileThreadMd,
  git,
  messageMd,
  mkReviewedRepo,
  put,
  writeThread,
} from './thread-fixture.mjs';

test('handles: an ambiguous prefix lists at most 10 candidates, then "and N more"', () => {
  const repo = mkRepo();
  put(repo, 'a.txt', 'x\n');
  git(repo, 'add', '-A');
  git(repo, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
  for (let i = 0; i < 14; i++) {
    const id = `20261002T10${String(i).padStart(2, '0')}00Z-aaaa${'bcdefghjkmnpqr'[i]}${'a'}`;
    writeThread(repo, id, {
      'thread.md': fileThreadMd(repo, 'a.txt'),
      [`${id.slice(0, 16)}-human-aaaaaa.md`]: messageMd({ kind: 'human', name: 'p', body: 'x' }),
    });
  }
  const r = lhr(['thread', 'show', '2026'], { cwd: repo });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /"2026" matches 14 threads: /);
  assert.equal(r.stderr.match(/\d{8}T\d{6}Z-[a-z2-7]{6}/g).length, 10 + 1); // 10 listed + example
  assert.match(r.stderr, /and 4 more/);
  assert.match(r.stderr, /\(INVALID_INPUT\)/);
  assert.match(r.stderr, /try: lhr thread show \d{8}T/);
});

const dir = mkReviewedRepo();
const paths = (r) => JSON.parse(r.stdout).data.threads.map((t) => t.anchor.path);

test('thread list --path: resolved against the cwd, so `cd src && --path auth` works', () => {
  const sub = lhr(['thread', 'list', '--path', 'auth', '--json'], { cwd: `${dir}/src` });
  assert.equal(sub.status, 0, sub.stderr);
  assert.deepEqual(paths(sub), ['src/auth/session.ts', 'src/auth/session.ts']);
  const dot = lhr(['thread', 'list', '--path', '.', '--json'], { cwd: `${dir}/src/auth` });
  assert.deepEqual(paths(dot), ['src/auth/session.ts', 'src/auth/session.ts']);
  const up = lhr(['thread', 'list', '--path', '../touch.ts', '--json'], { cwd: `${dir}/src/auth` });
  assert.equal(up.status, 0, up.stderr);
  assert.deepEqual(paths(up), ['src/touch.ts']);
});

test('thread list --path: outside the review root is a usage error', () => {
  const r = lhr(['thread', 'list', '--path', '../../..'], { cwd: `${dir}/src/auth` });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /\(INVALID_INPUT\)/);
  assert.match(r.stderr, /outside the review root/);
});
