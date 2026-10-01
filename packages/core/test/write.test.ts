import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { LhrError } from '../src/errors.js';
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
  head: string;
  branch: string;
  /** Sets the pinned clock, e.g. clock('130000') for 13:00:00 on 2026-10-01. */
  clock(hhmmss: string): void;
  /** Queue of random parts handed out in order; falls back to a counter. */
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
    const head = (await repo.git('rev-parse', 'HEAD')).trim();
    const branch = (await repo.git('symbolic-ref', '--short', 'HEAD')).trim();
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
        head,
        branch,
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

describe('humanAuthor', () => {
  it('reads git user.name', async () => {
    await withCtx(async ({ tree }) => {
      assert.deepEqual(await tree.humanAuthor(), {
        kind: 'human',
        name: 'LHR Test',
      });
    });
  });
});

describe('createThread', () => {
  it('writes thread.md then the opening message, byte for byte', async () => {
    await withCtx(async (c) => {
      c.randoms.push('aaaaaa', 'bbbbbb');
      const blob = (await c.repo.git('hash-object', 'src/a.ts')).trim();
      const res = await c.tree.createThread({
        anchor: { path: 'src/a.ts', kind: 'line', startLine: 5, endLine: 6 },
        body: 'Is this safe?',
        author: AGENT,
        clientId: 'c1',
        severity: 'high',
      });
      assert.deepEqual(res, {
        threadId: '20261001T120000Z-aaaaaa',
        messageId: '20261001T120000Z-agent-bbbbbb',
        created: true,
      });
      const dir = '.lhr/threads/20261001T120000Z-aaaaaa';
      assert.deepEqual(await c.ls(dir), ['20261001T120000Z-agent-bbbbbb.md', 'thread.md']);
      assert.equal(
        await c.read(`${dir}/thread.md`),
        `---
anchor.kind: line
anchor.path: src/a.ts
anchor.side: new
anchor.commit: ${c.head}
anchor.branch: ${c.branch}
anchor.blob: ${blob}
anchor.startLine: 5
anchor.endLine: 6
anchor.contextBefore: 3
anchor.contextAfter: 3
severity: high
---
\`\`\`ts
line 2
line 3
line 4
line 5
line 6
line 7
line 8
line 9
\`\`\`
`,
      );
      assert.equal(
        await c.read(`${dir}/20261001T120000Z-agent-bbbbbb.md`),
        `---
author.kind: agent
author.name: claude-code
author.session: s1
severity: high
clientId: c1
---
Is this safe?
`,
      );
    });
  });

  it('writes a file thread with an empty body and loads back with derived values', async () => {
    await withCtx(async (c) => {
      c.randoms.push('aaaaaa', 'bbbbbb');
      const res = await c.tree.createThread({
        anchor: { path: 'src/a.ts', kind: 'file' },
        body: 'Whole file looks odd.\n',
        author: AGENT,
      });
      assert.equal(res.created, true);
      assert.equal(
        await c.read(`.lhr/threads/${res.threadId}/thread.md`),
        `---
anchor.kind: file
anchor.path: src/a.ts
anchor.side: new
anchor.commit: ${c.head}
anchor.branch: ${c.branch}
---
`,
      );
      assert.equal(
        await c.read(`.lhr/threads/${res.threadId}/${res.messageId}.md`),
        `---
author.kind: agent
author.name: claude-code
author.session: s1
---
Whole file looks odd.
`,
      );
      const snap = await c.tree.load();
      assert.deepEqual(snap.problems, []);
      const t = snap.thread(res.threadId);
      assert.ok(t);
      assert.equal(t.status, 'open');
      assert.equal(t.severity, 'medium');
      assert.equal(t.whoseTurn, 'human');
      assert.deepEqual(t.reviewer, AGENT);
      assert.equal(t.messages[0]?.round, undefined);
      assert.equal(t.messages[0]?.body, 'Whole file looks odd.\n');
    });
  });

  it('loads a line thread back with its snapshot', async () => {
    await withCtx(async (c) => {
      const res = await c.tree.createThread({
        anchor: { path: 'src/a.ts', kind: 'line', startLine: 1 },
        body: 'hm',
        author: AGENT,
      });
      const snap = await c.tree.load();
      assert.deepEqual(snap.problems, []);
      const t = snap.thread(res.threadId);
      assert.equal(t?.snapshot, ['line 1', 'line 2', 'line 3', 'line 4'].join('\n'));
      assert.equal(t?.anchor.kind === 'line' && t.anchor.contextBefore, 0);
    });
  });

  it('is idempotent on clientId across threads', async () => {
    await withCtx(async (c) => {
      const input = {
        anchor: { path: 'src/a.ts', kind: 'file' as const },
        body: 'once',
        author: AGENT,
        clientId: 'same',
      };
      const first = await c.tree.createThread(input);
      c.clock('130000');
      const second = await c.tree.createThread(input);
      assert.deepEqual(second, { ...first, created: false });
      assert.equal((await c.ls('.lhr/threads')).length, 1);
    });
  });

  it('retries when the generated thread directory already exists', async () => {
    await withCtx(async (c) => {
      await c.repo.write('.lhr/threads/20261001T120000Z-aaaaaa/thread.md', 'x');
      c.randoms.push('aaaaaa', 'cccccc', 'bbbbbb');
      const res = await c.tree.createThread({
        anchor: { path: 'src/a.ts', kind: 'file' },
        body: 'hi',
        author: AGENT,
      });
      assert.equal(res.threadId, '20261001T120000Z-cccccc');
      assert.equal(res.messageId, '20261001T120000Z-agent-bbbbbb');
    });
  });

  it('rejects bad input and writes nothing', async () => {
    await withCtx(async (c) => {
      const base = {
        anchor: { path: 'src/a.ts', kind: 'file' as const },
        author: AGENT,
      };
      await assert.rejects(
        c.tree.createThread({ ...base, body: '  \n' }),
        hasCode('INVALID_INPUT'),
      );
      await assert.rejects(
        c.tree.createThread({
          ...base,
          body: 'x',
          author: { kind: 'agent', name: '' },
        }),
        hasCode('INVALID_INPUT'),
      );
      await assert.rejects(
        c.tree.createThread({
          ...base,
          body: 'x',
          anchor: { path: 'src/a.ts', kind: 'line', startLine: 99 },
        }),
        hasCode('INVALID_INPUT'),
      );
      await assert.rejects(c.ls('.lhr/threads'), /ENOENT/);
    });
  });
});

