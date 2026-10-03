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

// Message IDs have one-second resolution and same-second messages of one kind sort by a random
// suffix, so tests that depend on the order of two same-kind writes wait a second between them.
const tick = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1100);

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
    assert.equal(r.json.data.thread.id, undefined);
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

test('reply: unknown id and missing body', () => {
  const dir = repoWithFile();
  const id = createAgentThread(dir);
  const nf = agent(['thread', 'reply', 'zzzz', '--body', 'x'], dir);
  assert.equal(nf.status, 3);
  assert.equal(nf.json.error.code, 'THREAD_NOT_FOUND');
  assert.equal(agent(['thread', 'reply'], dir).status, 2);
  assert.equal(agent(['thread', 'reply', id], dir).status, 2);
});

test('reply: an ambiguous prefix is exit 2 and lists the candidates', () => {
  const dir = repoWithFile();
  const a = createAgentThread(dir);
  const b = createAgentThread(dir);
  const common = a.slice(0, 4); // the year: shared by both
  const r = agent(['thread', 'reply', common, '--body', 'x'], dir);
  assert.equal(r.status, 2);
  assert.equal(r.json.error.code, 'INVALID_INPUT');
  assert.match(r.json.error.message, new RegExp(`matches 2 threads: .*${a}`));
  assert.ok(r.json.error.message.includes(b));
});

