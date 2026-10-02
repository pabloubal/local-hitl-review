// Ports the re-anchoring prototype's scenarios (branch prototype/re-anchoring,
// prototypes/re-anchoring/reanchor.prototype.mjs) onto lhr.anchors(), on real
// temporary git repos. Scenario numbers match the prototype README.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, readFile, rename, symlink, unlink, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import {
  openTree,
  serializeFrontmatter,
  type AnchorResult,
  type LhrTree,
  type ThreadView,
} from '../src/index.js';
import { createTempDir, createTempRepo, type TempRepo } from './helpers/tempRepo.js';

const L = (i: number): string => `const v${i} = compute(${i});`;
const base30 = (): string[] => Array.from({ length: 30 }, (_, i) => L(i + 1));
const text = (lines: string[]): string => (lines.length ? `${lines.join('\n')}\n` : '');

function splitLines(content: string): string[] {
  if (content === '') return [];
  const ls = content.split('\n');
  if (ls[ls.length - 1] === '') ls.pop();
  return ls;
}

let counter = 0;

function view(anchor: ThreadView['anchor'], snapshot?: string): ThreadView {
  counter++;
  const t: ThreadView = {
    id: `20261001T120000Z-t${String(counter).padStart(5, '0')}`,
    createdAt: new Date('2026-10-01T12:00:00Z'),
    anchor,
    messages: [],
    isDraft: false,
    status: 'open',
    severity: 'medium',
    whoseTurn: 'agent',
    reviewer: { kind: 'human', name: 'Tester' },
  };
  if (snapshot !== undefined) t.snapshot = snapshot;
  return t;
}

async function head(repo: TempRepo): Promise<{ commit: string; branch?: string }> {
  const commit = (await repo.git('rev-parse', 'HEAD')).trim();
  const branch = (await repo.git('branch', '--show-current')).trim();
  return branch ? { commit, branch } : { commit };
}

interface AnchorOpts {
  /** Blob to store instead of the real one (simulates a pruned blob). */
  blob?: string;
  side?: 'new' | 'old';
  commit?: string;
}

/** Captures a line anchor the way #70 will: blob, commit, branch, snapshot. */
async function lineThread(
  repo: TempRepo,
  relPath: string,
  start: number,
  end: number,
  opts: AnchorOpts = {},
): Promise<ThreadView> {
  const content = await readFile(path.join(repo.root, relPath), 'utf8');
  const lines = splitLines(content);
  const cb = Math.min(3, start - 1);
  const ca = Math.min(3, lines.length - end);
  const blob =
    opts.blob ??
    (await repo.git('hash-object', '-w', '--no-filters', '--', relPath)).trim();
  const h = await head(repo);
  const snapshot = lines.slice(start - 1 - cb, end + ca).join('\n');
  return view(
    {
      kind: 'line',
      path: relPath,
      side: opts.side ?? 'new',
      commit: opts.commit ?? h.commit,
      ...(h.branch ? { branch: h.branch } : {}),
      blob,
      startLine: start,
      endLine: end,
      contextBefore: cb,
      contextAfter: ca,
    },
    snapshot,
  );
}

async function fileThread(repo: TempRepo, relPath: string): Promise<ThreadView> {
  const h = await head(repo);
  return view({
    kind: 'file',
    path: relPath,
    side: 'new',
    commit: h.commit,
    ...(h.branch ? { branch: h.branch } : {}),
  });
}

async function setupRepo(files: Record<string, string[]>): Promise<TempRepo> {
  const repo = await createTempRepo();
  for (const [p, lines] of Object.entries(files)) await repo.write(p, text(lines));
  await commitAll(repo, 'init');
  return repo;
}

async function commitAll(repo: TempRepo, msg: string): Promise<void> {
  await repo.git('add', '-A');
  await repo.git('commit', '-q', '-m', msg);
}

async function withRepo(
  files: Record<string, string[]>,
  fn: (repo: TempRepo) => Promise<void>,
): Promise<void> {
  const repo = await setupRepo(files);
  try {
    await fn(repo);
  } finally {
    await repo.cleanup();
  }
}

async function anchorAll(
  repo: TempRepo,
  threads: ThreadView[],
  overrides?: Map<string, string>,
): Promise<Map<string, AnchorResult>> {
  const tree: LhrTree = await openTree({ root: repo.root });
  try {
    return await tree.anchors(threads, overrides ? { overrides } : undefined);
  } finally {
    await tree.dispose();
  }
}

async function anchorOne(
  repo: TempRepo,
  t: ThreadView,
  overrides?: Map<string, string>,
): Promise<AnchorResult> {
  const r = (await anchorAll(repo, [t], overrides)).get(t.id);
  assert.ok(r, `no result for ${t.id}`);
  return r;
}

