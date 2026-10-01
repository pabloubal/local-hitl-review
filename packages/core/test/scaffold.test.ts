import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { LhrError } from '../src/errors.js';
import { createTempRepo } from './helpers/tempRepo.js';

describe('LhrError', () => {
  it('carries code, message and name', () => {
    const err = new LhrError('NOT_A_REPO', 'not a repo');
    assert.equal(err.code, 'NOT_A_REPO');
    assert.equal(err.message, 'not a repo');
    assert.equal(err.name, 'LhrError');
    assert.ok(err instanceof Error);
  });
});

describe('createTempRepo', () => {
  it('creates a git repo with .lhr/format "2\\n"', async () => {
    const repo = await createTempRepo();
    try {
      const inside = await repo.git('rev-parse', '--is-inside-work-tree');
      assert.equal(inside.trim(), 'true');
      const format = await readFile(path.join(repo.root, '.lhr', 'format'), 'utf8');
      assert.equal(format, '2\n');
    } finally {
      await repo.cleanup();
    }
  });

  it('omits .lhr/format when format is null', async () => {
    const repo = await createTempRepo({ format: null });
    try {
      await assert.rejects(stat(path.join(repo.root, '.lhr', 'format')));
    } finally {
      await repo.cleanup();
    }
  });
});

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(await listFiles(p)));
    } else {
      out.push(p);
    }
  }
  return out;
}

describe('core isolation', () => {
  it('never imports vscode', async () => {
    const srcDir = path.resolve(__dirname, '../../src');
    const re =
      /from\s+['"]vscode['"]|require\(\s*['"]vscode['"]\s*\)|import\(\s*['"]vscode['"]\s*\)/;
    const files = await listFiles(srcDir);
    assert.ok(files.length > 0);
    for (const f of files) {
      if (!f.endsWith('.ts')) {
        continue;
      }
      assert.ok(!re.test(await readFile(f, 'utf8')), `${f} imports vscode`);
    }
  });
});
