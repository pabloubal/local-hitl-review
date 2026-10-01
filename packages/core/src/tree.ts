import { realpath, stat } from 'node:fs/promises';
import { LhrError } from './errors.js';
import { checkFormat } from './format.js';
import { GitBatch, runGit } from './git.js';
import { createId, createMessageFileName, defaultRandom, type AuthorKind } from './ids.js';

export interface Host {
  /** Repo root (the directory holding .lhr/). */
  root: string;
  /** Clock. Default: () => new Date(). */
  now?: () => Date;
  /** 6 chars from [a-z2-7]. Default: crypto-backed. */
  random?: () => string;
  /** Git executable. Default: "git" on PATH. */
  gitPath?: string;
}

export interface LhrTree {
  readonly root: string;
  newId(): string;
  newMessageFileName(kind: AuthorKind): string;
  /** Releases the long-lived git process. Idempotent. */
  dispose(): Promise<void>;
}

export class Tree implements LhrTree {
  constructor(
    readonly root: string,
    readonly git: GitBatch,
    private readonly now: () => Date,
    private readonly random: () => string,
  ) {}

  newId(): string {
    return createId(this.now(), this.random());
  }

  newMessageFileName(kind: AuthorKind): string {
    return createMessageFileName(this.now(), kind, this.random());
  }

  dispose(): Promise<void> {
    return this.git.dispose();
  }
}

export async function openTree(host: Host): Promise<LhrTree> {
  const now = host.now ?? (() => new Date());
  const random = host.random ?? defaultRandom;
  const gitPath = host.gitPath ?? 'git';
  const { root } = host;

  let real: string;
  try {
    if (!(await stat(root)).isDirectory()) {
      throw new LhrError('NOT_A_REPO', `${root} is not a directory`);
    }
    real = await realpath(root);
  } catch (err) {
    if (err instanceof LhrError) throw err;
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new LhrError('NOT_A_REPO', `${root} does not exist`);
    }
    throw err;
  }

  let toplevel: string;
  try {
    toplevel = (await runGit(gitPath, root, ['rev-parse', '--show-toplevel'])).trim();
  } catch (err) {
    if (err instanceof LhrError && err.code === 'GIT_FAILED' && (await gitRuns(gitPath, root))) {
      throw new LhrError('NOT_A_REPO', `${root} is not inside a git repository`);
    }
    throw err;
  }

  if ((await realpath(toplevel)) !== real) {
    throw new LhrError(
      'NOT_A_REPO',
      `${root} is not the repository root; the toplevel is ${toplevel}`,
    );
  }

  await checkFormat(root);
  return new Tree(root, GitBatch.start(gitPath, root), now, random);
}

/** True when the git binary itself launches (distinguishes "not a repo" from "no git"). */
async function gitRuns(gitPath: string, cwd: string): Promise<boolean> {
  try {
    await runGit(gitPath, cwd, ['--version']);
    return true;
  } catch {
    return false;
  }
}
