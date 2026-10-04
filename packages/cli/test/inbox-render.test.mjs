import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lhr } from './helper.mjs';
import { IDS, lineThreadMd, messageMd, mkReviewedRepo, writeThread } from './thread-fixture.mjs';

// The inbox shares `thread list`'s layouts and thread object (cli.md: same output as thread list).
const dir = mkReviewedRepo();
const OLD = '20261002T111000Z-o2d2d2';
writeThread(dir, OLD, {
  'thread.md': lineThreadMd(dir, 'src/touch.ts', 2, 2).replace(
    'anchor.side: new',
    'anchor.side: old',
  ),
  '20261002T111000Z-human-iiiiii.md': messageMd({
    kind: 'human',
    name: 'pablo',
    body: 'Old side.',
  }),
});
const DRAFT_TWIN = '20261002T120000Z-w7p2xx';
writeThread(
  dir,
  DRAFT_TWIN,
  {
    'thread.md': lineThreadMd(dir, 'src/auth/session.ts', 3, 4),
    '20261002T120000Z-human-jjjjjj.md': messageMd({ kind: 'human', name: 'pablo', body: 'wip' }),
  },
  { draft: true },
);

const run = (args, env = {}) => lhr(args, { cwd: dir, env: { COLUMNS: '80', ...env } });
const threads = (args, env) => JSON.parse(run([...args, '--json'], env).stdout).data.threads;

test('inbox --json matches thread list --json for the same threads', () => {
  const inbox = threads(['inbox']);
  const list = threads(['thread', 'list', '--whose-turn', 'agent']);
  for (const t of inbox)
    assert.deepEqual(
      t,
      list.find((l) => l.id === t.id),
    );
  assert.deepEqual(inbox.map((t) => t.id).sort(), [IDS.moved, IDS.orphan, IDS.file, OLD].sort());
});

test('inbox --json: createdAt has no milliseconds', () => {
  const t = threads(['inbox']).find((x) => x.id === IDS.moved);
  assert.equal(t.createdAt, '2026-10-02T10:20:00Z');
});

test('inbox --json: orphaned thread keeps the saved line, old side gets a suffix', () => {
  const all = threads(['inbox']);
  assert.equal(all.find((x) => x.id === IDS.orphan).location, 'src/legacy.ts:2');
  assert.equal(all.find((x) => x.id === OLD).location, 'src/touch.ts:2 (old)');
  assert.equal(all.find((x) => x.id === IDS.file).location, 'README.md (file)');
});

test('inbox: wide table has a header and the markers', () => {
  const r = run(['inbox']);
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout.split('\n');
  assert.equal(out[0], '4 threads in the inbox');
  assert.match(out[2], /^ID +SEV +TURN +LOCATION +ANCHOR +MSGS$/);
  assert.match(r.stdout, /^w7p2d +low +agent +src\/legacy\.ts:2 +orphaned +1$/m);
  assert.match(r.stdout, /^o2d2 +medium +agent +src\/touch\.ts:2 \(old\)/m);
  assert.match(r.stdout, /\nlhr thread show <id> /);
});

test('inbox: narrow output (COLUMNS=60) is two lines per thread', () => {
  const r = run(['inbox'], { COLUMNS: '60' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(
    r.stdout,
    [
      '4 threads in the inbox',
      '',
      'k3m7a  medium  agent  moved',
      '  src/touch.ts:5',
      'w7p2d  low  agent  orphaned',
      '  src/legacy.ts:2',
      'n5n5  critical  agent',
      '  README.md (file)',
      'o2d2  medium  agent',
      '  src/touch.ts:2 (old)',
      '',
      'lhr thread show <id>   (the handle in the ID column is enough)',
      '',
    ].join('\n'),
  );
});

test('inbox: handles are unique among the threads the mode can see', () => {
  const human = threads(['inbox']).find((x) => x.id === IDS.orphan);
  assert.equal(human.shortId, 'w7p2d'); // the draft twin counts in human mode
  const agent = threads(['inbox'], { LHR_SESSION_ID: 's1' }).find((x) => x.id === IDS.orphan);
  assert.equal(agent.shortId, 'w7p2'); // agent mode never sees drafts
});
