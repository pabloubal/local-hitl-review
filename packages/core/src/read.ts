import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { Diagnostic } from './errors.js';
import { parseFrontmatter, type FrontmatterData } from './frontmatter.js';
import { parseId, parseMessageFileName, type AuthorKind } from './ids.js';
import {
  DiagnosticCode,
  type Anchor,
  type Author,
  type MessageView,
  type RoundView,
  type Severity,
  type ThreadRecord,
  type ThreadStatus,
  type TreeRecords,
  type Verdict,
} from './model.js';

const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
const STATUSES = ['open', 'resolved'] as const;
const VERDICTS = ['approve', 'comment', 'request-changes'] as const;
const SIDES = ['new', 'old'] as const;
const ANCHOR_KINDS = ['line', 'file'] as const;
const AUTHOR_KINDS = ['human', 'agent'] as const;

const THREAD_FILE = 'thread.md';

/** Validates keys of one parsed frontmatter block, collecting diagnostics. */
class Fields {
  readonly problems: Diagnostic[] = [];

  constructor(
    private readonly data: FrontmatterData,
    private readonly file: string,
  ) {}

  get ok(): boolean {
    return this.problems.length === 0;
  }

  fail(code: string, message: string): void {
    this.problems.push({ severity: 'error', code, path: this.file, message });
  }

  private raw(key: string, required: boolean): string | number | boolean | undefined {
    const v = this.data[key];
    if (v === undefined && required) {
      this.fail(DiagnosticCode.MissingKey, `missing required key "${key}"`);
    }
    return v;
  }

  string(key: string, required: boolean): string | undefined {
    const v = this.raw(key, required);
    if (v === undefined) return undefined;
    if (typeof v !== 'string') {
      this.fail(DiagnosticCode.InvalidValue, `key "${key}" must be a string`);
      return undefined;
    }
    return v;
  }

  enum<T extends string>(key: string, values: readonly T[], required: boolean): T | undefined {
    const v = this.raw(key, required);
    if (v === undefined) return undefined;
    const match = values.find((x) => x === v);
    if (match === undefined) {
      this.fail(DiagnosticCode.InvalidValue, `key "${key}" must be one of: ${values.join(', ')}`);
    }
    return match;
  }

  /** Repo-relative POSIX path: no backslash, no leading slash or drive letter, no empty, "." or ".." segment. */
  repoPath(key: string): string | undefined {
    const v = this.string(key, true);
    if (v === undefined) return undefined;
    if (
      v === '' ||
      v.includes('\\') ||
      v.startsWith('/') ||
      /^[A-Za-z]:/.test(v) ||
      v.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')
    ) {
      this.fail(DiagnosticCode.InvalidValue, `key "${key}" must be a repo-relative POSIX path`);
      return undefined;
    }
    return v;
  }

  int(key: string, min: number): number | undefined {
    const v = this.raw(key, true);
    if (v === undefined) return undefined;
    if (typeof v !== 'number' || v < min) {
      this.fail(DiagnosticCode.InvalidValue, `key "${key}" must be an integer >= ${min}`);
      return undefined;
    }
    return v;
  }
}

function parseAuthor(f: Fields, kind: AuthorKind | undefined): Author | undefined {
  const name = f.string('author.name', true);
  const session = f.string('author.session', false);
  const githubLogin = f.string('author.githubLogin', false);
  if (kind === undefined || name === undefined) return undefined;
  const author: Author = { kind, name };
  if (session !== undefined) author.session = session;
  if (githubLogin !== undefined) author.githubLogin = githubLogin;
  return author;
}

function parseAnchor(f: Fields): Anchor | undefined {
  const kind = f.enum('anchor.kind', ANCHOR_KINDS, true);
  const p = f.repoPath('anchor.path');
  const side = f.enum('anchor.side', SIDES, true);
  const commit = f.string('anchor.commit', true);
  const branch = f.string('anchor.branch', false);
  if (kind === undefined || p === undefined || side === undefined || commit === undefined) {
    if (kind === 'line') parseLineFields(f);
    return undefined;
  }
  const base = { path: p, side, commit, ...(branch !== undefined ? { branch } : {}) };
  if (kind === 'file') return { kind, ...base };
  const line = parseLineFields(f);
  return line && { kind, ...base, ...line };
}

