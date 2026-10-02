import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, rm, symlink, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { openTree, type Diagnostic } from '../src/index.js';
import { createTempRepo, type TempRepo } from './helpers/tempRepo.js';

const T1 = '20260101T100000Z-aaaaaa';
const M1 = '20260101T100100Z-human-cccccc';
const M2 = '20260101T100200Z-agent-dddddd';
const R1 = '20260101T120000Z-ffffff';
const P1 = '20260101T130000Z-gggggg';
const SHA = 'a'.repeat(40);

const THREAD_DIR = `.lhr/threads/${T1}`;
const THREAD_MD = `${THREAD_DIR}/thread.md`;

function lineThread(
  opts: {
    start?: number;
    end?: number;
    before?: number;
    after?: number;
    snap?: string[];
    drop?: string;
  } = {},
): string {
  const { start = 2, end = 3, before = 1, after = 0, snap = ['one', 'two', 'three'], drop } = opts;
  const lines = [
    'anchor.kind: line',
    'anchor.path: src/a.ts',
    'anchor.side: new',
    `anchor.commit: ${SHA}`,
    'anchor.branch: main',
    `anchor.blob: ${SHA}`,
    `anchor.startLine: ${start}`,
    `anchor.endLine: ${end}`,
    `anchor.contextBefore: ${before}`,
    `anchor.contextAfter: ${after}`,
  ].filter((l) => drop === undefined || !l.startsWith(`${drop}:`));
  return `---\n${lines.join('\n')}\n---\n\`\`\`ts\n${snap.join('\n')}\n\`\`\`\n`;
}

const FILE_THREAD = `---\nanchor.kind: file\nanchor.path: README.md\nanchor.side: old\nanchor.commit: ${SHA}\n---\n`;

function msg(extra = '', kind = 'human', body = 'hello\n', name = 'Pablo'): string {
  return `---\nauthor.kind: ${kind}\nauthor.name: ${name}\n${extra}---\n${body}`;
}

const ROUND = `---\nverdict: comment\nauthor.kind: human\nauthor.name: Pablo\n---\nsummary\n`;

function push(
  json: unknown = { threads: { [T1]: {} }, messages: { [M1]: {} } },
  extra = '',
): string {
  return (
    `---\nround: ${R1}\ngithub.repo: o/r\ngithub.pullNumber: 5\ngithub.reviewId: 9\n` +
    `github.reviewNodeId: PRR_x\ngithub.commitId: ${SHA}\ngithub.state: COMMENTED\n` +
    `github.url: "https://github.com/o/r/pull/5"\ngithub.verdictDowngraded: false\n${extra}---\n` +
    `\`\`\`json\n${JSON.stringify(json, null, 2)}\n\`\`\`\n`
  );
}

async function cleanTree(repo: TempRepo): Promise<void> {
  await repo.write(THREAD_MD, lineThread());
  await repo.write(`${THREAD_DIR}/${M1}.md`, msg(`round: ${R1}\n`));
  await repo.write(
    `${THREAD_DIR}/${M2}.md`,
    msg('author.session: s1\n', 'agent', 'ok\n', 'claude-code'),
  );
  await repo.write(`.lhr/rounds/${R1}.md`, ROUND);
  await repo.write(`.lhr/pushes/${P1}.md`, push());
  await repo.write('.lhr/drafts/.gitignore', '*\n');
  await repo.write('.lhr/drafts/.submitting', '');
}

async function run(
  setup: (repo: TempRepo) => Promise<void>,
  afterOpen?: (repo: TempRepo) => Promise<void>,
): Promise<Diagnostic[]> {
  const repo = await createTempRepo();
  try {
    await cleanTree(repo);
    await setup(repo);
    const tree = await openTree({ root: repo.root });
    try {
      await afterOpen?.(repo);
      return (await tree.check()).diagnostics;
    } finally {
      await tree.dispose();
    }
  } finally {
    await repo.cleanup();
  }
}

