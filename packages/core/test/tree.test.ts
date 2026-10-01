import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { LhrError } from '../src/errors.js';
import { Tree, openTree } from '../src/tree.js';
import { createTempDir, createTempRepo, type TempRepo } from './helpers/tempRepo.js';

function hasCode(code: string): (err: unknown) => boolean {
  return (err) => err instanceof LhrError && err.code === code;
}

async function withTree(fn: (tree: Tree, repo: TempRepo) => Promise<void>): Promise<void> {
  const repo = await createTempRepo();
  try {
    const tree = (await openTree({ root: repo.root })) as Tree;
    try {
      await fn(tree, repo);
    } finally {
      await tree.dispose();
    }
  } finally {
    await repo.cleanup();
  }
}

async function gone(pid: number): Promise<boolean> {
  for (let i = 0; i < 50; i++) {
    try {
      process.kill(pid, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') return true;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

describe('openTree', () => {
  it('opens a repo', async () => {
    await withTree(async (tree, repo) => {
      assert.equal(tree.root, repo.root);
    });
  });

  it('NOT_A_REPO for a plain temp dir', async () => {
    const dir = await createTempDir();
    try {
      await assert.rejects(openTree({ root: dir.root }), hasCode('NOT_A_REPO'));
    } finally {
      await dir.cleanup();
    }
  });

  it('NOT_A_REPO for a nonexistent path', async () => {
    const dir = await createTempDir();
    try {
      await assert.rejects(openTree({ root: path.join(dir.root, 'nope') }), hasCode('NOT_A_REPO'));
    } finally {
      await dir.cleanup();
    }
  });

  it('NOT_A_REPO for a subdirectory of a repo, naming the toplevel', async () => {
    const repo = await createTempRepo();
    try {
      await mkdir(path.join(repo.root, 'sub'));
      await assert.rejects(openTree({ root: path.join(repo.root, 'sub') }), (err: unknown) => {
        return (
          err instanceof LhrError && err.code === 'NOT_A_REPO' && err.message.includes(repo.root)
        );
      });
    } finally {
      await repo.cleanup();
    }
  });

  it('propagates FORMAT_MISSING', async () => {
    const repo = await createTempRepo({ format: null });
    try {
      await assert.rejects(openTree({ root: repo.root }), hasCode('FORMAT_MISSING'));
    } finally {
      await repo.cleanup();
    }
  });

  it('propagates FORMAT_VERSION', async () => {
    const repo = await createTempRepo({ format: '3\n' });
    try {
      await assert.rejects(openTree({ root: repo.root }), hasCode('FORMAT_VERSION'));
    } finally {
      await repo.cleanup();
    }
  });

  it('GIT_FAILED when git is missing', async () => {
    const repo = await createTempRepo();
    try {
      await assert.rejects(
        openTree({ root: repo.root, gitPath: '/nonexistent/git' }),
        hasCode('GIT_FAILED'),
      );
    } finally {
      await repo.cleanup();
    }
  });

  it('NOT_A_REPO includes git stderr', async () => {
    const dir = await createTempDir();
    try {
      await assert.rejects(openTree({ root: dir.root }), (err: unknown) => {
        return (
          err instanceof LhrError &&
          err.code === 'NOT_A_REPO' &&
          /not a git repository/i.test(err.message)
        );
      });
    } finally {
      await dir.cleanup();
    }
  });

  it('NOT_A_REPO when root is a file', async () => {
    const dir = await createTempDir();
    try {
      const f = path.join(dir.root, 'f.txt');
      await writeFile(f, 'x');
      await assert.rejects(openTree({ root: f }), hasCode('NOT_A_REPO'));
    } finally {
      await dir.cleanup();
    }
  });

  it('generates ids from now and random', async () => {
    const repo = await createTempRepo();
    try {
      const tree = await openTree({
        root: repo.root,
        now: () => new Date(Date.UTC(2026, 9, 1, 9, 30, 5)),
        random: () => 'abc234',
      });
      try {
        assert.equal(tree.newId(), '20261001T093005Z-abc234');
        assert.equal(tree.newMessageFileName('agent'), '20261001T093005Z-agent-abc234.md');
      } finally {
        await tree.dispose();
      }
    } finally {
      await repo.cleanup();
    }
  });
});

describe('GitBatch', () => {
  it('reads blobs exactly', async () => {
    await withTree(async (tree, repo) => {
      const binary = Buffer.from([0, 10, 255, 10, 10, 13, 0, 1]);
      await repo.write('text.txt', 'a\n\nb\nc');
      await writeFile(path.join(repo.root, 'bin.dat'), binary);
      await repo.git('add', 'text.txt', 'bin.dat');
      await repo.git('commit', '-q', '-m', 'init');

      const text = await tree.git.read('HEAD:text.txt');
      assert.equal(text?.type, 'blob');
      assert.equal(text?.size, 6);
      assert.equal(text?.content.toString('utf8'), 'a\n\nb\nc');
      const bin = await tree.git.read('HEAD:bin.dat');
      assert.deepEqual(bin?.content, binary);
    });
  });

  it('returns undefined for missing objects', async () => {
    await withTree(async (tree, repo) => {
      await repo.write('a.txt', 'a');
      await repo.git('add', 'a.txt');
      await repo.git('commit', '-q', '-m', 'init');
      assert.equal(await tree.git.read('HEAD:missing.txt'), undefined);
      assert.equal((await tree.git.read('HEAD:a.txt'))?.content.toString(), 'a');
    });
  });

  it('serialises 20 concurrent reads', async () => {
    await withTree(async (tree, repo) => {
      for (let i = 0; i < 20; i++) await repo.write(`f${i}.txt`, `file ${i}\n`.repeat(i + 1));
      await repo.git('add', '.');
      await repo.git('commit', '-q', '-m', 'init');
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) => tree.git.read(`HEAD:f${i}.txt`)),
      );
      results.forEach((r, i) => assert.equal(r?.content.toString(), `file ${i}\n`.repeat(i + 1)));
    });
  });

  it('rejects newline, CR, or empty rev with INVALID_INPUT', async () => {
    await withTree(async (tree) => {
      await assert.rejects(tree.git.read('HEAD\nfoo'), hasCode('INVALID_INPUT'));
      await assert.rejects(tree.git.read('HEAD\rfoo'), hasCode('INVALID_INPUT'));
      await assert.rejects(tree.git.read(''), hasCode('INVALID_INPUT'));
    });
  });
});

describe('dispose', () => {
  it('kills the process, is idempotent, and rejects later reads', async () => {
    const repo = await createTempRepo();
    try {
      const tree = (await openTree({ root: repo.root })) as Tree;
      const pid = tree.git.pid;
      assert.ok(pid !== undefined);
      await tree.dispose();
      assert.ok(await gone(pid), 'git process should be gone');
      await tree.dispose();
      await assert.rejects(tree.git.read('HEAD:x'), hasCode('GIT_FAILED'));
    } finally {
      await repo.cleanup();
    }
  });
});

describe('GitBatch failure modes', () => {
  it('rejects pending reads with GIT_FAILED when disposed', async () => {
    await withTree(async (tree, repo) => {
      await repo.write('a.txt', 'a');
      await repo.git('add', 'a.txt');
      await repo.git('commit', '-q', '-m', 'init');
      const reads = Array.from({ length: 5 }, () => tree.git.read('HEAD:a.txt'));
      const settled = Promise.allSettled(reads);
      await tree.dispose();
      const results = await settled;
      for (const r of results) {
        assert.equal(r.status, 'rejected');
        assert.ok(hasCode('GIT_FAILED')((r as PromiseRejectedResult).reason));
      }
    });
  });

  it('rejects reads with GIT_FAILED when the child is killed, and dispose resolves', async () => {
    await withTree(async (tree) => {
      const pid = tree.git.pid;
      assert.ok(pid !== undefined);
      const pending = tree.git.read('HEAD:x');
      process.kill(pid, 'SIGKILL');
      await assert.rejects(pending, hasCode('GIT_FAILED'));
      await assert.rejects(tree.git.read('HEAD:x'), hasCode('GIT_FAILED'));
      await tree.dispose();
    });
  });
});
