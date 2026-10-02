import {
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { LhrError } from './errors.js';
import { GitBatch, runGitStatus } from './git.js';
import type {
  Anchor,
  AnchorOptions,
  AnchorResult,
  FileAnchor,
  LineAnchor,
  ThreadView,
} from './model.js';

/**
 * Re-anchoring (ADR 0006). The current position of a thread is calculated
 * from its saved anchor on every call and never written back.
 *
 * Order for a `new`-side line thread:
 *   1. resolve the path (file on disk or override, else `git diff -M`
 *      renames, else an untracked file that holds the old content or, for
 *      anchors of 16+ non-whitespace characters, the anchored lines);
 *   2. blob still present: map lines with `git diff --no-index -U0 --histogram`
 *      (one diff per blob and path, shared by all threads of the call); when
 *      the diff says the anchored lines were deleted, look for them in the
 *      lines the diff added (moved code stays current; a match on unchanged
 *      lines only doesn't count);
 *   3. blob gone: text search against the snapshot, tolerant of whitespace and
 *      quote style, ranked by matching context first and distance second.
 */

/** Lines of context beyond the anchored size a context pair may enclose. */
const MAX_EXTRA_LINES = 50;
/** Threads resolved concurrently; bounds the number of parallel git diffs. */
const CONCURRENCY = 8;
const OID_RE = /^[0-9a-f]{4,64}$/i;
/** Untracked files larger than this aren't considered as a rename target. */
const MAX_UNTRACKED_BYTES = 1024 * 1024;
/** Bytes sniffed for a NUL to skip binary untracked files. */
const BINARY_SNIFF_BYTES = 8 * 1024;
/** Untracked files examined per rename search, best candidates first. */
const MAX_UNTRACKED_CANDIDATES = 200;
/** Hard ceiling on untracked files probed (size, binary) per rename search. */
const MAX_UNTRACKED_PROBES = 10 * MAX_UNTRACKED_CANDIDATES;
/**
 * Non-whitespace characters an anchor needs before it may match inside another
 * (untracked) file; shorter ones like `}` or `);` match anything.
 */
const MIN_RENAME_ANCHOR_CHARS = 16;
/** Neutralises user config that changes the diff output we parse. */
const DIFF_CONFIG = [
  '-c',
  'diff.noprefix=false',
  '-c',
  'diff.mnemonicPrefix=false',
  '-c',
  'diff.relative=false',
  '-c',
  'diff.interHunkContext=0',
  '-c',
  'color.ui=never',
];

export interface AnchorEnv {
  root: string;
  gitPath: string;
  git: GitBatch;
}

interface Hunk {
  /** old start, old count, new start, new count (as in `@@ -a,b +c,d @@`) */
  a: number;
  b: number;
  c: number;
  d: number;
}

interface Snapshot {
  before: string[];
  anchored: string[];
  after: string[];
}

type Mapped =
  | { state: 'current'; start: number; end: number }
  | { state: 'outdated'; start: number }
  | { state: 'orphaned' };

export async function computeAnchors(
  env: AnchorEnv,
  threads: readonly ThreadView[],
  opts?: AnchorOptions,
): Promise<Map<string, AnchorResult>> {
  const out = new Map<string, AnchorResult>();
  if (threads.length === 0) return out;
  const run = new AnchorRun(env, opts?.overrides ?? new Map<string, string>());
  try {
    const results = await mapLimit(threads, CONCURRENCY, (t) => run.resolve(t));
    threads.forEach((t, i) => out.set(t.id, results[i] as AnchorResult));
    return out;
  } finally {
    await run.dispose();
  }
}

/** State for one anchors() call: every git answer and file read is memoised. */
class AnchorRun {
  private readonly memo = new Map<string, Promise<unknown>>();
  private tmp: Promise<string> | undefined;
  private tmpCounter = 0;

  constructor(
    private readonly env: AnchorEnv,
    private readonly overrides: ReadonlyMap<string, string>,
  ) {}

  async dispose(): Promise<void> {
    if (!this.tmp) return;
    const dir = await this.tmp.catch(() => undefined);
    if (dir) await rm(dir, { recursive: true, force: true });
  }

  async resolve(thread: ThreadView): Promise<AnchorResult> {
    const a = thread.anchor;
    const fromBranch = await this.fromBranch(a);
    const result = await this.resolveAnchor(a, thread.snapshot);
    if (fromBranch !== undefined) result.fromBranch = fromBranch;
    return result;
  }

  private async resolveAnchor(a: Anchor, snapshotText?: string): Promise<AnchorResult> {
    if (!this.inRepo(a.path)) {
      return { state: 'orphaned', path: a.path, method: a.side === 'old' ? 'pinned' : 'path' };
    }
    if (a.side === 'old') return this.pinned(a, snapshotText);
    if (a.kind === 'file') return this.fileAnchor(a);
    return this.lineAnchor(a, snapshotText);
  }

  // -- thread kinds ---------------------------------------------------------

  private async fileAnchor(a: FileAnchor): Promise<AnchorResult> {
    const p = await this.resolvePath(a, async () => {
      if (!OID_RE.test(a.commit)) return undefined;
      return this.objectText(`${a.commit}:${a.path}`);
    });
    if (p === undefined) return { state: 'orphaned', path: a.path, method: 'path' };
    return { state: 'current', path: p, method: 'path' };
  }

  private async lineAnchor(a: LineAnchor, snapshotText?: string): Promise<AnchorResult> {
    const snap = parseSnapshot(a, snapshotText);
    const oldText = OID_RE.test(a.blob) ? await this.objectText(a.blob) : undefined;
    const p = await this.resolvePath(a, async () => oldText, snap?.anchored);
    if (p === undefined) return { state: 'orphaned', path: a.path, method: 'path' };

    const cur = await this.currentLines(p);
    const size = a.endLine - a.startLine + 1;

    if (oldText !== undefined) {
      const hunks = await this.diffHunks(a.blob, oldText, p);
      if (hunks === undefined) return { state: 'orphaned', path: p, method: 'diff' };
      const m = mapRange(hunks, a.startLine, a.endLine);
      if (m.state === 'current') {
        return { state: 'current', path: p, startLine: m.start, endLine: m.end, method: 'diff' };
      }
      if (m.state === 'outdated') {
        const range = keepSize(m.start, size, cur.length);
        return { state: 'outdated', path: p, ...range, method: 'diff' };
      }
      if (snap) {
        const added = addedRanges(hunks);
        const start = rankMatches(cur, cur, snap, a.startLine, false).find((x) =>
          touchesRanges(added, x.start, x.start + size - 1),
        )?.start;
        if (start !== undefined) {
          const endLine = start + size - 1;
          return { state: 'current', path: p, startLine: start, endLine, method: 'moved' };
        }
      }
      return { state: 'orphaned', path: p, method: 'diff' };
    }

    if (!snap) return { state: 'orphaned', path: p, method: 'text-search' };
    const found = textSearch(cur, await this.normalizedLines(p), snap, a.startLine);
    if (found.state === 'orphaned') return { state: 'orphaned', path: p, method: 'text-search' };
    if (found.state === 'current') {
      return {
        state: 'current',
        path: p,
        startLine: found.start,
        endLine: found.start + size - 1,
        method: 'text-search',
      };
    }
    return {
      state: 'outdated',
      path: p,
      ...keepSize(found.start, size, cur.length),
      method: 'text-search',
    };
  }

  /**
   * `old`-side threads comment on the base of a diff, which doesn't move. They
   * keep their saved lines; orphaned only when the commit is unreachable and
   * the snapshot can't be found (in the saved blob or the current file).
   */
  private async pinned(a: Anchor, snapshotText?: string): Promise<AnchorResult> {
    const lines =
      a.kind === 'line' ? { startLine: a.startLine, endLine: a.endLine } : {};
    const current: AnchorResult = { state: 'current', path: a.path, ...lines, method: 'pinned' };
    if (await this.hasCommit(a.commit)) return current;
    if (a.kind === 'line') {
      if (OID_RE.test(a.blob) && (await this.objectText(a.blob)) !== undefined) return current;
      const snap = parseSnapshot(a, snapshotText);
      if (snap && (await this.currentText(a.path)) !== undefined) {
        const cur = await this.currentLines(a.path);
        if (findAll(cur, snap.anchored).length > 0) return current;
      }
    }
    return { state: 'orphaned', path: a.path, method: 'pinned' };
  }

  // -- paths and renames ------------------------------------------------------

  private inRepo(rel: string): boolean {
    if (rel === '' || path.isAbsolute(rel) || /[\0\r\n]/.test(rel)) return false;
    const abs = path.resolve(this.env.root, rel);
    return abs.startsWith(this.env.root + path.sep);
  }

  /**
   * The anchor's file, or its new name: committed or staged renames via
   * `git diff -M`, then an untracked file whose content equals the saved
   * content or that still contains the anchored lines (same basename wins).
   */
  private async resolvePath(
    a: Anchor,
    oldText: () => Promise<string | undefined>,
    anchored?: string[],
  ): Promise<string | undefined> {
    if ((await this.currentText(a.path)) !== undefined) return a.path;

    const renamed = (await this.renames(a.commit)).get(a.path);
    if (renamed !== undefined && this.inRepo(renamed)) {
      if ((await this.currentText(renamed)) !== undefined) return renamed;
    }

    const old = await oldText();
    const searchable = anchored !== undefined && nonWhitespace(anchored) >= MIN_RENAME_ANCHOR_CHARS;
    if (old === undefined && !searchable) return undefined;
    const base = path.posix.basename(a.path);
    let best: { path: string; score: number } | undefined;
    let examined = 0;
    let probed = 0;
    for (const f of await this.untrackedCandidates(a.path)) {
      if (++probed > MAX_UNTRACKED_PROBES) break;
      if (!(await this.isSearchable(f))) continue;
      if (++examined > MAX_UNTRACKED_CANDIDATES) break;
      const text = await this.currentText(f);
      if (text === undefined) continue;
      let score = 0;
      if (old !== undefined && text === old) score = 3;
      else if (searchable && anchored && findAll(await this.currentLines(f), anchored).length > 0) {
        score = 1;
      }
      if (score === 0) continue;
      if (path.posix.basename(f) === base) score += 1;
      if (!best || score > best.score) best = { path: f, score };
    }
    return best?.path;
  }

  /** old path -> new path, from `git diff -M` of the commit against the work tree. */
  private renames(commit: string): Promise<Map<string, string>> {
    return this.once(`renames:${commit}`, async () => {
      const map = new Map<string, string>();
      if (!OID_RE.test(commit)) return map;
      const { code, stdout } = await this.git(
        [
          ...DIFF_CONFIG,
          'diff',
          '-M',
          '--name-status',
          '-z',
          '--no-color',
          '--no-ext-diff',
          commit,
          '--',
        ],
        [0, 128],
      );
      if (code !== 0) return map;
      const parts = stdout.split('\0');
      for (let i = 0; i < parts.length; ) {
        const status = parts[i] ?? '';
        if (status === '') break;
        if (status.startsWith('R') || status.startsWith('C')) {
          const from = parts[i + 1];
          const to = parts[i + 2];
          if (status.startsWith('R') && from !== undefined && to !== undefined) map.set(from, to);
          i += 3;
        } else {
          i += 2;
        }
      }
      return map;
    });
  }

  /**
   * Untracked files worth reading as a new name for `oldPath`: same basename
   * first, then same extension, then the rest. The caller applies the cap
   * to the files that pass the size and binary filters.
   */
  private async untrackedCandidates(oldPath: string): Promise<string[]> {
    const base = path.posix.basename(oldPath);
    const ext = path.posix.extname(oldPath);
    const rank = (f: string): number => {
      if (path.posix.basename(f) === base) return 0;
      return ext !== '' && path.posix.extname(f) === ext ? 1 : 2;
    };
    return (await this.untracked())
      .map((f) => ({ f, r: rank(f) }))
      .sort((x, y) => x.r - y.r)
      .map((x) => x.f);
  }

  private untracked(): Promise<string[]> {
    return this.once('untracked', async () => {
      const { stdout } = await this.git(['ls-files', '--others', '--exclude-standard', '-z'], []);
      return stdout
        .split('\0')
        .filter((f) => f !== '' && !f.startsWith('.lhr/') && this.inRepo(f));
    });
  }

  // -- content -------------------------------------------------------------

  /** Override text, else the file on disk; undefined when neither exists. */
  private currentText(rel: string): Promise<string | undefined> {
    return this.once(`text:${rel}`, async () => {
      const override = this.overrides.get(rel);
      if (override !== undefined) return override;
      const abs = await this.realFile(rel);
      if (abs === undefined) return undefined;
      try {
        return await readFile(abs, 'utf8');
      } catch {
        return undefined;
      }
    });
  }

  /**
   * Real path of a regular file whose real location is inside the repo (a
   * symlink may lead elsewhere); undefined otherwise.
   */
  private async realFile(rel: string): Promise<string | undefined> {
    try {
      const [root, real] = await Promise.all([
        this.once('realRoot', () => realpath(this.env.root)),
        realpath(path.join(this.env.root, rel)),
      ]);
      if (!real.startsWith(root + path.sep)) return undefined;
      return (await stat(real)).isFile() ? real : undefined;
    } catch {
      return undefined;
    }
  }

  /** Small text file on disk (size cap, no NUL in the first bytes), for rename search. */
  private isSearchable(rel: string): Promise<boolean> {
    return this.once(`searchable:${rel}`, () => this.probe(rel));
  }

  private async probe(rel: string): Promise<boolean> {
    const override = this.overrides.get(rel);
    if (override !== undefined) return Buffer.byteLength(override) <= MAX_UNTRACKED_BYTES;
    const abs = await this.realFile(rel);
    if (abs === undefined) return false;
    let handle: FileHandle | undefined;
    try {
      handle = await open(abs, 'r');
      if ((await handle.stat()).size > MAX_UNTRACKED_BYTES) return false;
      const buf = Buffer.alloc(BINARY_SNIFF_BYTES);
      const { bytesRead } = await handle.read(buf, 0, BINARY_SNIFF_BYTES, 0);
      return !buf.subarray(0, bytesRead).includes(0);
    } catch {
      return false;
    } finally {
      await handle?.close();
    }
  }

  private currentLines(rel: string): Promise<string[]> {
    return this.once(`lines:${rel}`, async () => splitLines((await this.currentText(rel)) ?? ''));
  }

  private normalizedLines(rel: string): Promise<string[]> {
    return this.once(`norm:${rel}`, async () => (await this.currentLines(rel)).map(normalize));
  }

  /** A blob's text through the long-lived cat-file process; undefined if missing. */
  private objectText(rev: string): Promise<string | undefined> {
    return this.once(`obj:${rev}`, async () => {
      const obj = await this.env.git.read(rev);
      return obj?.type === 'blob' ? obj.content.toString('utf8') : undefined;
    });
  }

  private hasCommit(commit: string): Promise<boolean> {
    return this.once(`commit:${commit}`, async () => {
      if (!OID_RE.test(commit)) return false;
      return (await this.env.git.read(commit))?.type === 'commit';
    });
  }

  /**
   * One `git diff --no-index` per (blob, path), shared by all threads on it.
   * Undefined when git fails for this file, so only its threads are orphaned.
   */
  private diffHunks(blob: string, oldText: string, rel: string): Promise<Hunk[] | undefined> {
    return this.once(`diff:${blob}:${rel}`, async () => {
      try {
        return await this.runDiff(oldText, rel);
      } catch (err) {
        if (err instanceof LhrError && err.code === 'GIT_FAILED') return undefined;
        throw err;
      }
    });
  }

  private async runDiff(oldText: string, rel: string): Promise<Hunk[]> {
    const curText = (await this.currentText(rel)) ?? '';
    if (curText === oldText) return [];
    const dir = await this.tmpDir();
    const n = this.tmpCounter++;
    const oldFile = path.join(dir, `${n}.old`);
    await writeFile(oldFile, oldText);
    let newFile = (await this.realFile(rel)) ?? path.join(this.env.root, rel);
    if (this.overrides.has(rel)) {
      newFile = path.join(dir, `${n}.new`);
      await writeFile(newFile, curText);
    }
    const { stdout } = await this.git(
      [
        ...DIFF_CONFIG,
        'diff',
        '--no-index',
        '--no-color',
        '--no-ext-diff',
        '--no-textconv',
        '--no-renames',
        '-a',
        '-U0',
        '--inter-hunk-context=0',
        '--histogram',
        '--',
        oldFile,
        newFile,
      ],
      [0, 1],
    );
    return parseHunks(stdout);
  }

  // -- branches ----------------------------------------------------------------

  /**
   * "from branch X" while X exists locally, HEAD isn't on X, and the anchor's
   * commit isn't an ancestor of HEAD.
   */
  private async fromBranch(a: Anchor): Promise<string | undefined> {
    const b = a.branch;
    if (b === undefined) return undefined;
    if (!(await this.branches()).has(b)) return undefined;
    if ((await this.headBranch()) === b) return undefined;
    if (await this.isAncestor(a.commit)) return undefined;
    return b;
  }

  private headBranch(): Promise<string | undefined> {
    return this.once('head', async () => {
      const { code, stdout } = await this.git(['symbolic-ref', '-q', 'HEAD'], [1]);
      const ref = stdout.trim();
      if (code !== 0 || !ref.startsWith('refs/heads/')) return undefined;
      return ref.slice('refs/heads/'.length);
    });
  }

  private branches(): Promise<Set<string>> {
    return this.once('branches', async () => {
      const { stdout } = await this.git(['for-each-ref', '--format=%(refname)', 'refs/heads/'], []);
      const set = new Set<string>();
      for (const ref of stdout.split('\n')) {
        if (ref.startsWith('refs/heads/')) set.add(ref.slice('refs/heads/'.length));
      }
      return set;
    });
  }

  private isAncestor(commit: string): Promise<boolean> {
    return this.once(`anc:${commit}`, async () => {
      if (!OID_RE.test(commit)) return false;
      const { code } = await this.git(['merge-base', '--is-ancestor', commit, 'HEAD'], [1, 128]);
      return code === 0;
    });
  }

  // -- plumbing ---------------------------------------------------------------

  private git(
    args: string[],
    okCodes: readonly number[],
  ): Promise<{ code: number; stdout: string }> {
    return runGitStatus(this.env.gitPath, this.env.root, args, okCodes);
  }

  private tmpDir(): Promise<string> {
    this.tmp ??= mkdtemp(path.join(os.tmpdir(), 'lhr-anchor-'));
    return this.tmp;
  }

  private once<T>(key: string, fn: () => Promise<T>): Promise<T> {
    let p = this.memo.get(key) as Promise<T> | undefined;
    if (!p) {
      p = fn();
      this.memo.set(key, p);
    }
    return p;
  }
}

// -- pure helpers ---------------------------------------------------------------

export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Whitespace removed and quote styles unified, for tolerant text search. */
function normalize(line: string): string {
  return line.replace(/\s+/g, '').replace(/['"`]/g, '"');
}

function parseSnapshot(a: Anchor, text: string | undefined): Snapshot | undefined {
  if (a.kind !== 'line' || text === undefined) return undefined;
  const lines = text.split('\n');
  const k = a.endLine - a.startLine + 1;
  const cb = a.contextBefore;
  if (lines.length < cb + k) return undefined;
  return {
    before: lines.slice(0, cb),
    anchored: lines.slice(cb, cb + k),
    after: lines.slice(cb + k, cb + k + a.contextAfter),
  };
}

const nonWhitespace = (lines: readonly string[]): number =>
  lines.reduce((n, l) => n + l.replace(/\s+/g, '').length, 0);

/** New-side line ranges [first, last] (1-based) that the hunks added. */
function addedRanges(hunks: readonly Hunk[]): Array<[number, number]> {
  return hunks.filter((h) => h.d > 0).map((h): [number, number] => [h.c, h.c + h.d - 1]);
}

/** True when any of lines [s, e] was added; a match on unchanged lines only isn't moved code. */
const touchesRanges = (ranges: ReadonlyArray<[number, number]>, s: number, e: number): boolean =>
  ranges.some(([from, to]) => s <= to && e >= from);

/** 0-based start indexes where `pat` occurs in `lines`. */
function findAll(lines: readonly string[], pat: readonly string[]): number[] {
  const out: number[] = [];
  if (pat.length === 0) return out;
  const first = pat[0];
  for (let i = 0; i + pat.length <= lines.length; i++) {
    if (lines[i] !== first) continue;
    let ok = true;
    for (let j = 1; j < pat.length; j++) {
      if (lines[i + j] !== pat[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

export function parseHunks(diff: string): Hunk[] {
  const hunks: Hunk[] = [];
  const re = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm;
  for (let m = re.exec(diff); m; m = re.exec(diff)) {
    hunks.push({
      a: Number(m[1]),
      b: m[2] === undefined ? 1 : Number(m[2]),
      c: Number(m[3]),
      d: m[4] === undefined ? 1 : Number(m[4]),
    });
  }
  return hunks;
}

// With -U0: b > 0 replaces old lines [a, a+b-1]; b == 0 inserts after old line a.
const touches = (h: Hunk, s: number, e: number): boolean =>
  h.b === 0 ? h.a >= s && h.a < e : h.a <= e && h.a + h.b - 1 >= s;
const hunkBefore = (h: Hunk, s: number): boolean => (h.b === 0 ? h.a < s : h.a + h.b - 1 < s);

/** Maps old lines [s, e] through -U0 hunks. */
export function mapRange(hunks: readonly Hunk[], s: number, e: number): Mapped {
  let shift = 0;
  const touching: Hunk[] = [];
  for (const h of hunks) {
    if (touches(h, s, e)) touching.push(h);
    else if (hunkBefore(h, s)) shift += h.d - h.b;
  }
  if (touching.length === 0) return { state: 'current', start: s + shift, end: e + shift };
  // Mapped start: the first anchored line that still has a place in the new
  // file. A line inside a replacement hunk maps to the same offset in the
  // replacement, clamped to its last line; a deleted line has no place.
  for (let i = s; i <= e; i++) {
    let off = shift;
    let pos: number | undefined;
    let deleted = false;
    for (const h of touching) {
      if (h.b > 0 && i >= h.a && i < h.a + h.b) {
        if (h.d > 0) pos = h.c + Math.min(i - h.a, h.d - 1);
        else deleted = true;
        break;
      }
      if (hunkBefore(h, i)) off += h.d - h.b;
    }
    if (pos !== undefined) return { state: 'outdated', start: pos };
    if (!deleted) return { state: 'outdated', start: i + off };
  }
  // Every anchored line was deleted; lines inserted inside the range remain.
  let start = Infinity;
  for (const h of touching) if (h.d > 0) start = Math.min(start, h.c);
  return start === Infinity ? { state: 'orphaned' } : { state: 'outdated', start };
}

/** An outdated range starts at the mapped line and keeps the anchor's size. */
function keepSize(
  start: number,
  size: number,
  fileLen: number,
): { startLine: number; endLine: number } {
  const last = Math.max(fileLen, 1);
  const s = Math.min(Math.max(start, 1), last);
  return { startLine: s, endLine: Math.min(s + size - 1, last) };
}

interface Match {
  /** 1-based */
  start: number;
  context: number;
  exact: boolean;
  dist: number;
}

/**
 * Occurrences of the anchored lines in `lines` (the current file, raw or
 * normalised to match `normalized`), best first: most matching context lines,
 * then exact over normalised-only matches (checked against `raw`), then
 * nearest to the old start line.
 */
function rankMatches(
  lines: readonly string[],
  raw: readonly string[],
  snap: Snapshot,
  oldStart: number,
  normalized: boolean,
): Match[] {
  const conv = normalized ? (xs: string[]) => xs.map(normalize) : (xs: string[]) => xs;
  const anchored = conv(snap.anchored);
  const pre = conv(snap.before);
  const post = conv(snap.after);
  const k = anchored.length;
  const matches = findAll(lines, anchored).map((i): Match => {
    let context = 0;
    for (let j = 0; j < pre.length; j++) if (lines[i - pre.length + j] === pre[j]) context++;
    for (let j = 0; j < post.length; j++) if (lines[i + k + j] === post[j]) context++;
    let exact = true;
    for (let j = 0; j < k; j++) {
      if (raw[i + j] !== snap.anchored[j]) {
        exact = false;
        break;
      }
    }
    return { start: i + 1, context, exact, dist: Math.abs(i + 1 - oldStart) };
  });
  matches.sort(
    (x, y) => y.context - x.context || Number(y.exact) - Number(x.exact) || x.dist - y.dist,
  );
  return matches;
}

/**
 * Snapshot search when the blob is gone. The anchored lines found (ignoring
 * whitespace and quotes) give current when they match exactly, else outdated.
 * Otherwise one matching context side is enough for outdated; both sides
 * found with nothing between them means the anchored lines were deleted.
 */
function textSearch(
  raw: readonly string[],
  norm: readonly string[],
  snap: Snapshot,
  oldStart: number,
): { state: 'current' | 'outdated'; start: number } | { state: 'orphaned' } {
  const best = rankMatches(norm, raw, snap, oldStart, true)[0];
  if (best) return { state: best.exact ? 'current' : 'outdated', start: best.start };

  const k = snap.anchored.length;
  const pre = snap.before.map(normalize);
  const post = snap.after.map(normalize);
  if (pre.length === 0 && post.length === 0) return { state: 'orphaned' };

  // 1-based line right after a before-context match / of an after-context match.
  // A side with no context at the edge of the file is anchored to that edge.
  const starts = pre.length ? findAll(norm, pre).map((i) => i + pre.length + 1) : [1];
  const ends = post.length ? findAll(norm, post).map((i) => i + 1) : [norm.length + 1];

  interface Candidate {
    start: number;
    sides: number;
    gap: number;
    dist: number;
  }
  const cands: Candidate[] = [];
  for (const s of starts) {
    for (const e of ends) {
      const gap = e - s;
      if (gap < 0 || gap > k + MAX_EXTRA_LINES) continue;
      cands.push({ start: s, sides: 2, gap, dist: Math.abs(s - oldStart) });
    }
  }
  if (pre.length) {
    for (const s of starts) {
      cands.push({ start: s, sides: 1, gap: -1, dist: Math.abs(s - oldStart) });
    }
  }
  if (post.length) {
    for (const e of ends) {
      const s = Math.max(1, e - k);
      cands.push({ start: s, sides: 1, gap: -1, dist: Math.abs(s - oldStart) });
    }
  }
  cands.sort((x, y) => y.sides - x.sides || x.dist - y.dist);
  const top = cands[0];
  if (!top || top.gap === 0) return { state: 'orphaned' };
  return { state: 'outdated', start: top.start };
}

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
