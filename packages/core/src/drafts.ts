import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, rm, rmdir, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { captureAnchor, threadMdText, type AnchorInput } from './capture.js';
import { LhrError } from './errors.js';
import { parseFrontmatter, serializeFrontmatter, type FrontmatterData } from './frontmatter.js';
import { parseId, parseMessageFileName, parseMessageId } from './ids.js';
import { withDraftsLock, type LockInfo } from './lock.js';
import type { Author, MessageView, Severity, ThreadStatus, ThreadView, Verdict } from './model.js';
import type { Tree } from './tree.js';
import {
  MAX_ATTEMPTS,
  createAtomic,
  ensureDraftsRoot,
  fsyncDir,
  replaceAtomic,
  tempDir,
  invalid,
  messageText,
  validateAuthor,
  validateMessage,
  writeMessage,
  type MessageFields,
} from './write.js';

export interface CreateDraftThreadInput {
  anchor: AnchorInput;
  body: string;
  author: Author;
  severity?: Severity;
}

export interface CreateDraftThreadResult {
  threadId: string;
  messageId: string;
}

export interface AddDraftMessageInput {
  body: string;
  author: Author;
  status?: ThreadStatus;
  severity?: Severity;
}

export interface DraftPatch {
  body?: string;
  status?: ThreadStatus;
  severity?: Severity;
}

export interface SubmitRoundInput {
  verdict: Verdict;
  summary: string;
  author: Author;
  /** Caller-chosen ID, stored on the round file; a retry with a known one returns that round. */
  clientId?: string;
}

export interface SubmitRoundResult {
  roundId: string;
  threadIds: string[];
  messageIds: string[];
  /** false when `clientId` matched an existing round, which is returned untouched */
  created: boolean;
  /**
   * true when this call finished an earlier, interrupted round, or when it waited for a
   * concurrent submit with the same author, verdict and summary and returns that round
   */
  resumed: boolean;
  /** invalid drafts left in drafts/ (empty when resuming) */
  skippedDraftIds: string[];
}

const VERDICTS: readonly string[] = ['approve', 'comment', 'request-changes'];
const THREAD_FILE = 'thread.md';
const MARKER = '.submitting';

function draftsDir(tree: Tree): string {
  return path.join(tree.root, '.lhr', 'drafts');
}

function draftThreadsDir(tree: Tree): string {
  return path.join(draftsDir(tree), 'threads');
}

function submittedThreadsDir(tree: Tree): string {
  return path.join(tree.root, '.lhr', 'threads');
}

function errnoCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException).code;
}

/** Creates `.lhr/drafts/` with its `.gitignore` (`*`) if missing, so drafts never reach git. */
async function ensureDrafts(tree: Tree): Promise<void> {
  await ensureDraftsRoot(tree);
  await mkdir(draftThreadsDir(tree), { recursive: true });
}

/** Runs `fn` under the cross-process drafts lock (see lock.ts), creating `drafts/` first. */
async function locked<T>(
  tree: Tree,
  op: string,
  fn: (lock: LockInfo) => Promise<T>,
): Promise<T> {
  await ensureDraftsRoot(tree);
  return withDraftsLock(tree.root, op, fn);
}

async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return false;
    throw err;
  }
}

function validateDraft(m: MessageFields): void {
  validateMessage(m);
  if (m.author.kind !== 'human') throw invalid('draft messages must have a human author');
}

