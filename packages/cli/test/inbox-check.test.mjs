import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { lhr, mkRepo } from './helper.mjs';

// ---- fixtures: real repos with hand-written thread files

function commit(repo) {
  writeFileSync(join(repo, 'README.md'), '# hi\n');
  const git = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
  git('add', 'README.md');
  git('-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
  return git('rev-parse', 'HEAD').stdout.trim();
}

function addThread(repo, sha, id, messages) {
  const dir = join(repo, '.lhr', 'threads', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'thread.md'),
    `---\nanchor.kind: file\nanchor.path: README.md\nanchor.side: new\nanchor.commit: ${sha}\n---\n`,
  );
  for (const [name, kind, session, body] of messages) {
    const sess = session ? `author.session: ${session}\n` : '';
    const who = kind === 'agent' ? 'bot' : 'Pablo';
    writeFileSync(
      join(dir, `${name}.md`),
      `---\nauthor.kind: ${kind}\nauthor.name: ${who}\n${sess}---\n${body}\n`,
    );
  }
}

const T1 = '20260101T100000Z-aaaaaa';
const T2 = '20260101T110000Z-bbbbbb';
const T3 = '20260101T120000Z-cccccc';
const T4 = '20260101T130000Z-dddddd';
const threadFile = (repo, id, name) => join(repo, '.lhr', 'threads', id, name);

function inboxRepo() {
  const repo = mkRepo();
  const sha = commit(repo);
  // T1: no agent has replied yet
  addThread(repo, sha, T1, [['20260101T100100Z-human-aaaaaa', 'human', '', 'please fix']]);
  // T2: last agent message from session A, then the human answered
  addThread(repo, sha, T2, [
    ['20260101T110100Z-agent-bbbbbb', 'agent', 'A', 'done?'],
    ['20260101T110200Z-human-bbbbbb', 'human', '', 'no, still wrong'],
  ]);
  // T3: same, but session B
  addThread(repo, sha, T3, [
    ['20260101T120100Z-agent-cccccc', 'agent', 'B', 'done?'],
    ['20260101T120200Z-human-cccccc', 'human', '', 'no'],
  ]);
  // T4: the agent replied last: the human's turn
  addThread(repo, sha, T4, [
    ['20260101T130100Z-human-dddddd', 'human', '', 'why?'],
    ['20260101T130200Z-agent-dddddd', 'agent', 'A', 'because'],
  ]);
  return repo;
}

const ids = (r) => JSON.parse(r.stdout).data.threads.map((t) => t.id);

// ---- inbox

test('inbox: human mode has no session filter', () => {
  const repo = inboxRepo();
  const r = lhr(['inbox', '--json'], { cwd: repo });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(ids(r), [T1, T2, T3]);
  const out = JSON.parse(r.stdout);
  assert.equal(out.version, 1);
  assert.equal(out.data.root, repo);
  assert.deepEqual(out.diagnostics, []);
  const t = out.data.threads[0];
  assert.equal(t.shortId, 'aaaa');
  assert.equal(t.whoseTurn, 'agent');
  assert.equal(t.isDraft, false);
  assert.equal(t.location, 'README.md (file)');
  assert.equal(t.anchor.state, 'current');
  assert.equal(t.messageCount, 1);
  assert.equal(t.messages, undefined);
});

