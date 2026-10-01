import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildSnapshot } from '../src/snapshot.js';
import type {
  Author,
  MessageView,
  RoundView,
  ThreadRecord,
  TreeRecords,
} from '../src/model.js';

const human: Author = { kind: 'human', name: 'Pablo' };
const agent = (session?: string): Author => ({
  kind: 'agent',
  name: 'claude',
  ...(session === undefined ? {} : { session }),
});

let counter = 0;
function msg(
  id: string,
  author: Author,
  extra: Partial<MessageView> = {},
): MessageView {
  counter += 1;
  return {
    id,
    createdAt: new Date(Date.UTC(2026, 9, 1, 9, 0, counter)),
    author,
    body: `body ${id}`,
    isDraft: false,
    ...extra,
  };
}

function thread(
  id: string,
  messages: MessageView[],
  extra: Partial<ThreadRecord> = {},
): ThreadRecord {
  return {
    id,
    createdAt: new Date(Date.UTC(2026, 9, 1, 9, 0, 0)),
    isDraft: false,
    anchor: { kind: 'file', path: 'src/a.ts', side: 'new', commit: 'abc' },
    messages,
    ...extra,
  };
}

function records(
  threads: ThreadRecord[],
  rounds: RoundView[] = [],
): TreeRecords {
  return { threads, rounds, problems: [] };
}

describe('buildSnapshot derived values', () => {
  it('reviewer is the opening message author', () => {
    const snap = buildSnapshot(
      records([thread('t1', [msg('m1', human), msg('m2', agent())])]),
    );
    assert.deepEqual(snap.thread('t1')?.reviewer, human);
  });

  it('status follows the last message', () => {
    const snap = buildSnapshot(
      records([
        thread('t1', [
          msg('m1', human),
          msg('m2', agent(), { status: 'resolved' }),
        ]),
        thread('t2', [
          msg('m1', human),
          msg('m2', agent(), { status: 'resolved' }),
          msg('m3', human),
        ]),
        thread('t3', [
          msg('m1', human),
          msg('m2', agent(), { status: 'resolved' }),
          msg('m3', human, { status: 'open' }),
        ]),
      ]),
    );
    assert.equal(snap.thread('t1')?.status, 'resolved');
    assert.equal(snap.thread('t2')?.status, 'open');
    assert.equal(snap.thread('t3')?.status, 'open');
  });

  it('severity: message beats thread.md beats medium; latest setter wins', () => {
    const snap = buildSnapshot(
      records([
        thread('t1', [msg('m1', human)]),
        thread('t2', [msg('m1', human)], { severity: 'low' }),
        thread('t3', [msg('m1', human, { severity: 'high' })], {
          severity: 'low',
        }),
        thread('t4', [
          msg('m1', human, { severity: 'high' }),
          msg('m2', agent(), { severity: 'critical' }),
          msg('m3', human),
        ]),
      ]),
    );
    assert.equal(snap.thread('t1')?.severity, 'medium');
    assert.equal(snap.thread('t2')?.severity, 'low');
    assert.equal(snap.thread('t3')?.severity, 'high');
    assert.equal(snap.thread('t4')?.severity, 'critical');
  });

  it('whoseTurn is the opposite of the last author kind', () => {
    const snap = buildSnapshot(
      records([
        thread('t1', [msg('m1', human)]),
        thread('t2', [msg('m1', human), msg('m2', agent())]),
      ]),
    );
    assert.equal(snap.thread('t1')?.whoseTurn, 'agent');
    assert.equal(snap.thread('t2')?.whoseTurn, 'human');
  });

  it('omits records with no basis messages', () => {
    const snap = buildSnapshot(
      records([
        thread('t1', []),
        thread('t2', [msg('m1', human, { isDraft: true })]),
      ]),
    );
    assert.deepEqual(snap.threads(), []);
    assert.deepEqual(snap.threads({ includeDrafts: true }), []);
  });
});

describe('buildSnapshot drafts', () => {
  const build = () =>
    buildSnapshot(
      records([
        thread('t1', [
          msg('m1', human),
          msg('m2', agent(), { status: 'resolved' }),
          msg('m3', human, { isDraft: true }),
        ]),
        thread('t2', [msg('m1', human, { isDraft: true })], { isDraft: true }),
      ]),
    );

  it('hides drafts by default from threads(), thread(), inbox()', () => {
    const snap = build();
    assert.deepEqual(
      snap.threads().map((t) => t.id),
      ['t1'],
    );
    assert.equal(snap.threads()[0]?.messages.length, 2);
    assert.equal(snap.thread('t2'), undefined);
    assert.equal(snap.thread('t1')?.messages.length, 2);
    assert.deepEqual(snap.inbox(), []);
  });

  it('keeps threads with pending draft replies in the inbox, drafts stripped', () => {
    const snap = buildSnapshot(
      records([
        thread('t1', [msg('m1', human), msg('m2', human, { isDraft: true })]),
      ]),
    );
    const items = snap.inbox();
    assert.deepEqual(
      items.map((t) => t.id),
      ['t1'],
    );
    assert.equal(items[0]?.messages.length, 1);
    assert.ok(items[0]?.messages.every((m) => !m.isDraft));
  });

  it('shows drafts with includeDrafts without changing derived values', () => {
    const snap = build();
    const all = snap.threads({ includeDrafts: true });
    assert.deepEqual(
      all.map((t) => t.id),
      ['t1', 't2'],
    );
    const t1 = all[0];
    assert.equal(t1?.messages.length, 3);
    assert.equal(t1?.messages[2]?.isDraft, true);
    assert.equal(t1?.status, 'resolved');
    assert.equal(t1?.whoseTurn, 'human');
    assert.equal(all[1]?.isDraft, true);
    assert.equal(all[1]?.whoseTurn, 'agent');
  });
});

