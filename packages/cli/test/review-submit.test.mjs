import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build as esbuild } from 'esbuild';
import { lhr, mkRepo, tmpDir } from './helper.mjs';

// Drafts are created through the core library (the write commands are separate work).
let core;
before(async () => {
  const outfile = join(tmpDir('lhr-core-'), 'core.mjs');
  await esbuild({
    entryPoints: [fileURLToPath(new URL('../../core/src/index.ts', import.meta.url))],
    bundle: true,
    outfile,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
  });
  core = await import(pathToFileURL(outfile).href);
});

async function repoWithDrafts() {
  const repo = mkRepo();
  writeFileSync(join(repo, 'a.ts'), 'one\ntwo\nthree\n');
  spawnSync('git', ['add', '.'], { cwd: repo });
  spawnSync('git', ['commit', '-qm', 'init'], { cwd: repo });
  const tree = await core.openTree({ root: repo });
  const author = await tree.humanAuthor();
  const t = await tree.createDraftThread({
    anchor: { path: 'a.ts', kind: 'line', startLine: 1 },
    body: 'first',
    author,
  });
  await tree.dispose();
  return { repo, threadId: t.threadId, messageId: t.messageId };
}

const roundFiles = (repo) => {
  const d = join(repo, '.lhr', 'rounds');
  return existsSync(d) ? readdirSync(d).filter((n) => n.endsWith('.md')) : [];
};
const json = (r) => JSON.parse(r.stdout);

test('submit with drafts writes one round and promotes the drafts', async () => {
  const { repo, threadId, messageId } = await repoWithDrafts();
  const r = lhr(
    ['review', 'submit', '--verdict', 'request-changes', '--body', 'fix it', '--json'],
    {
      cwd: repo,
    },
  );
  assert.equal(r.status, 0, r.stderr);
  const d = json(r).data;
  assert.equal(d.created, true);
  assert.deepEqual(d.threadIds, [threadId]);
  assert.deepEqual(d.messageIds, [messageId]);
  assert.equal(d.verdict, 'request-changes');
  assert.equal(roundFiles(repo).length, 1);
  assert.equal(`${d.roundId}.md`, roundFiles(repo)[0]);
});

test('submit text output names the round and counts', async () => {
  const { repo } = await repoWithDrafts();
  const r = lhr(['review', 'submit', '--verdict', 'comment'], { cwd: repo });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /submitted round \S+ \(comment\): 1 thread, 1 message/);
});

test('summary comes from stdin with -', async () => {
  const { repo } = await repoWithDrafts();
  const r = lhr(['review', 'submit', '--verdict', 'approve', '-', '--json'], {
    cwd: repo,
    input: 'looks good\n',
  });
  assert.equal(r.status, 0, r.stderr);
  const file = join(repo, '.lhr', 'rounds', roundFiles(repo)[0]);
  assert.match(readFileSync(file, 'utf8'), /looks good/);
});

test('- together with --body is a usage error', () => {
  const repo = mkRepo();
  const r = lhr(['review', 'submit', '--verdict', 'approve', '-', '--body', 'x'], {
    cwd: repo,
    input: 'y',
  });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /INVALID_INPUT/);
  assert.equal(roundFiles(repo).length, 0);
});

test('zero drafts is a valid bare verdict', () => {
  const repo = mkRepo();
  const r = lhr(['review', 'submit', '--verdict', 'approve', '--json'], { cwd: repo });
  assert.equal(r.status, 0, r.stderr);
  const d = json(r).data;
  assert.equal(d.created, true);
  assert.deepEqual(d.threadIds, []);
  assert.deepEqual(d.messageIds, []);
  assert.equal(roundFiles(repo).length, 1);
});

test('missing or bad --verdict is a usage error', () => {
  const repo = mkRepo();
  const missing = lhr(['review', 'submit'], { cwd: repo });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /--verdict/);
  const bad = lhr(['review', 'submit', '--verdict', 'nope'], { cwd: repo });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /INVALID_INPUT/);
  assert.equal(roundFiles(repo).length, 0);
});

test('retry with the same --client-id returns created:false and writes no second round', async () => {
  const { repo } = await repoWithDrafts();
  const args = ['review', 'submit', '--verdict', 'approve', '--client-id', 'pr-1', '--json'];
  const first = json(lhr(args, { cwd: repo })).data;
  const second = lhr(args, { cwd: repo });
  assert.equal(second.status, 0, second.stderr);
  const d = json(second).data;
  assert.equal(first.created, true);
  assert.equal(d.created, false);
  assert.equal(d.roundId, first.roundId);
  assert.equal(roundFiles(repo).length, 1);
});

test('without --client-id a retry writes a second round', () => {
  const repo = mkRepo();
  const args = ['review', 'submit', '--verdict', 'approve'];
  lhr(args, { cwd: repo });
  lhr(args, { cwd: repo });
  assert.equal(roundFiles(repo).length, 2);
});

test('--dry-run lists drafts and verdict and writes nothing', async () => {
  const { repo, threadId, messageId } = await repoWithDrafts();
  const r = lhr(['review', 'submit', '--verdict', 'approve', '--dry-run', '--json'], {
    cwd: repo,
  });
  assert.equal(r.status, 0, r.stderr);
  const d = json(r).data;
  assert.equal(d.dryRun, true);
  assert.equal(d.verdict, 'approve');
  assert.deepEqual(d.threadIds, [threadId]);
  assert.deepEqual(d.messageIds, [messageId]);
  assert.equal(roundFiles(repo).length, 0);
  assert.equal(existsSync(join(repo, '.lhr', 'drafts', '.submitting')), false);
  const text = lhr(['review', 'submit', '--verdict', 'approve', '--dry-run'], { cwd: repo });
  assert.match(text.stdout, /would submit/);
  assert.match(text.stdout, new RegExp(messageId));
});

test('agent mode is refused with exit 2 and the --as human command', async () => {
  const { repo } = await repoWithDrafts();
  const r = lhr(['review', 'submit', '--verdict', 'approve'], {
    cwd: repo,
    env: { LHR_SESSION_ID: 's1' },
  });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /INVALID_INPUT/);
  assert.match(r.stderr, /try: lhr review submit --verdict approve --as human/);
  assert.equal(roundFiles(repo).length, 0);
  const j = lhr(['review', 'submit', '--verdict', 'approve', '--as', 'agent', '--json'], {
    cwd: repo,
  });
  assert.equal(JSON.parse(j.stdout).error.code, 'INVALID_INPUT');
});

test('--as human bypasses the refusal inside an agent shell', () => {
  const repo = mkRepo();
  const r = lhr(['review', 'submit', '--verdict', 'approve', '--as', 'human'], {
    cwd: repo,
    env: { LHR_SESSION_ID: 's1' },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(roundFiles(repo).length, 1);
});
