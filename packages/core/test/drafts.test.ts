import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { LhrError } from '../src/errors.js';
import { seams } from '../src/write.js';
import { openTree, type Author, type LhrTree } from '../src/index.js';
import { createTempRepo, type TempRepo } from './helpers/tempRepo.js';

function hasCode(code: string): (err: unknown) => boolean {
  return (err) => err instanceof LhrError && err.code === code;
}

const LINES = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);
const AGENT: Author = { kind: 'agent', name: 'claude-code', session: 's1' };
const HUMAN: Author = { kind: 'human', name: 'LHR Test' };

interface Ctx {
  repo: TempRepo;
  tree: LhrTree;
  clock(hhmmss: string): void;
  randoms: string[];
  read(rel: string): Promise<string>;
  ls(rel: string): Promise<string[]>;
}

async function withCtx(fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const repo = await createTempRepo();
  let time = '120000';
  const randoms: string[] = [];
  let counter = 0;
  const fallback = (): string => {
    counter++;
    return `zz${'abcdefghij'[Math.floor(counter / 10) % 10]}${'abcdefghij'[counter % 10]}22`;
  };
  try {
    await repo.write('src/a.ts', LINES.join('\n') + '\n');
    await repo.git('add', '.');
    await repo.git('commit', '-q', '-m', 'init');
    const tree = await openTree({
      root: repo.root,
      now: () =>
        new Date(`2026-10-01T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}Z`),
      random: () => randoms.shift() ?? fallback(),
    });
    try {
      await fn({
        repo,
        tree,
        clock: (t) => {
          time = t;
        },
        randoms,
        read: (rel) => readFile(`${repo.root}/${rel}`, 'utf8'),
        ls: async (rel) => (await readdir(`${repo.root}/${rel}`)).sort(),
      });
    } finally {
      await tree.dispose();
    }
  } finally {
    await repo.cleanup();
  }
}

const FILE_ANCHOR = { path: 'src/a.ts', kind: 'file' } as const;

async function agentThread(c: Ctx): Promise<string> {
  const r = await c.tree.createThread({ anchor: FILE_ANCHOR, body: 'agent q', author: AGENT });
  return r.threadId;
}

describe('createDraftThread', () => {
  it('writes into drafts/threads, creates .gitignore, hidden by default', async () => {
    await withCtx(async (c) => {
      c.randoms.push('aaaaaa', 'bbbbbb');
      const res = await c.tree.createDraftThread({
        anchor: FILE_ANCHOR,
        body: 'Please rename',
        author: HUMAN,
        severity: 'low',
      });
      assert.deepEqual(res, {
        threadId: '20261001T120000Z-aaaaaa',
        messageId: '20261001T120000Z-human-bbbbbb',
      });
      assert.equal(await c.read('.lhr/drafts/.gitignore'), '*\n');
      const dir = '.lhr/drafts/threads/20261001T120000Z-aaaaaa';
      assert.deepEqual(await c.ls(dir), ['20261001T120000Z-human-bbbbbb.md', 'thread.md']);
      assert.equal(
        await c.read(`${dir}/20261001T120000Z-human-bbbbbb.md`),
        `---
author.kind: human
author.name: LHR Test
severity: low
---
Please rename
`,
      );
      assert.equal((await c.repo.git('status', '--porcelain')).includes('drafts'), false);
      const snap = await c.tree.load();
      assert.equal(snap.threads().length, 0);
      assert.equal(snap.thread('20261001T120000Z-aaaaaa'), undefined);
      const shown = snap.threads({ includeDrafts: true });
      assert.equal(shown.length, 1);
      assert.equal(shown[0]?.isDraft, true);
      assert.equal(shown[0]?.messages[0]?.body, 'Please rename\n');
      assert.deepEqual(snap.problems, []);
    });
  });

  it('writes nothing when the anchor cannot be captured', async () => {
    await withCtx(async (c) => {
      await assert.rejects(
        c.tree.createDraftThread({
          anchor: { path: 'src/missing.ts', kind: 'file' },
          body: 'x',
          author: HUMAN,
        }),
      );
      await assert.rejects(c.ls('.lhr/drafts'));
    });
  });

  it('rejects an empty body and writes nothing', async () => {
    await withCtx(async (c) => {
      await assert.rejects(
        c.tree.createDraftThread({ anchor: FILE_ANCHOR, body: ' ', author: HUMAN }),
        hasCode('INVALID_INPUT'),
      );
      await assert.rejects(c.ls('.lhr/drafts'));
    });
  });
});

