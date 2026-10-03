import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { lhr, mkRepo } from './helper.mjs';

const AGENT = { LHR_SESSION_ID: 's1', LHR_AGENT_NAME: 'bot' };

function repoWithFile() {
  const dir = mkRepo();
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'a.ts'), 'one\ntwo\nthree\nfour\n');
  const git = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  return dir;
}

const run = (args, dir, opts = {}) => {
  const r = lhr([...args, '--json'], { cwd: dir, ...opts });
  return { ...r, json: r.stdout ? JSON.parse(r.stdout) : undefined };
};
const agent = (args, dir, opts = {}) => run(args, dir, { ...opts, env: { ...AGENT, ...opts.env } });

const ls = (p) => {
  try {
    return readdirSync(p);
  } catch {
    return [];
  }
};
const count = (dir) => ls(join(dir, '.lhr', 'threads')).length;
const draftCount = (dir) =>
  ls(join(dir, '.lhr', 'drafts')).filter((n) => !n.startsWith('.')).length;

function createAgentThread(dir) {
  const r = agent(['thread', 'create', 'src/a.ts:2', '--body', 'first'], dir);
  assert.equal(r.status, 0, r.stderr);
  return r.json.data.thread.id;
}

// ---- create

test('create (agent): writes immediately, returns thread and message ids', () => {
  const dir = repoWithFile();
  const r = agent(
    ['thread', 'create', 'src/a.ts:2-3', '--body', 'hello', '--severity', 'high'],
    dir,
  );
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.data.root, dir);
  assert.equal(r.json.data.created, true);
  assert.ok(r.json.data.thread.id);
  assert.ok(r.json.data.message.id);
  assert.equal(count(dir), 1);
  const file = agent(['thread', 'create', 'src/a.ts', '--body', 'file level'], dir);
  assert.equal(file.status, 0, file.stderr);
});

