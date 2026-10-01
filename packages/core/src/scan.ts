import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { Diagnostic } from './errors.js';
import {
  parseId,
  parseMessageFileName,
  type ParsedId,
  type ParsedMessageId,
} from './ids.js';
import { DiagnosticCode } from './model.js';

/**
 * The one directory walk shared by load() (read.ts) and check() (check.ts).
 *
 * It lists `.lhr/threads/`, `.lhr/drafts/threads/`, `.lhr/rounds/` and optionally
 * `.lhr/pushes/`, reads every candidate file once, and reports what can be told from
 * names and file types alone: unreadable entries, invalid names, symlinks and missing
 * `thread.md`. It never follows a symlink: one where a thread directory or a `*.md` file
 * is expected is reported as SYMLINK and skipped. Draft bookkeeping (`.lhr/drafts/.gitignore`,
 * `.submitting`, `.tmp/`) lives outside the listed directories and is never seen.
 */

export const THREAD_FILE = 'thread.md';

/** A `*.md` entry, read once. `text` is undefined when it could not be read. */
export interface FileEntry {
  name: string;
  rel: string;
  text?: string;
}

export interface MessageEntry extends FileEntry {
  /** Undefined when the file name is not a valid message file name (already reported). */
  parsedName?: ParsedMessageId;
  /**
   * Draft only: the submitted twin directory holds a message with the same ID. The draft
   * file is a leftover of an interrupted submitRound, the same message, not a new one.
   */
  submittedCopy: boolean;
}

export interface RecordEntry extends FileEntry {
  /** Undefined when the file name is not a valid ID (already reported). */
  parsedId?: ParsedId;
}

export interface ThreadDirEntry {
  id: string;
  rel: string;
  draft: boolean;
  validId: boolean;
  /**
   * The thread.md entry. Always undefined for a draft directory with a submitted twin:
   * the submitted thread.md wins and a draft one there is a leftover of an interrupted submit.
   */
  threadMd?: FileEntry;
  /** `*.md` entries other than thread.md, sorted by name. */
  messages: MessageEntry[];
  /** Draft: the submitted directory with the same ID. Submitted: the draft one. */
  twin?: ThreadDirEntry;
  /** Diagnostics about this directory and its files, from the walk alone. */
  problems: Diagnostic[];
}

export interface TreeScan {
  threads: ThreadDirEntry[];
  drafts: ThreadDirEntry[];
  rounds: RecordEntry[];
  pushes: RecordEntry[];
  /** Diagnostics about the thread base directories (not tied to one thread directory). */
  problems: Diagnostic[];
  /** Diagnostics about round and push files and their directories. */
  recordProblems: Diagnostic[];
}

export interface ScanOptions {
  /** Also list and read `.lhr/pushes/` (check() validates push records, load() ignores them). */
  pushes?: boolean;
}

