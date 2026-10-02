import type { Diagnostic } from './errors.js';
import { parseFrontmatter, type FrontmatterData } from './frontmatter.js';
import { parseId, type AuthorKind } from './ids.js';
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
import {
  emptyThread,
  scanTree,
  submittedState,
  type FileEntry,
  type MessageEntry,
  type RecordEntry,
  type SubmittedState,
  type ThreadDirEntry,
  type TreeScan,
} from './scan.js';

const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
const STATUSES = ['open', 'resolved'] as const;
const VERDICTS = ['approve', 'comment', 'request-changes'] as const;
const SIDES = ['new', 'old'] as const;
const ANCHOR_KINDS = ['line', 'file'] as const;
const AUTHOR_KINDS = ['human', 'agent'] as const;

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
export function extractSnapshot(body: string): string | undefined {
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

/** A parse result: the value when the file is usable, plus every problem found. */
export interface Parsed<T> {
  value?: T;
  problems: Diagnostic[];
}

export interface ThreadMd {
  anchor: Anchor;
  snapshot?: string;
  severity?: Severity;
}

export function parseThreadMd(file: FileEntry): Parsed<ThreadMd> {
  if (file.text === undefined) return { problems: [] };
  const parsed = parseFrontmatter(file.text, file.rel);
  if (parsed.diagnostics.length > 0) return { problems: parsed.diagnostics };
  const f = new Fields(parsed.data, file.rel);
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
  if (!f.ok || anchor === undefined) return { problems: f.problems };
  const value: ThreadMd = { anchor };
  if (snapshot !== undefined) value.snapshot = snapshot;
  if (severity !== undefined) value.severity = severity;
  return { value, problems: [] };
}

export function parseMessage(file: MessageEntry, isDraft: boolean): Parsed<MessageView> {
  const parsedName = file.parsedName;
  if (!parsedName || file.text === undefined) return { problems: [] };
  const parsed = parseFrontmatter(file.text, file.rel);
  if (parsed.diagnostics.length > 0) return { problems: parsed.diagnostics };
  const f = new Fields(parsed.data, file.rel);
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
  if (!f.ok || author === undefined) return { problems: f.problems };
  const value: MessageView = {
    id: parsedName.id,
    createdAt: parsedName.timestamp,
    author,
    body: parsed.body,
    isDraft,
  };
  if (round !== undefined) value.round = round;
  if (status !== undefined) value.status = status;
  if (severity !== undefined) value.severity = severity;
  if (clientId !== undefined) value.clientId = clientId;
  return { value, problems: [] };
}

function parseRound(file: RecordEntry): Parsed<RoundView> {
  const parsedId = file.parsedId;
  if (!parsedId || file.text === undefined) return { problems: [] };
  const parsed = parseFrontmatter(file.text, file.rel);
  if (parsed.diagnostics.length > 0) return { problems: parsed.diagnostics };
  const f = new Fields(parsed.data, file.rel);
  const verdict: Verdict | undefined = f.enum('verdict', VERDICTS, true);
  const kind = f.enum('author.kind', ['human'] as const, true);
  const author = parseAuthor(f, kind);
  if (!f.ok || verdict === undefined || author === undefined) return { problems: f.problems };
  return {
    value: {
      id: file.name.slice(0, -3),
      createdAt: parsedId.timestamp,
      verdict,
      author,
      body: parsed.body,
    },
    problems: [],
  };
}

/** One thread directory parsed: its thread.md and its valid messages, sorted by ID. */
export interface ParsedDir {
  meta?: ThreadMd;
  /** Valid messages, leaving out draft copies of submitted messages. */
  messages: MessageView[];
  /** Draft message files that are copies of a valid submitted message (see parseThreads). */
  copies: Set<MessageEntry>;
  problems: Diagnostic[];
}

/**
 * Parses every file of a thread directory, reporting all broken ones. A valid message
 * whose ID is in `submittedIds` is a copy and is left out of `messages`.
 */
function parseDir(dir: ThreadDirEntry, submittedIds: ReadonlySet<string>): ParsedDir {
  const problems: Diagnostic[] = [];
  let meta: ThreadMd | undefined;
  if (dir.threadMd) {
    const r = parseThreadMd(dir.threadMd);
    problems.push(...r.problems);
    meta = r.value;
  }
  const messages: MessageView[] = [];
  const copies = new Set<MessageEntry>();
  for (const file of dir.messages) {
    const r = parseMessage(file, dir.draft);
    problems.push(...r.problems);
    if (r.value && submittedIds.has(r.value.id)) copies.add(file);
    else if (r.value) messages.push(r.value);
  }
  const out: ParsedDir = { messages: messages.sort(byId), copies, problems };
  if (meta) out.meta = meta;
  return out;
}

/**
 * Parses every thread directory and decides what each submitted one amounts to. A draft
 * message is a copy (left by an interrupted submitRound) only when its submitted twin
 * holds a *valid* message with the same ID; otherwise the draft is all there is of it.
 */
export function parseThreads(scan: TreeScan): {
  parsed: Map<ThreadDirEntry, ParsedDir>;
  states: Map<ThreadDirEntry, SubmittedState>;
} {
  const parsed = new Map<ThreadDirEntry, ParsedDir>();
  const none = new Set<string>();
  for (const dir of scan.threads) parsed.set(dir, parseDir(dir, none));
  for (const dir of scan.drafts) {
    const twin = dir.twin && parsed.get(dir.twin);
    parsed.set(dir, parseDir(dir, new Set(twin?.messages.map((m) => m.id))));
  }
  const states = new Map<ThreadDirEntry, SubmittedState>();
  for (const dir of scan.threads) {
    const own = parsed.get(dir) as ParsedDir;
    const draft = dir.twin && parsed.get(dir.twin);
    states.set(
      dir,
      submittedState(dir, own.meta !== undefined, own.messages.length, draft?.messages.length ?? 0),
    );
  }
  return { parsed, states };
}

function byId(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
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

export async function readTree(root: string): Promise<TreeRecords> {
  const scan = await scanTree(root);
  const { parsed, states } = parseThreads(scan);

  const threads = new Map<string, ThreadRecord>();
  const problems: Diagnostic[] = [...scan.problems];
  for (const dir of scan.threads) {
    const p = parsed.get(dir) as ParsedDir;
    problems.push(...dir.problems, ...p.problems);
    const state = states.get(dir);
    if (state === 'empty') problems.push(emptyThread(dir));
    if (state === 'thread' && p.meta) {
      threads.set(dir.id, record(dir.id, false, p.meta, p.messages));
    }
  }
  for (const dir of scan.drafts) {
    const p = parsed.get(dir) as ParsedDir;
    problems.push(...dir.problems, ...p.problems);
    const twin = dir.twin;
    const twinMeta = twin && parsed.get(twin)?.meta;
    if (twin && twinMeta) {
      const state = states.get(twin);
      if (state === 'rescued') {
        // Interrupted submit of a draft thread: thread.md was moved, messages were not.
        threads.set(dir.id, record(dir.id, true, twinMeta, p.messages));
      } else if (state === 'thread' && p.messages.length > 0) {
        const own = (parsed.get(twin) as ParsedDir).messages;
        threads.set(dir.id, record(dir.id, false, twinMeta, [...own, ...p.messages].sort(byId)));
      }
    } else if (!twin && dir.validId && p.meta && p.messages.length > 0) {
      threads.set(dir.id, record(dir.id, true, p.meta, p.messages));
    }
  }

  problems.push(...scan.recordProblems);
  const rounds: RoundView[] = [];
  for (const file of scan.rounds) {
    const r = parseRound(file);
    problems.push(...r.problems);
    if (r.value) rounds.push(r.value);
  }

  return {
    threads: [...threads.values()].sort(byId),
    rounds: rounds.sort(byId),
    problems,
  };
}