export async function createDraftThread(
  tree: Tree,
  input: CreateDraftThreadInput,
): Promise<CreateDraftThreadResult> {
  validateDraft(input);
  if (input.body.trim() === '') throw invalid('the opening message needs a body');
  const captured = await captureAnchor(
    { root: tree.root, gitPath: tree.gitPath, repos: tree.repos },
    input.anchor,
  );
  const text = threadMdText(captured, input.severity);
  // Serialize everything before touching disk so bad input leaves no files.
  const openingText = messageText({
    author: input.author,
    body: input.body,
    ...(input.severity !== undefined ? { severity: input.severity } : {}),
  });
  return locked(tree, 'createDraftThread', async () => {
    // The thread is built complete (thread.md + opening message) in a staging directory
    // under .tmp/ and renamed into place, so a crash never leaves a thread with no message.
    const staging = path.join(tempDir(tree), `thread-${randomUUID()}`);
    await mkdir(draftThreadsDir(tree), { recursive: true });
    try {
      let messageId: string | undefined;
      for (let i = 0; i < MAX_ATTEMPTS; i++) {
        const threadId = tree.newId();
        const dir = path.join(draftThreadsDir(tree), threadId);
        // Safe under the lock: only lock holders create draft thread directories.
        if (await exists(dir)) continue;
        if (messageId === undefined) {
          await mkdir(staging);
          await createAtomic(tree, path.join(staging, THREAD_FILE), text);
          messageId = await writeMessage(tree, staging, 'human', openingText);
        }
        try {
          await rename(staging, dir);
        } catch (err) {
          if (['EEXIST', 'ENOTEMPTY'].includes(errnoCode(err) ?? '')) continue;
          throw err;
        }
        await fsyncDir(draftThreadsDir(tree));
        return { threadId, messageId };
      }
      throw new LhrError('IO_FAILED', 'could not find an unused thread ID');
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  });
}

async function findThread(tree: Tree, threadId: string): Promise<ThreadView | undefined> {
  const snapshot = await tree.load();
  return snapshot.threads({ includeDrafts: true }).find((t) => t.id === threadId);
}

export async function addDraftMessage(
  tree: Tree,
  threadId: string,
  input: AddDraftMessageInput,
): Promise<{ messageId: string }> {
  validateDraft(input);
  const text = messageText(input);
  return locked(tree, 'addDraftMessage', async () => {
    const thread = await findThread(tree, threadId);
    if (!thread) throw new LhrError('THREAD_NOT_FOUND', `no thread ${threadId}`);
    const dir = path.join(draftThreadsDir(tree), threadId);
    await mkdir(dir, { recursive: true });
    return { messageId: await writeMessage(tree, dir, 'human', text) };
  });
}

interface FoundDraft {
  threadId: string;
  message: MessageView;
}

async function findDraftMessage(tree: Tree, messageId: string): Promise<FoundDraft> {
  const snapshot = await tree.load();
  for (const thread of snapshot.threads({ includeDrafts: true })) {
    const message = thread.messages.find((m) => m.id === messageId);
    if (!message) continue;
    if (!message.isDraft) throw new LhrError('NOT_A_DRAFT', `${messageId} is already submitted`);
    return { threadId: thread.id, message };
  }
  throw new LhrError('DRAFT_NOT_FOUND', `no draft message ${messageId}`);
}

/** Rewrites a draft message in place; unset patch fields keep their current value. */
export async function updateDraft(tree: Tree, messageId: string, patch: DraftPatch): Promise<void> {
  // Under the lock a submit cannot move the draft between the lookup and the rename,
  // so the rename can never recreate a draft that was just submitted.
  return locked(tree, 'updateDraft', () => updateLocked(tree, messageId, patch));
}

async function updateLocked(tree: Tree, messageId: string, patch: DraftPatch): Promise<void> {
  const { threadId, message } = await findDraftMessage(tree, messageId);
  const status = patch.status ?? message.status;
  const severity = patch.severity ?? message.severity;
  const fields: MessageFields = {
    author: message.author,
    body: patch.body ?? message.body,
    ...(status !== undefined ? { status } : {}),
    ...(severity !== undefined ? { severity } : {}),
    ...(message.clientId !== undefined ? { clientId: message.clientId } : {}),
  };
  validateDraft(fields);
  const file = path.join(draftThreadsDir(tree), threadId, `${messageId}.md`);
  try {
    await stat(file);
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') throw new LhrError('DRAFT_NOT_FOUND', `no draft ${messageId}`);
    throw err;
  }
  await replaceAtomic(tree, file, messageText(fields));
}

/** Deletes a draft message, or a draft thread with its messages. Submitted ids throw NOT_A_DRAFT. */
export async function discardDraft(tree: Tree, id: string): Promise<void> {
  return locked(tree, 'discardDraft', () => discardLocked(tree, id));
}

async function discardLocked(tree: Tree, id: string): Promise<void> {
  if (parseMessageId(id)) {
    const { threadId } = await findDraftMessage(tree, id);
    const dir = path.join(draftThreadsDir(tree), threadId);
    await rm(path.join(dir, `${id}.md`), { force: true });
    if ((await draftMessageNames(dir)).length === 0) await rm(dir, { recursive: true, force: true });
    return;
  }
  const thread = parseId(id) ? await findThread(tree, id) : undefined;
  if (!thread) throw new LhrError('DRAFT_NOT_FOUND', `no draft ${id}`);
  if (!thread.isDraft) throw new LhrError('NOT_A_DRAFT', `${id} is already submitted`);
  await rm(path.join(draftThreadsDir(tree), id), { recursive: true, force: true });
}

interface Marker {
  round: string;
  messages: string[];
}

/** An empty, unparseable or invalid marker counts as absent: nothing can depend on it yet. */
async function readMarker(file: string): Promise<Marker | undefined> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return undefined;
    throw err;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const { round, messages } = value as { round?: unknown; messages?: unknown };
  if (typeof round !== 'string' || !parseId(round)) return undefined;
  if (!Array.isArray(messages)) return undefined;
  const ids: string[] = [];
  for (const m of messages) {
    if (typeof m !== 'string' || !parseMessageId(m)) return undefined;
    ids.push(m);
  }
  return { round, messages: ids };
}

