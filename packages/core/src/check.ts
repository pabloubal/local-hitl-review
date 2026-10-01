import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { LhrError, type Diagnostic } from './errors.js';
import { checkFormat } from './format.js';
import { parseFrontmatter, type FrontmatterData } from './frontmatter.js';
import { parseId } from './ids.js';
import { DiagnosticCode } from './model.js';
import { extractSnapshot, readTree } from './read.js';
import { loadSchemas, unknownKeys, validate, type SchemaKind } from './schemaCheck.js';

export interface CheckResult {
  diagnostics: Diagnostic[];
}

const THREAD_FILE = 'thread.md';
const LINE_KEYS = [
  'anchor.blob',
  'anchor.startLine',
  'anchor.endLine',
  'anchor.contextBefore',
  'anchor.contextAfter',
] as const;
const ID_RE = /^[0-9]{8}T[0-9]{6}Z-[a-z2-7]{6}$/;

/** Problems readTree finds that the schema pass reports itself (or reports with more detail). */
const OWNED_BY_SCHEMA_PASS: readonly string[] = [
  DiagnosticCode.FrontmatterSyntax,
  DiagnosticCode.MissingKey,
  DiagnosticCode.InvalidValue,
];

interface Entry {
  name: string;
  isDir: boolean;
  isFile: boolean;
}

interface ParsedFile {
  data: FrontmatterData;
  body: string;
}

class Checker {
  readonly out: Diagnostic[] = [];
  private readonly schemas = loadSchemas();

  constructor(private readonly root: string) {}

  add(
    severity: 'error' | 'warning',
    code: string,
    file: string,
    message: string,
    line?: number,
  ): void {
    const d: Diagnostic = { severity, code, path: file, message };
    if (line !== undefined) d.line = line;
    this.out.push(d);
  }

  error(code: string, file: string, message: string): void {
    this.add('error', code, file, message);
  }