test('create (agent): body from stdin with -', () => {
  const dir = repoWithFile();
  const r = agent(['thread', 'create', 'src/a.ts:1', '-'], dir, { input: 'multi\nline\n' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(count(dir), 1);
});

test('create (agent): --client-id retry returns the existing thread, created:false', () => {
  const dir = repoWithFile();
  const a = agent(['thread', 'create', 'src/a.ts', '--body', 'x', '--client-id', 'k1'], dir);
  const b = agent(['thread', 'create', 'src/a.ts', '--body', 'x', '--client-id', 'k1'], dir);
  assert.equal(b.status, 0, b.stderr);
  assert.equal(b.json.data.created, false);
  assert.equal(b.json.data.thread.id, a.json.data.thread.id);
  assert.equal(count(dir), 1);
});

test('create (human): saves a draft and says to run review submit; --client-id is exit 2', () => {
  const dir = repoWithFile();
  const r = run(['thread', 'create', 'src/a.ts:2', '--body', 'mine'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.data.draft, true);
  assert.equal(count(dir), 0);
  assert.ok(draftCount(dir) > 0);
  const text = lhr(['thread', 'create', 'src/a.ts:3', '--body', 'again'], { cwd: dir });
  assert.match(text.stdout, /draft saved; run lhr review submit to send it/);
  const bad = run(['thread', 'create', 'src/a.ts:2', '--body', 'm', '--client-id', 'k'], dir);
  assert.equal(bad.status, 2);
  assert.equal(bad.json.error.code, 'INVALID_INPUT');
});

test('create: cwd-relative path becomes root-relative; outside root is exit 2', () => {
  const dir = repoWithFile();
  const r = agent(['thread', 'create', 'a.ts:2', '--body', 'x'], join(dir, 'src'));
  assert.equal(r.status, 0, r.stderr);
  const out = agent(['thread', 'create', '../../etc/passwd', '--body', 'x'], join(dir, 'src'));
  assert.equal(out.status, 2);
  assert.equal(out.json.error.code, 'INVALID_INPUT');
});

test('create: missing body and bad anchors are exit 2', () => {
  const dir = repoWithFile();
  assert.equal(agent(['thread', 'create', 'src/a.ts:2'], dir).status, 2);
  assert.equal(agent(['thread', 'create', 'src/a.ts:0', '--body', 'x'], dir).status, 2);
  assert.equal(agent(['thread', 'create', 'src/a.ts:5-3', '--body', 'x'], dir).status, 2);
  const both = agent(['thread', 'create', 'src/a.ts', '--body', 'x', '-'], dir, { input: 'y' });
  assert.equal(both.status, 2);
  assert.equal(count(dir), 0);
});

test('create: --dry-run writes nothing, dryRun:true, no ids', () => {
  const dir = repoWithFile();
  for (const go of [agent, run]) {
    const r = go(['thread', 'create', 'src/a.ts:2', '--body', 'x', '--dry-run'], dir);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.data.dryRun, true);
    assert.equal(r.json.data.thread, undefined);
  }
  assert.equal(count(dir), 0);
  assert.equal(draftCount(dir), 0);
});

// ---- reply

test('reply (agent): immediate, unique prefix works, --client-id is idempotent', () => {
  const dir = repoWithFile();
  const id = createAgentThread(dir);
  const a = agent(['thread', 'reply', id.slice(0, 12), '--body', 'r', '--client-id', 'c1'], dir);
  assert.equal(a.status, 0, a.stderr);
  assert.equal(a.json.data.thread.id, id);
  assert.equal(a.json.data.created, true);
  const b = agent(['thread', 'reply', id, '--body', 'r', '--client-id', 'c1'], dir);
  assert.equal(b.json.data.created, false);
  assert.equal(b.json.data.message.id, a.json.data.message.id);
});

test('reply (human): draft; --client-id exit 2', () => {
  const dir = repoWithFile();
  const id = createAgentThread(dir);
  const r = run(['thread', 'reply', id, '-'], dir, { input: 'hi\n' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.data.draft, true);
  assert.ok(r.json.data.message.id);
  assert.equal(run(['thread', 'reply', id, '--body', 'x', '--client-id', 'k'], dir).status, 2);
});

test('reply: unknown and ambiguous ids, missing body', () => {
  const dir = repoWithFile();
  const id = createAgentThread(dir);
  const nf = agent(['thread', 'reply', 'zzzz', '--body', 'x'], dir);
  assert.equal(nf.status, 3);
  assert.equal(nf.json.error.code, 'THREAD_NOT_FOUND');
  assert.equal(agent(['thread', 'reply'], dir).status, 2);
  assert.equal(agent(['thread', 'reply', id], dir).status, 2);
});

test('reply: --dry-run writes nothing', () => {
  const dir = repoWithFile();
  const id = createAgentThread(dir);
  const r = agent(['thread', 'reply', id, '--body', 'x', '--dry-run'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.data.dryRun, true);
  assert.equal(r.json.data.message, undefined);
  assert.equal(ls(join(dir, '.lhr', 'threads', id)).length, 2); // thread.md + opening
});

// ---- resolve / reopen

test('resolve/reopen without body: immediate in both modes; no-op is changed:false', () => {
  const dir = repoWithFile();
  const id = createAgentThread(dir);
  const a = run(['thread', 'resolve', id], dir);
  assert.equal(a.status, 0, a.stderr);
  assert.equal(a.json.data.changed, true);
  assert.equal(a.json.data.created, true);
  assert.ok(a.json.data.message.id);
  const b = agent(['thread', 'resolve', id], dir);
  assert.equal(b.status, 0);
  assert.equal(b.json.data.changed, false);
  assert.equal(b.json.data.created, false);
  assert.equal(b.json.data.message, undefined);
  const c = agent(['thread', 'reopen', id], dir);
  assert.equal(c.json.data.changed, true);
  assert.equal(draftCount(dir), 0);
});

test('resolve with body: agent writes immediately, human writes a draft', () => {
  const dir = repoWithFile();
  const id = createAgentThread(dir);
  const h = run(['thread', 'resolve', id, '--body', 'done'], dir);
  assert.equal(h.status, 0, h.stderr);
  assert.equal(h.json.data.draft, true);
  assert.equal(h.json.data.changed, undefined);
  const a = agent(['thread', 'resolve', id, '-'], dir, { input: 'done\n' });
  assert.equal(a.status, 0, a.stderr);
  assert.equal(a.json.data.created, true);
  const re = agent(['thread', 'reopen', id, '--body', 'nope'], dir);
  assert.equal(re.json.data.created, true);
});

test('resolve: --client-id is not offered; --dry-run writes nothing', () => {
  const dir = repoWithFile();
  const id = createAgentThread(dir);
  assert.equal(agent(['thread', 'resolve', id, '--client-id', 'k'], dir).status, 2);
  const d = agent(['thread', 'resolve', id, '--dry-run'], dir);
  assert.equal(d.status, 0, d.stderr);
  assert.equal(d.json.data.dryRun, true);
  assert.equal(d.json.data.changed, true);
  const after = agent(['thread', 'resolve', id], dir);
  assert.equal(after.json.data.changed, true); // the dry run left it open
});