function roundText(input: SubmitRoundInput): string {
  const body =
    input.summary === '' || input.summary.endsWith('\n') ? input.summary : `${input.summary}\n`;
  return serializeFrontmatter(
    {
      verdict: input.verdict,
      'author.kind': input.author.kind,
      'author.name': input.author.name,
      ...(input.clientId !== undefined ? { clientId: input.clientId } : {}),
    },
    body,
  );
}

/** Rewrites a draft message's text with `round: <id>` right after the author keys. */
function withRound(text: string, roundId: string, rel: string): string | undefined {
  const parsed = parseFrontmatter(text, rel);
  if (parsed.diagnostics.length > 0) return undefined;
  const rest = Object.entries(parsed.data).filter(([k]) => k !== 'round');
  const data: FrontmatterData = {};
  for (const [k, v] of rest) if (k.startsWith('author.')) data[k] = v;
  data.round = roundId;
  for (const [k, v] of rest) if (!k.startsWith('author.')) data[k] = v;
  return serializeFrontmatter(data, parsed.body);
}

/** Semantic check of a draft message file, mirroring what the reader requires. */
function draftIsValid(text: string, name: string, rel: string): boolean {
  const parsedName = parseMessageFileName(name);
  if (!parsedName) return false;
  const parsed = parseFrontmatter(text, rel);
  if (parsed.diagnostics.length > 0) return false;
  const { data } = parsed;
  if (data['author.kind'] !== parsedName.kind) return false;
  if (typeof data['author.name'] !== 'string' || data['author.name'].trim() === '') return false;
  if (parsed.body.trim() === '' && data.status === undefined && data.severity === undefined) {
    return false;
  }
  return true;
}

async function listDirs(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return [];
    throw err;
  }
}

async function readOptional(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8');
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return undefined;
    throw err;
  }
}

/** Draft message file names (not thread.md) in a draft thread directory. */
async function draftMessageNames(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((n) => n.endsWith('.md') && n !== THREAD_FILE).sort();
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return [];
    throw err;
  }
}

async function rmdirIfEmpty(dir: string): Promise<void> {
  try {
    await rmdir(dir);
  } catch (err) {
    if (!['ENOTEMPTY', 'EEXIST', 'ENOENT'].includes(errnoCode(err) ?? '')) throw err;
  }
}

