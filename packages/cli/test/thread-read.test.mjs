import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lhr, mkRepo } from './helper.mjs';
import {
  IDS,
  fileThreadMd,
  git,
  messageMd,
  mkReviewedRepo,
  put,
  writeThread,
} from './thread-fixture.mjs';

const dir = mkReviewedRepo();
const run = (args, env = {}) => lhr(args, { cwd: dir, env: { COLUMNS: '80', ...env } });
const json = (args, env) => {
  const r = run([...args, '--json'], env);
  return { ...r, body: r.stdout ? JSON.parse(r.stdout) : undefined };
};
const AGENT = { LHR_SESSION_ID: 's1' };
const cell = (s, n) => s.padEnd(n);
const rule = '─'.repeat(80);

// ---- thread list: human output (piped, uncoloured, 80 columns)

test('thread list: wide table, drafts marked, 5-wide handles for a shared prefix', () => {
  const r = run(['thread', 'list']);
  assert.equal(r.status, 0, r.stderr);
  const row = (id, sev, turn, loc, anchor, msgs) =>
    `${cell(id, 7)}${cell(sev, 10)}${cell(turn, 7)}${cell(loc, 41)}${cell(anchor, 10)}${msgs}`;
  assert.equal(
    r.stdout,
    [
      '5 open threads (status: open; --status all to widen)',
      '',
      row('ID', 'SEV', 'TURN', 'LOCATION', 'ANCHOR', 'MSGS'),
      row('k3m7q', 'high', 'human', 'src/auth/session.ts:6', '', '2'),
      row('k3m7a', 'medium', 'agent', 'src/touch.ts:5', 'moved', '1'),
      row('w7p2', 'low', 'agent', 'src/legacy.ts:2', 'orphaned', '1'),
      row('n5n5', 'critical', 'agent', 'README.md (file)', '', '1'),
      row('d4d4', 'medium', 'draft', 'src/auth/session.ts:3-4', '', '1'),
      '',
      'lhr thread show <id>   (the handle in the ID column is enough)',
      '',
    ].join('\n'),
  );
});

