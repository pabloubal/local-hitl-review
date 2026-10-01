// PROTOTYPE, throwaway, not production.
//
// Re-anchoring prototype for issue #50 ("Re-anchoring prototype on real git repos").
// Tests the planned anchor-state algorithm (current / outdated / orphaned) against
// real temporary git repos. Plain Node 22 ESM, only child_process + fs + os.
//
// Run: node prototypes/re-anchoring/reanchor.prototype.mjs

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';

// ---------------------------------------------------------------------------
// git plumbing
// ---------------------------------------------------------------------------

// Isolate from the user's git config so results are reproducible.
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'proto',
  GIT_AUTHOR_EMAIL: 'proto@example.invalid',
  GIT_COMMITTER_NAME: 'proto',
  GIT_COMMITTER_EMAIL: 'proto@example.invalid',
  GIT_TERMINAL_PROMPT: '0',
};

const stats = { spawns: 0 };

function git(cwd, args, { input, okCodes = [0], encoding = 'utf8' } = {}) {
  stats.spawns++;
  const r = spawnSync('git', args, {
    cwd,
    input,
    encoding: encoding === 'buffer' ? undefined : encoding,
    maxBuffer: 1 << 30,
    env: GIT_ENV,
  });
  if (!okCodes.includes(r.status)) {
    const err = Buffer.isBuffer(r.stderr) ? r.stderr.toString() : r.stderr;
    throw new Error(`git ${args.join(' ')} failed (${r.status}): ${err}`);
  }
  return r;
}

function splitLines(text) {
  if (text === '') return [];
  const ls = text.split('\n');
  if (ls[ls.length - 1] === '') ls.pop();
  return ls;
}

const isFile = (p) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