describe('reply', () => {
  async function opened(c: Ctx): Promise<string> {
    c.randoms.push('aaaaaa', 'bbbbbb');
    const { threadId } = await c.tree.createThread({
      anchor: { path: 'src/a.ts', kind: 'file' },
      body: 'question',
      author: HUMAN,
    });
    c.clock('130000');
    return threadId;
  }

  it('writes an agent message without round, byte for byte', async () => {
    await withCtx(async (c) => {
      const threadId = await opened(c);
      c.randoms.push('cccccc');
      const res = await c.tree.reply(threadId, {
        body: 'Fixed in abc123.\n\nSee `x`.',
        author: AGENT,
        clientId: 'r1',
        status: 'resolved',
        severity: 'low',
      });
      assert.deepEqual(res, {
        messageId: '20261001T130000Z-agent-cccccc',
        created: true,
      });
      assert.equal(
        await c.read(`.lhr/threads/${threadId}/20261001T130000Z-agent-cccccc.md`),
        `---
author.kind: agent
author.name: claude-code
author.session: s1
status: resolved
severity: low
clientId: r1
---
Fixed in abc123.

See \`x\`.
`,
      );
      const t = (await c.tree.load()).thread(threadId);
      assert.equal(t?.status, 'resolved');
      assert.equal(t?.severity, 'low');
      assert.equal(t?.whoseTurn, 'human');
      assert.deepEqual(t?.reviewer, HUMAN);
    });
  });

  it('flips whose turn and leaves the inbox', async () => {
    await withCtx(async (c) => {
      const threadId = await opened(c);
      assert.equal((await c.tree.load()).inbox().length, 1);
      await c.tree.reply(threadId, { body: 'done', author: AGENT });
      const snap = await c.tree.load();
      assert.deepEqual(snap.problems, []);
      assert.equal(snap.thread(threadId)?.whoseTurn, 'human');
      assert.equal(snap.inbox().length, 0);
    });
  });

  it('is idempotent on clientId within the thread', async () => {
    await withCtx(async (c) => {
      const threadId = await opened(c);
      const first = await c.tree.reply(threadId, {
        body: 'a',
        author: AGENT,
        clientId: 'k',
      });
      c.clock('140000');
      const second = await c.tree.reply(threadId, {
        body: 'b',
        author: AGENT,
        clientId: 'k',
      });
      assert.deepEqual(second, { messageId: first.messageId, created: false });
      assert.equal((await c.ls(`.lhr/threads/${threadId}`)).length, 3);
    });
  });

  it('never overwrites an existing message file', async () => {
    await withCtx(async (c) => {
      const threadId = await opened(c);
      const taken = `.lhr/threads/${threadId}/20261001T130000Z-agent-cccccc.md`;
      await c.repo.write(taken, 'KEEP');
      c.randoms.push('cccccc', 'dddddd');
      const res = await c.tree.reply(threadId, { body: 'x', author: AGENT });
      assert.equal(res.messageId, '20261001T130000Z-agent-dddddd');
      assert.equal(await c.read(taken), 'KEEP');
    });
  });

  it('throws THREAD_NOT_FOUND and INVALID_INPUT', async () => {
    await withCtx(async (c) => {
      await assert.rejects(
        c.tree.reply('20261001T120000Z-zzzzzz', { body: 'x', author: AGENT }),
        hasCode('THREAD_NOT_FOUND'),
      );
      await assert.rejects(
        c.tree.reply('../etc', { body: 'x', author: AGENT }),
        hasCode('THREAD_NOT_FOUND'),
      );
      const threadId = await opened(c);
      await assert.rejects(
        c.tree.reply(threadId, { body: '', author: AGENT }),
        hasCode('INVALID_INPUT'),
      );
      // an empty body is fine when status is set
      const ok = await c.tree.reply(threadId, {
        body: '',
        author: AGENT,
        status: 'resolved',
      });
      assert.equal(ok.created, true);
    });
  });
});

