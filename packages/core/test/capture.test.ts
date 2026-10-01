import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LhrError } from '../src/errors.js';
import { captureAnchor, threadMdText } from '../src/capture.js';
import { createTempRepo, type TempRepo } from './helpers/tempRepo.js';

function invalid(err: unknown): boolean {
  return err instanceof LhrError && err.code === 'INVALID_INPUT';
}

const LINES = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);
const FILE = LINES.join('\n') + '\n';

async function withRepo(
  fn: (repo: TempRepo, env: { root: string; gitPath: string }, head: string) => Promise<void>,
): Promise<void> {
  const repo = await createTempRepo();
  try {
    await repo.write('src/a.ts', FILE);
    await repo.git('add', '.');
    await repo.git('commit', '-q', '-m', 'init');
    const head = (await repo.git('rev-parse', 'HEAD')).trim();
    await fn(repo, { root: repo.root, gitPath: 'git' }, head);
  } finally {
    await repo.cleanup();
  }
}

describe('captureAnchor', () => {
  it('captures a line anchor with 3 lines of context each side', async () => {
    await withRepo(async (repo, env, head) => {
      const c = await captureAnchor(env, {
        path: 'src/a.ts',
        kind: 'line',
        startLine: 5,
        endLine: 6,
      });
      const blob = (await repo.git('hash-object', 'src/a.ts')).trim();
      const branch = (await repo.git('symbolic-ref', '--short', 'HEAD')).trim();
      assert.deepEqual(c.anchor, {
        kind: 'line',
        path: 'src/a.ts',
        side: 'new',
        commit: head,
        branch,
        blob,
        startLine: 5,
        endLine: 6,
        contextBefore: 3,
        contextAfter: 3,
      });
      assert.equal(c.snapshot, LINES.slice(1, 9).join('\n'));
      // blob exists in the object store
      assert.equal((await repo.git('cat-file', '-t', blob)).trim(), 'blob');
    });
  });

  it('keeps snapshot line count equal to contextBefore + lines + contextAfter at the edges', async () => {
    await withRepo(async (_repo, env) => {
      const start = await captureAnchor(env, {
        path: 'src/a.ts',
        kind: 'line',
        startLine: 1,
        endLine: 1,
      });
      assert.equal(start.anchor.kind === 'line' && start.anchor.contextBefore, 0);
      assert.equal(start.anchor.kind === 'line' && start.anchor.contextAfter, 3);
      assert.equal(start.snapshot?.split('\n').length, 4);
      const end = await captureAnchor(env, {
        path: 'src/a.ts',
        kind: 'line',
        startLine: 9,
        endLine: 10,
      });
      assert.equal(end.anchor.kind === 'line' && end.anchor.contextBefore, 3);
      assert.equal(end.anchor.kind === 'line' && end.anchor.contextAfter, 0);
      assert.equal(end.snapshot?.split('\n').length, 5);
      const whole = await captureAnchor(env, {
        path: 'src/a.ts',
        kind: 'line',
        startLine: 1,
        endLine: 10,
      });
      assert.equal(whole.snapshot, LINES.join('\n'));
    });
  });

  it('defaults endLine to startLine and side to new', async () => {
    await withRepo(async (_repo, env) => {
      const c = await captureAnchor(env, {
        path: 'src/a.ts',
        kind: 'line',
        startLine: 4,
      });
      assert.equal(c.anchor.kind === 'line' && c.anchor.endLine, 4);
      assert.equal(c.anchor.side, 'new');
    });
  });

  it('uses unsaved text for the blob and snapshot when given', async () => {
    await withRepo(async (repo, env) => {
      const text = 'x1\nx2\nx3\n';
      const c = await captureAnchor(env, {
        path: 'src/a.ts',
        kind: 'line',
        startLine: 2,
        text,
      });
      assert.equal(c.snapshot, 'x1\nx2\nx3');
      const blob = c.anchor.kind === 'line' ? c.anchor.blob : '';
      assert.equal(await repo.git('cat-file', 'blob', blob), text);
    });
  });

  it('hashes uncommitted edits on disk', async () => {
    await withRepo(async (repo, env) => {
      await repo.write('src/a.ts', 'edited\n');
      const c = await captureAnchor(env, {
        path: 'src/a.ts',
        kind: 'line',
        startLine: 1,
      });
      assert.equal(c.snapshot, 'edited');
      assert.equal(
        c.anchor.kind === 'line' && c.anchor.blob,
        (await repo.git('hash-object', 'src/a.ts')).trim(),
      );
    });
  });

  it('omits branch when HEAD is detached', async () => {
    await withRepo(async (repo, env, head) => {
      await repo.git('checkout', '-q', '--detach');
      const c = await captureAnchor(env, { path: 'src/a.ts', kind: 'file' });
      assert.deepEqual(c.anchor, {
        kind: 'file',
        path: 'src/a.ts',
        side: 'new',
        commit: head,
      });
      assert.equal(c.snapshot, undefined);
    });
  });

  it('takes the old side from baseCommit', async () => {
    await withRepo(async (repo, env, head) => {
      await repo.write('src/a.ts', 'new 1\nnew 2\n');
      await repo.git('commit', '-qam', 'second');
      const c = await captureAnchor(env, {
        path: 'src/a.ts',
        kind: 'line',
        side: 'old',
        baseCommit: head.slice(0, 8),
        startLine: 9,
        endLine: 10,
      });
      assert.equal(c.anchor.commit, head);
      assert.equal(c.anchor.side, 'old');
      assert.equal(c.snapshot, LINES.slice(5).join('\n'));
      assert.equal(
        c.anchor.kind === 'line' && c.anchor.blob,
        (await repo.git('rev-parse', `${head}:src/a.ts`)).trim(),
      );
    });
  });

  it('uses a fence longer than any backtick run and names the language', async () => {
    await withRepo(async (_repo, env) => {
      const text = 'a\n````\n```\nb\n';
      const c = await captureAnchor(env, {
        path: 'src/a.ts',
        kind: 'line',
        startLine: 1,
        endLine: 4,
        text,
      });
      const md = threadMdText(c);
      assert.ok(md.endsWith('\n`````ts\na\n````\n```\nb\n`````\n'), md);
    });
  });

  it('rejects bad input with INVALID_INPUT', async () => {
    await withRepo(async (_repo, env) => {
      const bad = (input: Parameters<typeof captureAnchor>[1]): Promise<unknown> =>
        assert.rejects(captureAnchor(env, input), invalid);
      await bad({ path: 'src/a.ts', kind: 'line' });
      await bad({ path: 'src/a.ts', kind: 'line', startLine: 0 });
      await bad({ path: 'src/a.ts', kind: 'line', startLine: 1.5 });
      await bad({ path: 'src/a.ts', kind: 'line', startLine: 5, endLine: 4 });
      await bad({ path: 'src/a.ts', kind: 'line', startLine: 11 });
      await bad({ path: 'src/a.ts', kind: 'line', startLine: 9, endLine: 11 });
      await bad({ path: 'src/a.ts', kind: 'file', startLine: 1 });
      await bad({ path: 'src/a.ts', kind: 'file', endLine: 1 });
      await bad({ path: 'src/a.ts', kind: 'line', side: 'old', startLine: 1 });
      await bad({ path: 'src/a.ts', kind: 'file', side: 'old' });
      await bad({
        path: 'src/a.ts',
        kind: 'line',
        side: 'old',
        baseCommit: 'nope',
        startLine: 1,
      });
      await bad({
        path: 'src/missing.ts',
        kind: 'line',
        side: 'old',
        baseCommit: 'HEAD',
        startLine: 1,
      });
      await bad({ path: 'src/missing.ts', kind: 'line', startLine: 1 });
      await bad({ path: '../x', kind: 'file' });
      await bad({ path: '/abs', kind: 'file' });
      await bad({ path: '', kind: 'file' });
    });
  });

  it('keeps CR in CRLF lines and handles a missing final newline at the last line', async () => {
    await withRepo(async (repo, env) => {
      await repo.write('src/crlf.ts', 'a\r\nb\r\nc\r\n');
      const crlf = await captureAnchor(env, {
        path: 'src/crlf.ts',
        kind: 'line',
        startLine: 2,
        endLine: 3,
      });
      // lone \r endings are not line breaks; lines split on \n only, like git diff
      assert.equal(crlf.snapshot, 'a\r\nb\r\nc\r');
      assert.equal(crlf.anchor.kind === 'line' && crlf.anchor.contextAfter, 0);
      await repo.write('src/nonl.ts', 'a\nb\nc');
      const nonl = await captureAnchor(env, { path: 'src/nonl.ts', kind: 'line', startLine: 3 });
      assert.equal(nonl.snapshot, 'a\nb\nc');
      assert.equal(nonl.anchor.kind === 'line' && nonl.anchor.endLine, 3);
    });
  });

  it('stores the original bytes of a non-UTF-8 file as the blob', async () => {
    await withRepo(async (repo, env) => {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(`${repo.root}/src/bin.txt`, Buffer.from([0x61, 0x0a, 0xff, 0xfe, 0x0a]));
      const c = await captureAnchor(env, { path: 'src/bin.txt', kind: 'line', startLine: 1 });
      const blob = c.anchor.kind === 'line' ? c.anchor.blob : '';
      assert.equal(blob, (await repo.git('hash-object', 'src/bin.txt')).trim());
    });
  });

  it('requires a file anchor target to exist', async () => {
    await withRepo(async (_repo, env, head) => {
      await assert.rejects(captureAnchor(env, { path: 'src/nope.ts', kind: 'file' }), invalid);
      await assert.rejects(captureAnchor(env, { path: 'src', kind: 'file' }), invalid);
      await assert.rejects(
        captureAnchor(env, { path: 'src/nope.ts', kind: 'file', side: 'old', baseCommit: head }),
        invalid,
      );
      const ok = await captureAnchor(env, {
        path: 'src/a.ts',
        kind: 'file',
        side: 'old',
        baseCommit: head,
      });
      assert.equal(ok.anchor.kind, 'file');
    });
  });

  it('rejects an old-side path that is a directory at the commit', async () => {
    await withRepo(async (_repo, env, head) => {
      for (const kind of ['line', 'file'] as const) {
        await assert.rejects(
          captureAnchor(env, { path: 'src', kind, side: 'old', baseCommit: head, startLine: 1 }),
          invalid,
        );
      }
    });
  });

  it('rejects an old-side path that is a submodule at the commit', async () => {
    const sub = await createTempRepo();
    try {
      await sub.write('f.txt', 'x\n');
      await sub.git('add', '.');
      await sub.git('commit', '-q', '-m', 'sub');
      await withRepo(async (repo, env) => {
        await repo.git(
          '-c',
          'protocol.file.allow=always',
          'submodule',
          'add',
          '-q',
          sub.root,
          'vendor/sub',
        );
        await repo.git('commit', '-q', '-m', 'add submodule');
        const base = (await repo.git('rev-parse', 'HEAD')).trim();
        for (const kind of ['file', 'line'] as const) {
          await assert.rejects(
            captureAnchor(env, {
              path: 'vendor/sub',
              kind,
              side: 'old',
              baseCommit: base,
              startLine: 1,
            }),
            invalid,
          );
        }
      });
    } finally {
      await sub.cleanup();
    }
  });
});
