import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { LhrError } from '../src/errors.js';
import { openTree, type LhrTree } from '../src/tree.js';
import { createTempDir, createTempRepo } from './helpers/tempRepo.js';

const run = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd });
  return stdout;
}

async function write(root: string, rel: string, content: string): Promise<void> {
  const full = path.join(root, rel);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, content);
}

/** A repo at `dir` (created if needed) with `files` committed. Returns HEAD. */
async function initRepo(dir: string, files: Record<string, string>): Promise<string> {
  await mkdir(dir, { recursive: true });
  await git(dir, 'init', '-q');
  await git(dir, 'config', 'user.name', 'LHR Test');
  await git(dir, 'config', 'user.email', 'test@example.com');
  await git(dir, 'config', 'commit.gpgsign', 'false');
  for (const [rel, content] of Object.entries(files)) await write(dir, rel, content);
  await git(dir, 'add', '.');
  await git(dir, 'commit', '-q', '-m', 'init');
  return (await git(dir, 'rev-parse', 'HEAD')).trim();
}

const BODY = Array.from({ length: 8 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
const human = { kind: 'human', name: 'Tester' } as const;

function hasCode(code: string): (err: unknown) => boolean {
  return (err) => err instanceof LhrError && err.code === code;
}

async function withRoot(
  fn: (root: string, tree: () => Promise<LhrTree>) => Promise<void>,
): Promise<void> {
  const dir = await createTempDir();
  const trees: LhrTree[] = [];
  try {
    await write(dir.root, '.lhr/format', '2\n');
    await fn(dir.root, async () => {
      const t = await openTree({ root: dir.root });
      trees.push(t);
      return t;
    });
  } finally {
    for (const t of trees) await t.dispose();
    await dir.cleanup();
  }
}

describe('review root: workspace with two nested repos', () => {
  it('opens a non-git root and anchors each path in its own repo', async () => {
    await withRoot(async (root, open) => {
      const h1 = await initRepo(path.join(root, 'repo1'), { 'src/a.ts': BODY });
      const h2 = await initRepo(path.join(root, 'repo2'), { 'b.ts': BODY });
      const tree = await open();
      assert.equal(tree.root, root);
      const a = await tree.createThread({
        anchor: { path: 'repo1/src/a.ts', kind: 'line', startLine: 3 },
        body: 'one',
        author: human,
      });
      const b = await tree.createThread({
        anchor: { path: 'repo2/b.ts', kind: 'line', startLine: 2, endLine: 3 },
        body: 'two',
        author: human,
      });
      const snap = await tree.load();
      const ta = snap.thread(a.threadId)!;
      const tb = snap.thread(b.threadId)!;
      assert.equal(ta.anchor.path, 'repo1/src/a.ts');
      assert.equal(ta.anchor.commit, h1);
      assert.equal(tb.anchor.path, 'repo2/b.ts');
      assert.equal(tb.anchor.commit, h2);
      assert.notEqual(h1, h2);
      if (ta.anchor.kind !== 'line') throw new Error('expected line');
      assert.equal(
        ta.anchor.blob,
        (await git(path.join(root, 'repo1'), 'hash-object', 'src/a.ts')).trim(),
      );
    });
  });

  it('re-anchors threads through each repo with root-relative paths', async () => {
    await withRoot(async (root, open) => {
      await initRepo(path.join(root, 'repo1'), { 'a.ts': BODY });
      await initRepo(path.join(root, 'repo2'), { 'b.ts': BODY });
      const tree = await open();
      const mk = (p: string) =>
        tree.createThread({
          anchor: { path: p, kind: 'line', startLine: 4 },
          body: 'x',
          author: human,
        });
      const a = await mk('repo1/a.ts');
      const b = await mk('repo2/b.ts');
      // Shift repo1's file by two lines; leave repo2's untouched.
      await write(root, 'repo1/a.ts', 'new 1\nnew 2\n' + BODY);
      const snap = await tree.load();
      const res = await tree.anchors(snap.threads());
      const ra = res.get(a.threadId)!;
      assert.equal(ra.state, 'current');
      assert.equal(ra.path, 'repo1/a.ts');
      assert.equal(ra.startLine, 6);
      assert.equal(ra.method, 'diff');
      const rb = res.get(b.threadId)!;
      assert.equal(rb.state, 'current');
      assert.equal(rb.path, 'repo2/b.ts');
      assert.equal(rb.startLine, 4);
    });
  });

  it('applies unsaved-text overrides keyed by root-relative path', async () => {
    await withRoot(async (root, open) => {
      await initRepo(path.join(root, 'repo1'), { 'a.ts': BODY });
      const tree = await open();
      const t = await tree.createThread({
        anchor: { path: 'repo1/a.ts', kind: 'line', startLine: 2 },
        body: 'x',
        author: human,
      });
      const snap = await tree.load();
      const res = await tree.anchors(snap.threads(), {
        overrides: new Map([['repo1/a.ts', 'top\n' + BODY]]),
      });
      assert.equal(res.get(t.threadId)!.startLine, 3);
    });
  });

  it('takes the human author from git config (global config for a non-git root)', async () => {
    await withRoot(async (root, open) => {
      const cfg = path.join(root, '..', `gitconfig-${path.basename(root)}`);
      await writeFile(cfg, '[user]\n\tname = Global Person\n');
      const prev = process.env.GIT_CONFIG_GLOBAL;
      process.env.GIT_CONFIG_GLOBAL = cfg;
      try {
        const tree = await open();
        assert.deepEqual(await tree.humanAuthor(), { kind: 'human', name: 'Global Person' });
        await writeFile(cfg, '');
        await assert.rejects(tree.humanAuthor(), hasCode('GIT_FAILED'));
      } finally {
        if (prev === undefined) delete process.env.GIT_CONFIG_GLOBAL;
        else process.env.GIT_CONFIG_GLOBAL = prev;
        await rm(cfg, { force: true });
      }
    });
  });
});

describe('review root: openTree', () => {
  it('FORMAT_MISSING for a root without .lhr/format', async () => {
    const dir = await createTempDir();
    try {
      await assert.rejects(openTree({ root: dir.root }), hasCode('FORMAT_MISSING'));
    } finally {
      await dir.cleanup();
    }
  });

  it('accepts a subdirectory of a repo and uses the enclosing repo', async () => {
    const repo = await createTempRepo({ format: null });
    try {
      await repo.write('pkg/sub/a.ts', BODY);
      await repo.write('pkg/.lhr/format', '2\n');
      await repo.git('add', '.');
      await repo.git('commit', '-q', '-m', 'init');
      const head = (await repo.git('rev-parse', 'HEAD')).trim();
      const root = path.join(repo.root, 'pkg');
      const tree = await openTree({ root });
      try {
        const t = await tree.createThread({
          anchor: { path: 'sub/a.ts', kind: 'line', startLine: 5 },
          body: 'x',
          author: human,
        });
        const view = (await tree.load()).thread(t.threadId)!;
        assert.equal(view.anchor.path, 'sub/a.ts');
        assert.equal(view.anchor.commit, head);
        await write(root, 'sub/a.ts', 'new\n' + BODY);
        const res = await tree.anchors([view]);
        assert.equal(res.get(t.threadId)!.startLine, 6);
        assert.equal(res.get(t.threadId)!.path, 'sub/a.ts');
      } finally {
        await tree.dispose();
      }
    } finally {
      await repo.cleanup();
    }
  });

  it('NOT_A_REPO when the root does not exist or is a file', async () => {
    const dir = await createTempDir();
    try {
      await assert.rejects(openTree({ root: path.join(dir.root, 'nope') }), hasCode('NOT_A_REPO'));
      await write(dir.root, 'f.txt', 'x');
      await assert.rejects(openTree({ root: path.join(dir.root, 'f.txt') }), hasCode('NOT_A_REPO'));
    } finally {
      await dir.cleanup();
    }
  });
});

describe('review root: repo below a git root', () => {
  it('uses the nearest repo for a nested path, the root repo otherwise', async () => {
    const outer = await createTempRepo({ format: null });
    try {
      await outer.write('top.ts', BODY);
      await outer.write('.lhr/format', '2\n');
      await outer.git('add', '.');
      await outer.git('commit', '-q', '-m', 'init');
      const outerHead = (await outer.git('rev-parse', 'HEAD')).trim();
      const innerHead = await initRepo(path.join(outer.root, 'inner'), { 'i.ts': BODY });
      const tree = await openTree({ root: outer.root });
      try {
        const mk = (p: string) =>
          tree.createThread({ anchor: { path: p, kind: 'file' }, body: 'x', author: human });
        const t1 = await mk('top.ts');
        const t2 = await mk('inner/i.ts');
        const snap = await tree.load();
        assert.equal(snap.thread(t1.threadId)!.anchor.commit, outerHead);
        assert.equal(snap.thread(t2.threadId)!.anchor.commit, innerHead);
      } finally {
        await tree.dispose();
      }
    } finally {
      await outer.cleanup();
    }
  });
});

describe('review root: submodule', () => {
  it('treats a submodule as its own repo', async () => {
    await withRoot(async (root, open) => {
      const lib = path.join(root, '_lib');
      await initRepo(lib, { 'l.ts': BODY });
      const main = path.join(root, 'main');
      await initRepo(main, { 'm.ts': BODY });
      await git(
        main,
        '-c',
        'protocol.file.allow=always',
        'submodule',
        'add',
        '-q',
        lib,
        'vendor/lib',
      );
      await git(main, 'commit', '-q', '-m', 'add submodule');
      const subHead = (await git(path.join(main, 'vendor/lib'), 'rev-parse', 'HEAD')).trim();
      const mainHead = (await git(main, 'rev-parse', 'HEAD')).trim();
      assert.notEqual(subHead, mainHead);
      const tree = await open();
      const t = await tree.createThread({
        anchor: { path: 'main/vendor/lib/l.ts', kind: 'line', startLine: 2 },
        body: 'x',
        author: human,
      });
      const m = await tree.createThread({
        anchor: { path: 'main/m.ts', kind: 'line', startLine: 2 },
        body: 'x',
        author: human,
      });
      const snap = await tree.load();
      assert.equal(snap.thread(t.threadId)!.anchor.commit, subHead);
      assert.equal(snap.thread(m.threadId)!.anchor.commit, mainHead);
      const res = await tree.anchors(snap.threads());
      assert.equal(res.get(t.threadId)!.state, 'current');
      assert.equal(res.get(t.threadId)!.path, 'main/vendor/lib/l.ts');
    });
  });
});

describe('review root: PATH_NOT_IN_REPO', () => {
  it('throws for a path outside any repo (createThread and createDraftThread)', async () => {
    await withRoot(async (root, open) => {
      await initRepo(path.join(root, 'repo1'), { 'a.ts': BODY });
      await write(root, 'loose/notes.md', 'hello\n');
      const tree = await open();
      const input = {
        anchor: { path: 'loose/notes.md', kind: 'file' as const },
        body: 'x',
        author: human,
      };
      await assert.rejects(tree.createThread(input), hasCode('PATH_NOT_IN_REPO'));
      await assert.rejects(tree.createDraftThread(input), hasCode('PATH_NOT_IN_REPO'));
    });
  });
});

describe('review root: missing repo', () => {
  it('orphans threads of a removed repo with a diagnostic and never throws', async () => {
    await withRoot(async (root, open) => {
      await initRepo(path.join(root, 'repo1'), { 'a.ts': BODY });
      await initRepo(path.join(root, 'repo2'), { 'b.ts': BODY });
      const tree = await open();
      const mk = (p: string) =>
        tree.createThread({
          anchor: { path: p, kind: 'line', startLine: 2 },
          body: 'x',
          author: human,
        });
      const a = await mk('repo1/a.ts');
      const b = await mk('repo2/b.ts');
      await rm(path.join(root, 'repo1'), { recursive: true, force: true });
      const snap = await tree.load();
      const res = await tree.anchors(snap.threads());
      const ra = res.get(a.threadId)!;
      assert.equal(ra.state, 'orphaned');
      assert.equal(ra.path, 'repo1/a.ts');
      assert.equal(ra.diagnostic?.code, 'REPO_MISSING');
      assert.equal(ra.diagnostic?.severity, 'warning');
      assert.match(ra.diagnostic?.message ?? '', /repo1\/a\.ts/);
      assert.ok(snap.thread(a.threadId)!.snapshot, 'snapshot is still available');
      assert.equal(res.get(b.threadId)!.state, 'current');
      assert.equal(res.get(b.threadId)!.diagnostic, undefined);
    });
  });

  it('orphans when the directory is no longer a repo', async () => {
    await withRoot(async (root, open) => {
      await initRepo(path.join(root, 'repo1'), { 'a.ts': BODY });
      const tree = await open();
      const a = await tree.createThread({
        anchor: { path: 'repo1/a.ts', kind: 'file' },
        body: 'x',
        author: human,
      });
      await rm(path.join(root, 'repo1/.git'), { recursive: true, force: true });
      const res = await tree.anchors((await tree.load()).threads());
      assert.equal(res.get(a.threadId)!.state, 'orphaned');
      assert.equal(res.get(a.threadId)!.diagnostic?.code, 'REPO_MISSING');
    });
  });
});

describe('ThreadFilter.path prefix semantics', () => {
  it('matches the file itself or anything under a directory, on segment boundaries', async () => {
    await withRoot(async (root, open) => {
      await initRepo(path.join(root, 'repo1'), {
        'src/a.ts': BODY,
        'src/b.ts': BODY,
        'srcx/c.ts': BODY,
      });
      const tree = await open();
      for (const p of ['repo1/src/a.ts', 'repo1/src/b.ts', 'repo1/srcx/c.ts']) {
        await tree.createThread({ anchor: { path: p, kind: 'file' }, body: 'x', author: human });
      }
      const snap = await tree.load();
      const paths = (p: string | undefined) =>
        snap
          .threads(p === undefined ? {} : { path: p })
          .map((t) => t.anchor.path)
          .sort();
      assert.deepEqual(paths('repo1/src/a.ts'), ['repo1/src/a.ts']);
      assert.deepEqual(paths('repo1/src'), ['repo1/src/a.ts', 'repo1/src/b.ts']);
      assert.deepEqual(paths('repo1/src/'), ['repo1/src/a.ts', 'repo1/src/b.ts']);
      assert.deepEqual(paths('repo1/sr'), []);
      assert.equal(paths('repo1').length, 3);
      assert.equal(paths(undefined).length, 3);
    });
  });
});