test('inbox: agent mode scopes to LHR_SESSION_ID', () => {
  const repo = inboxRepo();
  const r = lhr(['inbox', '--json'], { cwd: repo, env: { LHR_SESSION_ID: 'A' } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(ids(r), [T1, T2]);
});

test('inbox: --all-sessions widens the agent scope', () => {
  const repo = inboxRepo();
  const r = lhr(['inbox', '--all-sessions', '--json'], {
    cwd: repo,
    env: { LHR_SESSION_ID: 'A' },
  });
  assert.deepEqual(ids(r), [T1, T2, T3]);
});

test('inbox: --all-sessions is accepted and ignored in human mode', () => {
  const repo = inboxRepo();
  const r = lhr(['inbox', '--all-sessions', '--json'], { cwd: repo });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(ids(r), [T1, T2, T3]);
});

test('inbox: agent mode without a session sees everything, with no inbox warning', () => {
  const repo = inboxRepo();
  const r = lhr(['inbox', '--as', 'agent', '--json'], { cwd: repo });
  assert.equal(r.status, 0);
  assert.deepEqual(ids(r), [T1, T2, T3]);
  assert.doesNotMatch(r.stderr, /inbox/);
});

test('inbox: text lists one row per thread', () => {
  const repo = inboxRepo();
  const r = lhr(['inbox'], { cwd: repo });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.split('\n')[0], '3 threads in the inbox');
  assert.match(r.stdout, /^aaaa\s+medium\s+agent\s+README\.md \(file\)\s+1$/m);
  assert.match(r.stdout, /^bbbb\s/m);
  assert.doesNotMatch(r.stdout, /dddd/);
  assert.equal(r.stderr, '');
});

test('inbox: empty is exit 0 with a plain line', () => {
  const repo = mkRepo();
  const text = lhr(['inbox'], { cwd: repo });
  assert.equal(text.status, 0);
  assert.equal(text.stdout, '0 threads in the inbox\n');
  const json = lhr(['inbox', '--json'], { cwd: repo });
  assert.deepEqual(JSON.parse(json.stdout).data.threads, []);
});

test('inbox: skipped broken files are reported as diagnostics', () => {
  const repo = inboxRepo();
  writeFileSync(threadFile(repo, T1, '20260101T100200Z-human-zzzzzz.md'), 'no frontmatter\n');
  const json = lhr(['inbox', '--json'], { cwd: repo });
  assert.equal(json.status, 0, json.stderr);
  assert.ok(JSON.parse(json.stdout).diagnostics.length >= 1);
  const text = lhr(['inbox'], { cwd: repo });
  assert.match(text.stderr, /\d+ problems? skipped; run lhr check/);
});

test('inbox: outside a review root is exit 2', () => {
  const r = lhr(['inbox'], { cwd: mkRepo({ lhr: false }) });
  assert.equal(r.status, 2);
});

// ---- check

test('check: clean tree is exit 0 with a zero summary', () => {
  const repo = inboxRepo();
  const text = lhr(['check'], { cwd: repo });
  assert.equal(text.status, 0, text.stdout + text.stderr);
  assert.equal(text.stdout, '0 errors, 0 warnings\n');
  const json = lhr(['check', '--json'], { cwd: repo });
  assert.equal(json.status, 0);
  const out = JSON.parse(json.stdout);
  assert.deepEqual(out.data, { root: repo, errors: 0, warnings: 0 });
  assert.deepEqual(out.diagnostics, []);
});

test('check: a warning keeps exit 0', () => {
  const repo = inboxRepo();
  const name = '20260101T100100Z-human-aaaaaa.md';
  writeFileSync(
    threadFile(repo, T1, name),
    '---\nauthor.kind: human\nauthor.name: Pablo\nmood: grumpy\n---\nplease fix\n',
  );
  const text = lhr(['check'], { cwd: repo });
  assert.equal(text.status, 0, text.stdout + text.stderr);
  const lines = text.stdout.trimEnd().split('\n');
  assert.equal(lines[0], `warning UNKNOWN_KEY .lhr/threads/${T1}/${name} unknown key "mood"`);
  assert.equal(lines[1], '0 errors, 1 warning');
  const out = JSON.parse(lhr(['check', '--json'], { cwd: repo }).stdout);
  assert.equal(out.data.warnings, 1);
  assert.equal(out.diagnostics[0].code, 'UNKNOWN_KEY');
});

test('check: an error is exit 1 and still prints everything', () => {
  const repo = inboxRepo();
  writeFileSync(
    threadFile(repo, T1, '20260101T100100Z-human-aaaaaa.md'),
    '---\nauthor.kind: human\nauthor.name: Pablo\nround: 20260101T000000Z-qqqqqq\n---\nx\n',
  );
  const text = lhr(['check'], { cwd: repo });
  assert.equal(text.status, 1);
  assert.match(
    text.stdout,
    /^error UNKNOWN_ROUND \S+ round "20260101T000000Z-qqqqqq" does not exist$/m,
  );
  assert.match(text.stdout, /\n1 error, 0 warnings\n$/);
  assert.equal(text.stderr, '');
  const json = lhr(['check', '--json'], { cwd: repo });
  assert.equal(json.status, 1);
  const out = JSON.parse(json.stdout);
  assert.equal(out.data.errors, 1);
  assert.equal(out.diagnostics[0].severity, 'error');
});

test('check: a broken file is a diagnostic, not a crash', () => {
  const repo = inboxRepo();
  writeFileSync(threadFile(repo, T1, '20260101T100200Z-human-zzzzzz.md'), 'no frontmatter\n');
  const r = lhr(['check'], { cwd: repo });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /^error \w+ \.lhr\/threads\/\S+zzzzzz\.md/m);
  assert.equal(r.stderr, '');
});

test('check: a missing format file is reported with exit 1', () => {
  const repo = mkRepo({ lhr: false });
  mkdirSync(join(repo, '.lhr'));
  const r = lhr(['check', '--json'], { cwd: repo });
  assert.equal(r.status, 1, r.stderr);
  assert.equal(JSON.parse(r.stdout).diagnostics[0].code, 'FORMAT_MISSING');
});

test('check: outside a review root is exit 2', () => {
  const r = lhr(['check'], { cwd: mkRepo({ lhr: false }) });
  assert.equal(r.status, 2);
});