function parseLineFields(f: Fields):
  | {
      blob: string;
      startLine: number;
      endLine: number;
      contextBefore: number;
      contextAfter: number;
    }
  | undefined {
  const blob = f.string('anchor.blob', true);
  const startLine = f.int('anchor.startLine', 1);
  const endLine = f.int('anchor.endLine', startLine ?? 1);
  const contextBefore = f.int('anchor.contextBefore', 0);
  const contextAfter = f.int('anchor.contextAfter', 0);
  if (
    blob === undefined ||
    startLine === undefined ||
    endLine === undefined ||
    contextBefore === undefined ||
    contextAfter === undefined
  ) {
    return undefined;
  }
  return { blob, startLine, endLine, contextBefore, contextAfter };
}

/** Contents of the first fenced code block, exactly as stored; undefined if none. */
function extractSnapshot(body: string): string | undefined {
  const lines = body.split('\n');
  let open = -1;
  let fenceLen = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = /^(`{3,})[^`]*$/.exec(lines[i].replace(/\r$/, ''));
    if (m) {
      open = i;
      fenceLen = m[1].length;
      break;
    }
  }
  if (open === -1) return undefined;
  const closeRe = new RegExp(`^\`{${fenceLen},}[ \\t]*$`);
  for (let i = open + 1; i < lines.length; i++) {
    if (closeRe.test(lines[i].replace(/\r$/, ''))) {
      return lines.slice(open + 1, i).join('\n');
    }
  }
  return undefined;
}

function unreadable(rel: string, err: unknown): Diagnostic {
  const code = (err as NodeJS.ErrnoException).code ?? 'unknown error';
  return {
    severity: 'error',
    code: DiagnosticCode.UnreadableFile,
    path: rel,
    message: `cannot read file (${code})`,
  };
}

/** Tree root plus the sink that diagnostics are collected into. */
interface ReadContext {
  root: string;
  problems: Diagnostic[];
}