function expectOnly(
  diags: Diagnostic[],
  code: string,
  p: string,
  severity: 'error' | 'warning' = 'error',
): void {
  assert.deepEqual(
    diags.map((d) => [d.code, d.path, d.severity]),
    [[code, p, severity]],
    JSON.stringify(diags, null, 2),
  );
}

describe('check()', () => {
  it('yields no diagnostics for a clean tree', async () => {
    assert.deepEqual(await run(async () => {}), []);
  });

  it('accepts file threads and valid draft threads', async () => {
    const diags = await run(async (r) => {
      const t2 = '20260102T100000Z-bbbbbb';
      await r.write(`.lhr/threads/${t2}/thread.md`, FILE_THREAD);
      await r.write(`.lhr/threads/${t2}/${M1}.md`, msg());
      const t3 = '20260103T100000Z-cccccc';
      await r.write(`.lhr/drafts/threads/${t3}/thread.md`, FILE_THREAD);
      await r.write(`.lhr/drafts/threads/${t3}/20260103T100100Z-human-eeeeee.md`, msg());
    });
    assert.deepEqual(diags, []);
  });

  it('errors when .lhr/format goes missing after the tree is opened', async () => {
    const diags = await run(
      async () => {},
      async (r) => {
        await rm(path.join(r.root, '.lhr/format'));
      },
    );
    expectOnly(diags, 'FORMAT_MISSING', '.lhr/format');
  });

  it('errors when .lhr/format changes to a version other than 2', async () => {
    const diags = await run(
      async () => {},
      async (r) => {
        await writeFile(path.join(r.root, '.lhr/format'), '3\n');
      },
    );
    expectOnly(diags, 'FORMAT_VERSION', '.lhr/format');
  });

  it('errors on frontmatter syntax errors', async () => {
    const diags = await run(async (r) => {
      await r.write(`${THREAD_DIR}/${M1}.md`, '---\nauthor.kind human\n---\nx\n');
    });
    expectOnly(diags, 'FRONTMATTER_SYNTAX', `${THREAD_DIR}/${M1}.md`);
  });

  it('errors on a missing required key', async () => {
    const diags = await run(async (r) => {
      await r.write(`${THREAD_DIR}/${M1}.md`, '---\nauthor.kind: human\n---\nhi\n');
    });
    expectOnly(diags, 'MISSING_KEY', `${THREAD_DIR}/${M1}.md`);
  });

  it('errors on a wrong type', async () => {
    const diags = await run(async (r) => {
      await r.write(
        THREAD_MD,
        lineThread().replace('anchor.startLine: 2', 'anchor.startLine: "2"'),
      );
    });
    expectOnly(diags, 'INVALID_VALUE', THREAD_MD);
  });

  it('errors on a wrong enum value', async () => {
    const diags = await run(async (r) => {
      await r.write(`${THREAD_DIR}/${M1}.md`, msg('severity: urgent\n'));
    });
    expectOnly(diags, 'INVALID_VALUE', `${THREAD_DIR}/${M1}.md`);
  });

  it('errors on a non-repo-relative anchor.path', async () => {
    const diags = await run(async (r) => {
      await r.write(THREAD_MD, lineThread().replace('src/a.ts', '../a.ts'));
    });
    expectOnly(diags, 'INVALID_VALUE', THREAD_MD);
  });

  it('errors on a round and push record with schema violations', async () => {
    const diags = await run(async (r) => {
      await r.write(`.lhr/rounds/${R1}.md`, ROUND.replace('comment', 'maybe'));
      await r.write(
        `.lhr/pushes/${P1}.md`,
        push().replace('github.state: COMMENTED', 'github.state: DONE'),
      );
    });
    assert.deepEqual(diags.map((d) => [d.code, d.path]).sort(), [
      ['INVALID_VALUE', `.lhr/pushes/${P1}.md`],
      ['INVALID_VALUE', `.lhr/rounds/${R1}.md`],
    ]);
  });

  it('errors on an invalid thread directory name', async () => {
    const diags = await run(async (r) => {
      await r.write('.lhr/threads/not-an-id/thread.md', FILE_THREAD);
      await r.write(`.lhr/threads/not-an-id/${M1}.md`, msg());
    });
    assert.ok(
      diags.some((d) => d.code === 'INVALID_FILE_NAME' && d.path === '.lhr/threads/not-an-id'),
    );
  });

  it('errors on an invalid message file name', async () => {
    const diags = await run(async (r) => {
      await r.write(`${THREAD_DIR}/bogus.md`, msg());
    });
    expectOnly(diags, 'INVALID_FILE_NAME', `${THREAD_DIR}/bogus.md`);
  });

  it('errors on an invalid round and push file name', async () => {
    const diags = await run(async (r) => {
      await r.write('.lhr/rounds/zzz.md', ROUND);
      await r.write('.lhr/pushes/zzz.md', push());
    });
    assert.deepEqual(diags.map((d) => [d.code, d.path]).sort(), [
      ['INVALID_FILE_NAME', '.lhr/pushes/zzz.md'],
      ['INVALID_FILE_NAME', '.lhr/rounds/zzz.md'],
    ]);
  });

  it('errors when author.kind does not match the file name', async () => {
    const diags = await run(async (r) => {
      await r.write(`${THREAD_DIR}/${M1}.md`, msg('', 'agent').replace('Pablo', 'Pablo'));
    });
    assert.ok(
      diags.some(
        (d) =>
          d.code === 'AUTHOR_KIND_MISMATCH' &&
          d.path === `${THREAD_DIR}/${M1}.md` &&
          d.severity === 'error',
      ),
    );
  });

  it('errors on a thread directory without thread.md', async () => {
    const diags = await run(async (r) => {
      await rm(path.join(r.root, THREAD_MD));
    });
    expectOnly(diags, 'MISSING_THREAD_MD', THREAD_DIR);
  });

  it('errors on a submitted thread with no messages', async () => {
    const t2 = '20260102T100000Z-bbbbbb';
    const diags = await run(async (r) => {
      await r.write(`.lhr/threads/${t2}/thread.md`, FILE_THREAD);
    });
    expectOnly(diags, 'EMPTY_THREAD', `.lhr/threads/${t2}`);
  });

  it('errors on an empty message body without status or severity', async () => {
    const diags = await run(async (r) => {
      await r.write(`${THREAD_DIR}/${M1}.md`, msg(`round: ${R1}\n`, 'human', ''));
    });
    expectOnly(diags, 'EMPTY_BODY', `${THREAD_DIR}/${M1}.md`);
  });

  it('errors on a snapshot line count mismatch', async () => {
    const diags = await run(async (r) => {
      await r.write(THREAD_MD, lineThread({ snap: ['one', 'two'] }));
    });
    expectOnly(diags, 'SNAPSHOT_LINE_COUNT', THREAD_MD);
  });

  it('errors on a line thread without a snapshot fence', async () => {
    const diags = await run(async (r) => {
      await r.write(THREAD_MD, lineThread().split('---\n```')[0] + '---\nno fence\n');
    });
    expectOnly(diags, 'INVALID_VALUE', THREAD_MD);
  });

  it('errors on line-only keys missing from a line thread', async () => {
    const diags = await run(async (r) => {
      await r.write(THREAD_MD, lineThread({ drop: 'anchor.blob' }));
    });
    expectOnly(diags, 'MISSING_LINE_ANCHOR_KEY', THREAD_MD);
  });

  it('errors when endLine is before startLine', async () => {
    const diags = await run(async (r) => {
      await r.write(THREAD_MD, lineThread({ start: 3, end: 2, before: 0, after: 0, snap: ['x'] }));
    });
    expectOnly(diags, 'END_LINE_BEFORE_START', THREAD_MD);
  });

  it('errors on a message round that names a missing round', async () => {
    const diags = await run(async (r) => {
      await r.write(`${THREAD_DIR}/${M1}.md`, msg('round: 20260101T999999Z-zzzzzz\n'));
    });
    expectOnly(diags, 'UNKNOWN_ROUND', `${THREAD_DIR}/${M1}.md`);
  });

  it('errors on a duplicate clientId within a thread', async () => {
    const m3 = '20260101T100300Z-human-eeeeee';
    const diags = await run(async (r) => {
      await r.write(`${THREAD_DIR}/${M1}.md`, msg(`clientId: abc\nround: ${R1}\n`));
      await r.write(`${THREAD_DIR}/${m3}.md`, msg('clientId: abc\n'));
    });
    expectOnly(diags, 'DUPLICATE_CLIENT_ID', `${THREAD_DIR}/${m3}.md`);
  });

  it('allows the same clientId in different threads', async () => {
    const t2 = '20260102T100000Z-bbbbbb';
    const diags = await run(async (r) => {
      await r.write(`${THREAD_DIR}/${M1}.md`, msg(`clientId: abc\nround: ${R1}\n`));
      await r.write(`.lhr/threads/${t2}/thread.md`, FILE_THREAD);
      await r.write(`.lhr/threads/${t2}/${M1}.md`, msg('clientId: abc\n'));
    });
    assert.deepEqual(diags, []);
  });

  it('errors on a push record naming an unknown thread', async () => {
    const diags = await run(async (r) => {
      await r.write(
        `.lhr/pushes/${P1}.md`,
        push({ threads: { '20260909T000000Z-zzzzzz': {} }, messages: {} }),
      );
    });
    expectOnly(diags, 'PUSH_UNKNOWN_THREAD', `.lhr/pushes/${P1}.md`);
  });

  it('errors on a push record naming an unknown message', async () => {
    const diags = await run(async (r) => {
      await r.write(
        `.lhr/pushes/${P1}.md`,
        push({
          threads: {},
          messages: { '20260909T000000Z-human-zzzzzz': {} },
        }),
      );
    });
    expectOnly(diags, 'PUSH_UNKNOWN_MESSAGE', `.lhr/pushes/${P1}.md`);
  });

  it('errors on a push record body without valid json', async () => {
    const diags = await run(async (r) => {
      await r.write(
        `.lhr/pushes/${P1}.md`,
        push().split('---\n```')[0] + '---\n```json\n{oops\n```\n',
      );
    });
    expectOnly(diags, 'INVALID_PUSH_BODY', `.lhr/pushes/${P1}.md`);
  });

  it('warns on an unknown key', async () => {
    const diags = await run(async (r) => {
      await r.write(`${THREAD_DIR}/${M1}.md`, msg(`round: ${R1}\nmood: happy\n`));
    });
    expectOnly(diags, 'UNKNOWN_KEY', `${THREAD_DIR}/${M1}.md`, 'warning');
  });

  it('warns on an agent message without author.session', async () => {
    const diags = await run(async (r) => {
      await r.write(`${THREAD_DIR}/${M2}.md`, msg('', 'agent', 'ok\n', 'claude-code'));
    });
    expectOnly(diags, 'MISSING_AUTHOR_SESSION', `${THREAD_DIR}/${M2}.md`, 'warning');
  });

  it('validates drafts too', async () => {
    const t3 = '20260103T100000Z-cccccc';
    const m = '20260103T100100Z-human-eeeeee';
    const diags = await run(async (r) => {
      await r.write(`.lhr/drafts/threads/${t3}/thread.md`, FILE_THREAD);
      await r.write(`.lhr/drafts/threads/${t3}/${m}.md`, msg('severity: urgent\n'));
    });
    expectOnly(diags, 'INVALID_VALUE', `.lhr/drafts/threads/${t3}/${m}.md`);
  });

  it('does not throw on garbage files', async () => {
    const diags = await run(async (r) => {
      await r.write(`${THREAD_DIR}/20260101T100300Z-human-eeeeee.md`, '');
      await r.write(`${THREAD_DIR}/20260101T100400Z-human-ffffff.md`, '\u0000\u0001ÿþ binary');
      await r.write(`${THREAD_DIR}/20260101T100500Z-agent-gggggg.md`, '---\nno close');
      await r.write(`.lhr/rounds/20260101T130000Z-hhhhhh.md`, '');
      await r.write(`.lhr/pushes/20260101T130000Z-iiiiii.md`, '\u0000\u0000');
      await r.write('.lhr/threads/20260101T100000Z-jjjjjj/thread.md', '');
    });
    assert.ok(diags.length > 0);
    for (const d of diags) {
      assert.ok(d.code && d.path && !d.path.includes('\\'));
    }
  });
});

