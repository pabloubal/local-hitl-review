// Builds a real review root with a few threads for the thread read tests.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { mkRepo } from './helper.mjs';

export function git(dir, ...args) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

export function put(dir, rel, text) {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
}

/** thread.md for a line thread anchored on the committed file `rel`. */
export function lineThreadMd(dir, rel, start, end, { before = 2, after = 2, severity } = {}) {
  const lines = readFileSync(join(dir, rel), 'utf8').split('\n');
  const from = Math.max(1, start - before);
  const to = Math.min(lines.length - 1, end + after);
  const snap = lines.slice(from - 1, to).join('\n');
  const fm = [
    'anchor.kind: line',
    `anchor.path: ${rel}`,
    'anchor.side: new',
    `anchor.commit: ${git(dir, 'rev-parse', 'HEAD')}`,
    `anchor.blob: ${git(dir, 'hash-object', '-w', '--no-filters', rel)}`,
    `anchor.startLine: ${start}`,
    `anchor.endLine: ${end}`,
    `anchor.contextBefore: ${start - from}`,
    `anchor.contextAfter: ${to - end}`,
    ...(severity ? [`severity: ${severity}`] : []),
  ];
  return `---\n${fm.join('\n')}\n---\n\n\`\`\`\n${snap}\n\`\`\`\n`;
}

export function fileThreadMd(dir, rel) {
  const fm = [
    'anchor.kind: file',
    `anchor.path: ${rel}`,
    'anchor.side: new',
    `anchor.commit: ${git(dir, 'rev-parse', 'HEAD')}`,
  ];
  return `---\n${fm.join('\n')}\n---\n`;
}

export function messageMd({ kind, name, body, round, status, severity }) {
  const fm = [`author.kind: ${kind}`, `author.name: ${name}`];
  if (round) fm.push(`round: ${round}`);
  if (status) fm.push(`status: ${status}`);
  if (severity) fm.push(`severity: ${severity}`);
  return `---\n${fm.join('\n')}\n---\n${body}\n`;
}

export const SESSION = [
  'export function load(id) {',
  '  const s = store.get(id);',
  '  if (!s) return null;',
  '  if (s.expiresAt < Date.now()) {',
  '    store.delete(id);',
  '    return s;',
  '  }',
  '  return s;',
  '}',
  '',
].join('\n');

export const TOUCH = [
  'export function touch(id) {',
  '  const s = load(id);',
  '  s.expiresAt = Date.now() + TTL;',
  '  return s;',
  '}',
  '',
].join('\n');

export const LEGACY = ['// TODO remove after v2', 'export const LEGACY = true;', ''].join('\n');

export const IDS = {
  current: '20261002T101500Z-k3m7qz',
  moved: '20261002T102000Z-k3m7ab',
  orphan: '20261002T103000Z-w7p2dd',
  file: '20261002T104000Z-n5n5n5',
  resolved: '20261002T105000Z-z2z2z2',
  draft: '20261002T110000Z-d4d4d4',
};

/** Writes one thread: `files` maps file name -> text. */
export function writeThread(dir, id, files, { draft = false } = {}) {
  const base = join(dir, '.lhr', draft ? 'drafts/threads' : 'threads', id);
  mkdirSync(base, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(base, name), text);
}

/** Repo with five submitted threads (current, moved, orphaned, file, resolved) and one draft. */
export function mkReviewedRepo() {
  const dir = mkRepo();
  put(dir, 'src/auth/session.ts', SESSION);
  put(dir, 'src/touch.ts', TOUCH);
  put(dir, 'src/legacy.ts', LEGACY);
  put(dir, 'README.md', '# Hello\n');
  git(dir, 'add', '-A');
  git(dir, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');

  writeThread(dir, IDS.current, {
    'thread.md': lineThreadMd(dir, 'src/auth/session.ts', 6, 6),
    '20261002T101500Z-human-aaaaaa.md': messageMd({
      kind: 'human',
      name: 'pablo',
      round: '20261002T101400Z-r2r2r2',
      severity: 'high',
      body: 'This returns the session after deleting it. An expired session should come back as null, otherwise callers treat it as live.',
    }),
    '20261002T101900Z-agent-bbbbbb.md': messageMd({
      kind: 'agent',
      name: 'claude-code',
      body: 'Agreed. Fixed in 3f2a9c1.',
    }),
  });
  writeThread(dir, IDS.moved, {
    'thread.md': lineThreadMd(dir, 'src/touch.ts', 3, 3),
    '20261002T102000Z-human-cccccc.md': messageMd({
      kind: 'human',
      name: 'pablo',
      body: 'Non-null assertion is unsafe here.',
    }),
  });
  writeThread(dir, IDS.orphan, {
    'thread.md': lineThreadMd(dir, 'src/legacy.ts', 2, 2, { severity: 'low' }),
    '20261002T103000Z-human-dddddd.md': messageMd({
      kind: 'human',
      name: 'pablo',
      severity: 'low',
      body: 'Dead flag. Delete?',
    }),
  });
  writeThread(dir, IDS.file, {
    'thread.md': fileThreadMd(dir, 'README.md'),
    '20261002T104000Z-human-eeeeee.md': messageMd({
      kind: 'human',
      name: 'pablo',
      severity: 'critical',
      body: 'Document the new flags.',
    }),
  });
  writeThread(dir, IDS.resolved, {
    'thread.md': fileThreadMd(dir, 'README.md'),
    '20261002T105000Z-human-ffffff.md': messageMd({ kind: 'human', name: 'pablo', body: 'Typo.' }),
    '20261002T105500Z-agent-gggggg.md': messageMd({
      kind: 'agent',
      name: 'claude-code',
      status: 'resolved',
      body: 'Fixed.',
    }),
  });
  writeThread(
    dir,
    IDS.draft,
    {
      'thread.md': lineThreadMd(dir, 'src/auth/session.ts', 3, 4),
      '20261002T110000Z-human-hhhhhh.md': messageMd({
        kind: 'human',
        name: 'pablo',
        body: 'Not yet submitted.',
      }),
    },
    { draft: true },
  );

  // Working-tree edits made after the threads were written.
  put(dir, 'src/touch.ts', `// added\n// added\n${TOUCH.replace('+ TTL', '+ TTL_MS')}`);
  rmSync(join(dir, 'src/legacy.ts'));
  return dir;
}
