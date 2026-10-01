import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import { LhrError } from '../src/errors.js';
import { FORMAT_VERSION, checkFormat } from '../src/format.js';
import { createTempDir, createTempRepo } from './helpers/tempRepo.js';

function hasCode(code: string): (err: unknown) => boolean {
  return (err) => err instanceof LhrError && err.code === code;
}

describe('checkFormat', () => {
  it('exports version 2', () => {
    assert.equal(FORMAT_VERSION, 2);
  });

  for (const content of ['2\n', '2', '2\r\n']) {
    it(`accepts ${JSON.stringify(content)}`, async () => {
      const repo = await createTempRepo({ format: content });
      try {
        await checkFormat(repo.root);
      } finally {
        await repo.cleanup();
      }
    });
  }

  it('FORMAT_MISSING without .lhr dir', async () => {
    const dir = await createTempDir();
    try {
      await assert.rejects(checkFormat(dir.root), hasCode('FORMAT_MISSING'));
    } finally {
      await dir.cleanup();
    }
  });

  it('FORMAT_MISSING with .lhr but no format file', async () => {
    const dir = await createTempDir();
    try {
      await mkdir(path.join(dir.root, '.lhr'));
      await assert.rejects(checkFormat(dir.root), hasCode('FORMAT_MISSING'));
    } finally {
      await dir.cleanup();
    }
  });

  for (const content of ['1\n', '3\n', 'two', '', '2\n\nextra']) {
    it(`FORMAT_VERSION for ${JSON.stringify(content)}`, async () => {
      const repo = await createTempRepo({ format: content });
      try {
        await assert.rejects(checkFormat(repo.root), (err: unknown) => {
          return err instanceof LhrError && err.code === 'FORMAT_VERSION' && err.message.includes('2');
        });
      } finally {
        await repo.cleanup();
      }
    });
  }

  it('truncates long found values', async () => {
    const repo = await createTempRepo({ format: 'x'.repeat(500) });
    try {
      await assert.rejects(checkFormat(repo.root), (err: unknown) => {
        return err instanceof LhrError && err.code === 'FORMAT_VERSION' && err.message.length < 200;
      });
    } finally {
      await repo.cleanup();
    }
  });
});
