import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

const execFileAsync = promisify(execFile);

export interface TempRepo {
  root: string;
  git(...args: string[]): Promise<string>;
  write(relPath: string, content: string): Promise<void>;
  cleanup(): Promise<void>;
}

export async function createTempDir(): Promise<{
  root: string;
  cleanup(): Promise<void>;
}> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lhr-core-test-'));
  const root = await realpath(dir);
  return {
    root,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

export async function createTempRepo(options?: {
  format?: string | null;
}): Promise<TempRepo> {
  const dir = await createTempDir();
  const { root } = dir;

  const git = async (...args: string[]): Promise<string> => {
    const { stdout } = await execFileAsync('git', args, { cwd: root });
    return stdout;
  };

  const write = async (relPath: string, content: string): Promise<void> => {
    const full = path.join(root, relPath);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content);
  };

  try {
    await git('init', '-q');
    await git('config', 'user.name', 'LHR Test');
    await git('config', 'user.email', 'test@example.com');
    await git('config', 'commit.gpgsign', 'false');

    const format = options?.format;
    if (format === undefined) {
      await write('.lhr/format', '2\n');
    } else if (format !== null) {
      await write('.lhr/format', format);
    }
  } catch (err) {
    await dir.cleanup();
    throw err;
  }

  return { root, git, write, cleanup: dir.cleanup };
}
