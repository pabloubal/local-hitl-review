import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openTree, type TreeSnapshot } from '../src/index.js';
import { createTempRepo, type TempRepo } from './helpers/tempRepo.js';

const T1 = '20261001T120000Z-abcdef';
const T2 = '20261001T130000Z-bcdefg';
const T3 = '20261001T150000Z-defghi';
const R1 = '20261001T140000Z-cdefgh';
const SHA = 'a'.repeat(40);

function threadMd(severity?: string): string {
  const sev = severity === undefined ? '' : `severity: ${severity}\n`;
  return `---\nanchor.kind: file\nanchor.path: README.md\nanchor.side: new\nanchor.commit: ${SHA}\n${sev}---\n`;
}

function msg(
  kind: 'human' | 'agent',
  extra = '',
  name = kind === 'human' ? 'Pablo' : 'Claude',
): string {
  return `---\nauthor.kind: ${kind}\nauthor.name: ${name}\n${extra}---\nbody\n`;
}

function messageFile(time: string, kind: 'human' | 'agent', rand = 'abcdef'): string {
  return `20261001T${time}Z-${kind}-${rand}.md`;
}

async function withTree(
  fn: (repo: TempRepo, load: () => Promise<TreeSnapshot>) => Promise<void>,
): Promise<void> {
  const repo = await createTempRepo();
  const tree = await openTree({ root: repo.root });
  try {
    await fn(repo, () => tree.load());
  } finally {
    await tree.dispose();
    await repo.cleanup();
  }
}