describe('addDraftMessage', () => {
  it('adds a draft to a submitted thread, hidden by default', async () => {
    await withCtx(async (c) => {
      const tid = await agentThread(c);
      c.randoms.push('cccccc');
      const res = await c.tree.addDraftMessage(tid, {
        body: 'ok',
        author: HUMAN,
        status: 'resolved',
      });
      assert.deepEqual(res, { messageId: '20261001T120000Z-human-cccccc' });
      assert.equal(
        await c.read(`.lhr/drafts/threads/${tid}/20261001T120000Z-human-cccccc.md`),
        `---
author.kind: human
author.name: LHR Test
status: resolved
---
ok
`,
      );
      const snap = await c.tree.load();
      assert.equal(snap.thread(tid)?.messages.length, 1);
      assert.equal(snap.thread(tid)?.status, 'open');
      const full = snap.threads({ includeDrafts: true }).find((t) => t.id === tid);
      assert.equal(full?.messages.length, 2);
      assert.equal(full?.messages[1]?.isDraft, true);
    });
  });

  it('adds to a draft thread and throws THREAD_NOT_FOUND for unknown threads', async () => {
    await withCtx(async (c) => {
      const d = await c.tree.createDraftThread({ anchor: FILE_ANCHOR, body: 'a', author: HUMAN });
      const r = await c.tree.addDraftMessage(d.threadId, { body: 'b', author: HUMAN });
      assert.deepEqual(
        await c.ls(`.lhr/drafts/threads/${d.threadId}`),
        [`${d.messageId}.md`, `${r.messageId}.md`, 'thread.md'].sort(),
      );
      await assert.rejects(
        c.tree.addDraftMessage('20261001T120000Z-nope22', { body: 'x', author: HUMAN }),
        hasCode('THREAD_NOT_FOUND'),
      );
    });
  });
});

describe('updateDraft and discardDraft', () => {
  it('updateDraft rewrites the draft in place', async () => {
    await withCtx(async (c) => {
      const d = await c.tree.createDraftThread({ anchor: FILE_ANCHOR, body: 'a', author: HUMAN });
      await assert.rejects(c.tree.updateDraft(d.messageId, { body: '' }), hasCode('INVALID_INPUT'));
      await c.tree.updateDraft(d.messageId, { body: 'changed', severity: 'high' });
      assert.equal(
        await c.read(`.lhr/drafts/threads/${d.threadId}/${d.messageId}.md`),
        `---
author.kind: human
author.name: LHR Test
severity: high
---
changed
`,
      );
    });
  });

  it('reject submitted ids with NOT_A_DRAFT and unknown ids with DRAFT_NOT_FOUND', async () => {
    await withCtx(async (c) => {
      const tid = await agentThread(c);
      const snap = await c.tree.load();
      const mid = snap.thread(tid)?.messages[0]?.id as string;
      await assert.rejects(c.tree.updateDraft(mid, { body: 'x' }), hasCode('NOT_A_DRAFT'));
      await assert.rejects(c.tree.discardDraft(mid), hasCode('NOT_A_DRAFT'));
      await assert.rejects(c.tree.discardDraft(tid), hasCode('NOT_A_DRAFT'));
      await assert.rejects(
        c.tree.updateDraft('20261001T120000Z-human-nope22', { body: 'x' }),
        hasCode('DRAFT_NOT_FOUND'),
      );
      await assert.rejects(
        c.tree.discardDraft('20261001T120000Z-nope22'),
        hasCode('DRAFT_NOT_FOUND'),
      );
    });
  });

  it('discardDraft removes a draft message or a whole draft thread', async () => {
    await withCtx(async (c) => {
      const tid = await agentThread(c);
      const m = await c.tree.addDraftMessage(tid, { body: 'x', author: HUMAN });
      await c.tree.discardDraft(m.messageId);
      assert.deepEqual(await c.ls(`.lhr/threads/${tid}`).then((l) => l.length), 2);
      assert.equal((await c.tree.load()).thread(tid)?.messages.length, 1);
      const d = await c.tree.createDraftThread({ anchor: FILE_ANCHOR, body: 'a', author: HUMAN });
      await c.tree.addDraftMessage(d.threadId, { body: 'b', author: HUMAN });
      await c.tree.discardDraft(d.threadId);
      assert.equal((await c.tree.load()).threads({ includeDrafts: true }).length, 1);
      assert.equal((await c.ls('.lhr/drafts/threads')).includes(d.threadId), false);
    });
  });
});