describe('resolve and reopen', () => {
  it('writes an empty-bodied status message, byte for byte', async () => {
    await withCtx(async (c) => {
      c.randoms.push('aaaaaa', 'bbbbbb');
      const { threadId } = await c.tree.createThread({
        anchor: { path: 'src/a.ts', kind: 'file' },
        body: 'q',
        author: AGENT,
      });
      c.clock('130000');
      c.randoms.push('cccccc');
      const res = await c.tree.resolve(threadId, HUMAN);
      assert.deepEqual(res, {
        messageId: '20261001T130000Z-human-cccccc',
        changed: true,
      });
      assert.equal(
        await c.read(`.lhr/threads/${threadId}/20261001T130000Z-human-cccccc.md`),
        `---
author.kind: human
author.name: LHR Test
status: resolved
---
`,
      );
      let t = (await c.tree.load()).thread(threadId);
      assert.equal(t?.status, 'resolved');
      assert.equal(t?.whoseTurn, 'agent');

      // already resolved: nothing is written
      c.clock('140000');
      assert.deepEqual(await c.tree.resolve(threadId, HUMAN), {
        changed: false,
      });
      assert.equal((await c.ls(`.lhr/threads/${threadId}`)).length, 3);

      c.randoms.push('dddddd');
      const re = await c.tree.reopen(threadId, AGENT);
      assert.deepEqual(re, {
        messageId: '20261001T140000Z-agent-dddddd',
        changed: true,
      });
      assert.equal(
        await c.read(`.lhr/threads/${threadId}/20261001T140000Z-agent-dddddd.md`),
        `---
author.kind: agent
author.name: claude-code
author.session: s1
status: open
---
`,
      );
      t = (await c.tree.load()).thread(threadId);
      assert.equal(t?.status, 'open');
      assert.deepEqual(await c.tree.reopen(threadId, AGENT), {
        changed: false,
      });
      assert.deepEqual((await c.tree.load()).problems, []);
    });
  });

  it('throws THREAD_NOT_FOUND for unknown threads', async () => {
    await withCtx(async (c) => {
      await assert.rejects(
        c.tree.resolve('20261001T120000Z-zzzzzz', HUMAN),
        hasCode('THREAD_NOT_FOUND'),
      );
      await assert.rejects(
        c.tree.reopen('20261001T120000Z-zzzzzz', HUMAN),
        hasCode('THREAD_NOT_FOUND'),
      );
    });
  });
});