/** Compact form matching the prototype README's "Actual" column. */
function fmt(r: AnchorResult, t: ThreadView): string {
  let s: string = r.state;
  if (r.state !== 'orphaned') {
    const p = r.path !== t.anchor.path ? `${r.path}:` : '';
    s += ` ${p}${r.startLine}-${r.endLine}`;
  } else {
    assert.equal(r.startLine, undefined);
    assert.equal(r.endLine, undefined);
  }
  if (r.fromBranch) s += ` [from branch ${r.fromBranch}]`;
  return s;
}

async function expectOne(
  repo: TempRepo,
  t: ThreadView,
  expected: string,
  method: AnchorResult['method'],
): Promise<AnchorResult> {
  const r = await anchorOne(repo, t);
  assert.equal(fmt(r, t), expected);
  assert.equal(r.method, method);
  return r;
}

const MISSING_BLOB = 'f'.repeat(40);

describe('LhrTree.anchors: diff mapping (scenarios 1-3)', () => {
  it('1: insert 5 lines above -> current, shifted', async () => {
    await withRepo({ 'a.ts': base30() }, async (repo) => {
      const t = await lineThread(repo, 'a.ts', 10, 12);
      const l = base30();
      l.splice(2, 0, ...Array.from({ length: 5 }, (_, i) => `// inserted ${i}`));
      await repo.write('a.ts', text(l));
      await expectOne(repo, t, 'current 15-17', 'diff');
    });
  });

  it('2: edit an anchored line -> outdated', async () => {
    await withRepo({ 'a.ts': base30() }, async (repo) => {
      const t = await lineThread(repo, 'a.ts', 10, 12);
      const l = base30();
      l[10] = 'const v11 = compute(11) + 1;';
      await repo.write('a.ts', text(l));
      await expectOne(repo, t, 'outdated 10-12', 'diff');
    });
  });

  const code = [
    'function f(x) {',
    '  let y = 0;',
    '  if (x) {',
    '    y = 1;',
    '  }',
    '  if (x > 1) {',
    '    y = 2;',
    '  }',
    '  return y;',
    '}',
  ];
  const cases: Array<[string, string[], number, number, (l: string[]) => void, string]> = [
    ['3a: edit far above + far below', base30(), 10, 12, (l) => {
      l[2] += ' // e';
      l[24] += ' // e';
    }, 'current 10-12'],
    ['3b: edit line adjacent above + below', base30(), 10, 12, (l) => {
      l[8] += ' // e';
      l[12] += ' // e';
    }, 'current 10-12'],
    ['3c: insert directly above + directly below', base30(), 10, 12, (l) => {
      l.splice(12, 0, '// below');
      l.splice(9, 0, '// above');
    }, 'current 11-13'],
    ['3d: delete adjacent line above + below', base30(), 10, 12, (l) => {
      l.splice(12, 1);
      l.splice(8, 1);
    }, 'current 9-11'],
    ['3e: slider: block ending "  }" inserted below', code, 3, 5, (l) => {
      l.splice(5, 0, '  if (z) {', '    y = 9;', '  }');
    }, 'current 3-5'],
    ['3f: slider: block starting like range inserted above', code, 6, 8, (l) => {
      l.splice(5, 0, '  if (x > 1) {', '    y = 5;', '  }');
    }, 'current 9-11'],
    ['3g: slider: copy of anchored block pasted below', base30(), 10, 12, (l) => {
      l.splice(12, 0, L(10), L(11), L(12));
    }, 'current 10-12'],
    ['3h: slider: delete block below ending "  }"', code, 3, 5, (l) => {
      l.splice(5, 3);
    }, 'current 3-5'],
  ];
  for (const [name, initial, s, e, mutate, expected] of cases) {
    it(name, async () => {
      await withRepo({ 'a.ts': initial }, async (repo) => {
        const t = await lineThread(repo, 'a.ts', s, e);
        const l = [...initial];
        mutate(l);
        await repo.write('a.ts', text(l));
        await expectOne(repo, t, expected, 'diff');
      });
    });
  }
});