export function invalidName(rel: string, what: string): Diagnostic {
  return {
    severity: 'error',
    code: DiagnosticCode.InvalidFileName,
    path: rel,
    message: `${what} name is not a valid ID`,
  };
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

function symlink(rel: string): Diagnostic {
  return {
    severity: 'error',
    code: DiagnosticCode.Symlink,
    path: rel,
    message: 'symbolic links are not followed; replace the link with the file or directory',
  };
}

type Kind = 'dir' | 'file' | 'symlink' | 'other';

interface Listed {
  name: string;
  kind: Kind;
}

/** Sorted entries of a directory; a missing directory is empty. Never follows symlinks. */
async function list(root: string, rel: string, problems: Diagnostic[]): Promise<Listed[]> {
  try {
    const entries = await readdir(path.join(root, rel), { withFileTypes: true });
    return entries
      .map((e): Listed => {
        const kind: Kind = e.isSymbolicLink()
          ? 'symlink'
          : e.isDirectory()
            ? 'dir'
            : e.isFile()
              ? 'file'
              : 'other';
        return { name: e.name, kind };
      })
      .sort((a, b) => cmp(a.name, b.name));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') problems.push(unreadable(rel, err));
    return [];
  }
}

/**
 * The `*.md` entries of a directory: regular files and directories (reading a directory
 * reports UNREADABLE_FILE); symlinks are reported and dropped, other types ignored.
 */
function mdEntries(entries: Listed[], rel: string, problems: Diagnostic[]): Listed[] {
  return entries.filter((e) => {
    if (!e.name.endsWith('.md')) return false;
    if (e.kind === 'symlink') {
      problems.push(symlink(`${rel}/${e.name}`));
      return false;
    }
    return e.kind === 'file' || e.kind === 'dir';
  });
}

/** File text, or undefined if absent (silently) or unreadable (with a diagnostic). */
async function readText(
  root: string,
  rel: string,
  problems: Diagnostic[],
): Promise<string | undefined> {
  try {
    return await readFile(path.join(root, rel), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') problems.push(unreadable(rel, err));
    return undefined;
  }
}

async function readEntry(
  root: string,
  base: string,
  name: string,
  problems: Diagnostic[],
): Promise<FileEntry> {
  const rel = `${base}/${name}`;
  const entry: FileEntry = { name, rel };
  const text = await readText(root, rel, problems);
  if (text !== undefined) entry.text = text;
  return entry;
}

interface ListedDir {
  id: string;
  rel: string;
  draft: boolean;
  entries: Listed[];
  problems: Diagnostic[];
}

async function listThreadDirs(
  root: string,
  base: string,
  draft: boolean,
  problems: Diagnostic[],
): Promise<ListedDir[]> {
  const out: ListedDir[] = [];
  for (const e of await list(root, base, problems)) {
    if (e.kind === 'symlink') problems.push(symlink(`${base}/${e.name}`));
    if (e.kind !== 'dir') continue;
    out.push({ id: e.name, rel: `${base}/${e.name}`, draft, entries: [], problems: [] });
  }
  await Promise.all(
    out.map(async (d) => {
      d.entries = await list(root, d.rel, d.problems);
    }),
  );
  return out;
}

/** Reads one thread directory. `submittedTwin` is set for a draft directory with a twin. */
async function threadDir(
  root: string,
  listed: ListedDir,
  submittedTwin: ListedDir | undefined,
): Promise<ThreadDirEntry> {
  const { id, rel, draft, problems } = listed;
  const validId = parseId(id) !== undefined;
  if (!validId) problems.push(invalidName(rel, 'thread directory'));
  const md = mdEntries(listed.entries, rel, problems);
  const twinNames = new Set(
    (submittedTwin?.entries ?? []).filter((e) => e.name !== THREAD_FILE).map((e) => e.name),
  );
  const readThreadMd = submittedTwin === undefined && md.some((e) => e.name === THREAD_FILE);

  const [threadMd, messages] = await Promise.all([
    readThreadMd ? readEntry(root, rel, THREAD_FILE, problems) : undefined,
    Promise.all(
      md
        .filter((e) => e.name !== THREAD_FILE)
        .map(async (e): Promise<MessageEntry> => {
          const parsedName = parseMessageFileName(e.name);
          const local: Diagnostic[] = [];
          if (!parsedName) local.push(invalidName(`${rel}/${e.name}`, 'message file'));
          const file = await readEntry(root, rel, e.name, local);
          problems.push(...local);
          const entry: MessageEntry = { ...file, submittedCopy: twinNames.has(e.name) };
          if (parsedName) entry.parsedName = parsedName;
          return entry;
        }),
    ),
  ]);

  // A symlinked thread.md is already reported as SYMLINK; it is not also missing.
  if (submittedTwin === undefined && !listed.entries.some((e) => e.name === THREAD_FILE)) {
    problems.push({
      severity: 'error',
      code: DiagnosticCode.MissingThreadMd,
      path: rel,
      message: draft
        ? `draft thread directory has no ${THREAD_FILE} and no submitted thread with this ID`
        : `thread directory has no ${THREAD_FILE}`,
    });
  }

  const dir: ThreadDirEntry = { id, rel, draft, validId, messages, problems };
  if (threadMd) dir.threadMd = threadMd;
  return dir;
}

async function records(
  root: string,
  base: string,
  what: string,
  problems: Diagnostic[],
): Promise<RecordEntry[]> {
  const md = mdEntries(await list(root, base, problems), base, problems);
  const results = await Promise.all(
    md.map(async (e) => {
      const local: Diagnostic[] = [];
      const parsedId = parseId(e.name.slice(0, -3));
      if (!parsedId) local.push(invalidName(`${base}/${e.name}`, what));
      const entry: RecordEntry = await readEntry(root, base, e.name, local);
      if (parsedId) entry.parsedId = parsedId;
      return { entry, local };
    }),
  );
  for (const r of results) problems.push(...r.local);
  return results.map((r) => r.entry);
}

/** Walks the tree once. Content problems become diagnostics; it never throws for them. */
export async function scanTree(root: string, opts: ScanOptions = {}): Promise<TreeScan> {
  const problems: Diagnostic[] = [];
  const roundProblems: Diagnostic[] = [];
  const pushProblems: Diagnostic[] = [];
  const [submittedListed, draftListed, rounds, pushes] = await Promise.all([
    listThreadDirs(root, '.lhr/threads', false, problems),
    listThreadDirs(root, '.lhr/drafts/threads', true, problems),
    records(root, '.lhr/rounds', 'round file', roundProblems),
    opts.pushes ? records(root, '.lhr/pushes', 'push file', pushProblems) : [],
  ]);

  const submittedById = new Map(submittedListed.map((d) => [d.id, d]));
  const [threads, drafts] = await Promise.all([
    Promise.all(submittedListed.map((d) => threadDir(root, d, undefined))),
    Promise.all(draftListed.map((d) => threadDir(root, d, submittedById.get(d.id)))),
  ]);
  const threadById = new Map(threads.map((d) => [d.id, d]));
  for (const d of drafts) {
    const twin = threadById.get(d.id);
    if (twin) {
      d.twin = twin;
      twin.twin = d;
    }
  }

  return {
    threads,
    drafts,
    rounds,
    pushes,
    problems,
    recordProblems: [...roundProblems, ...pushProblems],
  };
}

export type SubmittedState =
  /** has at least one valid submitted message */
  | 'thread'
  /** no valid submitted message, but its draft twin has some (interrupted submit of a draft thread) */
  | 'rescued'
  /** valid thread.md, no valid message anywhere: EMPTY_THREAD */
  | 'empty'
  /** invalid ID or no valid thread.md; already reported */
  | 'broken';

/**
 * What a submitted thread directory amounts to, given how many of its messages (and of
 * its draft twin's messages that are not copies of submitted ones) are valid.
 */
export function submittedState(
  dir: ThreadDirEntry,
  threadMdOk: boolean,
  validMessages: number,
  validDraftMessages: number,
): SubmittedState {
  if (!dir.validId || !threadMdOk) return 'broken';
  if (validMessages > 0) return 'thread';
  if (validDraftMessages > 0) return 'rescued';
  return 'empty';
}

export function emptyThread(dir: ThreadDirEntry): Diagnostic {
  return {
    severity: 'error',
    code: DiagnosticCode.EmptyThread,
    path: dir.rel,
    message: 'submitted thread has no valid messages',
  };
}

export function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