describe('validation before writing', () => {
  it('leaves nothing on disk when a value cannot be serialized', async () => {
    await withCtx(async (c) => {
      const anchor = { path: 'src/a.ts', kind: 'file' as const };
      await assert.rejects(
        c.tree.createThread({ anchor, body: 'x', author: { kind: 'agent', name: 'a\nb' } }),
        hasCode('INVALID_INPUT'),
      );
      await assert.rejects(
        c.tree.createThread({ anchor, body: 'x', author: AGENT, clientId: 'a\u2028b' }),
        hasCode('INVALID_INPUT'),
      );
      await assert.rejects(c.ls('.lhr/threads'), /ENOENT/);
    });
  });

  it('reply and resolve throw INVALID_INPUT for unserializable authors', async () => {
    await withCtx(async (c) => {
      c.randoms.push('aaaaaa', 'bbbbbb');
      const { threadId } = await c.tree.createThread({
        anchor: { path: 'src/a.ts', kind: 'file' },
        body: 'q',
        author: HUMAN,
      });
      const bad: Author = { kind: 'agent', name: 'ok', session: 'x\ny' };
      await assert.rejects(
        c.tree.reply(threadId, { body: 'x', author: bad }),
        hasCode('INVALID_INPUT'),
      );
      await assert.rejects(c.tree.resolve(threadId, bad), hasCode('INVALID_INPUT'));
      assert.equal((await c.ls(`.lhr/threads/${threadId}`)).length, 2);
    });
  });
});

describe('CRLF and missing final newline', () => {
  it('loads a thread on the last line of such files with an exact snapshot', async () => {
    await withCtx(async (c) => {
      await c.repo.write('src/crlf.ts', 'a\r\nb\r\nc\r\n');
      await c.repo.write('src/nonl.ts', 'a\nb\nc');
      const one = await c.tree.createThread({
        anchor: { path: 'src/crlf.ts', kind: 'line', startLine: 3 },
        body: 'x',
        author: AGENT,
      });
      const two = await c.tree.createThread({
        anchor: { path: 'src/nonl.ts', kind: 'line', startLine: 2, endLine: 3 },
        body: 'x',
        author: AGENT,
      });
      const snap = await c.tree.load();
      assert.deepEqual(snap.problems, []);
      assert.equal(snap.thread(one.threadId)?.snapshot, 'a\r\nb\r\nc\r');
      assert.equal(snap.thread(two.threadId)?.snapshot, 'a\nb\nc');
      assert.ok((await c.read(`.lhr/threads/${one.threadId}/thread.md`)).includes('c\r\n```\n'));
    });
  });
});

describe('IO_FAILED', () => {
  it('is thrown when no unused thread ID is found', async () => {
    await withCtx(async (c) => {
      const anchor = { path: 'src/a.ts', kind: 'file' } as const;
      c.randoms.push('aaaaaa', 'bbbbbb');
      await c.tree.createThread({ anchor, body: 'one', author: AGENT });
      c.randoms.push(...Array<string>(10).fill('aaaaaa'));
      await assert.rejects(
        c.tree.createThread({ anchor, body: 'two', author: AGENT }),
        hasCode('IO_FAILED'),
      );
    });
  });

  it('is thrown when no unused message file name is found', async () => {
    await withCtx(async (c) => {
      const anchor = { path: 'src/a.ts', kind: 'file' } as const;
      c.randoms.push('aaaaaa', 'bbbbbb');
      const t = await c.tree.createThread({ anchor, body: 'one', author: AGENT });
      c.randoms.push(...Array<string>(10).fill('bbbbbb'));
      await assert.rejects(
        c.tree.reply(t.threadId, { body: 'again', author: AGENT }),
        hasCode('IO_FAILED'),
      );
    });
  });
});