describe('LhrTree.anchors: deletes and moves (scenario 4)', () => {
  it('4a: anchored lines deleted -> orphaned', async () => {
    await withRepo({ 'a.ts': base30() }, async (repo) => {
      const t = await lineThread(repo, 'a.ts', 10, 12);
      const l = base30();
      l.splice(9, 3);
      await repo.write('a.ts', text(l));
      await expectOne(repo, t, 'orphaned', 'diff');
    });
  });

  it('4b: partial delete -> outdated, range keeps its original size', async () => {
    // Prototype got "outdated 10-11" (surviving lines). ADR 0006 changed the
    // rule: an outdated range starts at the mapped start and keeps the anchor's
    // line count, so 10-14.
    await withRepo({ 'a.ts': base30() }, async (repo) => {
      const t = await lineThread(repo, 'a.ts', 10, 14);
      const l = base30();
      l.splice(11, 3);
      await repo.write('a.ts', text(l));
      await expectOne(repo, t, 'outdated 10-14', 'diff');
    });
  });

  it('4b (text): partial delete with the blob gone -> outdated, original size', async () => {
    await withRepo({ 'a.ts': base30() }, async (repo) => {
      const t = await lineThread(repo, 'a.ts', 10, 14, { blob: MISSING_BLOB });
      const l = base30();
      l.splice(11, 3);
      await repo.write('a.ts', text(l));
      await expectOne(repo, t, 'outdated 10-14', 'text-search');
    });
  });

  it('4c: anchored block moved within the file -> current, method moved', async () => {
    await withRepo({ 'a.ts': base30() }, async (repo) => {
      const t = await lineThread(repo, 'a.ts', 10, 12);
      const l = base30();
      const blk = l.splice(9, 3);
      l.splice(22, 0, ...blk);
      await repo.write('a.ts', text(l));
      await expectOne(repo, t, 'current 23-25', 'moved');
    });
  });

  it('4c: deleting one of two identical blocks does not move the thread to the other', async () => {
    const blk = ['function dup(a) {', '  const r = a * 2;', '  return r;', '}'];
    const file = (): string[] => {
      const l = base30();
      l.splice(20, 0, ...blk);
      l.splice(4, 0, ...blk);
      return l;
    };
    await withRepo({ 'a.ts': file() }, async (repo) => {
      const t = await lineThread(repo, 'a.ts', 5, 8);
      const l = file();
      l.splice(4, 4);
      await repo.write('a.ts', text(l));
      await expectOne(repo, t, 'orphaned', 'diff');
    });
  });

  it('4d: file deleted -> orphaned, method path', async () => {
    await withRepo({ 'a.ts': base30() }, async (repo) => {
      const t = await lineThread(repo, 'a.ts', 10, 12);
      await unlink(path.join(repo.root, 'a.ts'));
      const r = await expectOne(repo, t, 'orphaned', 'path');
      assert.equal(r.path, 'a.ts');
    });
  });

  it('outdated range is clamped to the end of the file', async () => {
    await withRepo({ 'a.ts': base30() }, async (repo) => {
      const t = await lineThread(repo, 'a.ts', 26, 30);
      await repo.write('a.ts', text([...base30().slice(0, 26), 'changed']));
      await expectOne(repo, t, 'outdated 26-27', 'diff');
    });
  });
});

describe('LhrTree.anchors: renames (scenario 5)', () => {
  const ins2edit = async (repo: TempRepo, editAnchored: boolean): Promise<void> => {
    const l = base30();
    if (editAnchored) l[10] += ' // edited';
    else l[24] += ' // edited';
    l.splice(1, 0, '// x', '// y');
    await repo.write('src/b.ts', text(l));
  };
  const mv = (repo: TempRepo): Promise<void> =>
    rename(path.join(repo.root, 'src/a.ts'), path.join(repo.root, 'src/b.ts'));

  const cases: Array<[string, (repo: TempRepo) => Promise<void>, string, AnchorResult['method']]> = [
    ['5a: git mv, committed', async (repo) => {
      await repo.git('mv', 'src/a.ts', 'src/b.ts');
      await commitAll(repo, 'mv');
    }, 'current src/b.ts:10-12', 'diff'],
    ['5b: git mv, staged not committed', async (repo) => {
      await repo.git('mv', 'src/a.ts', 'src/b.ts');
    }, 'current src/b.ts:10-12', 'diff'],
    ['5c: plain mv (new name untracked)', mv, 'current src/b.ts:10-12', 'diff'],
    ['5d: git mv committed + anchored line edited', async (repo) => {
      await repo.git('mv', 'src/a.ts', 'src/b.ts');
      await commitAll(repo, 'mv');
      await ins2edit(repo, true);
    }, 'outdated src/b.ts:12-14', 'diff'],
    ['5e: git mv committed + edit elsewhere', async (repo) => {
      await repo.git('mv', 'src/a.ts', 'src/b.ts');
      await commitAll(repo, 'mv');
      await ins2edit(repo, false);
    }, 'current src/b.ts:12-14', 'diff'],
    // 5f, KNOWN LIMITATION (ADR 0006 "Accepted limitation"): a plain mv (new
    // name untracked) plus an edit to the anchored lines comes out orphaned,
    // because git diff -M can't see untracked files and the content no longer
    // matches. The truth is "outdated src/b.ts:12-14"; staging the rename fixes it.
    ['5f: plain mv + anchored line edited (known limitation)', async (repo) => {
      await unlink(path.join(repo.root, 'src/a.ts'));
      await ins2edit(repo, true);
    }, 'orphaned', 'path'],
    ['5f staged: git mv + anchored line edited resolves once staged', async (repo) => {
      await repo.git('mv', 'src/a.ts', 'src/b.ts');
      await ins2edit(repo, true);
    }, 'outdated src/b.ts:12-14', 'diff'],
  ];
  for (const [name, act, expected, method] of cases) {
    it(name, async () => {
      await withRepo({ 'src/a.ts': base30() }, async (repo) => {
        const t = await lineThread(repo, 'src/a.ts', 10, 12);
        await act(repo);
        await expectOne(repo, t, expected, method);
      });
    });
  }

  it('prefers the untracked file with the same basename', async () => {
    await withRepo({ 'src/a.ts': base30() }, async (repo) => {
      const t = await lineThread(repo, 'src/a.ts', 10, 12);
      await repo.write('other/copy.ts', text(base30()));
      await repo.write('lib/a.ts', text(base30()));
      await unlink(path.join(repo.root, 'src/a.ts'));
      const r = await anchorOne(repo, t);
      assert.equal(fmt(r, t), 'current lib/a.ts:10-12');
    });
  });
});