test('reply: a handle from thread create resolves', () => {
  const dir = repoWithFile();
  const made = agent(['thread', 'create', 'src/a.ts:2', '--body', 'first'], dir);
  const { id } = made.json.data.thread;
  const shortId = id.slice(-6, -2); // 4-char handle; unique with one thread
  const r = agent(['thread', 'reply', shortId, '--body', 'via handle'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.data.thread.id, id);
  const rs = agent(['thread', 'resolve', shortId], dir);
  assert.equal(rs.status, 0, rs.stderr);
  assert.equal(rs.json.data.thread.id, id);
});

test('reply: drafts are visible to human mode only', () => {
  const dir = repoWithFile();
  const d = run(['thread', 'create', 'src/a.ts:2', '--body', 'draft'], dir);
  const { id } = d.json.data.thread;
  const shortId = id.slice(-6, -2);
  const human = run(['thread', 'reply', shortId, '--body', 'more'], dir);
  assert.equal(human.status, 0, human.stderr);
  assert.equal(human.json.data.thread.id, id);
  const bot = agent(['thread', 'reply', id, '--body', 'x'], dir);
  assert.equal(bot.status, 3);
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

test('resolve/reopen accept an empty --body as no body; create and reply still reject it', () => {
  const dir = repoWithFile();
  const id = createAgentThread(dir);
  const a = run(['thread', 'resolve', id, '--body', ''], dir);
  assert.equal(a.status, 0, a.stderr);
  assert.equal(a.json.data.changed, true);
  assert.equal(a.json.data.draft, undefined);
  const again = agent(['thread', 'resolve', id, '--body', '  '], dir);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.json.data.changed, false);
  const re = agent(['thread', 'reopen', id, '--body', ''], dir);
  assert.equal(re.status, 0, re.stderr);
  assert.equal(re.json.data.changed, true);
  assert.equal(agent(['thread', 'reply', id, '--body', ''], dir).status, 2);
  assert.equal(agent(['thread', 'create', 'src/a.ts:2', '--body', ''], dir).status, 2);
});

// ---- output shape

test('create/reply/resolve: data.thread is the full Thread object; text prints handles', () => {
  const dir = repoWithFile();
  const c = agent(['thread', 'create', 'src/a.ts:2', '--body', 'first', '--severity', 'high'], dir);
  const t = c.json.data.thread;
  assert.match(t.id, /^\d{8}T\d{6}Z-[a-z2-7]{6}$/);
  assert.equal(t.shortId, t.id.slice(-6, -2));
  assert.equal(t.isDraft, false);
  assert.equal(t.status, 'open');
  assert.equal(t.severity, 'high');
  assert.equal(t.whoseTurn, 'human');
  assert.equal(t.location, 'src/a.ts:2');
  assert.equal(t.anchor.state, 'current');
  assert.equal(t.messageCount, 1);
  tick();
  const r = agent(['thread', 'reply', t.shortId, '--body', 'two'], dir);
  assert.equal(r.json.data.thread.messageCount, 2);
  tick();
  assert.equal(r.json.data.thread.id, t.id);
  const rs = agent(['thread', 'resolve', t.shortId], dir);
  assert.equal(rs.json.data.thread.status, 'resolved');
  tick();
  const text = lhr(['thread', 'reply', t.shortId, '--body', 'three'], {
    cwd: dir,
    env: AGENT,
  }).stdout;
  assert.ok(text.includes(t.shortId));
  assert.ok(!text.includes(t.id), text);
  const d = run(['thread', 'create', 'src/a.ts:3', '--body', 'mine'], dir);
  assert.equal(d.json.data.thread.isDraft, true);
  assert.ok(d.json.data.thread.shortId);
});

test('create from a subdirectory reports the root-relative location', () => {
  const dir = repoWithFile();
  const r = agent(['thread', 'create', 'a.ts:2', '--body', 'x'], join(dir, 'src'));
  assert.equal(r.json.data.thread.location, 'src/a.ts:2');
});

// ---- changed rule

test('resolve/reopen with a body: changed reflects the status, created the message', () => {
  const dir = repoWithFile();
  const id = createAgentThread(dir);
  tick();
  const a = agent(['thread', 'resolve', id, '--body', 'done'], dir);
  assert.equal(a.json.data.created, true);
  assert.equal(a.json.data.changed, true);
  tick();
  const b = agent(['thread', 'resolve', id, '--body', 'done again'], dir);
  assert.equal(b.json.data.created, true);
  assert.equal(b.json.data.changed, false);
  assert.ok(b.json.data.message.id);
  tick();
  const c = agent(['thread', 'reopen', id, '--body', 'no'], dir);
  assert.equal(c.json.data.changed, true);
});

// ---- dry-run shape

test('create --dry-run: thread shape without ids; existing --client-id reports created:false', () => {
  const dir = repoWithFile();
  const r = agent(['thread', 'create', 'src/a.ts:2-3', '--body', 'x', '--dry-run'], dir);
  const t = r.json.data.thread;
  assert.equal(r.json.data.created, true);
  assert.equal(t.id, undefined);
  assert.equal(t.shortId, undefined);
  assert.equal(r.json.data.message, undefined);
  assert.equal(t.status, 'open');
  assert.equal(t.whoseTurn, 'human');
  assert.equal(t.location, 'src/a.ts:2-3');
  assert.equal(t.isDraft, false);
  assert.equal(t.messageCount, 1);
  const hd = run(['thread', 'create', 'src/a.ts:2', '--body', 'x', '--dry-run'], dir);
  assert.equal(hd.json.data.thread.isDraft, true);
  const made = agent(['thread', 'create', 'src/a.ts', '--body', 'x', '--client-id', 'k9'], dir);
  const again = agent(
    ['thread', 'create', 'src/a.ts', '--body', 'x', '--client-id', 'k9', '--dry-run'],
    dir,
  );
  assert.equal(again.json.data.created, false);
  assert.equal(again.json.data.dryRun, true);
  assert.equal(again.json.data.thread.id, made.json.data.thread.id);
  assert.equal(count(dir), 1);
});

test('human mode: --client-id rejection explains why', () => {
  const dir = repoWithFile();
  const r = run(['thread', 'create', 'src/a.ts:2', '--body', 'm', '--client-id', 'k'], dir);
  assert.equal(r.status, 2);
  assert.match(r.json.error.message, /--client-id applies to immediate agent writes/);
  assert.match(r.json.error.message, /drafts, which have no idempotency key/);
});

test('--help for thread create states the dry-run limits', () => {
  const r = lhr(['thread', 'create', '--help']);
  assert.match(r.stdout, /dry run validates input and thread existence, not anchors/i);
});
