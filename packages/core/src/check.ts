import { readdir, readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { LhrError, type Diagnostic } from './errors.js';
import { checkFormat } from './format.js';
import { parseFrontmatter, type FrontmatterData } from './frontmatter.js';
import { parseId, parseMessageFileName } from './ids.js';
import { DiagnosticCode } from './model.js';
import { extractSnapshot } from './read.js';
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

interface Entry {
  name: string;
  /** A directory, or a symlink to one. */
  isDir: boolean;
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
      const entries = await readdir(path.join(this.root, rel), { withFileTypes: true });
      const out: Entry[] = [];
      for (const e of entries) {
        let isDir = e.isDirectory();
        if (e.isSymbolicLink()) {
          isDir = await stat(path.join(this.root, rel, e.name)).then(
            (st) => st.isDirectory(),
            () => false,
          );
        }
        out.push({ name: e.name, isDir });
      }
      return out.sort((a, b) => cmp(a.name, b.name));
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
      this.unreadable(rel, code);
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
    const blocks = fencedBlocks(f.body);
    let json: unknown;
    try {
      json =
        blocks?.length === 1 && blocks[0].info === 'json' ? JSON.parse(blocks[0].text) : undefined;
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

interface FencedBlock {
  info: string;
  text: string;
}

/** All fenced code blocks of a body; undefined when a fence is never closed. */
function fencedBlocks(body: string): FencedBlock[] | undefined {
  const lines = body.split('\n').map((l) => l.replace(/\r$/, ''));
  const blocks: FencedBlock[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = /^(`{3,})([^`]*)$/.exec(lines[i]);
    if (!open) continue;
    const closeRe = new RegExp(`^\`{${open[1].length},}[ \\t]*$`);
    let j = i + 1;
    while (j < lines.length && !closeRe.test(lines[j])) j++;
    if (j >= lines.length) return undefined;
    blocks.push({ info: open[2].trim(), text: lines.slice(i + 1, j).join('\n') });
    i = j;
  }
  return blocks;
}

interface Group {
  id: string;
  rel: string;
  submitted: boolean;
  /** `*.md` entries, whatever their type; non-files are reported when read. */
  files: Entry[];
}

/**
 * Validates the whole tree, drafts included, against file-format-v2 § Validation.
 * Content problems become diagnostics; only operational failures throw.
 */
export async function checkTree(root: string): Promise<CheckResult> {
  const c = new Checker(root);

  const format = await formatDiagnostic(root);
  if (format) c.out.push(format);

  const [threadDirs, draftDirs, roundEntries, pushEntries] = await Promise.all([
    c.list('.lhr/threads'),
    c.list('.lhr/drafts/threads'),
    c.list('.lhr/rounds'),
    c.list('.lhr/pushes'),
  ]);
  // A `*.md` directory is not a valid file either; reading it reports UNREADABLE_FILE.
  const mdEntries = (entries: Entry[]): Entry[] => entries.filter((e) => e.name.endsWith('.md'));

  const groups: Group[] = [];
  for (const [entries, base, submitted] of [
    [threadDirs, '.lhr/threads', true],
    [draftDirs, '.lhr/drafts/threads', false],
  ] as const) {
    for (const e of entries.filter((x) => x.isDir)) {
      const rel = `${base}/${e.name}`;
      groups.push({ id: e.name, rel, submitted, files: mdEntries(await c.list(rel)) });
    }
  }

  const roundIds = new Set(
    mdEntries(roundEntries)
      .map((e) => e.name.slice(0, -3))
      .filter((id) => parseId(id) !== undefined),
  );
  const submittedIds = new Set(groups.filter((g) => g.submitted).map((g) => g.id));
  const draftsWithMessages = new Set(
    groups
      .filter((g) => !g.submitted && g.files.some((f) => f.name !== THREAD_FILE))
      .map((g) => g.id),
  );
  const messageIds = new Set<string>();
  const clientUses: { thread: string; clientId: string; rel: string; draft: boolean }[] = [];

  for (const g of groups) {
    if (parseId(g.id) === undefined) {
      c.error(DiagnosticCode.InvalidFileName, g.rel, 'thread directory name is not a valid ID');
    }
    const messages = g.files.filter((f) => f.name !== THREAD_FILE);
    const hasThreadMd = g.files.some((f) => f.name === THREAD_FILE);
    if (hasThreadMd) {
      const rel = `${g.rel}/${THREAD_FILE}`;
      const f = await c.file(rel, 'thread');
      if (f) c.checkThreadMd(rel, f);
    } else if (g.submitted || !submittedIds.has(g.id)) {
      c.error(DiagnosticCode.MissingThreadMd, g.rel, `thread directory has no ${THREAD_FILE}`);
    }
    if (g.submitted && messages.length === 0 && !draftsWithMessages.has(g.id)) {
      c.error(DiagnosticCode.EmptyThread, g.rel, 'submitted thread has no messages');
    }
    for (const e of messages) {
      const rel = `${g.rel}/${e.name}`;
      const id = e.name.slice(0, -3);
      if (g.submitted) messageIds.add(id);
      const name = parseMessageFileName(e.name);
      if (!name)
        c.error(DiagnosticCode.InvalidFileName, rel, 'message file name is not a valid ID');
      const f = await c.file(rel, 'message');
      if (!f) continue;
      const { data } = f;
      const kind = data['author.kind'];
      if (name && (kind === 'human' || kind === 'agent') && kind !== name.kind) {
        c.error(
          DiagnosticCode.AuthorKindMismatch,
          rel,
          `author.kind "${kind}" does not match the file name kind "${name.kind}"`,
        );
      }
      if (kind === 'agent' && data['author.session'] === undefined) {
        c.add(
          'warning',
          DiagnosticCode.MissingAuthorSession,
          rel,
          'agent message has no "author.session"',
        );
      }
      if (f.body.trim() === '' && data.status === undefined && data.severity === undefined) {
        c.error(
          DiagnosticCode.EmptyBody,
          rel,
          'message body is empty and neither status nor severity is set',
        );
      }
      const round = data.round;
      if (typeof round === 'string' && ID_RE.test(round) && !roundIds.has(round)) {
        c.error(DiagnosticCode.UnknownRound, rel, `round "${round}" does not exist`);
      }
      if (typeof data.clientId === 'string') {
        clientUses.push({ thread: g.id, clientId: data.clientId, rel, draft: !g.submitted });
      }
    }
  }

  // Duplicate clientIds: submitted before draft, then by file name; later files are flagged.
  clientUses.sort(
    (a, b) =>
      Number(a.draft) - Number(b.draft) ||
      cmp(a.rel.split('/').pop() ?? '', b.rel.split('/').pop() ?? '') ||
      cmp(a.rel, b.rel),
  );
  const firstUse = new Map<string, string>();
  for (const u of clientUses) {
    const key = `${u.thread}\u0000${u.clientId}`;
    const first = firstUse.get(key);
    if (first === undefined) firstUse.set(key, u.rel);
    else if (first !== u.rel) {
      c.error(
        DiagnosticCode.DuplicateClientId,
        u.rel,
        `clientId "${u.clientId}" is already used in ${first}`,
      );
    }
  }

  for (const e of mdEntries(roundEntries)) {
    const rel = `.lhr/rounds/${e.name}`;
    if (parseId(e.name.slice(0, -3)) === undefined) {
      c.error(DiagnosticCode.InvalidFileName, rel, 'round file name is not a valid ID');
    }
    await c.file(rel, 'round');
  }

  for (const e of mdEntries(pushEntries)) {
    const rel = `.lhr/pushes/${e.name}`;
    if (parseId(e.name.slice(0, -3)) === undefined) {
      c.error(DiagnosticCode.InvalidFileName, rel, 'push file name is not a valid ID');
    }
    const f = await c.file(rel, 'push');
    if (f) c.checkPushBody(rel, f, submittedIds, messageIds);
  }

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