describe('LhrTree.load', () => {
  it('returns an empty snapshot for a missing or empty threads dir', async () => {
    await withTree(async (repo, load) => {
      let snap = await load();
      assert.deepEqual(snap.problems, []);
      assert.deepEqual(snap.threads(), []);
      assert.deepEqual(snap.rounds(), []);
      await repo.write('.lhr/threads/.gitkeep', '');
      snap = await load();
      assert.deepEqual(snap.problems, []);
      assert.deepEqual(snap.threads(), []);
    });
  });

  it('takes createdAt of thread, message and round from the ID timestamp', async () => {
    await withTree(async (repo, load) => {
      await repo.write(`.lhr/threads/${T1}/thread.md`, threadMd());
      await repo.write(
        `.lhr/threads/${T1}/${messageFile('120100', 'human')}`,
        msg('human', `round: ${R1}\n`),
      );
      await repo.write(
        `.lhr/rounds/${R1}.md`,
        '---\nverdict: comment\nauthor.kind: human\nauthor.name: Pablo\n---\n',
      );
      const snap = await load();
      assert.deepEqual(snap.problems, []);
      const t = snap.thread(T1);
      assert.equal(t?.createdAt.toISOString(), '2026-10-01T12:00:00.000Z');
      assert.equal(
        t?.messages[0]?.createdAt.toISOString(),
        '2026-10-01T12:01:00.000Z',
      );
      assert.equal(
        snap.rounds()[0]?.createdAt.toISOString(),
        '2026-10-01T14:00:00.000Z',
      );
    });
  });

  it('takes the reviewer from the opening message author', async () => {
    await withTree(async (repo, load) => {
      await repo.write(`.lhr/threads/${T1}/thread.md`, threadMd());
      await repo.write(
        `.lhr/threads/${T1}/${messageFile('120200', 'human', 'bbbbbb')}`,
        msg('human', '', 'Second'),
      );
      await repo.write(
        `.lhr/threads/${T1}/${messageFile('120100', 'human', 'aaaaaa')}`,
        msg('human', '', 'First'),
      );
      const t = (await load()).thread(T1);
      assert.equal(t?.reviewer.name, 'First');
    });
  });

  it('resolves by the last message and reopens on a later message without status', async () => {
    await withTree(async (repo, load) => {
      await repo.write(`.lhr/threads/${T1}/thread.md`, threadMd());
      await repo.write(
        `.lhr/threads/${T1}/${messageFile('120100', 'human')}`,
        msg('human'),
      );
      await repo.write(
        `.lhr/threads/${T1}/${messageFile('120200', 'agent')}`,
        msg('agent', 'status: resolved\n'),
      );
      assert.equal((await load()).thread(T1)?.status, 'resolved');
      await repo.write(
        `.lhr/threads/${T1}/${messageFile('120300', 'human')}`,
        msg('human'),
      );
      assert.equal((await load()).thread(T1)?.status, 'open');
    });
  });

  it('prefers message severity over thread.md over medium', async () => {
    await withTree(async (repo, load) => {
      await repo.write(`.lhr/threads/${T1}/thread.md`, threadMd());
      await repo.write(
        `.lhr/threads/${T1}/${messageFile('120100', 'human')}`,
        msg('human'),
      );
      await repo.write(`.lhr/threads/${T2}/thread.md`, threadMd('high'));
      await repo.write(
        `.lhr/threads/${T2}/${messageFile('130100', 'human')}`,
        msg('human'),
      );
      let snap = await load();
      assert.equal(snap.thread(T1)?.severity, 'medium');
      assert.equal(snap.thread(T2)?.severity, 'high');
      await repo.write(
        `.lhr/threads/${T2}/${messageFile('130200', 'human')}`,
        msg('human', 'severity: low\n'),
      );
      snap = await load();
      assert.equal(snap.thread(T2)?.severity, 'low');
    });
  });

  it('gives the turn to the other party from the last message', async () => {
    await withTree(async (repo, load) => {
      await repo.write(`.lhr/threads/${T1}/thread.md`, threadMd());
      await repo.write(
        `.lhr/threads/${T1}/${messageFile('120100', 'human')}`,
        msg('human'),
      );
      assert.equal((await load()).thread(T1)?.whoseTurn, 'agent');
      await repo.write(
        `.lhr/threads/${T1}/${messageFile('120200', 'agent')}`,
        msg('agent'),
      );
      assert.equal((await load()).thread(T1)?.whoseTurn, 'human');
    });
  });

  it('hides drafts by default and keeps derived values off draft replies', async () => {
    await withTree(async (repo, load) => {
      await repo.write(`.lhr/threads/${T1}/thread.md`, threadMd());
      await repo.write(
        `.lhr/threads/${T1}/${messageFile('120100', 'human')}`,
        msg('human'),
      );
      await repo.write(
        `.lhr/threads/${T1}/${messageFile('120200', 'agent')}`,
        msg('agent', 'status: resolved\n'),
      );
      await repo.write(
        `.lhr/drafts/threads/${T1}/${messageFile('120300', 'human')}`,
        msg('human'),
      );
      await repo.write(`.lhr/drafts/threads/${T2}/thread.md`, threadMd());
      await repo.write(
        `.lhr/drafts/threads/${T2}/${messageFile('130100', 'human')}`,
        msg('human'),
      );
      const snap = await load();
      assert.deepEqual(snap.problems, []);
      assert.deepEqual(
        snap.threads().map((t) => t.id),
        [T1],
      );
      assert.equal(snap.thread(T2), undefined);
      assert.equal(snap.thread(T1)?.messages.length, 2);

      const all = snap.threads({ includeDrafts: true });
      assert.deepEqual(
        all.map((t) => t.id),
        [T1, T2],
      );
      assert.equal(all[0]?.messages.length, 3);
      assert.equal(all[0]?.status, 'resolved');
      assert.equal(all[0]?.whoseTurn, 'human');
      assert.equal(all[1]?.isDraft, true);
    });
  });

  it('drops a thread from the inbox after an agent reply', async () => {
    await withTree(async (repo, load) => {
      await repo.write(`.lhr/threads/${T1}/thread.md`, threadMd());
      await repo.write(
        `.lhr/threads/${T1}/${messageFile('120100', 'human')}`,
        msg('human'),
      );
      assert.deepEqual(
        (await load()).inbox().map((t) => t.id),
        [T1],
      );
      await repo.write(
        `.lhr/threads/${T1}/${messageFile('120200', 'agent')}`,
        msg('agent'),
      );
      assert.deepEqual((await load()).inbox(), []);
    });
  });

  it('filters the inbox by session', async () => {
    await withTree(async (repo, load) => {
      // T1: answered by s1, then a human follow-up.
      await repo.write(`.lhr/threads/${T1}/thread.md`, threadMd());
      await repo.write(
        `.lhr/threads/${T1}/${messageFile('120100', 'human')}`,
        msg('human'),
      );
      await repo.write(
        `.lhr/threads/${T1}/${messageFile('120200', 'agent')}`,
        msg('agent', 'author.session: s1\n'),
      );
      await repo.write(
        `.lhr/threads/${T1}/${messageFile('120300', 'human')}`,
        msg('human'),
      );
      // T2: answered by s2, then a human follow-up.
      await repo.write(`.lhr/threads/${T2}/thread.md`, threadMd());
      await repo.write(
        `.lhr/threads/${T2}/${messageFile('130100', 'human')}`,
        msg('human'),
      );
      await repo.write(
        `.lhr/threads/${T2}/${messageFile('130200', 'agent')}`,
        msg('agent', 'author.session: s2\n'),
      );
      await repo.write(
        `.lhr/threads/${T2}/${messageFile('130300', 'human')}`,
        msg('human'),
      );
      // T3: never answered.
      await repo.write(`.lhr/threads/${T3}/thread.md`, threadMd());
      await repo.write(
        `.lhr/threads/${T3}/${messageFile('150100', 'human')}`,
        msg('human'),
      );
      const snap = await load();
      assert.deepEqual(
        snap.inbox().map((t) => t.id),
        [T1, T2, T3],
      );
      assert.deepEqual(
        snap.inbox({ session: 's1' }).map((t) => t.id),
        [T1, T3],
      );
    });
  });

  it('reports a malformed message as one problem and still loads the thread', async () => {
    await withTree(async (repo, load) => {
      const bad = `.lhr/threads/${T1}/${messageFile('120200', 'human', 'bbbbbb')}`;
      await repo.write(`.lhr/threads/${T1}/thread.md`, threadMd());
      await repo.write(
        `.lhr/threads/${T1}/${messageFile('120100', 'human', 'aaaaaa')}`,
        msg('human'),
      );
      await repo.write(bad, 'no frontmatter here\n');
      const snap = await load();
      assert.equal(snap.problems.length, 1);
      assert.equal(snap.problems[0]?.path, bad);
      assert.equal(snap.thread(T1)?.messages.length, 1);
    });
  });
});