describe('submitRound', () => {
  it('moves N drafts into threads with the round, writes one round file, empties drafts', async () => {
    await withCtx(async (c) => {
      const tid = await agentThread(c);
      c.clock('130000');
      c.randoms.push('dddddd', 'mmmmmm');
      const d = await c.tree.createDraftThread({ anchor: FILE_ANCHOR, body: 'new', author: HUMAN });
      c.randoms.push('nnnnnn');
      const m = await c.tree.addDraftMessage(tid, {
        body: 'reply',
        author: HUMAN,
        severity: 'high',
      });
      c.clock('140000');
      c.randoms.push('rrrrrr');
      const res = await c.tree.submitRound({
        verdict: 'request-changes',
        summary: 'Fix these',
        author: HUMAN,
      });
      assert.equal(res.roundId, '20261001T140000Z-rrrrrr');
      assert.deepEqual(res.threadIds, [d.threadId]);
      assert.deepEqual(res.messageIds.sort(), [d.messageId, m.messageId].sort());
      assert.equal(
        await c.read('.lhr/rounds/20261001T140000Z-rrrrrr.md'),
        `---
verdict: request-changes
author.kind: human
author.name: LHR Test
---
Fix these
`,
      );
      assert.deepEqual(await c.ls('.lhr/rounds'), ['20261001T140000Z-rrrrrr.md']);
      assert.deepEqual(await c.ls('.lhr/drafts'), ['.gitignore', '.tmp']);
      assert.equal(
        await c.read(`.lhr/threads/${tid}/${m.messageId}.md`),
        `---
author.kind: human
author.name: LHR Test
round: 20261001T140000Z-rrrrrr
severity: high
---
reply
`,
      );
      assert.deepEqual(await c.ls(`.lhr/threads/${d.threadId}`), [
        `${d.messageId}.md`,
        'thread.md',
      ]);
      const snap = await c.tree.load();
      assert.deepEqual(snap.problems, []);
      assert.equal(snap.threads().length, 2);
      assert.equal(snap.threads({ round: res.roundId }).length, 2);
      assert.equal(snap.rounds()[0]?.verdict, 'request-changes');
      assert.equal(snap.threads({ includeDrafts: true }).length, 2);
    });
  });

  it('works with zero drafts and requires a human author', async () => {
    await withCtx(async (c) => {
      c.randoms.push('rrrrrr');
      const res = await c.tree.submitRound({ verdict: 'approve', summary: '', author: HUMAN });
      assert.deepEqual(res, {
        roundId: '20261001T120000Z-rrrrrr',
        threadIds: [],
        messageIds: [],
        resumed: false,
        skippedDraftIds: [],
      });
      assert.equal(
        await c.read('.lhr/rounds/20261001T120000Z-rrrrrr.md'),
        '---\nverdict: approve\nauthor.kind: human\nauthor.name: LHR Test\n---\n',
      );
      assert.deepEqual(await c.ls('.lhr/drafts'), ['.gitignore', '.tmp']);
      await assert.rejects(
        c.tree.submitRound({ verdict: 'approve', summary: '', author: AGENT }),
        hasCode('INVALID_INPUT'),
      );
    });
  });

  it('finishes the same round after an interruption, losing no drafts', async () => {
    await withCtx(async (c) => {
      const tid = await agentThread(c);
      const d = await c.tree.createDraftThread({ anchor: FILE_ANCHOR, body: 'new', author: HUMAN });
      const m1 = await c.tree.addDraftMessage(tid, { body: 'one', author: HUMAN });
      const m2 = await c.tree.addDraftMessage(d.threadId, { body: 'two', author: HUMAN });
      const roundId = '20261001T150000Z-iiiiii';
      const root = c.repo.root;
      // Hand-built interrupted state: marker, round file, the draft thread's thread.md and
      // m1 already copied into place, but their draft files not yet deleted.
      await writeFile(
        `${root}/.lhr/drafts/.submitting`,
        JSON.stringify({ round: roundId, messages: [d.messageId, m1.messageId, m2.messageId] }),
      );
      await mkdir(`${root}/.lhr/rounds`, { recursive: true });
      await writeFile(
        `${root}/.lhr/rounds/${roundId}.md`,
        '---\nverdict: comment\nauthor.kind: human\nauthor.name: LHR Test\n---\nhalf\n',
      );
      await mkdir(`${root}/.lhr/threads/${d.threadId}`, { recursive: true });
      await writeFile(
        `${root}/.lhr/threads/${d.threadId}/thread.md`,
        await c.read(`.lhr/drafts/threads/${d.threadId}/thread.md`),
      );
      await writeFile(
        `${root}/.lhr/threads/${tid}/${m1.messageId}.md`,
        `---\nauthor.kind: human\nauthor.name: LHR Test\nround: ${roundId}\n---\none\n`,
      );
      const mid = await c.tree.load();
      assert.deepEqual(mid.problems, []);
      const drafts = mid
        .threads({ includeDrafts: true })
        .flatMap((t) => t.messages)
        .filter((m) => m.isDraft)
        .map((m) => m.id);
      assert.equal(drafts.includes(d.messageId), true);
      assert.equal(drafts.includes(m2.messageId), true);

      const res = await c.tree.submitRound({
        verdict: 'approve',
        summary: 'ignored',
        author: HUMAN,
      });
      assert.equal(res.roundId, roundId);
      assert.equal(res.resumed, true);
      assert.deepEqual(res.messageIds.sort(), [d.messageId, m1.messageId, m2.messageId].sort());
      await assert.rejects(c.read('.lhr/drafts/.submitting'));
      assert.deepEqual(await c.ls('.lhr/drafts'), ['.gitignore', '.tmp']);
      assert.deepEqual(await c.ls('.lhr/rounds'), [`${roundId}.md`]);
      assert.equal((await c.read(`.lhr/rounds/${roundId}.md`)).includes('half'), true);
      const snap = await c.tree.load();
      assert.deepEqual(snap.problems, []);
      assert.equal(snap.threads({ round: roundId }).length, 2);
      assert.equal(snap.thread(tid)?.messages.length, 2);
      assert.equal(snap.thread(d.threadId)?.messages.length, 2);
      for (const m of snap.threads().flatMap((t) => t.messages)) {
        if (m.author.kind === 'human') assert.equal(m.round, roundId);
      }
      c.clock('160000');
      c.randoms.push('nnnnnn');
      const next = await c.tree.submitRound({ verdict: 'approve', summary: '', author: HUMAN });
      assert.equal(next.roundId, '20261001T160000Z-nnnnnn');
    });
  });

  it('writes the round file first when a marker exists without one', async () => {
    await withCtx(async (c) => {
      const tid = await agentThread(c);
      const m = await c.tree.addDraftMessage(tid, { body: 'x', author: HUMAN });
      const roundId = '20261001T150000Z-iiiiii';
      await writeFile(
        `${c.repo.root}/.lhr/drafts/.submitting`,
        JSON.stringify({ round: roundId, messages: [m.messageId] }),
      );
      const res = await c.tree.submitRound({ verdict: 'comment', summary: 's', author: HUMAN });
      assert.equal(res.roundId, roundId);
      assert.deepEqual(res.messageIds, [m.messageId]);
      assert.equal((await c.read(`.lhr/rounds/${roundId}.md`)).includes('verdict: comment'), true);
    });
  });
});