describe('LhrTree.anchors: duplicated code (scenario 6)', () => {
  const F = ['function dup(a) {', '  const r = a * 2;', '  return r;', '}'];
  const dupFile = [
    '// file', 'import x;', '', ...F, '', 'const mid = 1;', 'const mid2 = 2;', '', ...F, '',
    'const tail = 1;',
  ];
  const mutateDup = (repo: TempRepo): Promise<void> => {
    const l = [...dupFile];
    l.splice(1, 0, ...Array.from({ length: 6 }, (_, i) => `// header ${i}`));
    return repo.write('a.ts', text(l));
  };
  const F5 = ['function target(a) {', '  const r = a * 2;', '  log(r);', '  return r;', '}'];
  const tFile = (): string[] => {
    const l = base30();
    l.splice(9, 5, ...F5);
    return l;
  };
  const mutateCopy = (repo: TempRepo): Promise<void> => {
    const l = tFile();
    l.splice(7, 0, ...F5, '');
    return repo.write('a.ts', text(l));
  };

  it('6a: duplicate fn, 6 lines above (diff)', async () => {
    await withRepo({ 'a.ts': dupFile }, async (repo) => {
      const t = await lineThread(repo, 'a.ts', 12, 15);
      await mutateDup(repo);
      await expectOne(repo, t, 'current 18-21', 'diff');
    });
  });

  it('6b: duplicate fn, 6 lines above (text search ranks by context)', async () => {
    await withRepo({ 'a.ts': dupFile }, async (repo) => {
      const t = await lineThread(repo, 'a.ts', 12, 15, { blob: MISSING_BLOB });
      await mutateDup(repo);
      await expectOne(repo, t, 'current 18-21', 'text-search');
    });
  });

  it('6c: copy inserted above the original (diff)', async () => {
    await withRepo({ 'a.ts': tFile() }, async (repo) => {
      const t = await lineThread(repo, 'a.ts', 10, 14);
      await mutateCopy(repo);
      await expectOne(repo, t, 'current 16-20', 'diff');
    });
  });

  it('6d: copy inserted above the original (text search ranks by context)', async () => {
    await withRepo({ 'a.ts': tFile() }, async (repo) => {
      const t = await lineThread(repo, 'a.ts', 10, 14, { blob: MISSING_BLOB });
      await mutateCopy(repo);
      await expectOne(repo, t, 'current 16-20', 'text-search');
    });
  });
});

describe('LhrTree.anchors: pruned blobs (scenario 7)', () => {
  const run = (
    name: string,
    mutate: (l: string[]) => void,
    expected: string,
  ): void => {
    it(name, async () => {
      await withRepo({ 'a.ts': base30() }, async (repo) => {
        const l0 = base30();
        l0[4] += ' // uncommitted';
        await repo.write('a.ts', text(l0));
        const t = await lineThread(repo, 'a.ts', 10, 12);
        const l = [...l0];
        mutate(l);
        await repo.write('a.ts', text(l));
        await repo.git('reflog', 'expire', '--expire=now', '--all');
        await repo.git('gc', '-q', '--prune=now');
        assert.equal(t.anchor.kind, 'line');
        const blob = t.anchor.kind === 'line' ? t.anchor.blob : '';
        await assert.rejects(repo.git('cat-file', '-e', blob), 'blob should be pruned');
        await expectOne(repo, t, expected, 'text-search');
      });
    });
  };
  run("7a: blob gc'd, 4 lines above -> current", (l) => {
    l.splice(0, 0, '// 1', '// 2', '// 3', '// 4');
  }, 'current 14-16');
  run("7b: blob gc'd, anchored line edited -> outdated", (l) => {
    l[10] += ' // edit';
    l.splice(0, 0, '// 1', '// 2', '// 3', '// 4');
  }, 'outdated 14-16');
  // 7c was a prototype miss (it needed both context sides and got orphaned).
  // ADR 0006 counts one matching context side as enough, so the engine now gets
  // the true answer.
  run("7c: blob gc'd, anchored + context line edited -> outdated", (l) => {
    l[10] += ' // edit';
    l[8] += ' // edit';
    l.splice(0, 0, '// 1', '// 2', '// 3', '// 4');
  }, 'outdated 14-16');
  run("blob gc'd, anchored lines deleted between intact context -> orphaned", (l) => {
    l.splice(9, 3);
  }, 'orphaned');
});