function has(
  diags: Diagnostic[],
  code: string,
  p: string,
  severity: 'error' | 'warning' = 'error',
): boolean {
  return diags.some((d) => d.code === code && d.path === p && d.severity === severity);
}

describe('check() reports every bad file', () => {
  it('checks messages even when thread.md is broken', async () => {
    const mAgent = '20260101T100400Z-human-bbbbbb';
    const mEmpty = '20260101T100500Z-human-hhhhhh';
    const diags = await run(async (r) => {
      await r.write(THREAD_MD, lineThread().replace('anchor.side: new', 'anchor.side: sideways'));
      await r.write(`${THREAD_DIR}/${mAgent}.md`, msg('author.session: s\n', 'agent'));
      await r.write(`${THREAD_DIR}/bad-name.md`, msg());
      await r.write(`${THREAD_DIR}/${mEmpty}.md`, msg('', 'human', ''));
    });
    assert.ok(has(diags, 'INVALID_VALUE', THREAD_MD));
    assert.ok(has(diags, 'AUTHOR_KIND_MISMATCH', `${THREAD_DIR}/${mAgent}.md`));
    assert.ok(has(diags, 'INVALID_FILE_NAME', `${THREAD_DIR}/bad-name.md`));
    assert.ok(has(diags, 'EMPTY_BODY', `${THREAD_DIR}/${mEmpty}.md`));
  });

  it('checks draft messages even when the draft thread.md is broken', async () => {
    const t3 = '20260103T100000Z-cccccc';
    const m = '20260103T100100Z-human-eeeeee';
    const diags = await run(async (r) => {
      await r.write(`.lhr/drafts/threads/${t3}/thread.md`, '---\nbroken\n---\n');
      await r.write(`.lhr/drafts/threads/${t3}/${m}.md`, msg('', 'human', ''));
    });
    assert.ok(has(diags, 'FRONTMATTER_SYNTAX', `.lhr/drafts/threads/${t3}/thread.md`));
    assert.ok(has(diags, 'EMPTY_BODY', `.lhr/drafts/threads/${t3}/${m}.md`));
  });

  it('flags the draft file for a clientId already used by a submitted message', async () => {
    const early = '20260101T090000Z-human-zzzzzz';
    const diags = await run(async (r) => {
      await r.write(`${THREAD_DIR}/${M1}.md`, msg(`clientId: abc\nround: ${R1}\n`));
      await r.write(`.lhr/drafts/threads/${T1}/${early}.md`, msg('clientId: abc\n'));
    });
    expectOnly(diags, 'DUPLICATE_CLIENT_ID', `.lhr/drafts/threads/${T1}/${early}.md`);
  });

  it('flags the later of two draft files for a duplicate clientId', async () => {
    const t3 = '20260103T100000Z-cccccc';
    const a = '20260103T100100Z-human-aaaaaa';
    const b = '20260103T100200Z-human-bbbbbb';
    const diags = await run(async (r) => {
      await r.write(`.lhr/drafts/threads/${t3}/thread.md`, FILE_THREAD);
      await r.write(`.lhr/drafts/threads/${t3}/${a}.md`, msg('clientId: q\n'));
      await r.write(`.lhr/drafts/threads/${t3}/${b}.md`, msg('clientId: q\n'));
    });
    expectOnly(diags, 'DUPLICATE_CLIENT_ID', `.lhr/drafts/threads/${t3}/${b}.md`);
  });

  const pushWith = (body: string): string => push().split('---\n```')[0] + `---\n${body}`;
  const json = '```json\n{"threads":{},"messages":{}}\n```\n';

  for (const [name, body] of [
    ['a non-json fence', '```yaml\nthreads: {}\n```\n'],
    ['no fence', 'nothing here\n'],
    ['two json fences', json + json],
  ] as const) {
    it(`errors on a push body with ${name}`, async () => {
      const diags = await run(async (r) => {
        await r.write(`.lhr/pushes/${P1}.md`, pushWith(body));
      });
      expectOnly(diags, 'INVALID_PUSH_BODY', `.lhr/pushes/${P1}.md`);
    });
  }
});

