import { realpath, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { LhrError } from './errors.js';
import { GitBatch, GitExitError, runGit } from './git.js';

/**
 * Repo membership for a review root (core-api.md § Review root). The root
 * need not be a repo: each path belongs to the nearest directory holding
 * `.git` between the file and the root, else to the repo enclosing the root.
 * A submodule has its own `.git`, so it is its own repo.
 */

/** One git repo under (or enclosing) the review root. */
export class Repo {
  private batch: GitBatch | undefined;

  constructor(
    /** Real path of the repo's working tree. */
    readonly top: string,
    private readonly realRoot: string,
    private readonly gitPath: string,
  ) {}

  /** Long-lived `git cat-file --batch`, started on first use. */
  get git(): GitBatch {
    this.batch ??= GitBatch.start(this.gitPath, this.top);
    return this.batch;
  }

  /** Root-relative POSIX path -> repo-relative POSIX path. */
  toRepoPath(rel: string): string {
    return posix(path.relative(this.top, path.join(this.realRoot, rel)));
  }

  /** Repo-relative POSIX path -> root-relative, or undefined when outside the root. */
  toRootPath(repoRel: string): string | undefined {
    const out = posix(path.relative(this.realRoot, path.join(this.top, repoRel)));
    if (out === '' || out === '..' || out.startsWith('../') || path.isAbsolute(out)) {
      return undefined;
    }
    return out;
  }

  dispose(): Promise<void> {
    return this.batch ? this.batch.dispose() : Promise.resolve();
  }
}

function posix(p: string): string {
  return path.sep === '/' ? p : p.split(path.sep).join('/');
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export class RepoSet {
  private readonly repos = new Map<string, Repo>();
  private real: Promise<string> | undefined;

  constructor(
    readonly root: string,
    readonly gitPath: string,
  ) {}

  realRoot(): Promise<string> {
    this.real ??= realpath(this.root);
    return this.real;
  }

  /** A lookup that memoises answers, for one batch of paths. */
  lookup(): RepoLookup {
    return new RepoLookup(this);
  }

  /** The repo holding a root-relative file path, or undefined. */
  forPath(rel: string): Promise<Repo | undefined> {
    return this.lookup().forPath(rel);
  }

  /** The repo holding a root-relative directory ('' is the root itself). */
  forDir(rel: string): Promise<Repo | undefined> {
    return this.lookup().forDir(rel);
  }

  /** @internal Verified repo whose working tree is `dir`, or undefined. */
  async repoAt(dir: string): Promise<Repo | undefined> {
    const known = this.repos.get(dir);
    if (!(await exists(path.join(dir, '.git')))) {
      if (known) {
        this.repos.delete(dir);
        await known.dispose();
      }
      return undefined;
    }
    if (known) return known;
    // A stray or broken `.git` doesn't make a repo: git must agree on the toplevel.
    let top: string;
    try {
      top = await realpath((await runGit(this.gitPath, dir, ['rev-parse', '--show-toplevel'])).trim());
    } catch (err) {
      if (err instanceof GitExitError) return undefined;
      throw err;
    }
    if (top !== dir) return undefined;
    const repo = new Repo(top, await this.realRoot(), this.gitPath);
    this.repos.set(dir, repo);
    return repo;
  }

  /** @internal The repo enclosing the root itself. */
  async enclosing(): Promise<Repo | undefined> {
    const root = await this.realRoot();
    let top: string;
    try {
      top = await realpath((await runGit(this.gitPath, root, ['rev-parse', '--show-toplevel'])).trim());
    } catch (err) {
      if (err instanceof GitExitError) return undefined;
      throw err;
    }
    const known = this.repos.get(top);
    if (known) return known;
    const repo = new Repo(top, root, this.gitPath);
    this.repos.set(top, repo);
    return repo;
  }

  async dispose(): Promise<void> {
    const all = [...this.repos.values()];
    this.repos.clear();
    await Promise.all(all.map((r) => r.dispose()));
  }
}

export class RepoLookup {
  private readonly byDir = new Map<string, Promise<Repo | undefined>>();
  private enclosingRepo: Promise<Repo | undefined> | undefined;

  constructor(private readonly set: RepoSet) {}

  forPath(rel: string): Promise<Repo | undefined> {
    const dir = path.posix.dirname(rel);
    return this.forDir(dir === '.' ? '' : dir);
  }

  async forDir(rel: string): Promise<Repo | undefined> {
    const root = await this.set.realRoot();
    return this.walk(root, path.join(root, ...rel.split('/').filter((s) => s !== '' && s !== '.')));
  }

  private walk(root: string, dir: string): Promise<Repo | undefined> {
    let p = this.byDir.get(dir);
    if (!p) {
      p = (async () => {
        const here = await this.set.repoAt(dir);
        if (here) return here;
        if (dir === root || !dir.startsWith(root + path.sep)) {
          this.enclosingRepo ??= this.set.enclosing();
          return this.enclosingRepo;
        }
        return this.walk(root, path.dirname(dir));
      })();
      this.byDir.set(dir, p);
    }
    return p;
  }
}

export function pathNotInRepo(rel: string): LhrError {
  return new LhrError('PATH_NOT_IN_REPO', `${rel} is not inside any git repository`);
}
