import { LhrError, type Diagnostic } from './errors.js';
import { checkFormat } from './format.js';
import { parseFrontmatter, type FrontmatterData } from './frontmatter.js';
import { DiagnosticCode } from './model.js';
import { extractSnapshot, parseThreads } from './read.js';
import { cmp, emptyThread, scanTree, type FileEntry } from './scan.js';
import { loadSchemas, unknownKeys, validate, type SchemaKind } from './schemaCheck.js';

export interface CheckResult {
  diagnostics: Diagnostic[];
}

const LINE_KEYS = [
  'anchor.blob',
  'anchor.startLine',
  'anchor.endLine',
  'anchor.contextBefore',
  'anchor.contextAfter',
] as const;
const ID_RE = /^[0-9]{8}T[0-9]{6}Z-[a-z2-7]{6}$/;

interface ParsedFile {
  data: FrontmatterData;
  body: string;
}

class Checker {
  readonly out: Diagnostic[] = [];
  private readonly schemas = loadSchemas();

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

  /** Parses and schema-validates one file read by the walk; undefined when unusable. */
  file(entry: FileEntry, kind: SchemaKind): ParsedFile | undefined {
    const { text, rel } = entry;
    if (text === undefined) return undefined;
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

/**
 * Validates the whole tree, drafts included, against file-format-v2 § Validation.
 * Walks the tree with the same scan as load() (scan.ts) and adds the schema and
 * cross-file rules on top. Content problems become diagnostics; only operational
 * failures throw.
 */
export async function checkTree(root: string): Promise<CheckResult> {
  const c = new Checker();

  const format = await formatDiagnostic(root);
  if (format) c.out.push(format);

  const scan = await scanTree(root, { pushes: true });
  const { parsed, states } = parseThreads(scan);
  c.out.push(...scan.problems, ...scan.recordProblems);

  const roundIds = new Set(scan.rounds.filter((e) => e.parsedId).map((e) => e.name.slice(0, -3)));
  const submittedIds = new Set(scan.threads.map((d) => d.id));
  const messageIds = new Set<string>();
  const clientUses: { thread: string; clientId: string; rel: string; draft: boolean }[] = [];

  for (const dir of [...scan.threads, ...scan.drafts]) {
    const copies = parsed.get(dir)?.copies;
    c.out.push(...dir.problems);
    if (states.get(dir) === 'empty') c.out.push(emptyThread(dir));
    if (dir.threadMd) {
      const f = c.file(dir.threadMd, 'thread');
      if (f) c.checkThreadMd(dir.threadMd.rel, f);
    }
    for (const e of dir.messages) {
      const { rel } = e;
      if (!dir.draft) messageIds.add(e.name.slice(0, -3));
      const f = c.file(e, 'message');
      if (!f) continue;
      const { data } = f;
      const kind = data['author.kind'];
      const name = e.parsedName;
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
      // A draft copy of a submitted message is that same message, not a second use.
      if (typeof data.clientId === 'string' && !copies?.has(e)) {
        clientUses.push({ thread: dir.id, clientId: data.clientId, rel, draft: dir.draft });
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

  for (const e of scan.rounds) c.file(e, 'round');

  for (const e of scan.pushes) {
    const f = c.file(e, 'push');
    if (f) c.checkPushBody(e.rel, f, submittedIds, messageIds);
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