describe('LhrTree.anchors: text search tolerance', () => {
  it('quote and whitespace changes are found and reported outdated', async () => {
    const before = [...base30()];
    before[9] = "const s = 'hello';";
    await withRepo({ 'a.ts': before }, async (repo) => {
      const t = await lineThread(repo, 'a.ts', 10, 10, { blob: MISSING_BLOB });
      const l = [...before];
      l[9] = 'const s  =  "hello";';
      for (let i = 6; i < 13; i++) if (i !== 9) l[i] = `  ${l[i]}`;
      l.splice(0, 0, '// a', '// b');
      await repo.write('a.ts', text(l));
      await expectOne(repo, t, 'outdated 12-12', 'text-search');
    });
  });

  it('no snapshot and no blob -> orphaned', async () => {
    await withRepo({ 'a.ts': base30() }, async (repo) => {
      const t = await lineThread(repo, 'a.ts', 10, 12, { blob: MISSING_BLOB });
      delete t.snapshot;
      await expectOne(repo, t, 'orphaned', 'text-search');
    });
  });
});

describe('LhrTree.anchors: branches (scenario 8)', () => {
  async function setup(repo: TempRepo): Promise<{ A: ThreadView; B: ThreadView; main: string }> {
    const main = (await repo.git('branch', '--show-current')).trim();
    await repo.git('checkout', '-q', '-b', 'feature');
    const l = base30();
    l.splice(10, 0, 'function feat() {', '  return 42;', '}', '');
    await repo.write('a.ts', text(l));
    await commitAll(repo, 'feature work');
    const A = await lineThread(repo, 'a.ts', 11, 13);
    const B = await lineThread(repo, 'a.ts', 20, 22);
    await repo.git('checkout', '-q', main);
    return { A, B, main };
  }

  it('8a-8d: labelled on main, cleared after a real merge', async () => {
    await withRepo({ 'a.ts': base30() }, async (repo) => {
      const { A, B } = await setup(repo);
      await expectOne(repo, A, 'orphaned [from branch feature]', 'diff');
      await expectOne(repo, B, 'current 16-18 [from branch feature]', 'diff');
      await repo.git('merge', '-q', '--no-ff', '-m', 'merge feature', 'feature');
      await expectOne(repo, A, 'current 11-13', 'diff');
      await expectOne(repo, B, 'current 20-22', 'diff');
    });
  });

  it('no label while on the anchor branch', async () => {
    await withRepo({ 'a.ts': base30() }, async (repo) => {
      const { B } = await setup(repo);
      await repo.git('checkout', '-q', 'feature');
      await expectOne(repo, B, 'current 20-22', 'diff');
    });
  });

  // 8e, KNOWN LIMITATION: after a squash merge anchor.commit is never an
  // ancestor of HEAD, so the label stays while the branch still exists. The
  // prototype expected "current 20-22"; ADR 0006 accepts the label until the
  // branch is deleted, which is asserted next.
  it('8e: squash merge keeps the label while the branch exists (known limitation)', async () => {
    await withRepo({ 'a.ts': base30() }, async (repo) => {
      const { B } = await setup(repo);
      await repo.git('merge', '-q', '--squash', 'feature');
      await repo.git('commit', '-q', '-m', 'squash');
      await expectOne(repo, B, 'current 20-22 [from branch feature]', 'diff');
      await repo.git('branch', '-q', '-D', 'feature');
      await expectOne(repo, B, 'current 20-22', 'diff');
    });
  });

  it('no label when the anchor has no branch (detached at creation)', async () => {
    await withRepo({ 'a.ts': base30() }, async (repo) => {
      const { B } = await setup(repo);
      delete B.anchor.branch;
      await expectOne(repo, B, 'current 16-18', 'diff');
    });
  });
});