/** Removes temp files that a crashed write left behind (older than an hour). */
async function cleanStaleTemps(tree: Tree): Promise<void> {
  try {
    const dir = tempDir(tree);
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const name of await readdir(dir)) {
      try {
        if ((await stat(path.join(dir, name))).mtimeMs < cutoff) {
          await rm(path.join(dir, name), { recursive: true, force: true });
        }
      } catch {
        // best-effort: a failed cleanup must never fail a submit
      }
    }
  } catch {
    // best-effort
  }
}

interface Scan {
  /** draft message id -> draft thread id, for every message file in drafts/ */
  location: Map<string, string>;
  eligible: string[];
  skipped: string[];
}

/** Lists the drafts a fresh round would publish, and those it must skip as invalid. */
async function scanDrafts(tree: Tree): Promise<Scan> {
  const scan: Scan = { location: new Map(), eligible: [], skipped: [] };
  for (const threadId of await listDirs(draftThreadsDir(tree))) {
    if (!parseId(threadId)) continue;
    const dir = path.join(draftThreadsDir(tree), threadId);
    const draftMeta = await readOptional(path.join(dir, THREAD_FILE));
    const targetMeta = await readOptional(
      path.join(submittedThreadsDir(tree), threadId, THREAD_FILE),
    );
    const meta = targetMeta ?? draftMeta;
    const threadOk =
      meta !== undefined &&
      parseFrontmatter(meta, `.lhr/drafts/threads/${threadId}/${THREAD_FILE}`).diagnostics
        .length === 0;
    for (const name of await draftMessageNames(dir)) {
      const id = name.slice(0, -3);
      scan.location.set(id, threadId);
      const text = await readOptional(path.join(dir, name));
      const rel = `.lhr/drafts/threads/${threadId}/${name}`;
      if (text !== undefined && threadOk && draftIsValid(text, name, rel)) scan.eligible.push(id);
      else scan.skipped.push(id);
    }
  }
  scan.eligible.sort();
  scan.skipped.sort();
  return scan;
}

/** Publishes the listed drafts of one thread. Every step tolerates ENOENT and EEXIST. */
async function publishThread(
  tree: Tree,
  threadId: string,
  ids: string[],
  roundId: string,
): Promise<void> {
  const from = path.join(draftThreadsDir(tree), threadId);
  const to = path.join(submittedThreadsDir(tree), threadId);
  const sources = new Map<string, string>();
  for (const id of ids) {
    const text = await readOptional(path.join(from, `${id}.md`));
    if (text !== undefined) sources.set(id, text);
  }
  if (sources.size === 0) return; // all already published: no thread.md to move either

  const targetMeta = path.join(to, THREAD_FILE);
  if ((await readOptional(targetMeta)) === undefined) {
    const draftMeta = await readOptional(path.join(from, THREAD_FILE));
    if (draftMeta !== undefined) {
      await mkdir(to, { recursive: true });
      await createAtomic(tree, targetMeta, draftMeta);
    }
  }
  // Never delete a draft before the thread it joins is verifiably complete.
  const meta = await readOptional(targetMeta);
  if (meta === undefined || parseFrontmatter(meta, targetMeta).diagnostics.length > 0) {
    throw invalid(`${targetMeta} is missing or invalid; refusing to submit into it`);
  }

  for (const [id, source] of sources) {
    const rel = `.lhr/drafts/threads/${threadId}/${id}.md`;
    const text = withRound(source, roundId, rel);
    if (text === undefined) throw invalid(`draft ${id} cannot be parsed`);
    const target = path.join(to, `${id}.md`);
    await createAtomic(tree, target, text); // false: an earlier run already wrote it
    const written = await readOptional(target);
    if (written === undefined || parseFrontmatter(written, target).diagnostics.length > 0) {
      throw invalid(`${target} is missing or invalid; keeping the draft`);
    }
    await rm(path.join(from, `${id}.md`), { force: true });
  }
  if ((await draftMessageNames(from)).length === 0) {
    await rm(from, { recursive: true, force: true });
  }
}