/** File text, or undefined if absent (silently) or unreadable (with a diagnostic). */
async function readText(ctx: ReadContext, rel: string): Promise<string | undefined> {
  try {
    return await readFile(path.join(ctx.root, rel), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') ctx.problems.push(unreadable(rel, err));
    return undefined;
  }
}

interface Entry {
  name: string;
  isDir: boolean;
  isFile: boolean;
}

async function listDir(ctx: ReadContext, rel: string): Promise<Entry[]> {
  try {
    const entries = await readdir(path.join(ctx.root, rel), { withFileTypes: true });
    return entries
      .map((e) => ({ name: e.name, isDir: e.isDirectory(), isFile: e.isFile() }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') ctx.problems.push(unreadable(rel, err));
    return [];
  }
}

function invalidName(rel: string, what: string): Diagnostic {
  return {
    severity: 'error',
    code: DiagnosticCode.InvalidFileName,
    path: rel,
    message: `${what} name is not a valid ID`,
  };
}

interface ThreadMd {
  anchor: Anchor;
  snapshot?: string;
  severity?: Severity;
}

async function readThreadMd(ctx: ReadContext, rel: string): Promise<ThreadMd | undefined> {
  const text = await readText(ctx, rel);
  if (text === undefined) return undefined;
  const parsed = parseFrontmatter(text, rel);
  if (parsed.diagnostics.length > 0) {
    ctx.problems.push(...parsed.diagnostics);
    return undefined;
  }
  const f = new Fields(parsed.data, rel);
  const anchor = parseAnchor(f);
  const severity = f.enum('severity', SEVERITIES, false);
  let snapshot: string | undefined;
  if (anchor?.kind === 'line') {
    snapshot = extractSnapshot(parsed.body);
    if (snapshot === undefined) {
      f.fail(
        DiagnosticCode.InvalidValue,
        'a line thread body must hold a closed fenced code block (the snapshot)',
      );
    }
  }
  ctx.problems.push(...f.problems);
  if (!f.ok || anchor === undefined) return undefined;
  const out: ThreadMd = { anchor };
  if (snapshot !== undefined) out.snapshot = snapshot;
  if (severity !== undefined) out.severity = severity;
  return out;
}

async function readMessage(
  ctx: ReadContext,
  rel: string,
  name: string,
  isDraft: boolean,
): Promise<MessageView | undefined> {
  const parsedName = parseMessageFileName(name);
  if (!parsedName) {
    ctx.problems.push(invalidName(rel, 'message file'));
    return undefined;
  }
  const text = await readText(ctx, rel);
  if (text === undefined) return undefined;
  const parsed = parseFrontmatter(text, rel);
  if (parsed.diagnostics.length > 0) {
    ctx.problems.push(...parsed.diagnostics);
    return undefined;
  }
  const f = new Fields(parsed.data, rel);
  const kind = f.enum('author.kind', AUTHOR_KINDS, true);
  if (kind !== undefined && kind !== parsedName.kind) {
    f.fail(
      DiagnosticCode.AuthorKindMismatch,
      `author.kind "${kind}" does not match the file name kind "${parsedName.kind}"`,
    );
  }
  const author = parseAuthor(f, kind);
  const round = f.string('round', false);
  const clientId = f.string('clientId', false);
  const status: ThreadStatus | undefined = f.enum('status', STATUSES, false);
  const severity = f.enum('severity', SEVERITIES, false);
  if (f.ok && parsed.body.trim() === '' && status === undefined && severity === undefined) {
    f.fail(DiagnosticCode.EmptyBody, 'message body is empty and neither status nor severity is set');
  }
  ctx.problems.push(...f.problems);
  if (!f.ok || author === undefined) return undefined;
  const msg: MessageView = {
    id: parsedName.id,
    createdAt: parsedName.timestamp,
    author,
    body: parsed.body,
    isDraft,
  };
  if (round !== undefined) msg.round = round;
  if (status !== undefined) msg.status = status;
  if (severity !== undefined) msg.severity = severity;
  if (clientId !== undefined) msg.clientId = clientId;
  return msg;
}

async function readMessages(
  ctx: ReadContext,
  dirRel: string,
  isDraft: boolean,
): Promise<MessageView[]> {
  const files = (await listDir(ctx, dirRel)).filter(
    (e) => (e.isFile || e.isDir) && e.name.endsWith('.md') && e.name !== THREAD_FILE,
  );
  const results = await Promise.all(
    files.map(async (e) => {
      const local: Diagnostic[] = [];
      const message = await readMessage({ ...ctx, problems: local }, `${dirRel}/${e.name}`, e.name, isDraft);
      return { message, local };
    }),
  );
  const messages: MessageView[] = [];
  for (const r of results) {
    ctx.problems.push(...r.local);
    if (r.message) messages.push(r.message);
  }
  return messages.sort(byId);
}

function byId(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

interface ThreadDir {
  id: string;
  rel: string;
  problems: Diagnostic[];
}

async function listThreadDirs(ctx: ReadContext, base: string): Promise<ThreadDir[]> {
  const dirs = (await listDir(ctx, base)).filter((e) => e.isDir);
  return dirs.map((e) => ({ id: e.name, rel: `${base}/${e.name}`, problems: [] }));
}

interface SubmittedResult {
  dir: ThreadDir;
  thread?: ThreadRecord;
  /** valid thread.md but no valid messages; EMPTY_THREAD unless draft messages rescue it */
  empty?: ThreadMd;
  rescued?: boolean;
}

async function loadSubmitted(root: string, dir: ThreadDir): Promise<SubmittedResult> {
  const ctx: ReadContext = { root, problems: dir.problems };
  if (!parseId(dir.id)) {
    dir.problems.push(invalidName(dir.rel, 'thread directory'));
    return { dir };
  }
  const meta = await readThreadMd(ctx, `${dir.rel}/${THREAD_FILE}`);
  if (dir.problems.length > 0) return { dir };
  if (!meta) {
    dir.problems.push({
      severity: 'error',
      code: DiagnosticCode.MissingThreadMd,
      path: dir.rel,
      message: `thread directory has no ${THREAD_FILE}`,
    });
    return { dir };
  }
  const messages = await readMessages(ctx, dir.rel, false);
  if (messages.length === 0) return { dir, empty: meta };
  return { dir, thread: record(dir.id, false, meta, messages) };
}

function record(id: string, isDraft: boolean, meta: ThreadMd, messages: MessageView[]): ThreadRecord {
  const t: ThreadRecord = {
    id,
    createdAt: (parseId(id) as { timestamp: Date }).timestamp,
    isDraft,
    anchor: meta.anchor,
    messages,
  };
  if (meta.snapshot !== undefined) t.snapshot = meta.snapshot;
  if (meta.severity !== undefined) t.severity = meta.severity;
  return t;
}

async function loadDraft(
  root: string,
  dir: ThreadDir,
  submitted: Map<string, SubmittedResult>,
): Promise<ThreadRecord | undefined> {
  const ctx: ReadContext = { root, problems: dir.problems };
  if (!parseId(dir.id)) {
    dir.problems.push(invalidName(dir.rel, 'thread directory'));
    return undefined;
  }
  const twin = submitted.get(dir.id);
  if (twin) {
    // Submitted thread.md wins; a draft thread.md here is a leftover of an interrupted submit.
    const messages = await readMessages(ctx, dir.rel, true);
    if (twin.empty && messages.length > 0) {
      // Interrupted submit of a draft thread: thread.md was moved, messages were not.
      twin.rescued = true;
      return record(dir.id, true, twin.empty, messages);
    }
    if (!twin.thread) return undefined;
    const seen = new Set(twin.thread.messages.map((m) => m.id));
    const extra = messages.filter((m) => !seen.has(m.id));
    return { ...twin.thread, messages: [...twin.thread.messages, ...extra].sort(byId) };
  }
  const meta = await readThreadMd(ctx, `${dir.rel}/${THREAD_FILE}`);
  if (dir.problems.length > 0) return undefined;
  if (!meta) {
    dir.problems.push({
      severity: 'error',
      code: DiagnosticCode.MissingThreadMd,
      path: dir.rel,
      message: `draft thread directory has no ${THREAD_FILE} and no submitted thread with this ID`,
    });
    return undefined;
  }
  const messages = await readMessages(ctx, dir.rel, true);
  if (messages.length === 0) return undefined;
  return record(dir.id, true, meta, messages);
}

interface RoundResult {
  round?: RoundView;
  problems: Diagnostic[];
}

async function loadRound(root: string, name: string): Promise<RoundResult> {
  const rel = `.lhr/rounds/${name}`;
  const problems: Diagnostic[] = [];
  const ctx: ReadContext = { root, problems };
  const id = name.slice(0, -3);
  const parsedId = parseId(id);
  if (!parsedId) {
    problems.push(invalidName(rel, 'round file'));
    return { problems };
  }
  const text = await readText(ctx, rel);
  if (text === undefined) return { problems };
  const parsed = parseFrontmatter(text, rel);
  if (parsed.diagnostics.length > 0) return { problems: parsed.diagnostics };
  const f = new Fields(parsed.data, rel);
  const verdict: Verdict | undefined = f.enum('verdict', VERDICTS, true);
  const kind = f.enum('author.kind', ['human'] as const, true);
  const author = parseAuthor(f, kind);
  if (!f.ok || verdict === undefined || author === undefined) return { problems: f.problems };
  return {
    round: { id, createdAt: parsedId.timestamp, verdict, author, body: parsed.body },
    problems,
  };
}

export async function readTree(root: string): Promise<TreeRecords> {
  const rootProblems: Diagnostic[] = [];
  const ctx: ReadContext = { root, problems: rootProblems };
  const [submittedDirs, draftDirs, roundEntries] = await Promise.all([
    listThreadDirs(ctx, '.lhr/threads'),
    listThreadDirs(ctx, '.lhr/drafts/threads'),
    listDir(ctx, '.lhr/rounds'),
  ]);

  const submittedResults = await Promise.all(submittedDirs.map((d) => loadSubmitted(root, d)));
  const submitted = new Map(submittedResults.map((r) => [r.dir.id, r]));
  const draftThreads = await Promise.all(draftDirs.map((d) => loadDraft(root, d, submitted)));
  const roundResults = await Promise.all(
    roundEntries.filter((e) => e.isFile && e.name.endsWith('.md')).map((e) => loadRound(root, e.name)),
  );

  for (const r of submittedResults) {
    if (r.empty && !r.rescued) {
      r.dir.problems.push({
        severity: 'error',
        code: DiagnosticCode.EmptyThread,
        path: r.dir.rel,
        message: 'submitted thread has no valid messages',
      });
    }
  }

  const problems: Diagnostic[] = [
    ...rootProblems,
    ...submittedDirs.flatMap((d) => d.problems),
    ...draftDirs.flatMap((d) => d.problems),
    ...roundResults.flatMap((r) => r.problems),
  ];

  const threads = new Map<string, ThreadRecord>();
  for (const r of submittedResults) {
    if (r.thread) threads.set(r.dir.id, r.thread);
  }
  for (const t of draftThreads) {
    if (t) threads.set(t.id, t);
  }

  return {
    threads: [...threads.values()].sort(byId),
    rounds: roundResults.flatMap((r) => (r.round ? [r.round] : [])).sort(byId),
    problems,
  };
}
