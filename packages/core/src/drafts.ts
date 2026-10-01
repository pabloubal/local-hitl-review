import { mkdir, readFile, readdir, rm, rmdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { captureAnchor, threadMdText, type AnchorInput } from './capture.js';
import { LhrError } from './errors.js';
import { parseFrontmatter, serializeFrontmatter, type FrontmatterData } from './frontmatter.js';
import { parseId, parseMessageId } from './ids.js';
import type { Author, MessageView, Severity, ThreadStatus, ThreadView, Verdict } from './model.js';
import type { Tree } from './tree.js';
import {
  MAX_ATTEMPTS,
  createExclusive,
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
}

export interface SubmitRoundResult {
  roundId: string;
  threadIds: string[];
  messageIds: string[];
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
  await mkdir(draftThreadsDir(tree), { recursive: true });
  await createExclusive(path.join(draftsDir(tree), '.gitignore'), '*\n');
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
  const captured = await captureAnchor({ root: tree.root, gitPath: tree.gitPath }, input.anchor);
  const text = threadMdText(captured, input.severity);
  // Serialize everything before touching disk so bad input leaves no files.
  const openingText = messageText({
    author: input.author,
    body: input.body,
    ...(input.severity !== undefined ? { severity: input.severity } : {}),
  });
  await ensureDrafts(tree);
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const threadId = tree.newId();
    const dir = path.join(draftThreadsDir(tree), threadId);
    try {
      await mkdir(dir);
    } catch (err) {
      if (errnoCode(err) === 'EEXIST') continue;
      throw err;
    }
    if (!(await createExclusive(path.join(dir, THREAD_FILE), text))) continue;
    const messageId = await writeMessage(tree, dir, 'human', openingText);
    return { threadId, messageId };
  }
  throw new LhrError('GIT_FAILED', 'could not find an unused thread ID');
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
  const thread = await findThread(tree, threadId);
  if (!thread) throw new LhrError('THREAD_NOT_FOUND', `no thread ${threadId}`);
  const dir = path.join(draftThreadsDir(tree), threadId);
  await ensureDrafts(tree);
  await mkdir(dir, { recursive: true });
  return { messageId: await writeMessage(tree, dir, 'human', text) };
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
  await writeFile(
    path.join(draftThreadsDir(tree), threadId, `${messageId}.md`),
    messageText(fields),
  );
}

/** Deletes a draft message, or a draft thread with its messages. Submitted ids throw NOT_A_DRAFT. */
export async function discardDraft(tree: Tree, id: string): Promise<void> {
  if (parseMessageId(id)) {
    const { threadId } = await findDraftMessage(tree, id);
    await rm(path.join(draftThreadsDir(tree), threadId, `${id}.md`), { force: true });
    return;
  }
  const thread = parseId(id) ? await findThread(tree, id) : undefined;
  if (!thread) throw new LhrError('DRAFT_NOT_FOUND', `no draft ${id}`);
  if (!thread.isDraft) throw new LhrError('NOT_A_DRAFT', `${id} is already submitted`);
  await rm(path.join(draftThreadsDir(tree), id), { recursive: true, force: true });
}

async function readMarker(file: string): Promise<string | undefined> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return undefined;
    throw err;
  }
  const id = text.trim();
  if (!parseId(id)) throw invalid(`${file} does not hold a round ID`);
  return id;
}

function roundText(input: SubmitRoundInput): string {
  const body =
    input.summary === '' || input.summary.endsWith('\n') ? input.summary : `${input.summary}\n`;
  return serializeFrontmatter(
    {
      verdict: input.verdict,
      'author.kind': input.author.kind,
      'author.name': input.author.name,
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

async function exists(file: string): Promise<boolean> {
  try {
    await readFile(file);
    return true;
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return false;
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

/** Moves one draft thread directory's contents into `.lhr/threads/<id>/`. Idempotent. */
async function moveDraftThread(tree: Tree, threadId: string, roundId: string): Promise<void> {
  const from = path.join(draftThreadsDir(tree), threadId);
  const to = path.join(submittedThreadsDir(tree), threadId);
  const names = (await readdir(from)).filter((n) => n.endsWith('.md')).sort();
  const hasThreadMd = names.includes(THREAD_FILE);
  if (hasThreadMd) {
    await mkdir(to, { recursive: true });
    // thread.md first, so a message never lands in a thread without one.
    await createExclusive(
      path.join(to, THREAD_FILE),
      await readFile(path.join(from, THREAD_FILE), 'utf8'),
    );
  } else if (!(await exists(path.join(to, THREAD_FILE)))) {
    return; // nothing to attach these messages to; leave them as drafts
  }
  for (const name of names) {
    if (name === THREAD_FILE) continue;
    const rel = `.lhr/drafts/threads/${threadId}/${name}`;
    const text = withRound(await readFile(path.join(from, name), 'utf8'), roundId, rel);
    if (text === undefined) continue; // unparseable draft: keep it, check() reports it
    // Overwrite is safe: a file with this name here can only be an earlier, possibly
    // partial, copy of this same draft.
    await writeFile(path.join(to, name), text);
    await rm(path.join(from, name));
  }
  if (hasThreadMd) await rm(path.join(from, THREAD_FILE));
  await rmdirIfEmpty(from);
}

/**
 * Submits every draft as one review round (file-format-v2 § Submitting a review round).
 *
 * Interruption guarantee: `drafts/.submitting` holds the round ID before anything else is
 * written, the round file is written before any message points at it, and each draft is
 * deleted only after its submitted copy is fully written, so a crash at any point loses no
 * draft and leaves no message pointing at a missing round. Calling `submitRound` again
 * finishes that same round (the new call's verdict and summary are ignored if the round
 * file already exists) and then removes the marker; `load()` reads every intermediate state.
 */
export async function submitRound(tree: Tree, input: SubmitRoundInput): Promise<SubmitRoundResult> {
  validateAuthor(input.author);
  if (input.author.kind !== 'human') throw invalid('a round must be submitted by a human');
  if (!VERDICTS.includes(input.verdict)) {
    throw invalid(`verdict must be approve, comment or request-changes: ${String(input.verdict)}`);
  }
  const round = roundText(input);
  await ensureDrafts(tree);
  const markerFile = path.join(draftsDir(tree), MARKER);
  let roundId = await readMarker(markerFile);
  if (roundId === undefined) {
    const fresh = tree.newId();
    roundId = (await createExclusive(markerFile, `${fresh}\n`))
      ? fresh
      : await readMarker(markerFile);
    if (roundId === undefined) throw new LhrError('GIT_FAILED', 'could not write the round marker');
  }

  await mkdir(path.join(tree.root, '.lhr', 'rounds'), { recursive: true });
  await createExclusive(path.join(tree.root, '.lhr', 'rounds', `${roundId}.md`), round);

  for (const threadId of await listDirs(draftThreadsDir(tree))) {
    if (parseId(threadId)) await moveDraftThread(tree, threadId, roundId);
  }
  await rmdirIfEmpty(draftThreadsDir(tree));
  await rm(markerFile, { force: true });

  const threadIds: string[] = [];
  const messageIds: string[] = [];
  for (const thread of (await tree.load()).threads()) {
    if (thread.messages[0]?.round === roundId) threadIds.push(thread.id);
    for (const m of thread.messages) if (m.round === roundId) messageIds.push(m.id);
  }
  return { roundId, threadIds, messageIds };
}