/**
 * Submits drafts as one review round (file-format-v2 § Submitting a review round).
 *
 * Guarantee: no draft is ever lost, no file outside `drafts/` is ever partial, and no
 * message ever points at a missing round, whenever the process dies. Every file under
 * `threads/` and `rounds/` is written to a temp file, fsynced and hard-linked into place,
 * so it is absent or complete. `drafts/.submitting` (JSON `{ round, messages }`, written
 * atomically) is created before anything else and fixes the round ID and the exact draft
 * messages in this round; the round file is written before any message; a draft is
 * deleted only after its submitted copy exists. Calling `submitRound` again while the
 * marker is valid resumes that round (`resumed: true`): it finishes exactly the listed
 * messages, ignores the new verdict and summary (they are used only if the round file
 * was never written), leaves drafts added since as drafts, and removes the marker. An
 * empty, unparseable or invalid marker counts as absent and is replaced, since nothing
 * can depend on it before the round file exists. Drafts that are invalid (a mismatched
 * author kind, an empty body without status or severity, a broken thread) are not
 * listed, stay in `drafts/` and come back as `skippedDraftIds` (empty when resuming).
 *
 * The whole submit runs under the drafts lock, so concurrent submits (and draft edits)
 * are serialised on every file system. A submit that had to wait for the lock, and finds
 * that a concurrent submit wrote a round with the same author, verdict and summary
 * meanwhile, is a double submit: it returns that round with `resumed: true` rather than
 * starting a second one. Otherwise it is an ordinary submit of the drafts left. On file
 * systems without hard links the no-partial-file guarantee is best-effort: an error-path
 * unlink covers process errors, not a hard kill mid-write. Unexpected file system errors surface as `LhrError`. Crash-safe against
 * process death; power loss is best-effort (files and directories are fsynced where the
 * platform allows).
 */
export async function submitRound(tree: Tree, input: SubmitRoundInput): Promise<SubmitRoundResult> {
  validateAuthor(input.author);
  if (input.author.kind !== 'human') throw invalid('a round must be submitted by a human');
  if (!VERDICTS.includes(input.verdict)) {
    throw invalid(`verdict must be approve, comment or request-changes: ${String(input.verdict)}`);
  }
  if (input.clientId !== undefined && input.clientId.trim() === '') {
    throw invalid('clientId must not be empty');
  }
  const round = roundText(input);
  try {
    // Rounds written while this call waits for the lock belong to a concurrent submit.
    const before = new Set(await listRoundIds(tree));
    return await locked(tree, 'submitRound', (lock) =>
      runRound(tree, round, lock.waited ? before : undefined, input.clientId),
    );
  } catch (err) {
    if (err instanceof LhrError) throw err;
    throw new LhrError('IO_FAILED', `submitRound failed: ${(err as Error).message}`);
  }
}

function roundsDir(tree: Tree): string {
  return path.join(tree.root, '.lhr', 'rounds');
}

async function listRoundIds(tree: Tree): Promise<string[]> {
  try {
    const names = await readdir(roundsDir(tree));
    return names.filter((n) => n.endsWith('.md')).map((n) => n.slice(0, -3));
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return [];
    throw err;
  }
}

/** The author, verdict and summary of a round file: what makes two submits the same submit. */
function roundKey(text: string, rel: string): string | undefined {
  const parsed = parseFrontmatter(text, rel);
  if (parsed.diagnostics.length > 0) return undefined;
  const { data } = parsed;
  return JSON.stringify([data['author.kind'], data['author.name'], data.verdict, parsed.body]);
}

