import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ChangedFile, FileStatus } from './types.js';
import { log } from './logger.js';

const execFileAsync = promisify(execFile);

/**
 * Service for git operations using shell commands.
 * All commands run against a specific repository root.
 */
export class GitService {
  constructor(public readonly repoRoot: string) {}

  /**
   * Find the merge-base (common ancestor) between HEAD and a base branch.
   */
  async getMergeBase(baseBranch: string): Promise<string> {
    const { stdout } = await this.git('merge-base', 'HEAD', baseBranch);
    return stdout.trim();
  }

  /**
   * Get the list of files changed between a ref and the working tree.
   * Uses diff against the merge-base to capture all branch changes.
   */
  async getChangedFiles(mergeBase: string): Promise<ChangedFile[]> {
    const { stdout: diffStdout } = await this.git('diff', '--name-status', mergeBase);
    const files = this.parseNameStatus(diffStdout);
    
    // Include untracked files
    try {
      const { stdout: untrackedStdout } = await this.git('ls-files', '--others', '--exclude-standard');
      for (const line of untrackedStdout.split('\n')) {
        if (line.trim()) {
          files.push({ path: line.trim(), status: 'A' });
        }
      }
    } catch (e) {
      // ignore
    }
    
    return files;
  }

  /**
   * Get file content at a specific git ref.
   */
  async getFileAtRef(ref: string, filePath: string): Promise<string> {
    const { stdout } = await this.git('show', `${ref}:${filePath}`);
    return stdout;
  }

  /**
   * Get the current branch name.
   */
  async getCurrentBranch(): Promise<string> {
    const { stdout } = await this.git('rev-parse', '--abbrev-ref', 'HEAD');
    return stdout.trim();
  }

  /**
   * List local branch names.
   */
  async listBranches(): Promise<string[]> {
    const { stdout } = await this.git('branch', '-a', '--format=%(refname:short)');
    return stdout
      .split('\n')
      .map((b) => b.trim())
      .filter((b) => b && b !== 'origin');
  }

  /**
   * Auto-detect the likely base branch.
   * Tries common defaults including remote branches.
   */
  async detectBaseBranch(): Promise<string | undefined> {
    const branches = await this.listBranches();
    const currentBranch = await this.getCurrentBranch();

    // Don't return the current branch as base
    const candidates = [
      'origin/main', 'origin/master', 'origin/develop',
      'upstream/main', 'upstream/master',
      'main', 'master', 'develop'
    ];
    for (const candidate of candidates) {
      if (branches.includes(candidate) && candidate !== currentBranch) {
        return candidate;
      }
    }

    // Fallback: first branch that isn't the current one
    return branches.find((b) => b !== currentBranch);
  }

  /**
   * List commits on the current branch since it diverged from the base branch.
   * Returns commits in reverse chronological order (newest first).
   */
  async listCommits(baseBranch: string): Promise<import('./types.js').GitCommit[]> {
    try {
      const mergeBase = await this.getMergeBase(baseBranch);
      const { stdout } = await this.git(
        'log',
        `${mergeBase}..HEAD`,
        '--format=%H|%h|%s|%an|%cr',
        '--no-merges'
      );
      return stdout
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [hash, shortHash, subject, author, date] = line.split('|');
          return { hash, shortHash, subject, author, date };
        });
    } catch {
      return [];
    }
  }

  /**
   * Get the list of files changed in a specific commit.
   */
  async getCommitChanges(hash: string): Promise<ChangedFile[]> {
    const { stdout } = await this.git('diff-tree', '--no-commit-id', '--name-status', '-r', hash);
    return this.parseNameStatus(stdout);
  }

  /**
   * Get changed files between two refs (no working tree).
   */
  async getChangedFilesBetweenRefs(fromRef: string, toRef: string): Promise<ChangedFile[]> {
    const { stdout } = await this.git('diff', '--name-status', fromRef, toRef);
    return this.parseNameStatus(stdout);
  }

  /**
   * Get uncommitted changes (staged + unstaged vs HEAD).
   */
  async getUncommittedChanges(): Promise<ChangedFile[]> {
    const { stdout: diffStdout } = await this.git('diff', '--name-status', 'HEAD');
    const files = this.parseNameStatus(diffStdout);
    
    // Include untracked files
    try {
      const { stdout: untrackedStdout } = await this.git('ls-files', '--others', '--exclude-standard');
      for (const line of untrackedStdout.split('\n')) {
        if (line.trim()) {
          files.push({ path: line.trim(), status: 'A' });
        }
      }
    } catch (e) {
      // ignore
    }
    
    return files;
  }

  private async git(...args: string[]): Promise<{ stdout: string; stderr: string }> {
    const start = Date.now();
    log(`> git ${args.join(' ')}`);
    try {
      const result = await execFileAsync('git', args, {
        cwd: this.repoRoot,
        maxBuffer: 10 * 1024 * 1024, // 10MB
      });
      const duration = Date.now() - start;
      log(`< ok (${duration}ms) stdout: ${result.stdout.length} bytes`);
      return result;
    } catch (e: any) {
      const duration = Date.now() - start;
      log(`< failed (${duration}ms) error: ${e.message}`);
      throw e;
    }
  }

  private parseNameStatus(stdout: string): ChangedFile[] {
    const files: ChangedFile[] = [];
    for (const line of stdout.split('\n')) {
      if (!line.trim()) { continue; }
      const parts = line.split('\t');
      const statusChar = parts[0].charAt(0) as FileStatus;
      if (statusChar === 'R' || statusChar === 'C') {
        files.push({ path: parts[2], status: statusChar, originalPath: parts[1] });
      } else {
        files.push({ path: parts[1], status: statusChar });
      }
    }
    return files;
  }
}
