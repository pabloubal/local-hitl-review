import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { LhrError } from './errors.js';

/** git ran and exited non-zero. */
export class GitExitError extends LhrError {
  constructor(
    message: string,
    readonly exitCode: number,
    readonly stderr: string,
  ) {
    super('GIT_FAILED', message);
    this.name = 'GitExitError';
  }
}

/** Runs git without a shell and returns stdout. Failures throw GIT_FAILED. */
export function runGit(gitPath: string, cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      gitPath,
      args,
      { cwd, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err) {
          const detail = (stderr ?? '').trim() || err.message;
          const message = `git ${args.join(' ')} failed: ${detail}`;
          const exitCode = (err as { code?: unknown }).code;
          if (typeof exitCode === 'number') {
            reject(new GitExitError(message, exitCode, (stderr ?? '').trim()));
          } else {
            reject(new LhrError('GIT_FAILED', message));
          }
          return;
        }
        resolve(stdout);
      },
    );
  });
}

export interface GitObject {
  type: string;
  size: number;
  content: Buffer;
}

interface Pending {
  resolve(value: GitObject | undefined): void;
  reject(err: unknown): void;
}

const KILL_AFTER_MS = 2000;

/** Long-lived `git cat-file --batch` process with serialised requests. */
export class GitBatch {
  readonly pid: number | undefined;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly queue: Pending[] = [];
  private buffer: Buffer = Buffer.alloc(0);
  private failure: LhrError | undefined;
  private disposed = false;
  private readonly exited: Promise<void>;

  private constructor(gitPath: string, cwd: string) {
    this.child = spawn(gitPath, ['cat-file', '--batch'], {
      cwd,
      stdio: 'pipe',
    });
    this.pid = this.child.pid;
    this.exited = new Promise<void>((resolve) => {
      this.child.once('close', () => resolve());
      this.child.once('error', () => resolve());
    });
    this.child.on('error', (err) => this.fail(`git cat-file failed to run: ${err.message}`));
    this.child.on('close', (code, signal) => this.fail(`git cat-file exited (${signal ?? code})`));
    this.child.stdin.on('error', () => {
      // EPIPE after exit is reported via 'close'.
    });
    this.child.stdout.on('data', (chunk: Buffer) => this.onData(chunk));
    this.child.stderr.on('data', () => {
      // Drain stderr so the child never blocks on a full pipe.
    });
  }

  static start(gitPath: string, cwd: string): GitBatch {
    return new GitBatch(gitPath, cwd);
  }

  read(rev: string): Promise<GitObject | undefined> {
    if (rev === '' || rev.includes('\n') || rev.includes('\r')) {
      return Promise.reject(
        new LhrError('INVALID_INPUT', 'Revision must be non-empty and contain no line breaks'),
      );
    }
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      this.queue.push({ resolve, reject });
      this.child.stdin.write(`${rev}\n`);
    });
  }

  async dispose(): Promise<void> {
    if (!this.disposed) {
      this.disposed = true;
      this.fail('git cat-file process was disposed');
      this.child.stdin.end();
    }
    const timer = setTimeout(() => this.child.kill('SIGKILL'), KILL_AFTER_MS);
    try {
      await this.exited;
    } finally {
      clearTimeout(timer);
    }
  }

  private fail(message: string): void {
    if (!this.failure) this.failure = new LhrError('GIT_FAILED', message);
    const pending = this.queue.splice(0);
    for (const p of pending) p.reject(this.failure);
  }

  private onData(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const head = this.queue[0];
      if (!head) {
        this.buffer = Buffer.alloc(0);
        return;
      }
      const nl = this.buffer.indexOf(0x0a);
      if (nl < 0) return;
      const line = this.buffer.subarray(0, nl).toString('utf8');
      if (/ (missing|ambiguous)$/.test(line)) {
        this.buffer = this.buffer.subarray(nl + 1);
        this.queue.shift();
        head.resolve(undefined);
        continue;
      }
      const m = /^[0-9a-f]+ (\S+) (\d+)$/.exec(line);
      if (!m) {
        this.fail(`Unexpected git cat-file output: ${line.slice(0, 80)}`);
        this.child.kill('SIGKILL');
        return;
      }
      const size = Number(m[2]);
      const end = nl + 1 + size;
      if (this.buffer.length < end + 1) return;
      const content = Buffer.from(this.buffer.subarray(nl + 1, end));
      this.buffer = this.buffer.subarray(end + 1);
      this.queue.shift();
      head.resolve({ type: m[1] as string, size, content });
    }
  }
}

/** Like runGit, but feeds `input` to git's stdin. */
export function runGitWithInput(
  gitPath: string,
  cwd: string,
  args: string[],
  input: string | Buffer,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(gitPath, args, { cwd, stdio: 'pipe' });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => err.push(c));
    child.stdin.on('error', () => {
      // EPIPE after exit is reported via 'close'.
    });
    child.once('error', (e) =>
      reject(new LhrError('GIT_FAILED', `git failed to run: ${e.message}`)),
    );
    child.once('close', (code) => {
      const stderr = Buffer.concat(err).toString('utf8').trim();
      if (code === 0) {
        resolve(Buffer.concat(out).toString('utf8'));
      } else {
        const message = `git ${args.join(' ')} failed: ${stderr || `exit ${String(code)}`}`;
        reject(
          typeof code === 'number'
            ? new GitExitError(message, code, stderr)
            : new LhrError('GIT_FAILED', message),
        );
      }
    });
    child.stdin.end(input);
  });
}
