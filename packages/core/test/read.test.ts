import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readTree } from '../src/read.js';
import { createTempRepo, type TempRepo } from './helpers/tempRepo.js';

const T1 = '20260101T100000Z-aaaaaa';
const T2 = '20260102T100000Z-bbbbbb';
const M1 = '20260101T100100Z-human-cccccc';
const M2 = '20260101T100200Z-agent-dddddd';
const M3 = '20260101T100300Z-human-eeeeee';
const R1 = '20260101T120000Z-ffffff';

const SHA = 'a'.repeat(40);

function lineThread(): string {
  return `---
anchor.kind: line
anchor.path: src/a.ts
anchor.side: new
anchor.commit: ${SHA}
anchor.branch: main
anchor.blob: ${SHA}
anchor.startLine: 2
anchor.endLine: 3
anchor.contextBefore: 1
anchor.contextAfter: 0
---
\`\`\`ts
one
two
three
\`\`\`
`;
}

const FILE_THREAD = `---
anchor.kind: file
anchor.path: README.md
anchor.side: old
anchor.commit: ${SHA}
severity: high
---
`;

function msg(extra = '', kind = 'human', body = 'hello\n'): string {
  return `---\nauthor.kind: ${kind}\nauthor.name: Pablo\n${extra}---\n${body}`;
}

async function withRepo(fn: (repo: TempRepo) => Promise<void>): Promise<void> {
  const repo = await createTempRepo();
  try {
    await fn(repo);
  } finally {
    await repo.cleanup();
  }
}

function codes(problems: { code: string }[]): string[] {
  return problems.map((p) => p.code);
}