describe('LhrTree.anchors: large files (scenario 9a)', () => {
  function rng(seed: number): () => number {
    return () => {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  for (const N of [10_000, 100_000]) {
    it(`9a: ${N / 1000}k lines, 300 edits, thread near the end`, async () => {
      const initial = Array.from(
        { length: N },
        (_, i) => `const v${i + 1} = compute(${i + 1}); // line ${i + 1}`,
      );
      await withRepo({ 'big.ts': initial }, async (repo) => {
        const S = N - 10;
        const E = N - 8;
        const t = await lineThread(repo, 'big.ts', S, E);
        const lines = [...initial];
        const rand = rng(N);
        const pos = new Set<number>();
        while (pos.size < 300) pos.add(1 + Math.floor(rand() * (N - 20)));
        let inserts = 0;
        for (const p of [...pos].sort((a, b) => b - a)) {
          if (rand() < 1 / 3) {
            lines.splice(p, 0, `// inserted after ${p}`);
            inserts++;
          } else lines[p - 1] += ' // edited';
        }
        await repo.write('big.ts', text(lines));
        await expectOne(repo, t, `current ${S + inserts}-${E + inserts}`, 'diff');
        const tt = await lineThread(repo, 'big.ts', S, E, { blob: MISSING_BLOB });
        // Re-captured on the new content; text search must find it in place.
        await expectOne(repo, tt, `current ${S}-${E}`, 'text-search');
      });
    });
  }
});

describe('LhrTree.anchors: file threads, old side, overrides, batching', () => {
  it('file threads are current while the file exists, following renames', async () => {
    await withRepo({ 'src/a.ts': base30(), 'src/c.ts': ['c'] }, async (repo) => {
      const a = await fileThread(repo, 'src/a.ts');
      const c = await fileThread(repo, 'src/c.ts');
      const gone = await fileThread(repo, 'src/gone.ts');
      await repo.git('mv', 'src/a.ts', 'src/b.ts');
      const res = await anchorAll(repo, [a, c, gone]);
      assert.deepEqual(res.get(a.id), { state: 'current', path: 'src/b.ts', method: 'path' });
      assert.deepEqual(res.get(c.id), { state: 'current', path: 'src/c.ts', method: 'path' });
      assert.deepEqual(res.get(gone.id), {
        state: 'orphaned',
        path: 'src/gone.ts',
        method: 'path',
      });
    });
  });

  it('file thread follows a plain mv with identical content', async () => {
    await withRepo({ 'src/a.ts': base30() }, async (repo) => {
      const a = await fileThread(repo, 'src/a.ts');
      await rename(path.join(repo.root, 'src/a.ts'), path.join(repo.root, 'src/z.ts'));
      const r = await anchorOne(repo, a);
      assert.deepEqual(r, { state: 'current', path: 'src/z.ts', method: 'path' });
    });
  });

  it('old-side threads are pinned to their saved lines', async () => {
    await withRepo({ 'a.ts': base30() }, async (repo) => {
      const t = await lineThread(repo, 'a.ts', 10, 12, { side: 'old' });
      const l = base30();
      l.splice(0, 0, '// moved everything');
      l[12] = 'changed';
      await repo.write('a.ts', text(l));
      await commitAll(repo, 'change');
      await expectOne(repo, t, 'current 10-12', 'pinned');
    });
  });

  it('old-side thread: unreachable commit, snapshot only in blob or file -> pinned', async () => {
    await withRepo({ 'a.ts': base30() }, async (repo) => {
      const withBlob = await lineThread(repo, 'a.ts', 10, 12, {
        side: 'old',
        commit: 'b'.repeat(40),
      });
      await expectOne(repo, withBlob, 'current 10-12', 'pinned');
      const inFile = await lineThread(repo, 'a.ts', 10, 12, {
        side: 'old',
        commit: 'b'.repeat(40),
        blob: MISSING_BLOB,
      });
      await expectOne(repo, inFile, 'current 10-12', 'pinned');
    });
  });

  it('old-side thread: unreachable commit and snapshot not found -> orphaned', async () => {
    await withRepo({ 'a.ts': base30() }, async (repo) => {
      const t = await lineThread(repo, 'a.ts', 10, 12, {
        side: 'old',
        commit: 'b'.repeat(40),
        blob: MISSING_BLOB,
      });
      const l = base30();
      l.splice(8, 5, 'gone');
      await repo.write('a.ts', text(l));
      await expectOne(repo, t, 'orphaned', 'pinned');
    });
  });

  it('overrides replace the content on disk', async () => {
    await withRepo({ 'a.ts': base30() }, async (repo) => {
      const t = await lineThread(repo, 'a.ts', 10, 12);
      const l = base30();
      l.splice(0, 0, '// unsaved 1', '// unsaved 2');
      const r = await anchorOne(repo, t, new Map([['a.ts', text(l)]]));
      assert.equal(fmt(r, t), 'current 12-14');
      assert.equal(r.method, 'diff');
      const edited = base30();
      edited[10] = 'unsaved edit';
      const r2 = await anchorOne(repo, t, new Map([['a.ts', text(edited)]]));
      assert.equal(fmt(r2, t), 'outdated 10-12');
    });
  });

  it('an override keeps a thread alive when the file is gone on disk', async () => {
    await withRepo({ 'a.ts': base30() }, async (repo) => {
      const t = await lineThread(repo, 'a.ts', 10, 12);
      const f = await fileThread(repo, 'a.ts');
      await unlink(path.join(repo.root, 'a.ts'));
      const res = await anchorAll(repo, [t, f], new Map([['a.ts', text(base30())]]));
      assert.equal(fmt(res.get(t.id) as AnchorResult, t), 'current 10-12');
      assert.equal(res.get(f.id)?.state, 'current');
    });
  });

  it('paths outside the repo are orphaned, not read', async () => {
    await withRepo({ 'a.ts': base30() }, async (repo) => {
      const f = await fileThread(repo, 'a.ts');
      f.anchor.path = '../outside.ts';
      const r = await anchorOne(repo, f);
      assert.equal(r.state, 'orphaned');
    });
  });

  it('returns an empty map for no threads and keys results by thread id', async () => {
    await withRepo({ 'a.ts': base30(), 'b.ts': base30() }, async (repo) => {
      assert.equal((await anchorAll(repo, [])).size, 0);
      const ts = [
        await lineThread(repo, 'a.ts', 1, 1),
        await lineThread(repo, 'a.ts', 30, 30),
        await lineThread(repo, 'b.ts', 5, 9),
      ];
      const res = await anchorAll(repo, ts);
      assert.deepEqual(
        ts.map((t) => fmt(res.get(t.id) as AnchorResult, t)),
        ['current 1-1', 'current 30-30', 'current 5-9'],
      );
    });
  });

  it('anchors threads loaded from hand-written .lhr files', async () => {
    await withRepo({ 'a.ts': base30() }, async (repo) => {
      const captured = await lineThread(repo, 'a.ts', 10, 12);
      const a = captured.anchor;
      assert.equal(a.kind, 'line');
      if (a.kind !== 'line') return;
      const id = '20261001T120000Z-abcdef';
      const data = {
        'anchor.kind': a.kind,
        'anchor.path': a.path,
        'anchor.side': a.side,
        'anchor.commit': a.commit,
        'anchor.blob': a.blob,
        'anchor.startLine': a.startLine,
        'anchor.endLine': a.endLine,
        'anchor.contextBefore': a.contextBefore,
        'anchor.contextAfter': a.contextAfter,
      };
      await repo.write(
        `.lhr/threads/${id}/thread.md`,
        serializeFrontmatter(data, `\`\`\`ts\n${captured.snapshot ?? ''}\n\`\`\`\n`),
      );
      await repo.write(
        `.lhr/threads/${id}/20261001T120100Z-human-abcdef.md`,
        '---\nauthor.kind: human\nauthor.name: Pablo\n---\nbody\n',
      );
      const l = base30();
      l.splice(0, 0, '// one');
      await repo.write('a.ts', text(l));
      const tree = await openTree({ root: repo.root });
      try {
        const snap = await tree.load();
        assert.deepEqual(snap.problems, []);
        const res = await tree.anchors(snap.threads());
        assert.deepEqual(res.get(id), {
          state: 'current',
          path: 'a.ts',
          startLine: 11,
          endLine: 13,
          method: 'diff',
        });
      } finally {
        await tree.dispose();
      }
    });
  });
});

describe('LhrTree.anchors: robustness', () => {
  it('3b with diff.interHunkContext=3 and other diff config stays current', async () => {
    await withRepo({ 'a.ts': base30() }, async (repo) => {
      await repo.git('config', 'diff.interHunkContext', '3');
      await repo.git('config', 'diff.noprefix', 'true');
      await repo.git('config', 'diff.relative', 'true');
      await repo.git('config', 'color.ui', 'always');
      const t = await lineThread(repo, 'a.ts', 10, 12);
      const l = base30();
      l[8] += ' // e';
      l[12] += ' // e';
      await repo.write('a.ts', text(l));
      await expectOne(repo, t, 'current 10-12', 'diff');
    });
  });

  const replace = (l: string[], from: number, count: number, n: number): void => {
    l.splice(from - 1, count, ...Array.from({ length: n }, (_, i) => `// replaced ${i}`));
  };
  const overlap: Array<[string, (l: string[]) => void, string]> = [
    // Anchor 10-14, old lines 5-10 replaced (-5,6 +5,6): the first anchored
    // line maps into the hunk at the same offset, not to the hunk's first line.
    ['replacement overlapping from above, same size', (l) => replace(l, 5, 6, 6), 'outdated 10-14'],
    // -5,6 +5,3: line 10 maps to the hunk's last line, 7.
    ['replacement overlapping from above, shrunk', (l) => replace(l, 5, 6, 3), 'outdated 7-11'],
    ['replacement overlapping from below, same size', (l) => replace(l, 12, 6, 6), 'outdated 10-14'],
    ['replacement overlapping from below, shrunk', (l) => replace(l, 12, 6, 2), 'outdated 10-14'],
  ];
  for (const [name, mutate, expected] of overlap) {
    it(name, async () => {
      await withRepo({ 'a.ts': base30() }, async (repo) => {
        const t = await lineThread(repo, 'a.ts', 10, 14);
        const l = base30();
        mutate(l);
        await repo.write('a.ts', text(l));
        await expectOne(repo, t, expected, 'diff');
      });
    });
  }

  it('untracked rename search skips files over 1 MiB and binary files', async () => {
    await withRepo({ 'src/a.ts': base30() }, async (repo) => {
      const t = await lineThread(repo, 'src/a.ts', 10, 12);
      const filler = '// filler line for a big file\n'.repeat(40_000);
      await repo.write('big/a.ts', text(base30()) + filler);
      await repo.write('bin/a.ts', `\0binary\n${text(base30())}`);
      await unlink(path.join(repo.root, 'src/a.ts'));
      await expectOne(repo, t, 'orphaned', 'path');
      await repo.write('ok/a.ts', text(base30()));
      const r = await anchorOne(repo, t);
      assert.equal(fmt(r, t), 'current ok/a.ts:10-12');
    });
  });

  for (const [chars, expected] of [
    [15, 'orphaned'],
    [16, 'current moved/a.ts:10-10'],
  ] as const) {
    it(`untracked rename search needs 16 non-whitespace characters (${chars})`, async () => {
      const line = `  ${'x'.repeat(chars - 1)};`;
      const lines = base30();
      lines[9] = line;
      await withRepo({ 'src/a.ts': lines }, async (repo) => {
        const t = await lineThread(repo, 'src/a.ts', 10, 10, { blob: MISSING_BLOB });
        await repo.write('moved/a.ts', text(lines));
        await unlink(path.join(repo.root, 'src/a.ts'));
        const r = await anchorOne(repo, t);
        assert.equal(fmt(r, t), expected);
      });
    });
  }

  it('skipped untracked files do not use up the candidate cap', async () => {
    await withRepo({ 'src/a.ts': base30() }, async (repo) => {
      const t = await lineThread(repo, 'src/a.ts', 10, 12);
      // 201 higher-ranked (same basename) binary files and one oversize one.
      for (let i = 0; i < 201; i++) await repo.write(`bin${i}/a.ts`, '\0binary\n');
      await repo.write('big/a.ts', 'x'.repeat(1024 * 1024 + 1));
      await repo.write('ok/other.txt', text(base30()));
      await unlink(path.join(repo.root, 'src/a.ts'));
      const r = await anchorOne(repo, t);
      assert.equal(fmt(r, t), 'current ok/other.txt:10-12');
    });
  });

  it('a git diff failure on one file orphans its threads only', async () => {
    await withRepo({ 'a.ts': base30(), 'bad.ts': base30() }, async (repo) => {
      const good = await lineThread(repo, 'a.ts', 10, 12);
      const bad = await lineThread(repo, 'bad.ts', 10, 12);
      const l = base30();
      l.splice(0, 0, '// new');
      await repo.write('a.ts', text(l));
      await repo.write('bad.ts', text(l));
      const tmp = await createTempDir();
      try {
        // git wrapper that fails `git diff --no-index` for bad.ts only.
        const fake = path.join(tmp.root, 'git');
        await writeFile(
          fake,
          '#!/bin/sh\ncase "$*" in *--no-index*bad.ts*) echo boom >&2; exit 2;; esac\nexec git "$@"\n',
        );
        await chmod(fake, 0o755);
        const tree = await openTree({ root: repo.root, gitPath: fake });
        try {
          const res = await tree.anchors([good, bad]);
          assert.equal(fmt(res.get(good.id) as AnchorResult, good), 'current 11-13');
          assert.deepEqual(res.get(bad.id), { state: 'orphaned', path: 'bad.ts', method: 'diff' });
        } finally {
          await tree.dispose();
        }
      } finally {
        await tmp.cleanup();
      }
    });
  });

  it('a symlink that leads outside the repo is orphaned', async () => {
    await withRepo({ 'a.ts': base30() }, async (repo) => {
      const t = await lineThread(repo, 'a.ts', 10, 12);
      const f = await fileThread(repo, 'a.ts');
      const outside = await createTempDir();
      try {
        await writeFile(path.join(outside.root, 'a.ts'), text(base30()));
        await unlink(path.join(repo.root, 'a.ts'));
        await symlink(path.join(outside.root, 'a.ts'), path.join(repo.root, 'a.ts'));
        const res = await anchorAll(repo, [t, f]);
        assert.equal(res.get(t.id)?.state, 'orphaned');
        assert.equal(res.get(f.id)?.state, 'orphaned');
      } finally {
        await outside.cleanup();
      }
    });
  });

  it('a symlink inside the repo is followed', async () => {
    await withRepo({ 'real.ts': base30() }, async (repo) => {
      await symlink('real.ts', path.join(repo.root, 'link.ts'));
      const f = await fileThread(repo, 'link.ts');
      assert.equal((await anchorOne(repo, f)).state, 'current');
    });
  });
});