function findAll(lines, pat) {
  const out = [];
  if (!pat.length) return out;
  for (let i = 0; i + pat.length <= lines.length; i++) {
    if (lines[i] !== pat[0]) continue;
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

// ---------------------------------------------------------------------------
// Anchor creation
// ---------------------------------------------------------------------------

function headInfo(repo) {
  const out = git(repo, ['rev-parse', 'HEAD', '--abbrev-ref', 'HEAD']).stdout.trim().split('\n');
  return { commit: out[0], branch: out[1] === 'HEAD' ? null : out[1] };
}

function buildSnapshot(lines, start, end, ctx = 3) {
  const cb = Math.min(ctx, start - 1);
  const ca = Math.min(ctx, lines.length - end);
  return {
    contextBefore: cb,
    contextAfter: ca,
    snapshot: {
      before: lines.slice(start - 1 - cb, start - 1),
      anchored: lines.slice(start - 1, end),
      after: lines.slice(end, end + ca),
    },
  };
}

function createAnchor(repo, relPath, start, end) {
  const content = fs.readFileSync(`${repo}/${relPath}`, 'utf8');
  // --no-filters: store the raw working-tree bytes, so the later diff against the
  // raw working-tree file is not polluted by clean filters / autocrlf.
  const blob = git(repo, ['hash-object', '-w', '--no-filters', '--', relPath]).stdout.trim();
  const { commit, branch } = headInfo(repo);
  return {
    path: relPath,
    side: 'working-tree',
    commit,
    branch,
    blob,
    startLine: start,
    endLine: end,
    ...buildSnapshot(splitLines(content), start, end),
  };
}

// Anchor as if created at an older commit (scenario 10): blob already in the repo.
function createAnchorAtCommit(repo, commit, relPath, start, end, branch, content) {
  const blob = git(repo, ['rev-parse', `${commit}:${relPath}`]).stdout.trim();
  return {
    path: relPath,
    side: 'working-tree',
    commit,
    branch,
    blob,
    startLine: start,
    endLine: end,
    ...buildSnapshot(splitLines(content), start, end),
  };
}

// ---------------------------------------------------------------------------
// Diff hunk parsing and range mapping
// ---------------------------------------------------------------------------

function parseHunks(diffText) {
  const hunks = [];
  const re = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm;
  let m;
  while ((m = re.exec(diffText))) {
    hunks.push({
      a: +m[1],
      b: m[2] === undefined ? 1 : +m[2],
      c: +m[3],
      d: m[4] === undefined ? 1 : +m[4],
    });
  }
  return hunks;
}

// Hunk semantics with -U0:
//   b > 0: old lines [a, a+b-1] replaced/deleted.  b == 0: insertion after old line a.
//   d > 0: new lines [c, c+d-1].                   d == 0: deletion sits after new line c.
const hunkTouches = (h, S, E) => (h.b === 0 ? h.a >= S && h.a < E : h.a <= E && h.a + h.b - 1 >= S);
const hunkBefore = (h, S) => (h.b === 0 ? h.a < S : h.a + h.b - 1 < S);
const hunkStr = (h) => `-${h.a},${h.b} +${h.c},${h.d}`;

// "Diff slider" normalisation (deviation from the brief, see README): a pure
// insertion or pure deletion whose content allows it to be shifted up/down
// (first line == line after, or last line == line before) has several equally
// valid placements. If one placement is outside the anchored range, use it.
function slideOut(h, S, E, oldLines, newLines, changedOld) {
  const pureIns = h.b === 0 && h.d > 0;
  const pureDel = h.d === 0 && h.b > 0;
  if (!pureIns && !pureDel) return null;
  for (const dir of [1, -1]) {
    let a = h.a;
    let c = h.c;
    let ok = true;
    let guard = 0;
    while (hunkTouches({ ...h, a, c }, S, E) && guard++ < 100000) {
      if (pureIns) {
        if (dir > 0) {
          if (changedOld.has(a + 1) || c + h.d > newLines.length || newLines[c - 1] !== newLines[c + h.d - 1]) ok = false;
        } else if (a < 1 || changedOld.has(a) || c < 2 || newLines[c + h.d - 2] !== newLines[c - 2]) ok = false;
      } else if (dir > 0) {
        if (changedOld.has(a + h.b) || a + h.b > oldLines.length || oldLines[a - 1] !== oldLines[a + h.b - 1]) ok = false;
      } else if (a < 2 || changedOld.has(a - 1) || oldLines[a + h.b - 2] !== oldLines[a - 2]) ok = false;
      if (!ok) break;
      a += dir;
      c += dir;
    }
    if (ok) return { ...h, a, c };
  }
  return null;
}

function mapRange(hunksIn, S, E, oldLines, newLines, { slider }, notes) {
  let hunks = hunksIn;
  if (slider) {
    const changedOld = new Set();
    for (const h of hunksIn) for (let i = h.a; i < h.a + h.b; i++) changedOld.add(i);
    hunks = hunksIn.map((h) => {
      if (!hunkTouches(h, S, E)) return h;
      const s = slideOut(h, S, E, oldLines, newLines, changedOld);
      if (s) {
        notes.push(`slider: moved hunk ${hunkStr(h)} to ${hunkStr(s)} (outside range)`);
        return s;
      }
      return h;
    });
  }
  let shift = 0;
  const touching = [];
  for (const h of hunks) {
    if (hunkTouches(h, S, E)) touching.push(h);
    else if (hunkBefore(h, S)) shift += h.d - h.b;
  }
  if (!touching.length) return { state: 'current', startLine: S + shift, endLine: E + shift };
  notes.push(`touching hunks: ${touching.map(hunkStr).join(' ')}`);
  const pos = [];
  for (let i = S; i <= E; i++) {
    let off = shift;
    let gone = false;
    for (const h of touching) {
      if (h.b > 0 && i >= h.a && i < h.a + h.b) {
        gone = true;
        break;
      }
      if (hunkBefore(h, i)) off += h.d - h.b;
    }
    if (!gone) pos.push(i + off);
  }
  for (const h of touching) if (h.d > 0) pos.push(h.c, h.c + h.d - 1);
  if (!pos.length) return { state: 'orphaned' };
  return { state: 'outdated', startLine: Math.min(...pos), endLine: Math.max(...pos) };
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

class Resolver {
  constructor(repo, opts = {}) {
    this.repo = repo;
    this.opts = {
      cache: true, // one diff per (blob, current file); memoise HEAD / blob checks
      forceTextSearch: false, // pretend the blob is gone
      slider: true, // deviation: diff slider normalisation
      contextRank: true, // deviation: rank text-search matches by context first
      untrackedRename: true, // deviation: look for untracked new names
      movedFallback: true, // deviation: diff says orphaned -> exact text match elsewhere = moved
      ...opts,
    };
    this.memo = new Map();
    this.tmp = null;
    this.counter = 0;
    this.diffs = 0;
  }

  m(key, fn) {
    if (!this.opts.cache) return fn();
    if (!this.memo.has(key)) this.memo.set(key, fn());
    return this.memo.get(key);
  }

  tmpDir() {
    if (!this.tmp) this.tmp = fs.mkdtempSync(`${os.tmpdir()}/reanchor-blobs-`);
    return this.tmp;
  }

  dispose() {
    if (this.tmp) fs.rmSync(this.tmp, { recursive: true, force: true });
    this.tmp = null;
  }

  head() {
    return this.m('head', () => headInfo(this.repo));
  }

  isAncestor(commit) {
    return this.m(`anc:${commit}`, () => git(this.repo, ['merge-base', '--is-ancestor', commit, 'HEAD'], { okCodes: [0, 1, 128] }).status === 0);
  }

  blobExists(blob) {
    return this.m(`exists:${blob}`, () => git(this.repo, ['cat-file', '-e', blob], { okCodes: [0, 1, 128] }).status === 0);
  }

  blobBuf(blob) {
    return this.m(`blob:${blob}`, () => git(this.repo, ['cat-file', 'blob', blob], { encoding: 'buffer' }).stdout);
  }

  oldLines(blob) {
    return this.m(`oldlines:${blob}`, () => splitLines(this.blobBuf(blob).toString('utf8')));
  }

  fileKey(relPath) {
    const st = fs.statSync(`${this.repo}/${relPath}`);
    return `${relPath}:${st.size}:${st.mtimeMs}`;
  }

  fileLines(relPath) {
    return this.m(`file:${this.fileKey(relPath)}`, () => splitLines(fs.readFileSync(`${this.repo}/${relPath}`, 'utf8')));
  }

  diffHunks(blob, relPath) {
    return this.m(`diff:${blob}:${this.fileKey(relPath)}`, () => {
      const oldFile = `${this.tmpDir()}/${blob}-${this.counter++}`;
      fs.writeFileSync(oldFile, this.blobBuf(blob));
      const r = git(
        this.repo,
        ['diff', '--no-index', '--no-color', '--no-ext-diff', '-a', '-U0', '--histogram', '--', oldFile, `${this.repo}/${relPath}`],
        { okCodes: [0, 1] },
      );
      this.diffs++;
      return parseHunks(r.stdout);
    });
  }

  findRename(anchor, notes) {
    const r = git(this.repo, ['diff', '-M', '--name-status', '--no-color', anchor.commit], { okCodes: [0, 128] });
    if (r.status !== 0) notes.push(`git diff -M failed: ${r.stderr.trim()}`);
    else {
      for (const line of r.stdout.split('\n')) {
        const parts = line.split('\t');
        if (parts[0].startsWith('R') && parts[1] === anchor.path) return { path: parts[2], how: `git diff -M (${parts[0]})` };
      }
      notes.push('git diff -M: no rename');
    }
    if (!this.opts.untrackedRename) return null;
    // Untracked new names are invisible to git diff -M. Heuristic: an untracked file
    // whose content equals the saved blob, or that contains the anchored lines.
    const untracked = git(this.repo, ['ls-files', '--others', '--exclude-standard', '-z']).stdout.split('\0').filter(Boolean);
    const oldText = this.blobExists(anchor.blob) ? this.blobBuf(anchor.blob).toString('utf8') : null;
    const base = anchor.path.split('/').pop();
    let best = null;
    for (const f of untracked) {
      const text = fs.readFileSync(`${this.repo}/${f}`, 'utf8');
      let score = 0;
      if (oldText !== null && text === oldText) score = 3;
      else if (findAll(splitLines(text), anchor.snapshot.anchored).length) score = 1;
      if (!score) continue;
      if (f.split('/').pop() === base) score += 1;
      if (!best || score > best.score) best = { path: f, score };
    }
    if (best) return { path: best.path, how: `untracked-file heuristic (score ${best.score})` };
    notes.push('untracked heuristic: no candidate');
    return null;
  }

  resolve(anchor) {
    const notes = [];
    const head = this.head();
    let branchLabel;
    if (anchor.branch && head.branch !== anchor.branch && !this.isAncestor(anchor.commit)) branchLabel = `from branch ${anchor.branch}`;
    let p = anchor.path;
    if (!isFile(`${this.repo}/${p}`)) {
      const ren = this.findRename(anchor, notes);
      if (!ren) return { state: 'orphaned', path: anchor.path, method: 'path', branchLabel, notes: [...notes, 'file gone'] };
      notes.push(`renamed via ${ren.how}`);
      p = ren.path;
    }
    let res;
    if (!this.opts.forceTextSearch && this.blobExists(anchor.blob)) {
      res = { ...mapRange(this.diffHunks(anchor.blob, p), anchor.startLine, anchor.endLine, this.oldLines(anchor.blob), this.fileLines(p), this.opts, notes), method: 'diff' };
      if (res.state === 'orphaned' && this.opts.movedFallback) {
        const t = this.viaText(anchor, p, notes, true);
        if (t.state === 'current') {
          notes.push('diff said orphaned, exact match elsewhere (moved)');
          res = { ...t, method: 'diff+text' };
        }
      }
    } else {
      if (!this.opts.forceTextSearch) notes.push('blob missing');
      res = this.viaText(anchor, p, notes, false);
    }
    return { ...res, path: p, branchLabel, notes };
  }

  viaText(anchor, p, notes, exactOnly) {
    const cur = this.fileLines(p);
    const { before, anchored, after } = anchor.snapshot;
    const S = anchor.startLine;
    const k = anchored.length;
    const cands = findAll(cur, anchored);
    if (cands.length) {
      const scored = cands.map((i) => {
        let score = 0;
        if (this.opts.contextRank) {
          for (let j = 0; j < before.length; j++) if (cur[i - before.length + j] === before[j]) score++;
          for (let j = 0; j < after.length; j++) if (cur[i + k + j] === after[j]) score++;
        }
        return { i, score, dist: Math.abs(i + 1 - S) };
      });
      scored.sort((x, y) => y.score - x.score || x.dist - y.dist);
      if (cands.length > 1) notes.push(`${cands.length} exact matches, picked line ${scored[0].i + 1} (ctx ${scored[0].score}, dist ${scored[0].dist})`);
      return { state: 'current', startLine: scored[0].i + 1, endLine: scored[0].i + k, method: 'text-search', matches: cands.length };
    }
    if (exactOnly) return { state: 'orphaned', method: 'text-search' };
    if (!before.length && !after.length) {
      notes.push('no context to search');
      return { state: 'orphaned', method: 'text-search' };
    }
    const starts = before.length ? findAll(cur, before).map((i) => i + before.length + 1) : [1];
    const ends = after.length ? findAll(cur, after) : [cur.length];
    const maxLen = k + 50;
    let best = null;
    for (const s of starts) {
      for (const e of ends) {
        const len = e - s + 1;
        if (len < 0 || len > maxLen) continue;
        const c = { s, e, len, dist: Math.abs(s - S) };
        if (!best || c.dist < best.dist || (c.dist === best.dist && c.len < best.len)) best = c;
      }
    }
    if (!best) {
      notes.push('anchored lines and context pair not found');
      return { state: 'orphaned', method: 'text-search' };
    }
    if (best.len === 0) {
      notes.push('context found adjacent: anchored lines deleted');
      return { state: 'orphaned', method: 'text-search' };
    }
    return { state: 'outdated', startLine: best.s, endLine: best.e, method: 'text-search' };
  }
}

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

const tmpRoots = [];
const results = [];
const extraReport = [];

function mkTmp(prefix) {
  const d = fs.mkdtempSync(`${os.tmpdir()}/${prefix}`);
  tmpRoots.push(d);
  return d;
}

function mkRepo() {
  const d = mkTmp('reanchor-');
  git(d, ['init', '-q', '-b', 'main']);
  git(d, ['config', 'gc.auto', '0']);
  return d;
}

function write(repo, rel, lines) {
  const abs = `${repo}/${rel}`;
  fs.mkdirSync(abs.slice(0, abs.lastIndexOf('/')), { recursive: true });
  fs.writeFileSync(abs, lines.length ? `${lines.join('\n')}\n` : '');
}

function commitAll(repo, msg) {
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', msg]);
}

function setupRepo(files) {
  const repo = mkRepo();
  for (const [p, lines] of Object.entries(files)) write(repo, p, lines);
  commitAll(repo, 'init');
  return repo;
}

function resolveWith(repo, anchor, opts) {
  const r = new Resolver(repo, opts);
  try {
    return r.resolve(anchor);
  } finally {
    r.dispose();
  }
}

function fmt(r, anchor) {
  let s = r.state;
  if (r.state !== 'orphaned') s += ` ${anchor && r.path !== anchor.path ? `${r.path}:` : ''}${r.startLine}-${r.endLine}`;
  if (r.branchLabel) s += ` [${r.branchLabel}]`;
  return s;
}

function record(id, name, expected, r, anchor, note = '') {
  const actual = typeof r === 'string' ? r : fmt(r, anchor);
  const method = typeof r === 'string' ? '-' : r.method;
  results.push({ id, name, expected, actual, method, verdict: expected === actual ? 'PASS' : 'FAIL', note });
  if (process.env.VERBOSE && typeof r !== 'string') console.error(id, r.notes);
}

function info(id, name, actual, note = '') {
  results.push({ id, name, expected: '(measure)', actual, method: '-', verdict: 'INFO', note });
}

function scenario(id, name, fn) {
  try {
    fn();
  } catch (e) {
    results.push({ id, name, expected: '?', actual: `ERROR: ${e.message.split('\n')[0]}`, method: '-', verdict: 'ERROR', note: '' });
  }
}

// note helper: compare with a variant resolver option
function variantNote(repo, anchor, main, label, opts) {
  const v = resolveWith(repo, anchor, opts);
  return fmt(v, anchor) === fmt(main, anchor) ? '' : `${label}: ${fmt(v, anchor)}`;
}

function rng(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const L = (i) => `const v${i} = compute(${i});`;
const base30 = () => Array.from({ length: 30 }, (_, i) => L(i + 1));
const joinNotes = (...xs) => xs.filter(Boolean).join('; ');
const sliderNote = (r) => r.notes.filter((n) => n.startsWith('slider') || n.startsWith('touching')).join('; ');

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

function s1() {
  scenario('1', 'insert 5 lines above', () => {
    const repo = setupRepo({ 'a.ts': base30() });
    const an = createAnchor(repo, 'a.ts', 10, 12);
    const lines = base30();
    lines.splice(2, 0, ...Array.from({ length: 5 }, (_, i) => `// inserted ${i}`));
    write(repo, 'a.ts', lines);
    record('1', 'insert 5 lines above', 'current 15-17', resolveWith(repo, an), an);
  });
}

function s2() {
  scenario('2', 'edit an anchored line', () => {
    const repo = setupRepo({ 'a.ts': base30() });
    const an = createAnchor(repo, 'a.ts', 10, 12);
    const lines = base30();
    lines[10] = 'const v11 = compute(11) + 1;';
    write(repo, 'a.ts', lines);
    record('2', 'edit an anchored line', 'outdated 10-12', resolveWith(repo, an), an);
  });
}

function s3() {
  const run = (id, name, initial, S, E, mutate, expected) =>
    scenario(id, name, () => {
      const repo = setupRepo({ 'a.ts': initial });
      const an = createAnchor(repo, 'a.ts', S, E);
      const lines = [...initial];
      mutate(lines);
      write(repo, 'a.ts', lines);
      const r = resolveWith(repo, an);
      record(id, name, expected, r, an, joinNotes(sliderNote(r), variantNote(repo, an, r, 'slider off', { slider: false })));
    });
  run('3a', 'edit far above + far below', base30(), 10, 12, (l) => {
    l[2] += ' // e';
    l[24] += ' // e';
  }, 'current 10-12');
  run('3b', 'edit line adjacent above + below', base30(), 10, 12, (l) => {
    l[8] += ' // e';
    l[12] += ' // e';
  }, 'current 10-12');
  run('3c', 'insert directly above + directly below', base30(), 10, 12, (l) => {
    l.splice(12, 0, '// below');
    l.splice(9, 0, '// above');
  }, 'current 11-13');
  run('3d', 'delete adjacent line above + below', base30(), 10, 12, (l) => {
    l.splice(12, 1);
    l.splice(8, 1);
  }, 'current 9-11');
  const code = ['function f(x) {', '  let y = 0;', '  if (x) {', '    y = 1;', '  }', '  if (x > 1) {', '    y = 2;', '  }', '  return y;', '}'];
  run('3e', 'slider: block ending "  }" inserted below', code, 3, 5, (l) => {
    l.splice(5, 0, '  if (z) {', '    y = 9;', '  }');
  }, 'current 3-5');
  run('3f', 'slider: block starting like range inserted above', code, 6, 8, (l) => {
    l.splice(5, 0, '  if (x > 1) {', '    y = 5;', '  }');
  }, 'current 9-11');
  run('3g', 'slider: copy of anchored block pasted below', base30(), 10, 12, (l) => {
    l.splice(12, 0, L(10), L(11), L(12));
  }, 'current 10-12');
  run('3h', 'slider: delete block below ending "  }"', code, 3, 5, (l) => {
    l.splice(5, 3);
  }, 'current 3-5');
}

function s4() {
  scenario('4a', 'anchored lines deleted', () => {
    const repo = setupRepo({ 'a.ts': base30() });
    const an = createAnchor(repo, 'a.ts', 10, 12);
    const l = base30();
    l.splice(9, 3);
    write(repo, 'a.ts', l);
    record('4a', 'anchored lines deleted', 'orphaned', resolveWith(repo, an), an);
  });
  scenario('4b', 'partial delete (10-14, delete 12-14)', () => {
    const repo = setupRepo({ 'a.ts': base30() });
    const an = createAnchor(repo, 'a.ts', 10, 14);
    const l = base30();
    l.splice(11, 3);
    write(repo, 'a.ts', l);
    const r = resolveWith(repo, an);
    record('4b', 'partial delete (10-14, delete 12-14)', 'outdated 10-11', r, an, variantNote(repo, an, r, 'text-search', { forceTextSearch: true }));
  });
  scenario('4c', 'anchored block moved within file', () => {
    const repo = setupRepo({ 'a.ts': base30() });
    const an = createAnchor(repo, 'a.ts', 10, 12);
    const l = base30();
    const blk = l.splice(9, 3);
    l.splice(22, 0, ...blk); // after old line 25 (now index 22)
    write(repo, 'a.ts', l);
    const r = resolveWith(repo, an);
    record('4c', 'anchored block moved within file', 'current 23-25', r, an, variantNote(repo, an, r, 'pure diff (no moved fallback)', { movedFallback: false }));
  });
  scenario('4d', 'file deleted', () => {
    const repo = setupRepo({ 'a.ts': base30() });
    const an = createAnchor(repo, 'a.ts', 10, 12);
    fs.unlinkSync(`${repo}/a.ts`);
    record('4d', 'file deleted', 'orphaned', resolveWith(repo, an), an);
  });
}

function s5() {
  const run = (id, name, act, expected, opts) =>
    scenario(id, name, () => {
      const repo = setupRepo({ 'src/a.ts': base30() });
      const an = createAnchor(repo, 'src/a.ts', 10, 12);
      act(repo);
      const r = resolveWith(repo, an, opts);
      record(id, name, expected, r, an, joinNotes(r.notes.filter((n) => n.includes('renam') || n.includes('untracked')).join('; '), opts ? '' : variantNote(repo, an, r, 'no untracked heuristic', { untrackedRename: false })));
    });
  const ins2edit = (repo, editAnchored) => {
    const l = base30();
    if (editAnchored) l[10] += ' // edited';
    else l[24] += ' // edited';
    l.splice(1, 0, '// x', '// y');
    write(repo, 'src/b.ts', l);
  };
  run('5a', 'git mv, committed', (repo) => {
    git(repo, ['mv', 'src/a.ts', 'src/b.ts']);
    commitAll(repo, 'mv');
  }, 'current src/b.ts:10-12');
  run('5b', 'git mv, staged not committed', (repo) => git(repo, ['mv', 'src/a.ts', 'src/b.ts']), 'current src/b.ts:10-12');
  run('5c', 'plain mv (new name untracked)', (repo) => fs.renameSync(`${repo}/src/a.ts`, `${repo}/src/b.ts`), 'current src/b.ts:10-12');
  run('5d', 'git mv committed + anchored line edited', (repo) => {
    git(repo, ['mv', 'src/a.ts', 'src/b.ts']);
    commitAll(repo, 'mv');
    ins2edit(repo, true);
  }, 'outdated src/b.ts:12-14');
  run('5e', 'git mv committed + edit elsewhere', (repo) => {
    git(repo, ['mv', 'src/a.ts', 'src/b.ts']);
    commitAll(repo, 'mv');
    ins2edit(repo, false);
  }, 'current src/b.ts:12-14');
  run('5f', 'plain mv + anchored line edited', (repo) => {
    fs.unlinkSync(`${repo}/src/a.ts`);
    ins2edit(repo, true);
  }, 'outdated src/b.ts:12-14');
}

function s6() {
  const F = ['function dup(a) {', '  const r = a * 2;', '  return r;', '}'];
  const dupFile = ['// file', 'import x;', '', ...F, '', 'const mid = 1;', 'const mid2 = 2;', '', ...F, '', 'const tail = 1;'];
  // second F at 12-15; insert 6 lines after line 1 -> first F at 10-13, second at 18-21
  const mutateDup = (repo) => {
    const l = [...dupFile];
    l.splice(1, 0, ...Array.from({ length: 6 }, (_, i) => `// header ${i}`));
    write(repo, 'a.ts', l);
  };
  scenario('6a', 'duplicate fn, 6 lines above (diff)', () => {
    const repo = setupRepo({ 'a.ts': dupFile });
    const an = createAnchor(repo, 'a.ts', 12, 15);
    mutateDup(repo);
    record('6a', 'duplicate fn, 6 lines above (diff)', 'current 18-21', resolveWith(repo, an), an);
  });
  scenario('6b', 'duplicate fn, 6 lines above (text)', () => {
    const repo = setupRepo({ 'a.ts': dupFile });
    const an = createAnchor(repo, 'a.ts', 12, 15);
    mutateDup(repo);
    const r = resolveWith(repo, an, { forceTextSearch: true });
    record('6b', 'duplicate fn, 6 lines above (text)', 'current 18-21', r, an, variantNote(repo, an, r, 'naive closest (no ctx rank)', { forceTextSearch: true, contextRank: false }));
  });
  const F5 = ['function target(a) {', '  const r = a * 2;', '  log(r);', '  return r;', '}'];
  const tFile = () => {
    const l = base30();
    l.splice(9, 5, ...F5); // target at 10-14
    return l;
  };
  const mutateCopy = (repo) => {
    const l = tFile();
    l.splice(7, 0, ...F5, ''); // copy at 8-12, blank 13, original at 16-20
    write(repo, 'a.ts', l);
  };
  scenario('6c', 'copy inserted ABOVE original (diff)', () => {
    const repo = setupRepo({ 'a.ts': tFile() });
    const an = createAnchor(repo, 'a.ts', 10, 14);
    mutateCopy(repo);
    const r = resolveWith(repo, an);
    record('6c', 'copy inserted ABOVE original (diff)', 'current 16-20', r, an, sliderNote(r));
  });
  scenario('6d', 'copy inserted ABOVE original (text)', () => {
    const repo = setupRepo({ 'a.ts': tFile() });
    const an = createAnchor(repo, 'a.ts', 10, 14);
    mutateCopy(repo);
    const r = resolveWith(repo, an, { forceTextSearch: true });
    record('6d', 'copy inserted ABOVE original (text)', 'current 16-20', r, an, variantNote(repo, an, r, 'naive closest', { forceTextSearch: true, contextRank: false }));
  });
}

function s7() {
  const run = (id, name, mutate, expected) =>
    scenario(id, name, () => {
      const repo = setupRepo({ 'a.ts': base30() });
      const l0 = base30();
      l0[4] += ' // uncommitted';
      write(repo, 'a.ts', l0);
      const an = createAnchor(repo, 'a.ts', 10, 12);
      const l = [...l0];
      mutate(l);
      write(repo, 'a.ts', l);
      git(repo, ['reflog', 'expire', '--expire=now', '--all']);
      git(repo, ['gc', '-q', '--prune=now']);
      const gone = git(repo, ['cat-file', '-e', an.blob], { okCodes: [0, 1, 128] }).status !== 0;
      const r = resolveWith(repo, an);
      record(id, name, expected, r, an, gone ? 'cat-file -e fails after gc' : 'BLOB STILL PRESENT after gc');
    });
  run('7a', 'blob gc\'d, 4 lines above', (l) => l.splice(0, 0, '// 1', '// 2', '// 3', '// 4'), 'current 14-16');
  run('7b', 'blob gc\'d, anchored line edited', (l) => {
    l[10] += ' // edit';
    l.splice(0, 0, '// 1', '// 2', '// 3', '// 4');
  }, 'outdated 14-16');
  run('7c', 'blob gc\'d, anchored + context line edited', (l) => {
    l[10] += ' // edit';
    l[8] += ' // edit';
    l.splice(0, 0, '// 1', '// 2', '// 3', '// 4');
  }, 'outdated 14-16');
}

function s8() {
  const setup = () => {
    const repo = setupRepo({ 'a.ts': base30() });
    git(repo, ['checkout', '-q', '-b', 'feature']);
    const l = base30();
    l.splice(10, 0, 'function feat() {', '  return 42;', '}', '');
    write(repo, 'a.ts', l);
    commitAll(repo, 'feature work');
    const A = createAnchor(repo, 'a.ts', 11, 13); // feature-only code
    const B = createAnchor(repo, 'a.ts', 20, 22); // = main lines 16-18
    git(repo, ['checkout', '-q', 'main']);
    return { repo, A, B };
  };
  scenario('8', 'branch', () => {
    const { repo, A, B } = setup();
    record('8a', 'feature-only lines viewed on main', 'orphaned [from branch feature]', resolveWith(repo, A), A);
    record('8b', 'shared lines viewed on main', 'current 16-18 [from branch feature]', resolveWith(repo, B), B);
    git(repo, ['merge', '-q', '--no-ff', '-m', 'merge feature', 'feature']);
    record('8c', 'feature-only lines after merge --no-ff', 'current 11-13', resolveWith(repo, A), A);
    record('8d', 'shared lines after merge --no-ff', 'current 20-22', resolveWith(repo, B), B);
  });
  scenario('8e', 'shared lines after SQUASH merge', () => {
    const { repo, B } = setup();
    git(repo, ['merge', '-q', '--squash', 'feature']);
    git(repo, ['commit', '-q', '-m', 'squash']);
    record('8e', 'shared lines after SQUASH merge', 'current 20-22', resolveWith(repo, B), B);
  });
}

function s9() {
  for (const N of [10000, 100000]) {
    scenario(`9a`, `${N} lines`, () => {
      const repo = setupRepo({ 'big.ts': Array.from({ length: N }, (_, i) => `const v${i + 1} = compute(${i + 1}); // line ${i + 1}`) });
      const S = N - 10;
      const E = N - 8;
      const an = createAnchor(repo, 'big.ts', S, E);
      const lines = splitLines(fs.readFileSync(`${repo}/big.ts`, 'utf8'));
      const rand = rng(N);
      const pos = new Set();
      while (pos.size < 300) pos.add(1 + Math.floor(rand() * (N - 20)));
      let inserts = 0;
      for (const p of [...pos].sort((a, b) => b - a)) {
        if (rand() < 1 / 3) {
          lines.splice(p, 0, `// inserted after ${p}`);
          inserts++;
        } else lines[p - 1] += ' // edited';
      }
      write(repo, 'big.ts', lines);
      let s0 = stats.spawns;
      let t0 = performance.now();
      const r = resolveWith(repo, an);
      const ms = (performance.now() - t0).toFixed(1);
      const sp = stats.spawns - s0;
      s0 = stats.spawns;
      t0 = performance.now();
      const rt = resolveWith(repo, an, { forceTextSearch: true });
      const ms2 = (performance.now() - t0).toFixed(1);
      const sp2 = stats.spawns - s0;
      record(`9a`, `${N / 1000}k lines, 300 edits, thread near end`, `current ${S + inserts}-${E + inserts}`, r, an, `diff ${ms} ms / ${sp} git procs; text ${ms2} ms / ${sp2} procs -> ${fmt(rt, an)}`);
    });
  }
  scenario('9b', '200 threads / 20 files', () => {
    const repo = mkRepo();
    const rand = rng(99);
    const files = Array.from({ length: 20 }, (_, f) => `src/f${String(f).padStart(2, '0')}.ts`);
    const contents = {};
    files.forEach((p, f) => {
      contents[p] = Array.from({ length: 1000 }, (_, i) => `const f${f}_${i + 1} = ${i + 1};`);
      write(repo, p, contents[p]);
    });
    commitAll(repo, 'init');
    const edit = (l, n, tag) => {
      for (let k = 0; k < n; k++) {
        const p = Math.floor(rand() * (l.length - 1));
        const x = rand();
        if (x < 0.4) l[p] += ` // ${tag}${k}`;
        else if (x < 0.7) l.splice(p, 0, `// ins ${tag}${k}`);
        else l.splice(p, 1);
      }
    };
    const anchors = [];
    const addAnchors = (p) => {
      for (let k = 0; k < 5; k++) {
        const s = 1 + Math.floor(rand() * 980);
        anchors.push(createAnchor(repo, p, s, s + Math.floor(rand() * 5)));
      }
    };
    for (const p of files) {
      addAnchors(p);
      edit(contents[p], 20, 'a');
      write(repo, p, contents[p]);
      addAnchors(p);
      edit(contents[p], 20, 'b');
      write(repo, p, contents[p]);
    }
    const runAll = (cache) => {
      const s0 = stats.spawns;
      const t0 = performance.now();
      const R = new Resolver(repo, { cache });
      const out = anchors.map((a) => R.resolve(a));
      R.dispose();
      return { out, ms: (performance.now() - t0).toFixed(1), spawns: stats.spawns - s0, diffs: R.diffs };
    };
    const nc = runAll(false);
    const wc = runAll(true);
    const same = nc.out.every((r, i) => fmt(r) === fmt(wc.out[i]));
    const Rs = new Resolver(repo, { slider: false });
    const sliderDiffs = anchors.filter((a, i) => fmt(Rs.resolve(a)) !== fmt(wc.out[i])).length;
    Rs.dispose();
    const tally = {};
    for (const r of wc.out) tally[r.state] = (tally[r.state] || 0) + 1;
    record('9b', '200 threads / 20 files, cache vs none', 'same verdicts', same ? 'same verdicts' : 'DIFFERENT verdicts', null,
      `no cache ${nc.ms} ms / ${nc.spawns} procs / ${nc.diffs} diffs; cache ${wc.ms} ms / ${wc.spawns} procs / ${wc.diffs} diffs; ${JSON.stringify(tally)}; slider normalisation changed ${sliderDiffs}/200 verdicts`);
  });
}

function s10() {
  scenario('10', 'replay own history', () => {
    const root = decodeURIComponent(new URL('../..', import.meta.url).pathname).replace(/\/$/, '');
    const dir = mkTmp('reanchor-clone-');
    const repo = `${dir}/repo`;
    git(dir, ['clone', '--quiet', root, repo]);
    const head = headInfo(repo);
    const commits = git(repo, ['rev-list', 'HEAD~1', '--', 'src']).stdout.trim().split('\n').filter(Boolean);
    const rand = rng(50);
    const pick = (arr) => arr[Math.floor(rand() * arr.length)];
    const lsCache = new Map();
    const Rd = new Resolver(repo);
    const Rt = new Resolver(repo, { forceTextSearch: true });
    const samples = [];
    let tries = 0;
    let skippedUnchanged = 0;
    while (samples.length < 50 && tries++ < 5000) {
      const c = pick(commits);
      if (!lsCache.has(c)) lsCache.set(c, git(repo, ['ls-tree', '-r', '--name-only', c, '--', 'src']).stdout.split('\n').filter((f) => /\.ts$/.test(f)));
      const files = lsCache.get(c);
      if (!files.length) continue;
      const f = pick(files);
      const oldBlob = git(repo, ['rev-parse', `${c}:${f}`]).stdout.trim();
      const headBlob = git(repo, ['rev-parse', `HEAD:${f}`], { okCodes: [0, 128] }).stdout.trim();
      if (oldBlob === headBlob) {
        skippedUnchanged++;
        continue; // file unchanged since then: trivially agrees, not informative
      }
      const content = Rd.blobBuf(oldBlob).toString('utf8');
      const lines = splitLines(content);
      if (lines.length < 5) continue;
      const start = 1 + Math.floor(rand() * lines.length);
      if (!lines[start - 1].trim()) continue;
      const end = Math.min(lines.length, start + Math.floor(rand() * 6));
      const an = createAnchorAtCommit(repo, c, f, start, end, head.branch, content);
      samples.push({ c, an, d: Rd.resolve(an), t: Rt.resolve(an) });
    }
    const Rs = new Resolver(repo, { slider: false });
    const sliderDiffs = samples.filter((s) => fmt(Rs.resolve(s.an), s.an) !== fmt(s.d, s.an)).length;
    const blowups = samples.filter((s) => s.d.state === 'outdated' && s.d.endLine - s.d.startLine + 1 > 3 * (s.an.endLine - s.an.startLine + 1) + 2).length;
    Rd.dispose();
    Rt.dispose();
    Rs.dispose();
    const agree = samples.filter((s) => fmt(s.d, s.an) === fmt(s.t, s.an));
    const stateAgree = samples.filter((s) => s.d.state === s.t.state);
    const tally = (k) => {
      const o = {};
      for (const s of samples) o[s[k].state] = (o[s[k].state] || 0) + 1;
      return JSON.stringify(o);
    };
    const curLines = (s, r) => {
      if (r.state === 'orphaned') return '(none)';
      const cl = splitLines(fs.readFileSync(`${repo}/${r.path}`, 'utf8')).slice(r.startLine - 1, Math.min(r.endLine, r.startLine + 1));
      return cl.map((x) => JSON.stringify(x.trim().slice(0, 70))).join(' / ');
    };
    const dis = samples.filter((s) => fmt(s.d, s.an) !== fmt(s.t, s.an));
    const block = [`Scenario 10 disagreements (${dis.length}/${samples.length}); diff verdicts ${tally('d')}, text verdicts ${tally('t')}; ${skippedUnchanged} draws skipped because the file was unchanged at HEAD`, ''];
    dis.forEach((s, i) => {
      block.push(`[${i + 1}] ${s.c.slice(0, 7)} ${s.an.path}:${s.an.startLine}-${s.an.endLine}`);
      block.push(`    anchored: ${s.an.snapshot.anchored.slice(0, 2).map((x) => JSON.stringify(x.trim().slice(0, 70))).join(' / ')}${s.an.snapshot.anchored.length > 2 ? ' / ...' : ''}`);
      block.push(`    diff: ${fmt(s.d, s.an).padEnd(26)} ${curLines(s, s.d)}${s.d.notes.length ? `   {${s.d.notes.join('; ')}}` : ''}`);
      block.push(`    text: ${fmt(s.t, s.an).padEnd(26)} ${curLines(s, s.t)}${s.t.notes.length ? `   {${s.t.notes.join('; ')}}` : ''}`);
    });
    extraReport.push(block.join('\n'));
    info('10', `replay own history, ${samples.length} samples`, `agree ${agree.length}/${samples.length} (state ${stateAgree.length}/${samples.length})`, `diff ${tally('d')}; text ${tally('t')}; ${blowups} outdated extents > 3x anchored size; slider changed ${sliderDiffs}`);
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function table() {
  const rows = results.map((r) => [r.id, r.name, r.expected, r.actual, r.method, r.verdict, r.note]);
  const head = ['#', 'Scenario', 'Expected', 'Actual', 'Method', 'Result', 'Notes'];
  const esc = (s) => String(s).replace(/\|/g, '\\|');
  return [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.map(esc).join(' | ')} |`)].join('\n');
}

function main() {
  const t0 = performance.now();
  try {
    s1();
    s2();
    s3();
    s4();
    s5();
    s6();
    s7();
    s8();
    s9();
    s10();
  } finally {
    for (const d of tmpRoots) fs.rmSync(d, { recursive: true, force: true });
  }
  const t = table();
  const counts = results.reduce((o, r) => ((o[r.verdict] = (o[r.verdict] || 0) + 1), o), {});
  const summary = `Totals: ${JSON.stringify(counts)}; ${stats.spawns} git processes; ${((performance.now() - t0) / 1000).toFixed(1)} s; git ${git(os.tmpdir(), ['--version']).stdout.trim()}; node ${process.version}`;
  console.log(extraReport.join('\n\n'));
  console.log(`\n${t}\n\n${summary}`);

  const readme = new URL('./README.md', import.meta.url);
  if (fs.existsSync(readme)) {
    const text = fs.readFileSync(readme, 'utf8');
    const startM = '<!-- RESULTS:START -->';
    const endM = '<!-- RESULTS:END -->';
    const i = text.indexOf(startM);
    const j = text.indexOf(endM);
    if (i >= 0 && j > i) {
      const gen = `${startM}\n\n${t}\n\n${summary}\n\n\`\`\`text\n${extraReport.join('\n\n')}\n\`\`\`\n\n${endM}`;
      fs.writeFileSync(readme, text.slice(0, i) + gen + text.slice(j + endM.length));
    }
  }
}

main();