/** The newest round not in `before` with the same author, verdict and summary. */
async function findDoubleSubmit(
  tree: Tree,
  roundContent: string,
  before: Set<string>,
): Promise<string | undefined> {
  const key = roundKey(roundContent, 'submitted round');
  const fresh = (await listRoundIds(tree)).filter((id) => !before.has(id)).sort().reverse();
  for (const id of fresh) {
    const text = await readOptional(path.join(roundsDir(tree), `${id}.md`));
    if (text !== undefined && roundKey(text, `.lhr/rounds/${id}.md`) === key) return id;
  }
  return undefined;
}

/** The ID of the round file that stores `clientId`, if any. */
async function findRoundByClientId(tree: Tree, clientId: string): Promise<string | undefined> {
  for (const id of (await listRoundIds(tree)).sort()) {
    const text = await readOptional(path.join(roundsDir(tree), `${id}.md`));
    if (text === undefined) continue;
    const parsed = parseFrontmatter(text, `.lhr/rounds/${id}.md`);
    if (parsed.diagnostics.length === 0 && parsed.data.clientId === clientId) return id;
  }
  return undefined;
}

/**
 * Runs under the drafts lock: no other submit or draft edit can interleave.
 * `roundsBefore` is set only when the call had to wait for the lock.
 */
async function runRound(
  tree: Tree,
  roundContent: string,
  roundsBefore: Set<string> | undefined,
  clientId?: string,
): Promise<SubmitRoundResult> {
  const markerFile = path.join(draftsDir(tree), MARKER);
  let marker = await readMarker(markerFile);
  const resumed = marker !== undefined;
  let created = true;
  if (clientId !== undefined) {
    // An idempotent retry: return the known round without touching drafts, unless it is
    // the round an interrupted run left in the marker, which is finished first.
    const known = await findRoundByClientId(tree, clientId);
    if (known !== undefined) {
      if (marker === undefined || marker.round !== known) {
        return roundResult(tree, known, false, [], false);
      }
      created = false;
    }
  }
  if (marker === undefined && roundsBefore !== undefined) {
    const joined = await findDoubleSubmit(tree, roundContent, roundsBefore);
    if (joined !== undefined) return roundResult(tree, joined, true, [], false);
  }
  await ensureDrafts(tree);
  await cleanStaleTemps(tree);
  let skippedDraftIds: string[] = [];
  const scan = await scanDrafts(tree);
  if (marker === undefined) {
    // Absent or invalid: (re)write it. The lock makes a plain atomic replace safe, also
    // on file systems without hard links.
    marker = { round: tree.newId(), messages: scan.eligible };
    await replaceAtomic(tree, markerFile, `${JSON.stringify(marker)}\n`);
    skippedDraftIds = scan.skipped;
  }
  const roundId = marker.round;

  await mkdir(roundsDir(tree), { recursive: true });
  await createAtomic(tree, path.join(roundsDir(tree), `${roundId}.md`), roundContent);

  const byThread = new Map<string, string[]>();
  for (const id of marker.messages) {
    const threadId = scan.location.get(id);
    if (threadId === undefined) continue; // already published (or discarded)
    byThread.set(threadId, [...(byThread.get(threadId) ?? []), id]);
  }
  for (const threadId of [...byThread.keys()].sort()) {
    await publishThread(tree, threadId, byThread.get(threadId) ?? [], roundId);
  }
  await rmdirIfEmpty(draftThreadsDir(tree));
  await rm(markerFile, { force: true });
  return roundResult(tree, roundId, resumed, skippedDraftIds, created);
}

async function roundResult(
  tree: Tree,
  roundId: string,
  resumed: boolean,
  skippedDraftIds: string[],
  created: boolean,
): Promise<SubmitRoundResult> {
  const threadIds: string[] = [];
  const messageIds: string[] = [];
  for (const thread of (await tree.load()).threads()) {
    if (thread.messages[0]?.round === roundId) threadIds.push(thread.id);
    for (const m of thread.messages) if (m.round === roundId) messageIds.push(m.id);
  }
  return { roundId, threadIds, messageIds, created, resumed, skippedDraftIds };
}