test('thread list: narrow output is two lines per thread', () => {
  const r = run(['thread', 'list', '--whose-turn', 'agent'], { COLUMNS: '60' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(
    r.stdout,
    [
      '4 open threads (status: open, turn: agent; --status all to widen)',
      '',
      'k3m7a  medium  agent  moved',
      '  src/touch.ts:5',
      'w7p2  low  agent  orphaned',
      '  src/legacy.ts:2',
      'n5n5  critical  agent',
      '  README.md (file)',
      'd4d4  medium  draft',
      '  src/auth/session.ts:3-4',
      '',
      'lhr thread show <id>   (the handle in the ID column is enough)',
      '',
    ].join('\n'),
  );
});

test('thread list: a location wider than the terminal is cut with an ellipsis', () => {
  const r = run(['thread', 'list', '--path', 'src/auth'], { COLUMNS: '20' });
  assert.match(r.stdout, /^2 open threads/);
  assert.match(r.stdout, /\n {2}src\/auth\/session\.…\n/);
});

test('thread list: agent mode never lists drafts', () => {
  const r = run(['thread', 'list'], AGENT);
  assert.match(r.stdout, /^4 open threads/);
  assert.doesNotMatch(r.stdout, /draft|d4d4/);
});

test('thread list: --status resolved and all', () => {
  const resolved = run(['thread', 'list', '--status', 'resolved']);
  assert.match(resolved.stdout, /^1 resolved thread \(status: resolved; --status all to widen\)/);
  assert.match(resolved.stdout, /z2z2/);
  const all = run(['thread', 'list', '--status', 'all']);
  assert.match(all.stdout, /^6 threads \(status: all\)/);
});

test('thread list: an empty result prints only the count line', () => {
  const r = run(['thread', 'list', '--path', 'nope']);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '0 open threads (status: open, path: nope; --status all to widen)\n');
});

test('thread list: bad filter values are exit 2', () => {
  const r = run(['thread', 'list', '--status', 'bogus']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--status must be open, resolved or all/);
  assert.equal(run(['thread', 'list', '--whose-turn', 'x']).status, 2);
});

test('thread list: --round filters by round', () => {
  const r = run(['thread', 'list', '--round', '20261002T101400Z-r2r2r2']);
  assert.match(r.stdout, /^1 open thread /);
  assert.match(r.stdout, /k3m7q/);
});

// ---- thread list: JSON

test('thread list --json: thread objects with location, re-anchored anchor, isDraft', () => {
  const r = json(['thread', 'list']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.body.version, 1);
  assert.deepEqual(r.body.diagnostics, []);
  assert.equal(r.body.data.root, dir);
  const t = r.body.data.threads;
  assert.equal(t.length, 5);
  assert.deepEqual(t[0], {
    id: IDS.current,
    shortId: 'k3m7q',
    isDraft: false,
    status: 'open',
    severity: 'high',
    whoseTurn: 'human',
    reviewer: { kind: 'human', name: 'pablo' },
    createdAt: '2026-10-02T10:15:00Z',
    location: 'src/auth/session.ts:6',
    anchor: {
      path: 'src/auth/session.ts',
      kind: 'line',
      side: 'new',
      startLine: 6,
      endLine: 6,
      state: 'current',
      method: 'diff',
    },
    messageCount: 2,
  });
  assert.equal(t[1].anchor.state, 'outdated');
  assert.equal(t[1].anchor.startLine, 5);
  assert.equal(t[2].anchor.state, 'orphaned');
  assert.equal('startLine' in t[2].anchor, false);
  assert.equal(t[2].location, 'src/legacy.ts:2');
  assert.deepEqual(t[3].anchor, {
    path: 'README.md',
    kind: 'file',
    side: 'new',
    state: 'current',
    method: 'path',
  });
  assert.equal(t[3].location, 'README.md (file)');
  assert.equal(t[4].isDraft, true);
  assert.equal(t[4].shortId, 'd4d4');
});

test('thread list --json: agent mode excludes drafts', () => {
  const r = json(['thread', 'list'], AGENT);
  assert.equal(r.body.data.threads.length, 4);
  assert.ok(r.body.data.threads.every((t) => t.isDraft === false));
});

// ---- thread show

test('thread show: current line thread', () => {
  const r = run(['thread', 'show', 'k3m7q']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(
    r.stdout,
    [
      '20261002T101500Z-k3m7qz  open  high  turn: human  reviewer: pablo',
      'src/auth/session.ts:6',
      rule,
      '  working tree',
      '  4 │   if (s.expiresAt < Date.now()) {',
      '  5 │     store.delete(id);',
      '> 6 │     return s;',
      '  7 │   }',
      '  8 │   return s;',
      rule,
      'pablo (human)  2026-10-02 10:15  20261002T101400Z-r2r2r2, severity: high',
      '  This returns the session after deleting it. An expired session should come',
      '  back as null, otherwise callers treat it as live.',
      '',
      'claude-code (agent)  2026-10-02 10:19',
      '  Agreed. Fixed in 3f2a9c1.',
      '',
      'lhr thread reply k3m7q -   |   lhr thread resolve k3m7q',
      '',
    ].join('\n'),
  );
});

test('thread show: outdated thread explains the move', () => {
  const r = run(['thread', 'show', 'k3m7a']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^20261002T102000Z-k3m7ab {2}open {2}medium {2}turn: agent/);
  assert.match(r.stdout, /\n! anchor moved: saved at line 3, now line 5 \(diff\)\.\n/);
  assert.match(r.stdout, /\n> 5 │ {3}s\.expiresAt = Date\.now\(\) \+ TTL_MS;\n/);
});

test('thread show: orphaned thread shows the snapshot', () => {
  const r = run(['thread', 'show', 'w7p2']);
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout.replace(/[0-9a-f]{7}\)/, '<sha>)');
  assert.match(
    out,
    /\n! orphaned: src\/legacy\.ts no longer exists at HEAD\. Showing the lines as they\n! were when the comment was made \(snapshot at <sha>\)\.\n/,
  );
  assert.match(
    out,
    /\n {2}snapshot [0-9a-f]{7}\n {2}1 │ \/\/ TODO remove after v2\n> 2 │ export const LEGACY = true;\n/,
  );
});

test('thread show: a file thread has no snippet and one rule', () => {
  const r = run(['thread', 'show', 'n5n5']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.split(rule).length - 1, 1);
  assert.match(r.stdout, /^20261002T104000Z-n5n5n5 {2}open {2}critical/);
  assert.match(r.stdout, /\nREADME\.md \(file\)\n/);
  assert.doesNotMatch(r.stdout, /│/);
});

test('thread show: a draft thread says draft in place of status', () => {
  const r = run(['thread', 'show', 'd4d4']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^20261002T110000Z-d4d4d4 {2}draft {2}medium/);
  assert.match(r.stdout, /pablo \(human\) {2}2026-10-02 11:00 \[draft\]\n/);
});

test('thread show: agent mode cannot see a draft thread', () => {
  const r = run(['thread', 'show', 'd4d4'], AGENT);
  assert.equal(r.status, 3);
  assert.match(r.stderr, /THREAD_NOT_FOUND/);
});

test('thread show --json: adds snapshot, saved lines and messages', () => {
  const r = json(['thread', 'show', IDS.moved]);
  assert.equal(r.status, 0, r.stderr);
  const t = r.body.data.thread;
  assert.equal(t.id, IDS.moved);
  assert.equal(
    t.snapshot,
    'export function touch(id) {\n  const s = load(id);\n  s.expiresAt = Date.now() + TTL;\n  return s;\n}',
  );
  assert.equal(t.savedStartLine, 3);
  assert.equal(t.savedEndLine, 3);
  assert.equal(t.messageCount, 1);
  assert.deepEqual(t.messages, [
    {
      id: '20261002T102000Z-human-cccccc',
      createdAt: '2026-10-02T10:20:00Z',
      author: { kind: 'human', name: 'pablo' },
      body: 'Non-null assertion is unsafe here.\n',
    },
  ]);
});

test('thread show --json: current anchors carry no saved lines; file threads no snapshot', () => {
  const cur = json(['thread', 'show', 'k3m7q']).body.data.thread;
  assert.equal('savedStartLine' in cur, false);
  assert.equal(cur.messages[0].round, '20261002T101400Z-r2r2r2');
  assert.equal(cur.messages[0].severity, 'high');
  const file = json(['thread', 'show', 'n5n5']).body.data.thread;
  assert.equal('snapshot' in file, false);
});

test('thread show: a missing argument is exit 2; an unknown thread is exit 3', () => {
  assert.equal(run(['thread', 'show']).status, 2);
  const r = run(['thread', 'show', 'zzzz']);
  assert.equal(r.status, 3);
  assert.match(r.stderr, /no thread matches "zzzz" \(THREAD_NOT_FOUND\)/);
  assert.match(r.stderr, /try: lhr thread list --status all/);
});

// ---- handles

test('handles: full id, id prefix and handle all resolve the same thread', () => {
  for (const input of [IDS.current, '20261002T1015', '20261002T101', 'k3m7q', 'k3m7qz']) {
    const r = json(['thread', 'show', input]);
    assert.equal(r.status, 0, `${input}: ${r.stderr}`);
    assert.equal(r.body.data.thread.id, IDS.current);
  }
});

test('handles: an ambiguous handle is exit 2 listing candidates and an example', () => {
  const r = run(['thread', 'show', 'k3m7']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /"k3m7" matches 2 threads/);
  assert.match(r.stderr, new RegExp(IDS.current));
  assert.match(r.stderr, new RegExp(IDS.moved));
  assert.match(r.stderr, /\(INVALID_INPUT\)/);
  assert.match(r.stderr, new RegExp(`try: lhr thread show ${IDS.current}`));
});

test('handles: an ambiguous id prefix is exit 2', () => {
  const r = run(['thread', 'show', '20261002T10']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /matches \d+ threads/);
});

test('handles: length is the shortest unique one, 4 at minimum', () => {
  const all = json(['thread', 'list', '--status', 'all']).body.data.threads;
  const byId = Object.fromEntries(all.map((t) => [t.id, t.shortId]));
  assert.equal(byId[IDS.current], 'k3m7q');
  assert.equal(byId[IDS.moved], 'k3m7a');
  assert.equal(byId[IDS.orphan], 'w7p2');
  assert.equal(byId[IDS.resolved], 'z2z2');
});

test('handles: grow to 6 characters when five are shared, and 6 resolves them', () => {
  const repo = mkRepo();
  put(repo, 'a.txt', 'x\n');
  git(repo, 'add', '-A');
  git(repo, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
  const mk = (id, msg) =>
    writeThread(repo, id, {
      'thread.md': fileThreadMd(repo, 'a.txt'),
      [`${id.slice(0, 16)}-human-aaaaaa.md`]: messageMd({ kind: 'human', name: 'p', body: msg }),
    });
  mk('20261002T101500Z-abcdez', 'one');
  mk('20261002T101600Z-abcdey', 'two');
  mk('20261002T101700Z-qqqqqq', 'three');
  const r = lhr(['thread', 'list', '--json'], { cwd: repo });
  assert.deepEqual(
    JSON.parse(r.stdout).data.threads.map((t) => t.shortId),
    ['abcdez', 'abcdey', 'qqqq'],
  );
  const show = lhr(['thread', 'show', 'abcdey', '--json'], { cwd: repo });
  assert.equal(JSON.parse(show.stdout).data.thread.id, '20261002T101600Z-abcdey');
  const amb = lhr(['thread', 'show', 'abcde'], { cwd: repo });
  assert.equal(amb.status, 2);
  assert.match(amb.stderr, /matches 2 threads/);
});