describe('crash safety', () => {
  const marker = (c: Ctx): string => `${c.repo.root}/.lhr/drafts/.submitting`;

  it('treats an empty or truncated marker as absent and starts a new round', async () => {
    for (const junk of ['', '{"round": "2026', 'not json', '{"round":"bad","messages":[]}']) {
      await withCtx(async (c) => {
        const tid = await agentThread(c);
        const m = await c.tree.addDraftMessage(tid, { body: 'x', author: HUMAN });
        await writeFile(marker(c), junk);
        c.clock('130000');
        c.randoms.push('rrrrrr');
        const res = await c.tree.submitRound({ verdict: 'comment', summary: 's', author: HUMAN });
        assert.equal(res.resumed, false);
        assert.equal(res.roundId, '20261001T130000Z-rrrrrr');
        assert.deepEqual(res.messageIds, [m.messageId]);
        assert.deepEqual(await c.ls('.lhr/drafts'), ['.gitignore', '.tmp']);
      });
    }
  });

  it('resumes after a kill right after the round file was written', async () => {
    await withCtx(async (c) => {
      const tid = await agentThread(c);
      const m = await c.tree.addDraftMessage(tid, { body: 'x', author: HUMAN });
      const roundId = '20261001T150000Z-iiiiii';
      await writeFile(marker(c), JSON.stringify({ round: roundId, messages: [m.messageId] }));
      await mkdir(`${c.repo.root}/.lhr/rounds`, { recursive: true });
      await writeFile(
        `${c.repo.root}/.lhr/rounds/${roundId}.md`,
        '---\nverdict: comment\nauthor.kind: human\nauthor.name: LHR Test\n---\n',
      );
      assert.deepEqual((await c.tree.load()).problems, []);
      const res = await c.tree.submitRound({ verdict: 'approve', summary: 'z', author: HUMAN });
      assert.equal(res.resumed, true);
      assert.equal(res.roundId, roundId);
      assert.deepEqual(res.messageIds, [m.messageId]);
      assert.equal((await c.tree.load()).thread(tid)?.messages.length, 2);
    });
  });

  it('accepts a pre-existing complete target thread.md and a gone source', async () => {
    await withCtx(async (c) => {
      const d = await c.tree.createDraftThread({ anchor: FILE_ANCHOR, body: 'a', author: HUMAN });
      const roundId = '20261001T150000Z-iiiiii';
      await writeFile(marker(c), JSON.stringify({ round: roundId, messages: [d.messageId] }));
      await mkdir(`${c.repo.root}/.lhr/threads/${d.threadId}`, { recursive: true });
      await writeFile(
        `${c.repo.root}/.lhr/threads/${d.threadId}/thread.md`,
        await c.read(`.lhr/drafts/threads/${d.threadId}/thread.md`),
      );
      const res = await c.tree.submitRound({ verdict: 'comment', summary: '', author: HUMAN });
      assert.deepEqual(res.threadIds, [d.threadId]);
      assert.deepEqual(await c.ls('.lhr/drafts'), ['.gitignore', '.tmp']);
      assert.equal((await c.tree.load()).thread(d.threadId)?.messages.length, 1);
      // a listed message whose draft is already gone and whose target exists is fine
      await writeFile(marker(c), JSON.stringify({ round: roundId, messages: [d.messageId] }));
      const again = await c.tree.submitRound({ verdict: 'comment', summary: '', author: HUMAN });
      assert.equal(again.resumed, true);
      assert.equal(again.roundId, roundId);
    });
  });

  it('removes a draft thread once all its messages are discarded', async () => {
    await withCtx(async (c) => {
      const d = await c.tree.createDraftThread({ anchor: FILE_ANCHOR, body: 'a', author: HUMAN });
      await c.tree.discardDraft(d.messageId);
      assert.deepEqual(await c.ls('.lhr/drafts/threads'), []);
      assert.equal((await c.tree.load()).threads({ includeDrafts: true }).length, 0);
    });
  });

  it('keeps a draft added while .submitting exists as a draft', async () => {
    await withCtx(async (c) => {
      const tid = await agentThread(c);
      const m1 = await c.tree.addDraftMessage(tid, { body: 'one', author: HUMAN });
      const roundId = '20261001T150000Z-iiiiii';
      await writeFile(marker(c), JSON.stringify({ round: roundId, messages: [m1.messageId] }));
      const m2 = await c.tree.addDraftMessage(tid, { body: 'two', author: HUMAN });
      const res = await c.tree.submitRound({ verdict: 'comment', summary: '', author: HUMAN });
      assert.equal(res.resumed, true);
      assert.deepEqual(res.messageIds, [m1.messageId]);
      assert.deepEqual(await c.ls(`.lhr/drafts/threads/${tid}`), [`${m2.messageId}.md`]);
      await assert.rejects(c.read('.lhr/drafts/.submitting'));
    });
  });

  it('updateDraft after submit throws NOT_A_DRAFT and creates nothing in drafts/', async () => {
    await withCtx(async (c) => {
      const tid = await agentThread(c);
      const m = await c.tree.addDraftMessage(tid, { body: 'one', author: HUMAN });
      await c.tree.submitRound({ verdict: 'comment', summary: '', author: HUMAN });
      await assert.rejects(
        c.tree.updateDraft(m.messageId, { body: 'late' }),
        hasCode('NOT_A_DRAFT'),
      );
      assert.deepEqual(await c.ls('.lhr/drafts'), ['.gitignore', '.tmp']);
      assert.deepEqual(await c.ls('.lhr/drafts/.tmp'), []);
    });
  });

  it('skips invalid drafts, leaves them in drafts and reports them', async () => {
    await withCtx(async (c) => {
      const tid = await agentThread(c);
      const good = await c.tree.addDraftMessage(tid, { body: 'one', author: HUMAN });
      const badId = '20261001T120000Z-human-badbad';
      await writeFile(
        `${c.repo.root}/.lhr/drafts/threads/${tid}/${badId}.md`,
        '---\nauthor.kind: human\nauthor.name: LHR Test\n---\n',
      );
      const res = await c.tree.submitRound({ verdict: 'comment', summary: '', author: HUMAN });
      assert.deepEqual(res.messageIds, [good.messageId]);
      assert.deepEqual(res.skippedDraftIds, [badId]);
      assert.deepEqual(await c.ls(`.lhr/drafts/threads/${tid}`), [`${badId}.md`]);
    });
  });

  it('immediate writes leave no temp files behind', async () => {
    await withCtx(async (c) => {
      const tid = await agentThread(c);
      await c.tree.reply(tid, { body: 'r', author: AGENT });
      await c.tree.resolve(tid, HUMAN);
      assert.deepEqual(await c.ls('.lhr/drafts/.tmp'), []);
      assert.equal(await c.read('.lhr/drafts/.gitignore'), '*\n');
    });
  });

  it('keeps drafts and the marker when the target thread.md is truncated', async () => {
    await withCtx(async (c) => {
      const d = await c.tree.createDraftThread({ anchor: FILE_ANCHOR, body: 'a', author: HUMAN });
      const roundId = '20261001T150000Z-iiiiii';
      await writeFile(marker(c), JSON.stringify({ round: roundId, messages: [d.messageId] }));
      await mkdir(`${c.repo.root}/.lhr/threads/${d.threadId}`, { recursive: true });
      await writeFile(`${c.repo.root}/.lhr/threads/${d.threadId}/thread.md`, '---\nanchor.kind: li');
      await assert.rejects(
        c.tree.submitRound({ verdict: 'comment', summary: '', author: HUMAN }),
        (e) => e instanceof LhrError,
      );
      assert.deepEqual(await c.ls(`.lhr/drafts/threads/${d.threadId}`), [
        `${d.messageId}.md`,
        'thread.md',
      ]);
      assert.equal((await c.read('.lhr/drafts/.submitting')).includes(roundId), true);
    });
  });

  it('two concurrent submits make one round and lose no drafts', async () => {
    await withCtx(async (c) => {
      const tid = await agentThread(c);
      const ids: string[] = [];
      for (let i = 0; i < 4; i++) {
        ids.push((await c.tree.addDraftMessage(tid, { body: `m${i}`, author: HUMAN })).messageId);
      }
      const input = { verdict: 'comment', summary: '', author: HUMAN } as const;
      const [a, b] = await Promise.all([c.tree.submitRound(input), c.tree.submitRound(input)]);
      assert.equal(a.roundId, b.roundId);
      assert.equal(a.resumed !== b.resumed, true);
      assert.equal((await c.ls('.lhr/rounds')).length, 1);
      const snap = await c.tree.load();
      assert.deepEqual(snap.problems, []);
      assert.equal(snap.thread(tid)?.messages.length, 5);
      assert.deepEqual(await c.ls('.lhr/drafts'), ['.gitignore', '.tmp']);
      assert.deepEqual(snap.thread(tid)?.messages.slice(1).map((m) => m.id), ids.slice().sort());
    });
  });
});