describe('readTree', () => {
  it('returns empty records when .lhr/threads is missing', async () => {
    await withRepo(async (repo) => {
      const r = await readTree(repo.root);
      assert.deepEqual(r, { threads: [], rounds: [], problems: [] });
    });
  });

  it('parses line and file threads, messages and rounds', async () => {
    await withRepo(async (repo) => {
      await repo.write(`.lhr/threads/${T1}/thread.md`, lineThread());
      await repo.write(
        `.lhr/threads/${T1}/${M1}.md`,
        msg('severity: low\nclientId: c1\nround: ' + R1 + '\n', 'human', 'fix this\n'),
      );
      await repo.write(
        `.lhr/threads/${T1}/${M2}.md`,
        msg('author.session: s1\nstatus: resolved\n', 'agent', ''),
      );
      await repo.write(`.lhr/threads/${T2}/thread.md`, FILE_THREAD);
      await repo.write(`.lhr/threads/${T2}/${M3}.md`, msg());
      await repo.write('.lhr/threads/.DS_Store', 'x');
      await repo.write(`.lhr/threads/${T1}/notes.txt`, 'x');
      await repo.write(
        `.lhr/rounds/${R1}.md`,
        '---\nverdict: request-changes\nauthor.kind: human\nauthor.name: Pablo\n---\nbody\n',
      );
      const r = await readTree(repo.root);
      assert.deepEqual(r.problems, []);
      assert.deepEqual(
        r.threads.map((t) => t.id),
        [T1, T2],
      );
      const [a, b] = r.threads;
      assert.equal(a.createdAt.toISOString(), '2026-01-01T10:00:00.000Z');
      assert.equal(a.isDraft, false);
      assert.deepEqual(a.anchor, {
        kind: 'line',
        path: 'src/a.ts',
        side: 'new',
        commit: SHA,
        branch: 'main',
        blob: SHA,
        startLine: 2,
        endLine: 3,
        contextBefore: 1,
        contextAfter: 0,
      });
      assert.equal(a.snapshot, 'one\ntwo\nthree');
      assert.deepEqual(
        a.messages.map((m) => m.id),
        [M1, M2],
      );
      assert.deepEqual(a.messages[0], {
        id: M1,
        createdAt: new Date('2026-01-01T10:01:00.000Z'),
        author: { kind: 'human', name: 'Pablo' },
        body: 'fix this\n',
        round: R1,
        severity: 'low',
        clientId: 'c1',
        isDraft: false,
      });
      assert.equal(a.messages[1].status, 'resolved');
      assert.equal(a.messages[1].author.session, 's1');
      assert.equal(b.anchor.kind, 'file');
      assert.equal(b.anchor.side, 'old');
      assert.equal(b.snapshot, undefined);
      assert.equal(b.severity, 'high');
      assert.equal(r.rounds.length, 1);
      assert.deepEqual(r.rounds[0], {
        id: R1,
        createdAt: new Date('2026-01-01T12:00:00.000Z'),
        verdict: 'request-changes',
        author: { kind: 'human', name: 'Pablo' },
        body: 'body\n',
      });
    });
  });

  it('keeps longer fences and snapshot text exactly', async () => {
    await withRepo(async (repo) => {
      const text = [
        '---',
        'anchor.kind: line',
        'anchor.path: a.md',
        'anchor.side: new',
        `anchor.commit: ${SHA}`,
        `anchor.blob: ${SHA}`,
        'anchor.startLine: 1',
        'anchor.endLine: 1',
        'anchor.contextBefore: 0',
        'anchor.contextAfter: 2',
        '---',
        '````md',
        'one',
        '```',
        '  three  ',
        '````',
        '',
      ].join('\n');
      await repo.write(`.lhr/threads/${T1}/thread.md`, text);
      await repo.write(`.lhr/threads/${T1}/${M1}.md`, msg());
      const r = await readTree(repo.root);
      assert.deepEqual(r.problems, []);
      assert.equal(r.threads[0].snapshot, 'one\n```\n  three  ');
    });
  });

  it('reports a malformed message and keeps the others', async () => {
    await withRepo(async (repo) => {
      await repo.write(`.lhr/threads/${T1}/thread.md`, FILE_THREAD);
      await repo.write(`.lhr/threads/${T1}/${M1}.md`, 'no frontmatter\n');
      await repo.write(`.lhr/threads/${T1}/${M3}.md`, msg());
      const r = await readTree(repo.root);
      assert.equal(r.problems.length, 1);
      assert.equal(r.problems[0].code, 'FRONTMATTER_SYNTAX');
      assert.equal(r.problems[0].path, `.lhr/threads/${T1}/${M1}.md`);
      assert.deepEqual(
        r.threads[0].messages.map((m) => m.id),
        [M3],
      );
    });
  });

  it('flags bad thread dir and file names', async () => {
    await withRepo(async (repo) => {
      await repo.write('.lhr/threads/not-an-id/thread.md', FILE_THREAD);
      await repo.write(`.lhr/threads/${T1}/thread.md`, FILE_THREAD);
      await repo.write(`.lhr/threads/${T1}/bogus.md`, msg());
      await repo.write(`.lhr/threads/${T1}/${M1}.md`, msg());
      await repo.write('.lhr/rounds/nope.md', '---\n---\n');
      const r = await readTree(repo.root);
      assert.deepEqual(
        r.problems.map((p) => [p.code, p.path]),
        [
          ['INVALID_FILE_NAME', `.lhr/threads/${T1}/bogus.md`],
          ['INVALID_FILE_NAME', '.lhr/threads/not-an-id'],
          ['INVALID_FILE_NAME', '.lhr/rounds/nope.md'],
        ],
      );
      assert.equal(r.threads.length, 1);
    });
  });

  it('validates thread.md keys', async () => {
    await withRepo(async (repo) => {
      const cases: [string, string, string][] = [
        ['20260101T000001Z-aaaaaa', FILE_THREAD.replace('anchor.path: README.md\n', ''), 'MISSING_KEY'],
        ['20260101T000002Z-aaaaaa', FILE_THREAD.replace('side: old', 'side: left'), 'INVALID_VALUE'],
        ['20260101T000003Z-aaaaaa', FILE_THREAD.replace('severity: high', 'severity: huge'), 'INVALID_VALUE'],
        ['20260101T000004Z-aaaaaa', FILE_THREAD.replace('kind: file', 'kind: range'), 'INVALID_VALUE'],
        ['20260101T000005Z-aaaaaa', lineThread().replace('startLine: 2', 'startLine: 0'), 'INVALID_VALUE'],
        ['20260101T000006Z-aaaaaa', lineThread().replace('endLine: 3', 'endLine: 1'), 'INVALID_VALUE'],
        ['20260101T000007Z-aaaaaa', lineThread().replace('contextAfter: 0', 'contextAfter: -1'), 'INVALID_VALUE'],
        ['20260101T000008Z-aaaaaa', lineThread().replace(/anchor\.blob: .*\n/, ''), 'MISSING_KEY'],
        ['20260101T000009Z-aaaaaa', lineThread().replace('startLine: 2', 'startLine: two'), 'INVALID_VALUE'],
      ];
      for (const [id, text] of cases) {
        await repo.write(`.lhr/threads/${id}/thread.md`, text);
        await repo.write(`.lhr/threads/${id}/${M1}.md`, msg());
      }
      const r = await readTree(repo.root);
      assert.equal(r.threads.length, 0);
      assert.deepEqual(
        r.problems.map((p) => p.code),
        cases.map((c) => c[2]),
      );
      assert.ok(r.problems.every((p) => p.path.endsWith('/thread.md')));
    });
  });

  it('validates message keys', async () => {
    await withRepo(async (repo) => {
      const d = `.lhr/threads/${T1}`;
      await repo.write(`${d}/thread.md`, FILE_THREAD);
      await repo.write(`${d}/${M3}.md`, msg());
      await repo.write(`${d}/${M1}.md`, msg('', 'agent')); // kind mismatch (human in name)
      await repo.write(`${d}/${M2}.md`, '---\nauthor.kind: agent\n---\nhi\n'); // missing name
      const m4 = '20260101T100400Z-human-aaaaaa';
      await repo.write(`${d}/${m4}.md`, msg('status: done\n'));
      const m5 = '20260101T100500Z-human-aaaaaa';
      await repo.write(`${d}/${m5}.md`, msg('', 'human', '  \n'));
      const m6 = '20260101T100600Z-human-aaaaaa';
      await repo.write(`${d}/${m6}.md`, msg('severity: low\n', 'human', '\n'));
      const m7 = '20260101T100700Z-human-aaaaaa';
      await repo.write(`${d}/${m7}.md`, msg('unknown: 1\n'));
      const r = await readTree(repo.root);
      assert.deepEqual(codes(r.problems).sort(), [
        'AUTHOR_KIND_MISMATCH',
        'EMPTY_BODY',
        'INVALID_VALUE',
        'MISSING_KEY',
      ]);
      assert.deepEqual(
        r.threads[0].messages.map((m) => m.id),
        [M3, m6, m7],
      );
    });
  });

  it('flags validation errors in rounds', async () => {
    await withRepo(async (repo) => {
      await repo.write(
        `.lhr/rounds/${R1}.md`,
        '---\nverdict: maybe\nauthor.kind: human\nauthor.name: P\n---\n',
      );
      await repo.write(
        '.lhr/rounds/20260101T120001Z-ffffff.md',
        '---\nverdict: approve\nauthor.kind: agent\nauthor.name: P\n---\n',
      );
      await repo.write(
        '.lhr/rounds/20260101T120002Z-ffffff.md',
        '---\nverdict: approve\nauthor.kind: human\n---\n',
      );
      await repo.write('.lhr/rounds/20260101T120003Z-ffffff.md', 'junk');
      await repo.write('.lhr/rounds/readme.txt', 'junk');
      const r = await readTree(repo.root);
      assert.equal(r.rounds.length, 0);
      assert.deepEqual(codes(r.problems), [
        'INVALID_VALUE',
        'INVALID_VALUE',
        'MISSING_KEY',
        'FRONTMATTER_SYNTAX',
      ]);
    });
  });

  it('reports MISSING_THREAD_MD and EMPTY_THREAD', async () => {
    await withRepo(async (repo) => {
      await repo.write(`.lhr/threads/${T1}/${M1}.md`, msg());
      await repo.write(`.lhr/threads/${T2}/thread.md`, FILE_THREAD);
      await repo.write(`.lhr/drafts/threads/20260103T000000Z-cccccc/${M1}.md`, msg());
      const r = await readTree(repo.root);
      assert.equal(r.threads.length, 0);
      assert.deepEqual(
        r.problems.map((p) => [p.code, p.path]),
        [
          ['MISSING_THREAD_MD', `.lhr/threads/${T1}`],
          ['EMPTY_THREAD', `.lhr/threads/${T2}`],
          ['MISSING_THREAD_MD', '.lhr/drafts/threads/20260103T000000Z-cccccc'],
        ],
      );
    });
  });

  it('loads draft threads and draft replies', async () => {
    await withRepo(async (repo) => {
      await repo.write(`.lhr/threads/${T1}/thread.md`, FILE_THREAD);
      await repo.write(`.lhr/threads/${T1}/${M1}.md`, msg());
      await repo.write(`.lhr/drafts/threads/${T1}/${M3}.md`, msg());
      await repo.write(`.lhr/drafts/threads/${T2}/thread.md`, FILE_THREAD);
      await repo.write(`.lhr/drafts/threads/${T2}/${M2}.md`, msg('', 'agent'));
      await repo.write('.lhr/drafts/threads/20260105T000000Z-cccccc/thread.md', FILE_THREAD);
      const r = await readTree(repo.root);
      assert.deepEqual(r.problems, []);
      assert.deepEqual(
        r.threads.map((t) => [t.id, t.isDraft]),
        [
          [T1, false],
          [T2, true],
        ],
      );
      assert.deepEqual(
        r.threads[0].messages.map((m) => [m.id, m.isDraft]),
        [
          [M1, false],
          [M3, true],
        ],
      );
      assert.equal(r.threads[1].messages[0].isDraft, true);
    });
  });

  it('handles an interrupted submit (id in both trees)', async () => {
    await withRepo(async (repo) => {
      await repo.write(`.lhr/threads/${T1}/thread.md`, FILE_THREAD);
      await repo.write(`.lhr/threads/${T1}/${M1}.md`, msg());
      await repo.write(`.lhr/drafts/threads/${T1}/thread.md`, 'garbage');
      await repo.write(`.lhr/drafts/threads/${T1}/${M1}.md`, msg());
      await repo.write(`.lhr/drafts/threads/${T1}/${M3}.md`, msg());
      const r = await readTree(repo.root);
      assert.deepEqual(r.problems, []);
      assert.equal(r.threads.length, 1);
      assert.equal(r.threads[0].isDraft, false);
      assert.deepEqual(
        r.threads[0].messages.map((m) => [m.id, m.isDraft]),
        [
          [M1, false],
          [M3, true],
        ],
      );
    });
  });

  it('turns an interrupted draft-thread submit into one draft thread', async () => {
    await withRepo(async (repo) => {
      await repo.write(`.lhr/threads/${T1}/thread.md`, FILE_THREAD);
      await repo.write(`.lhr/drafts/threads/${T1}/${M1}.md`, msg());
      const r = await readTree(repo.root);
      assert.deepEqual(r.problems, []);
      assert.equal(r.threads.length, 1);
      assert.equal(r.threads[0].isDraft, true);
      assert.deepEqual(
        r.threads[0].messages.map((m) => [m.id, m.isDraft]),
        [[M1, true]],
      );
    });
  });

  it('keeps EMPTY_THREAD when a thread.md has no messages anywhere', async () => {
    await withRepo(async (repo) => {
      await repo.write(`.lhr/threads/${T1}/thread.md`, FILE_THREAD);
      await repo.write(`.lhr/drafts/threads/${T1}/${M1}.md`, 'bad');
      const r = await readTree(repo.root);
      assert.deepEqual(codes(r.problems).sort(), ['EMPTY_THREAD', 'FRONTMATTER_SYNTAX']);
      assert.equal(r.threads.length, 0);
    });
  });

  it('reports unreadable entries instead of throwing', async () => {
    await withRepo(async (repo) => {
      await repo.write(`.lhr/threads/${T1}/thread.md/x`, 'x');
      await repo.write(`.lhr/threads/${T2}/thread.md`, FILE_THREAD);
      await repo.write(`.lhr/threads/${T2}/${M1}.md`, msg());
      await repo.write(`.lhr/threads/${T2}/${M3}.md/x`, 'x');
      const r = await readTree(repo.root);
      assert.deepEqual(
        r.problems.map((p) => [p.code, p.path]),
        [
          ['UNREADABLE_FILE', `.lhr/threads/${T1}/thread.md`],
          ['UNREADABLE_FILE', `.lhr/threads/${T2}/${M3}.md`],
        ],
      );
      assert.deepEqual(
        r.threads.map((t) => t.id),
        [T2],
      );
    });
  });

  it('rejects anchor.path that is not repo-relative POSIX', async () => {
    await withRepo(async (repo) => {
      const bad = ['"src\\\\a.ts"', '/abs/a.ts', '../x', 'a/./b', 'a//b', '""', '"C:/repo/a.ts"'];
      for (const [i, p] of bad.entries()) {
        const id = `20260101T00000${i}Z-aaaaaa`;
        await repo.write(
          `.lhr/threads/${id}/thread.md`,
          FILE_THREAD.replace('README.md', p === '""' ? '""' : p),
        );
        await repo.write(`.lhr/threads/${id}/${M1}.md`, msg());
      }
      const r = await readTree(repo.root);
      assert.equal(r.threads.length, 0);
      assert.deepEqual(codes(r.problems), bad.map(() => 'INVALID_VALUE'));
    });
  });
});
