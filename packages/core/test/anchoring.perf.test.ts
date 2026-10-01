// Scenario 9b of the re-anchoring prototype: 200 threads across 20 files, each
// file edited twice with anchors captured on both versions (two blobs per file).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openTree, type ThreadView } from '../src/index.js';
import { createTempRepo } from './helpers/tempRepo.js';

function rng(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const text = (lines: string[]): string => `${lines.join('\n')}\n`;

describe('LhrTree.anchors performance', () => {
  it('9b: anchors 200 threads across 20 files in under 2 s', async () => {
    const repo = await createTempRepo();
    try {
      const rand = rng(99);
      const files = Array.from({ length: 20 }, (_, f) => `src/f${String(f).padStart(2, '0')}.ts`);
      const contents = new Map<string, string[]>();
      for (const [f, p] of files.entries()) {
        const lines = Array.from({ length: 1000 }, (_, i) => `const f${f}_${i + 1} = ${i + 1};`);
        contents.set(p, lines);
        await repo.write(p, text(lines));
      }
      await repo.git('add', '-A');
      await repo.git('commit', '-q', '-m', 'init');
      const commit = (await repo.git('rev-parse', 'HEAD')).trim();
      const branch = (await repo.git('branch', '--show-current')).trim();

      const edit = (l: string[], n: number, tag: string): void => {
        for (let k = 0; k < n; k++) {
          const p = Math.floor(rand() * (l.length - 1));
          const x = rand();
          if (x < 0.4) l[p] += ` // ${tag}${k}`;
          else if (x < 0.7) l.splice(p, 0, `// ins ${tag}${k}`);
          else l.splice(p, 1);
        }
      };

      const threads: ThreadView[] = [];
      const addThreads = async (p: string, lines: string[]): Promise<void> => {
        const blob = (await repo.git('hash-object', '-w', '--no-filters', '--', p)).trim();
        for (let k = 0; k < 5; k++) {
          const s = 1 + Math.floor(rand() * 980);
          const e = s + Math.floor(rand() * 5);
          const cb = Math.min(3, s - 1);
          const ca = Math.min(3, lines.length - e);
          threads.push({
            id: `20261001T120000Z-p${String(threads.length).padStart(5, '0')}`,
            createdAt: new Date(),
            anchor: {
              kind: 'line',
              path: p,
              side: 'new',
              commit,
              branch,
              blob,
              startLine: s,
              endLine: e,
              contextBefore: cb,
              contextAfter: ca,
            },
            snapshot: lines.slice(s - 1 - cb, e + ca).join('\n'),
            messages: [],
            isDraft: false,
            status: 'open',
            severity: 'medium',
            whoseTurn: 'agent',
            reviewer: { kind: 'human', name: 'Tester' },
          });
        }
      };

      for (const p of files) {
        const l = contents.get(p) as string[];
        await addThreads(p, l);
        edit(l, 20, 'a');
        await repo.write(p, text(l));
        await addThreads(p, l);
        edit(l, 20, 'b');
        await repo.write(p, text(l));
      }
      assert.equal(threads.length, 200);

      const tree = await openTree({ root: repo.root });
      try {
        const t0 = performance.now();
        const res = await tree.anchors(threads);
        const ms = performance.now() - t0;
        const tally: Record<string, number> = {};
        for (const r of res.values()) tally[r.state] = (tally[r.state] ?? 0) + 1;
        console.log(`# anchors(): 200 threads / 20 files in ${ms.toFixed(1)} ms ${JSON.stringify(tally)}`);
        assert.equal(res.size, 200);
        assert.ok(ms < 2000, `took ${ms.toFixed(1)} ms`);
        // Most random threads survive 20 random edits untouched.
        assert.ok((tally.current ?? 0) > 150, JSON.stringify(tally));
      } finally {
        await tree.dispose();
      }
    } finally {
      await repo.cleanup();
    }
  });
});