describe('check() with odd file system entries', () => {
  const NAME = '20260101T100300Z-human-eeeeee.md';

  it('reports a directory where a message file is expected', async () => {
    const diags = await run(async (r) => {
      await r.write(`${THREAD_DIR}/${NAME}/inner.txt`, 'x');
    });
    expectOnly(diags, 'UNREADABLE_FILE', `${THREAD_DIR}/${NAME}`);
  });

  it('reports directories named like thread.md, round and push files', async () => {
    const diags = await run(async (r) => {
      await rm(path.join(r.root, THREAD_MD));
      await r.write(`${THREAD_MD}/inner.txt`, 'x');
      await r.write(`.lhr/rounds/20260101T130000Z-hhhhhh.md/inner.txt`, 'x');
      await r.write(`.lhr/pushes/20260101T130000Z-iiiiii.md/inner.txt`, 'x');
    });
    assert.deepEqual(
      diags.map((d) => [d.code, d.path]),
      [
        ['UNREADABLE_FILE', THREAD_MD],
        ['UNREADABLE_FILE', '.lhr/pushes/20260101T130000Z-iiiiii.md'],
        ['UNREADABLE_FILE', '.lhr/rounds/20260101T130000Z-hhhhhh.md'],
      ].sort((a, b) => (a[1] < b[1] ? -1 : 1)),
    );
  });

  it('reports a symlinked message instead of following it', async () => {
    const other = '20260101T100400Z-human-ffffff.md';
    const diags = await run(async (r) => {
      await r.write('outside/bad.txt', '---\nno colon\n---\n');
      await r.write('outside/good.txt', msg());
      await symlink(path.join(r.root, 'outside/bad.txt'), path.join(r.root, THREAD_DIR, NAME));
      await symlink(path.join(r.root, 'outside/good.txt'), path.join(r.root, THREAD_DIR, other));
    });
    assert.deepEqual(
      diags.map((d) => [d.code, d.path, d.severity]),
      [
        ['SYMLINK', `${THREAD_DIR}/${NAME}`, 'error'],
        ['SYMLINK', `${THREAD_DIR}/${other}`, 'error'],
      ],
    );
  });

  it('reports a broken symlink', async () => {
    const diags = await run(async (r) => {
      await symlink(path.join(r.root, 'nowhere'), path.join(r.root, THREAD_DIR, NAME));
    });
    expectOnly(diags, 'SYMLINK', `${THREAD_DIR}/${NAME}`);
  });

  it('reports an unreadable file', async (t) => {
    if (process.getuid?.() === 0) return t.skip('running as root');
    const target = `${THREAD_DIR}/${NAME}`;
    let file = '';
    const diags = await run(async (r) => {
      await r.write(target, msg());
      file = path.join(r.root, target);
      await chmod(file, 0o000);
    });
    expectOnly(diags, 'UNREADABLE_FILE', target);
    void file;
  });
});