  async list(rel: string): Promise<Entry[]> {
    try {
      const entries = await readdir(path.join(this.root, rel), {
        withFileTypes: true,
      });
      return entries
        .map((e) => ({
          name: e.name,
          isDir: e.isDirectory(),
          isFile: e.isFile(),
        }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') this.unreadable(rel, code);
      return [];
    }
  }

  private unreadable(rel: string, code: string | undefined): void {
    this.error(DiagnosticCode.UnreadableFile, rel, `cannot read file (${code ?? 'unknown error'})`);
  }

  /** Reads, parses and schema-validates one file. Returns undefined when it can't be used further. */
  async file(rel: string, kind: SchemaKind): Promise<ParsedFile | undefined> {
    let text: string;
    try {
      text = await readFile(path.join(this.root, rel), 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') this.unreadable(rel, code);
      return undefined;
    }
    const parsed = parseFrontmatter(text, rel);
    if (parsed.diagnostics.length > 0) {
      this.out.push(...parsed.diagnostics);
      return undefined;
    }
    const schema = this.schemas[kind];
    for (const issue of validate(schema, parsed.data)) {
      this.error(
        issue.kind === 'missing' ? DiagnosticCode.MissingKey : DiagnosticCode.InvalidValue,
        rel,
        issue.message,
      );
    }
    for (const key of unknownKeys(schema, parsed.data)) {
      this.add('warning', DiagnosticCode.UnknownKey, rel, `unknown key "${key}"`);
    }
    return { data: parsed.data, body: parsed.body };
  }

  checkThreadMd(rel: string, f: ParsedFile): void {
    const { data } = f;
    const p = data['anchor.path'];
    if (typeof p === 'string' && !isRepoPath(p)) {
      this.error(
        DiagnosticCode.InvalidValue,
        rel,
        'key "anchor.path" must be a repo-relative POSIX path',
      );
    }
    if (data['anchor.kind'] !== 'line') return;

    for (const key of LINE_KEYS) {
      if (data[key] === undefined) {
        this.error(DiagnosticCode.MissingLineAnchorKey, rel, `a line thread requires key "${key}"`);
      }
    }
    const start = intValue(data['anchor.startLine']);
    const end = intValue(data['anchor.endLine']);
    const before = intValue(data['anchor.contextBefore']);
    const after = intValue(data['anchor.contextAfter']);
    if (start !== undefined && start < 1) {
      this.error(
        DiagnosticCode.InvalidValue,
        rel,
        'key "anchor.startLine" must be an integer >= 1',
      );
    }
    if (before !== undefined && before < 0) {
      this.error(
        DiagnosticCode.InvalidValue,
        rel,
        'key "anchor.contextBefore" must be an integer >= 0',
      );
    }
    if (after !== undefined && after < 0) {
      this.error(
        DiagnosticCode.InvalidValue,
        rel,
        'key "anchor.contextAfter" must be an integer >= 0',
      );
    }
    const rangeOk = start !== undefined && end !== undefined && end >= start;
    if (start !== undefined && end !== undefined && end < start) {
      this.error(
        DiagnosticCode.EndLineBeforeStart,
        rel,
        `anchor.endLine (${end}) is before anchor.startLine (${start})`,
      );
    }
    const snapshot = extractSnapshot(f.body);
    if (snapshot === undefined) {
      this.error(
        DiagnosticCode.InvalidValue,
        rel,
        'a line thread body must hold a closed fenced code block (the snapshot)',
      );
      return;
    }
    if (rangeOk && before !== undefined && after !== undefined && before >= 0 && after >= 0) {
      const expected = before + (end - start + 1) + after;
      const actual = snapshot.split('\n').length;
      if (actual !== expected) {
        this.error(
          DiagnosticCode.SnapshotLineCount,
          rel,
          `snapshot has ${actual} lines, expected contextBefore + (endLine - startLine + 1) + contextAfter = ${expected}`,
        );
      }
    }
  }

  checkPushBody(rel: string, f: ParsedFile, threadIds: Set<string>, messageIds: Set<string>): void {
    const block = extractSnapshot(f.body);
    let json: unknown;
    try {
      json = block === undefined ? undefined : JSON.parse(block);
    } catch {
      json = undefined;
    }
    if (typeof json !== 'object' || json === null || Array.isArray(json)) {
      this.error(
        DiagnosticCode.InvalidPushBody,
        rel,
        'a push record body must hold one fenced json block with an object',
      );
      return;
    }
    const maps = json as { threads?: unknown; messages?: unknown };
    for (const [field, known, code, what] of [
      ['threads', threadIds, DiagnosticCode.PushUnknownThread, 'thread'],
      ['messages', messageIds, DiagnosticCode.PushUnknownMessage, 'message'],
    ] as const) {
      const value = maps[field];
      if (value === undefined) continue;
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        this.error(DiagnosticCode.InvalidPushBody, rel, `"${field}" must be an object`);
        continue;
      }
      for (const id of Object.keys(value)) {
        if (!known.has(id)) this.error(code, rel, `push record names unknown ${what} "${id}"`);
      }
    }
  }
}

function intValue(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) ? v : undefined;
}

function isRepoPath(v: string): boolean {
  return !(
    v === '' ||
    v.includes('\\') ||
    v.startsWith('/') ||
    /^[A-Za-z]:/.test(v) ||
    v.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')
  );
}

async function formatDiagnostic(root: string): Promise<Diagnostic | undefined> {
  try {
    await checkFormat(root);
    return undefined;
  } catch (err) {
    if (
      err instanceof LhrError &&
      (err.code === 'FORMAT_MISSING' || err.code === 'FORMAT_VERSION')
    ) {
      return {
        severity: 'error',
        code:
          err.code === 'FORMAT_MISSING'
            ? DiagnosticCode.FormatMissing
            : DiagnosticCode.FormatVersion,
        path: '.lhr/format',
        message: err.message,
      };
    }
    throw err;
  }
}

/**
 * Validates the whole tree, drafts included, against file-format-v2 § Validation.
 * Content problems become diagnostics; only operational failures throw.
 */
export async function checkTree(root: string): Promise<CheckResult> {
  const c = new Checker(root);

  const format = await formatDiagnostic(root);
  if (format) c.out.push(format);

  // Structural rules (names, directories, authorship, empty threads/bodies) come from the reader.
  const records = await readTree(root);
  c.out.push(...records.problems.filter((p) => !OWNED_BY_SCHEMA_PASS.includes(p.code)));

  const [threadDirs, draftDirs, roundEntries, pushEntries] = await Promise.all([
    c.list('.lhr/threads'),
    c.list('.lhr/drafts/threads'),
    c.list('.lhr/rounds'),
    c.list('.lhr/pushes'),
  ]);

  const roundIds = new Set(
    roundEntries
      .filter((e) => e.isFile && e.name.endsWith('.md'))
      .map((e) => e.name.slice(0, -3))
      .filter((id) => parseId(id) !== undefined),
  );
  const threadIds = new Set(threadDirs.filter((e) => e.isDir).map((e) => e.name));
  const messageIds = new Set<string>();
  const pending: { thread: string; clientId: string; rel: string }[] = [];

  const groups = [
    ...threadDirs
      .filter((e) => e.isDir)
      .map((e) => ({
        id: e.name,
        rel: `.lhr/threads/${e.name}`,
        submitted: true,
      })),
    ...draftDirs
      .filter((e) => e.isDir)
      .map((e) => ({
        id: e.name,
        rel: `.lhr/drafts/threads/${e.name}`,
        submitted: false,
      })),
  ];

  await Promise.all(
    groups.map(async (g) => {
      const entries = (await c.list(g.rel)).filter((e) => e.isFile && e.name.endsWith('.md'));
      const local = new Checker(root);
      for (const e of entries) {
        const rel = `${g.rel}/${e.name}`;
        if (e.name === THREAD_FILE) {
          const f = await local.file(rel, 'thread');
          if (f) local.checkThreadMd(rel, f);
          continue;
        }
        if (g.submitted) messageIds.add(e.name.slice(0, -3));
        const f = await local.file(rel, 'message');
        if (!f) continue;
        const { data } = f;
        if (data['author.kind'] === 'agent' && data['author.session'] === undefined) {
          local.add(
            'warning',
            DiagnosticCode.MissingAuthorSession,
            rel,
            'agent message has no "author.session"',
          );
        }
        const round = data.round;
        if (typeof round === 'string' && ID_RE.test(round) && !roundIds.has(round)) {
          local.error(DiagnosticCode.UnknownRound, rel, `round "${round}" does not exist`);
        }
        const clientId = data.clientId;
        if (typeof clientId === 'string') {
          pending.push({ thread: g.id, clientId, rel });
        }
      }
      c.out.push(...local.out);
    }),
  );

  // Duplicate clientIds: the first file in path order keeps it, later ones are flagged.
  const firstUse = new Map<string, string>();
  pending.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  for (const p of pending) {
    const k = `${p.thread}\u0000${p.clientId}`;
    const first = firstUse.get(k);
    if (first === undefined) firstUse.set(k, p.rel);
    else if (first !== p.rel) {
      c.error(
        DiagnosticCode.DuplicateClientId,
        p.rel,
        `clientId "${p.clientId}" is already used in ${first}`,
      );
    }
  }

  await Promise.all(
    roundEntries
      .filter((e) => e.isFile && e.name.endsWith('.md'))
      .map(async (e) => {
        const local = new Checker(root);
        await local.file(`.lhr/rounds/${e.name}`, 'round');
        c.out.push(...local.out);
      }),
  );

  await Promise.all(
    pushEntries
      .filter((e) => e.isFile && e.name.endsWith('.md'))
      .map(async (e) => {
        const rel = `.lhr/pushes/${e.name}`;
        const local = new Checker(root);
        if (parseId(e.name.slice(0, -3)) === undefined) {
          local.error(DiagnosticCode.InvalidFileName, rel, 'push file name is not a valid ID');
        }
        const f = await local.file(rel, 'push');
        if (f) local.checkPushBody(rel, f, threadIds, messageIds);
        c.out.push(...local.out);
      }),
  );

  return { diagnostics: finish(c.out) };
}

function finish(all: Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  const unique = all.filter((d) => {
    const key = `${d.code}\u0000${d.path}\u0000${d.line ?? ''}\u0000${d.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return unique.sort(
    (a, b) =>
      cmp(a.path, b.path) ||
      (a.line ?? 0) - (b.line ?? 0) ||
      cmp(a.code, b.code) ||
      cmp(a.message, b.message),
  );
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