describe('filesystem fallbacks', () => {
  function stubLink(code: string): () => void {
    const original = seams.link;
    seams.link = () => Promise.reject(Object.assign(new Error(code), { code }));
    return () => {
      seams.link = original;
    };
  }

  it('falls back to exclusive create when hard links are unsupported', async () => {
    await withCtx(async (c) => {
      const restore = stubLink('EPERM');
      try {
        const t = await c.tree.createThread({ anchor: FILE_ANCHOR, body: 'q', author: AGENT });
        const r = await c.tree.reply(t.threadId, { body: 'again', author: AGENT });
        const dir = `.lhr/threads/${t.threadId}`;
        assert.deepEqual(await c.ls(dir), [`${t.messageId}.md`, `${r.messageId}.md`, 'thread.md'].sort());
        assert.equal((await c.read(`${dir}/${r.messageId}.md`)).endsWith('again\n'), true);
        assert.deepEqual(await c.ls('.lhr/drafts/.tmp'), []);
      } finally {
        restore();
      }
    });
  });

  it('wraps unexpected fs errors as LhrError', async () => {
    await withCtx(async (c) => {
      const tid = await agentThread(c);
      const restore = stubLink('EIO');
      try {
        await assert.rejects(
          c.tree.reply(tid, { body: 'x', author: AGENT }),
          (e) => e instanceof LhrError,
        );
        await assert.rejects(
          c.tree.addDraftMessage(tid, { body: 'x', author: HUMAN }),
          (e) => e instanceof LhrError,
        );
      } finally {
        restore();
      }
    });
  });
});