describe('buildSnapshot filters', () => {
  const rounds: RoundView[] = [
    {
      id: 'r2',
      createdAt: new Date(0),
      verdict: 'comment',
      author: human,
      body: '',
    },
    {
      id: 'r1',
      createdAt: new Date(0),
      verdict: 'approve',
      author: human,
      body: '',
    },
  ];
  const snap = buildSnapshot(
    records(
      [
        thread('t3', [msg('m1', human, { round: 'r2' })], {
          anchor: { kind: 'file', path: 'src/b.ts', side: 'new', commit: 'x' },
        }),
        thread('t1', [msg('m1', human, { round: 'r1' })]),
        thread('t2', [
          msg('m1', human),
          msg('m2', agent(), { status: 'resolved' }),
        ]),
      ],
      rounds,
    ),
  );
  const ids = (f: Parameters<typeof snap.threads>[0]): string[] =>
    snap.threads(f).map((t) => t.id);

  it('sorts by id', () => {
    assert.deepEqual(ids(undefined), ['t1', 't2', 't3']);
    assert.deepEqual(
      snap.rounds().map((r) => r.id),
      ['r1', 'r2'],
    );
  });
  it('filters by status', () => {
    assert.deepEqual(ids({ status: 'resolved' }), ['t2']);
    assert.deepEqual(ids({ status: 'open' }), ['t1', 't3']);
  });
  it('filters by whoseTurn', () => {
    assert.deepEqual(ids({ whoseTurn: 'human' }), ['t2']);
  });
  it('filters by path', () => {
    assert.deepEqual(ids({ path: 'src/b.ts' }), ['t3']);
  });
  it('filters by round', () => {
    assert.deepEqual(ids({ round: 'r1' }), ['t1']);
  });
  it('ANDs filters together', () => {
    assert.deepEqual(ids({ status: 'open', path: 'src/a.ts' }), ['t1']);
    assert.deepEqual(ids({ status: 'resolved', round: 'r1' }), []);
  });
});

describe('buildSnapshot inbox', () => {
  it('lists open threads awaiting the agent; an agent reply removes the item', () => {
    const snap = buildSnapshot(
      records([
        thread('t1', [msg('m1', human)]),
        thread('t2', [msg('m1', human), msg('m2', agent())]),
        thread('t3', [
          msg('m1', human),
          msg('m2', agent(), { status: 'resolved' }),
          msg('m3', human, { status: 'resolved' }),
        ]),
      ]),
    );
    assert.deepEqual(
      snap.inbox().map((t) => t.id),
      ['t1'],
    );
  });

  it('session filter keeps own-session and never-replied threads', () => {
    const snap = buildSnapshot(
      records([
        thread('t1', [msg('m1', human)]),
        thread('t2', [
          msg('m1', human),
          msg('m2', agent('s1')),
          msg('m3', human),
        ]),
        thread('t3', [
          msg('m1', human),
          msg('m2', agent('s2')),
          msg('m3', human),
        ]),
      ]),
    );
    assert.deepEqual(
      snap.inbox().map((t) => t.id),
      ['t1', 't2', 't3'],
    );
    assert.deepEqual(
      snap.inbox({ session: 's1' }).map((t) => t.id),
      ['t1', 't2'],
    );
  });
});

describe('buildSnapshot immutability', () => {
  it('returns frozen views and fresh arrays', () => {
    const snap = buildSnapshot(records([thread('t1', [msg('m1', human)])]));
    const view = snap.threads()[0];
    assert.ok(view);
    assert.throws(() => {
      view.status = 'resolved';
    }, TypeError);
    assert.throws(() => {
      view.messages.push(msg('m9', human));
    }, TypeError);
    assert.throws(() => {
      (view.messages[0] as MessageView).body = 'x';
    }, TypeError);
    assert.throws(() => {
      (view.messages[0] as MessageView).author.name = 'x';
    }, TypeError);
    assert.throws(() => {
      view.anchor.path = 'x';
    }, TypeError);
    assert.notEqual(snap.threads(), snap.threads());
    assert.equal(snap.threads()[0], snap.threads()[0]);
  });
});
