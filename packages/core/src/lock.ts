import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, rmdir, stat, utimes, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import * as path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { LhrError } from './errors.js';

/**
 * The cross-process drafts lock: the directory `.lhr/drafts/.lock/`. `mkdir` is atomic
 * on every file system we support (exFAT and SMB included, unlike hard links), so at most
 * one caller holds it. The holder writes `owner` (JSON `{ pid, hostname, acquiredAt,
 * token }`) inside it and touches the directory every `heartbeatMs` while it holds it.
 * Every draft mutation runs under the lock.
 *
 * A lock is stale when its owner is a dead process on this host, or when the directory
 * has not been touched for `staleMs`. Breakers are serialised by a second directory,
 * `.lhr/drafts/.lock.break/`, and re-check staleness while holding it, so a lock is only
 * moved aside right after it was verified stale.
 */

interface Owner {
  pid: number;
  hostname: string;
  acquiredAt: string;
  token: string;
}

/** What the lock holder learns about the acquisition. */
export interface LockInfo {
  /** true when the lock was held by someone else and this call had to wait */
  waited: boolean;
}

export interface LockSeams {
  /** how long to wait for a busy lock before throwing IO_FAILED */
  timeoutMs: number;
  /** a lock untouched for this long is broken whoever holds it */
  staleMs: number;
  /** how often the holder touches the lock directory */
  heartbeatMs: number;
  /** a break guard older than this was left by a dead breaker and is removed */
  breakGuardStaleMs: number;
  hostname(): string;
  isAlive(pid: number): boolean;
  /** removes the lock directory on release */
  removeLock(dir: string): Promise<void>;
  /** awaited before the first attempt (tests) */
  beforeAcquire?: (op: string) => Promise<void>;
  /** called once per acquisition that has to wait for a busy lock (tests) */
  onWait?: (op: string) => void;
  /** awaited right after the lock is acquired (tests) */
  onAcquired?: (op: string) => Promise<void>;
  /** awaited before trying to break a lock judged stale (tests) */
  beforeBreak?: (op: string) => Promise<void>;
  /** called with the owner token of each lock actually broken (tests) */
  onBreak?: (token: string | undefined) => void;
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
  heartbeatMs: 10_000,
  breakGuardStaleMs: 10_000,
  hostname,
  isAlive: processIsAlive,
  // Retries ride out transient EBUSY/EPERM (Windows virus scanners and indexers).
  removeLock: (dir) => rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }),
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
 * lock directory was not touched for `staleMs` (a holder refreshes it every
 * `heartbeatMs`). 'gone' means it was released meanwhile.
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
 * Tries to break a lock judged stale. Takes the break guard first (returns false when
 * another breaker holds it, removing a guard left by a dead breaker), re-verifies the
 * lock under the guard, then renames it aside and deletes it. Returns true when a stale
 * lock was removed.
 */
async function tryBreak(root: string, dir: string, op: string): Promise<boolean> {
  await lockSeams.beforeBreak?.(op);
  const guard = path.join(draftsDir(root), '.lock.break');
  try {
    await mkdir(guard);
  } catch (err) {
    if (errCode(err) !== 'EEXIST') throw err;
    try {
      if (Date.now() - (await stat(guard)).mtimeMs > lockSeams.breakGuardStaleMs) {
        await rmdir(guard);
      }
    } catch (rmErr) {
      if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(errCode(rmErr) ?? '')) throw rmErr;
    }
    return false;
  }
  try {
    // The lock may have been released and retaken since it was judged: check again.
    const holder = await readOwner(dir);
    if ((await staleness(dir, holder)) !== true) return false;
    const asideDir = path.join(draftsDir(root), '.tmp');
    await mkdir(asideDir, { recursive: true });
    const aside = path.join(asideDir, `lock-${randomUUID()}`);
    try {
      await rename(dir, aside);
    } catch (err) {
      if (errCode(err) === 'ENOENT') return false;
      throw err;
    }
    lockSeams.onBreak?.(holder?.token);
    await rm(aside, { recursive: true, force: true });
    return true;
  } finally {
    await rmdir(guard).catch(() => undefined);
  }
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

interface Held {
  token: string;
  waited: boolean;
}

async function acquire(root: string, op: string): Promise<Held> {
  await lockSeams.beforeAcquire?.(op);
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
    let created = false;
    try {
      await mkdir(dir);
      created = true;
    } catch (err) {
      if (errCode(err) !== 'EEXIST') throw err;
    }
    if (created) {
      try {
        owner.acquiredAt = new Date().toISOString();
        await writeFile(path.join(dir, OWNER_FILE), `${JSON.stringify(owner)}\n`);
      } catch (err) {
        await rm(dir, { recursive: true, force: true });
        throw err;
      }
      return { token: owner.token, waited };
    }
    const holder = await readOwner(dir);
    const stale = await staleness(dir, holder);
    if (stale === 'gone') continue;
    if (stale && (await tryBreak(root, dir, op))) continue;
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

/** Touches the lock directory while it is still ours, so it never looks stale. */
async function touch(root: string, token: string): Promise<void> {
  const dir = lockDir(root);
  if ((await readOwner(dir))?.token !== token) return;
  const now = new Date();
  await utimes(dir, now, now);
}

/** Removes the lock if it is still ours (it is not if it was broken as stale). */
async function release(root: string, token: string): Promise<void> {
  const dir = lockDir(root);
  if ((await readOwner(dir))?.token !== token) return;
  await lockSeams.removeLock(dir);
}

/**
 * Runs `fn` holding the drafts lock of the tree at `root`. `.lhr/drafts/` must exist.
 * Waits up to `timeoutMs` for a busy lock, then throws `IO_FAILED`; other file system
 * failures while locking are `IO_FAILED` too. A failed release never fails the call: the
 * work is done, and the lock goes stale once its heartbeat stops.
 */
export async function withDraftsLock<T>(
  root: string,
  op: string,
  fn: (lock: LockInfo) => Promise<T>,
): Promise<T> {
  let held: Held;
  try {
    held = await acquire(root, op);
  } catch (err) {
    if (err instanceof LhrError) throw err;
    throw new LhrError('IO_FAILED', `could not take the drafts lock: ${(err as Error).message}`);
  }
  const heartbeat = setInterval(() => {
    touch(root, held.token).catch(() => undefined);
  }, lockSeams.heartbeatMs);
  heartbeat.unref();
  try {
    await lockSeams.onAcquired?.(op);
    return await fn({ waited: held.waited });
  } finally {
    clearInterval(heartbeat);
    await release(root, held.token).catch(() => undefined);
  }
}
