import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import * as path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { LhrError } from './errors.js';

/**
 * The cross-process drafts lock: the directory `.lhr/drafts/.lock/`. `mkdir` is atomic
 * on every file system we support (exFAT and SMB included, unlike hard links), so at most
 * one caller holds it. The holder writes `owner` (JSON `{ pid, hostname, acquiredAt,
 * token }`) inside it. Every draft mutation runs under the lock.
 */

interface Owner {
  pid: number;
  hostname: string;
  acquiredAt: string;
  token: string;
}

export interface LockSeams {
  /** how long to wait for a busy lock before throwing IO_FAILED */
  timeoutMs: number;
  /** a lock older than this is broken whoever holds it */
  staleMs: number;
  hostname(): string;
  isAlive(pid: number): boolean;
  /** called once per acquisition that finds the lock busy (tests) */
  onWait?: (op: string) => void;
  /** awaited right after the lock is acquired (tests) */
  onAcquired?: (op: string) => Promise<void>;
}

const OWNER_FILE = 'owner';
const MAX_DELAY_MS = 100;

function errCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException).code;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return errCode(err) === 'EPERM'; // exists, owned by someone else
  }
}

/** Internal test seam and tuning. Not part of the public API. */
export const lockSeams: LockSeams = {
  timeoutMs: 5000,
  staleMs: 60_000,
  hostname,
  isAlive: processIsAlive,
};

function draftsDir(root: string): string {
  return path.join(root, '.lhr', 'drafts');
}

function lockDir(root: string): string {
  return path.join(draftsDir(root), '.lock');
}

/** The owner file, or undefined when it is missing, unreadable or not an owner. */
async function readOwner(dir: string): Promise<Owner | undefined> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path.join(dir, OWNER_FILE), 'utf8'));
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const o = value as Partial<Record<keyof Owner, unknown>>;
  if (typeof o.pid !== 'number' || !Number.isInteger(o.pid) || o.pid <= 0) return undefined;
  if (typeof o.hostname !== 'string') return undefined;
  if (typeof o.acquiredAt !== 'string' || typeof o.token !== 'string') return undefined;
  return { pid: o.pid, hostname: o.hostname, acquiredAt: o.acquiredAt, token: o.token };
}

/**
 * Whether a busy lock may be broken: its owner is a dead process on this host, or the
 * lock directory is older than `staleMs` (owner on another host, or no owner file yet).
 * 'gone' means it was released meanwhile.
 */
async function staleness(dir: string, owner: Owner | undefined): Promise<boolean | 'gone'> {
  if (owner && owner.hostname === lockSeams.hostname() && !lockSeams.isAlive(owner.pid)) {
    return true;
  }
  try {
    return Date.now() - (await stat(dir)).mtimeMs > lockSeams.staleMs;
  } catch (err) {
    if (errCode(err) === 'ENOENT') return 'gone';
    throw err;
  }
}

/**
 * Breaks a stale lock atomically: rename it aside (only one breaker's rename succeeds),
 * then delete it. If what was moved is not the lock judged stale (it was released and
 * retaken in between), it is put back; that is best-effort, a narrow window that needs a
 * stale lock and three contenders.
 */
async function breakLock(root: string, dir: string, judged: string | undefined): Promise<void> {
  const asideDir = path.join(draftsDir(root), '.tmp');
  await mkdir(asideDir, { recursive: true });
  const aside = path.join(asideDir, `lock-${randomUUID()}`);
  try {
    await rename(dir, aside);
  } catch (err) {
    if (errCode(err) === 'ENOENT') return; // another breaker won
    throw err;
  }
  if ((await readOwner(aside))?.token !== judged) {
    try {
      await rename(aside, dir);
      return;
    } catch {
      // a newer lock is already in place; drop the one we moved
    }
  }
  await rm(aside, { recursive: true, force: true });
}

function busyMessage(owner: Owner | undefined): string {
  const who = owner
    ? `pid ${owner.pid} on ${owner.hostname} since ${owner.acquiredAt}`
    : 'an unknown process';
  return (
    `drafts are locked by ${who} (.lhr/drafts/.lock); try again, or delete that ` +
    'directory if no lhr process is running'
  );
}

async function acquire(root: string, op: string): Promise<string> {
  const dir = lockDir(root);
  const owner: Owner = {
    pid: process.pid,
    hostname: lockSeams.hostname(),
    acquiredAt: '',
    token: randomUUID(),
  };
  const deadline = Date.now() + lockSeams.timeoutMs;
  let delay = 5;
  let waited = false;
  for (;;) {
    try {
      await mkdir(dir);
      try {
        owner.acquiredAt = new Date().toISOString();
        await writeFile(path.join(dir, OWNER_FILE), `${JSON.stringify(owner)}\n`);
      } catch (err) {
        await rm(dir, { recursive: true, force: true });
        throw err;
      }
      return owner.token;
    } catch (err) {
      if (errCode(err) !== 'EEXIST') throw err;
    }
    const holder = await readOwner(dir);
    const stale = await staleness(dir, holder);
    if (stale === true) await breakLock(root, dir, holder?.token);
    if (stale !== false) continue;
    if (!waited) {
      waited = true;
      lockSeams.onWait?.(op);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new LhrError('IO_FAILED', busyMessage(holder));
    // Back off with jitter so in-process and cross-process waiters never busy-spin.
    await sleep(Math.min(remaining, delay * (0.5 + Math.random())));
    delay = Math.min(delay * 2, MAX_DELAY_MS);
  }
}

/** Removes the lock if it is still ours (it is not if it was broken as stale). */
async function release(root: string, token: string): Promise<void> {
  const dir = lockDir(root);
  if ((await readOwner(dir))?.token !== token) return;
  await rm(dir, { recursive: true, force: true });
}

/**
 * Runs `fn` holding the drafts lock of the tree at `root`. `.lhr/drafts/` must exist.
 * Waits up to `timeoutMs` for a busy lock, then throws `IO_FAILED`.
 */
export async function withDraftsLock<T>(
  root: string,
  op: string,
  fn: () => Promise<T>,
): Promise<T> {
  const token = await acquire(root, op);
  let result: T;
  try {
    await lockSeams.onAcquired?.(op);
    result = await fn();
  } catch (err) {
    await release(root, token).catch(() => undefined);
    throw err;
  }
  await release(root, token);
  return result;
}