/** [code, path] pairs of check() diagnostics and load() problems, for the same tree. */
async function both(
  setup: (repo: TempRepo) => Promise<void>,
): Promise<{ check: string[][]; load: string[][]; threads: string[][] }> {
  const repo = await createTempRepo();
  try {
    await cleanTree(repo);
    await setup(repo);
    const tree = await openTree({ root: repo.root });
    try {
      const pairs = (ds: readonly Diagnostic[]): string[][] =>
        ds.map((d) => [d.code, d.path]).sort((a, b) => (a.join() < b.join() ? -1 : 1));
      const snap = await tree.load();
      return {
        check: pairs((await tree.check()).diagnostics),
        load: pairs(snap.problems),
        threads: snap
          .threads({ includeDrafts: true })
          .map((t) => [t.id, ...t.messages.map((m) => m.id)]),
      };
    } finally {
      await tree.dispose();
    }
  } finally {
    await repo.cleanup();
  }
}

describe('check() and load() agree', () => {
  const NAME = '20260101T100300Z-human-eeeeee.md';
  const T2 = '20260102T100000Z-bbbbbb';

  it('report a symlinked message and do not follow it', async () => {
    const r = await both(async (repo) => {
      await repo.write('outside/good.txt', msg());
      await symlink(
        path.join(repo.root, 'outside/good.txt'),
        path.join(repo.root, THREAD_DIR, NAME),
      );
    });
    assert.deepEqual(r.check, [['SYMLINK', `${THREAD_DIR}/${NAME}`]]);
    assert.deepEqual(r.load, r.check);
    assert.deepEqual(r.threads, [[T1, M1, M2]]);
  });

  it('report a symlinked thread directory, thread.md and round file', async () => {
    const r2 = '20260101T120100Z-hhhhhh';
    const r = await both(async (repo) => {
      await repo.write(`outside/${T2}/thread.md`, FILE_THREAD);
      await repo.write(`outside/${T2}/${M1}.md`, msg());
      await symlink(path.join(repo.root, 'outside', T2), path.join(repo.root, '.lhr/threads', T2));
      await repo.write('outside/round.md', ROUND);
      await symlink(
        path.join(repo.root, 'outside/round.md'),
        path.join(repo.root, `.lhr/rounds/${r2}.md`),
      );
      await rm(path.join(repo.root, THREAD_MD));
      await symlink(
        path.join(repo.root, `outside/${T2}/thread.md`),
        path.join(repo.root, THREAD_MD),
      );
    });
    assert.deepEqual(r.check, [
      ['SYMLINK', `.lhr/rounds/${r2}.md`],
      ['SYMLINK', THREAD_MD],
      ['SYMLINK', `.lhr/threads/${T2}`],
    ]);
    assert.deepEqual(r.load, r.check);
    assert.deepEqual(r.threads, []);
  });

  it('report EMPTY_THREAD when every message of a submitted thread is invalid', async () => {
    const r = await both(async (repo) => {
      await repo.write(`${THREAD_DIR}/${M1}.md`, '---\nno colon\n---\n');
      await repo.write(`${THREAD_DIR}/${M2}.md`, msg('author.session: s1\n', 'agent', ''));
    });
    assert.deepEqual(r.check, [
      ['EMPTY_BODY', `${THREAD_DIR}/${M2}.md`],
      ['EMPTY_THREAD', THREAD_DIR],
      ['FRONTMATTER_SYNTAX', `${THREAD_DIR}/${M1}.md`],
    ]);
    assert.deepEqual(r.load, r.check);
  });

  it('do not flag a leftover draft copy of a submitted message as a duplicate', async () => {
    const r = await both(async (repo) => {
      await repo.write(`${THREAD_DIR}/${M1}.md`, msg(`clientId: abc\nround: ${R1}\n`));
      await repo.write(`.lhr/drafts/threads/${T1}/${M1}.md`, msg('clientId: abc\n'));
    });
    assert.deepEqual(r.check, []);
    assert.deepEqual(r.load, []);
    assert.deepEqual(r.threads, [[T1, M1, M2]]);
  });

  it('keep a valid draft whose submitted copy is broken (failed publish)', async () => {
    const r = await both(async (repo) => {
      await rm(path.join(repo.root, THREAD_DIR, `${M2}.md`));
      await repo.write(`${THREAD_DIR}/${M1}.md`, '---\nno colon\n---\n');
      await repo.write(`.lhr/drafts/threads/${T1}/${M1}.md`, msg('clientId: abc\n'));
    });
    assert.deepEqual(r.check, [['FRONTMATTER_SYNTAX', `${THREAD_DIR}/${M1}.md`]]);
    assert.deepEqual(r.load, r.check);
    assert.deepEqual(r.threads, [[T1, M1]]);
  });

  it('keep a valid draft whose submitted copy is broken, next to valid messages', async () => {
    const r = await both(async (repo) => {
      await repo.write(`${THREAD_DIR}/${M1}.md`, msg(`clientId: abc\nround: ${R1}\n`));
      await repo.write(`${THREAD_DIR}/${NAME}`, '---\nno colon\n---\n');
      await repo.write(`.lhr/drafts/threads/${T1}/${NAME}`, msg('clientId: abc\n'));
    });
    assert.deepEqual(r.check, [
      ['DUPLICATE_CLIENT_ID', `.lhr/drafts/threads/${T1}/${NAME}`],
      ['FRONTMATTER_SYNTAX', `${THREAD_DIR}/${NAME}`],
    ]);
    assert.deepEqual(r.load, [['FRONTMATTER_SYNTAX', `${THREAD_DIR}/${NAME}`]]);
    assert.deepEqual(r.threads, [[T1, M1, M2, NAME.slice(0, -3)]]);
  });

  it('report a FIFO where a message or thread.md is expected', async (t) => {
    if (process.platform === 'win32') return t.skip('no FIFOs on Windows');
    const r = await both(async (repo) => {
      await repo.write(`.lhr/threads/${T2}/${M1}.md`, msg());
      execFileSync('mkfifo', [
        path.join(repo.root, THREAD_DIR, NAME),
        path.join(repo.root, `.lhr/threads/${T2}/thread.md`),
      ]);
    });
    assert.deepEqual(r.check, [
      ['UNREADABLE_FILE', `${THREAD_DIR}/${NAME}`],
      ['UNREADABLE_FILE', `.lhr/threads/${T2}/thread.md`],
    ]);
    assert.deepEqual(r.load, r.check);
    assert.deepEqual(r.threads, [[T1, M1, M2]]);
  });

  it('ignore a symlinked leftover draft thread.md next to a submitted thread', async () => {
    const r = await both(async (repo) => {
      await repo.write(`.lhr/drafts/threads/${T1}/${NAME}`, msg());
      await symlink(
        path.join(repo.root, THREAD_MD),
        path.join(repo.root, `.lhr/drafts/threads/${T1}/thread.md`),
      );
    });
    assert.deepEqual(r.check, []);
    assert.deepEqual(r.load, []);
  });

  it('ignore a leftover draft thread.md next to a submitted thread', async () => {
    const r = await both(async (repo) => {
      await repo.write(`.lhr/drafts/threads/${T1}/thread.md`, 'garbage');
      await repo.write(`.lhr/drafts/threads/${T1}/${NAME}`, msg());
    });
    assert.deepEqual(r.check, []);
    assert.deepEqual(r.load, []);
  });
});
