import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { captureAnchor, threadMdText, type AnchorInput } from './capture.js';
import { LhrError } from './errors.js';
import { serializeFrontmatter, type FrontmatterData } from './frontmatter.js';
import type { Author, Severity, ThreadStatus, ThreadView } from './model.js';
import type { Tree } from './tree.js';

export interface ReplyInput {
  body: string;
  author: Author;
  clientId?: string;
  status?: ThreadStatus;
  severity?: Severity;
}

export interface ReplyResult {
  messageId: string;
  created: boolean;
}

export interface CreateThreadInput {
  anchor: AnchorInput;
  body: string;
  author: Author;
  clientId?: string;
  severity?: Severity;
}

export interface CreateThreadResult {
  threadId: string;
  messageId: string;
  created: boolean;
}

export interface StatusChangeResult {
  messageId?: string;
  changed: boolean;
}

export const MAX_ATTEMPTS = 10;
const SEVERITIES: readonly string[] = ['critical', 'high', 'medium', 'low'];
const STATUSES: readonly string[] = ['open', 'resolved'];

export function invalid(message: string): LhrError {
  return new LhrError('INVALID_INPUT', message);
}

export function validateAuthor(author: Author): void {
  if (author.kind !== 'human' && author.kind !== 'agent') {
    throw invalid(`author.kind must be "human" or "agent": ${String(author.kind)}`);
  }
  if (typeof author.name !== 'string' || author.name.trim() === '') {
    throw invalid('author.name must not be empty');
  }
}

/** Fields of a message file, in the order the format lists them. */
export interface MessageFields {
  author: Author;
  body: string;
  round?: string;
  status?: ThreadStatus;
  severity?: Severity;
  clientId?: string;
}

export function validateMessage(m: MessageFields): void {
  validateAuthor(m.author);
  if (m.status !== undefined && !STATUSES.includes(m.status)) {
    throw invalid(`status must be "open" or "resolved": ${String(m.status)}`);
  }
  if (m.severity !== undefined && !SEVERITIES.includes(m.severity)) {
    throw invalid(`severity must be critical, high, medium or low: ${String(m.severity)}`);
  }
  if (m.clientId !== undefined && m.clientId.trim() === '') {
    throw invalid('clientId must not be empty');
  }
  if (m.body.trim() === '' && m.status === undefined && m.severity === undefined) {
    throw invalid('body must not be empty unless status or severity is set');
  }
}

export function messageText(m: MessageFields): string {
  const data: FrontmatterData = {
    'author.kind': m.author.kind,
    'author.name': m.author.name,
  };
  if (m.author.session !== undefined) data['author.session'] = m.author.session;
  if (m.author.githubLogin !== undefined) data['author.githubLogin'] = m.author.githubLogin;
  if (m.round !== undefined) data.round = m.round;
  if (m.status !== undefined) data.status = m.status;
  if (m.severity !== undefined) data.severity = m.severity;
  if (m.clientId !== undefined) data.clientId = m.clientId;
  const body = m.body === '' || m.body.endsWith('\n') ? m.body : `${m.body}\n`;
  return serializeFrontmatter(data, body);
}

/** Creates `file` exclusively. Returns false when it already exists. */
export async function createExclusive(file: string, content: string): Promise<boolean> {
  try {
    await writeFile(file, content, { flag: 'wx' });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
}

/** Writes a new message file into `dir` and returns its message ID. */
export async function writeMessage(
  tree: Tree,
  dir: string,
  kind: Author['kind'],
  text: string,
): Promise<string> {
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const name = tree.newMessageFileName(kind);
    if (await createExclusive(path.join(dir, name), text)) return name.slice(0, -3);
  }
  throw new LhrError('GIT_FAILED', `could not find an unused message file name in ${dir}`);
}

export async function requireThread(tree: Tree, threadId: string): Promise<ThreadView> {
  const thread = (await tree.load()).thread(threadId);
  if (!thread) throw new LhrError('THREAD_NOT_FOUND', `no thread ${threadId}`);
  return thread;
}

function threadDir(tree: Tree, threadId: string): string {
  return path.join(tree.root, '.lhr', 'threads', threadId);
}

export async function reply(tree: Tree, threadId: string, input: ReplyInput): Promise<ReplyResult> {
  validateMessage(input);
  const text = messageText(input);
  const thread = await requireThread(tree, threadId);
  if (input.clientId !== undefined) {
    const existing = thread.messages.find((m) => !m.isDraft && m.clientId === input.clientId);
    if (existing) return { messageId: existing.id, created: false };
  }
  const messageId = await writeMessage(tree, threadDir(tree, threadId), input.author.kind, text);
  return { messageId, created: true };
}

export async function createThread(
  tree: Tree,
  input: CreateThreadInput,
): Promise<CreateThreadResult> {
  validateMessage(input);
  if (input.body.trim() === '') throw invalid('the opening message needs a body');
  if (input.severity !== undefined && !SEVERITIES.includes(input.severity)) {
    throw invalid(`severity must be critical, high, medium or low: ${String(input.severity)}`);
  }
  const snapshot = await tree.load();
  if (input.clientId !== undefined) {
    for (const thread of snapshot.threads()) {
      const opening = thread.messages[0];
      if (opening?.clientId === input.clientId) {
        return { threadId: thread.id, messageId: opening.id, created: false };
      }
    }
  }
  const opening: MessageFields = {
    author: input.author,
    body: input.body,
    ...(input.severity !== undefined ? { severity: input.severity } : {}),
    ...(input.clientId !== undefined ? { clientId: input.clientId } : {}),
  };
  // Serialize everything before touching disk so bad input leaves no files.
  const openingText = messageText(opening);
  const captured = await captureAnchor({ root: tree.root, gitPath: tree.gitPath }, input.anchor);
  const text = threadMdText(captured, input.severity);
  const threads = path.join(tree.root, '.lhr', 'threads');
  await mkdir(threads, { recursive: true });
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const threadId = tree.newId();
    const dir = path.join(threads, threadId);
    try {
      await mkdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw err;
    }
    if (!(await createExclusive(path.join(dir, 'thread.md'), text))) continue;
    // A crash between thread.md and the first message leaves a thread with no
    // messages, which check() reports as EmptyThread. The spec defines no
    // crash-safe ordering for immediate writes.
    const messageId = await writeMessage(tree, dir, input.author.kind, openingText);
    return { threadId, messageId, created: true };
  }
  throw new LhrError('GIT_FAILED', 'could not find an unused thread ID');
}

async function setStatus(
  tree: Tree,
  threadId: string,
  author: Author,
  status: ThreadStatus,
): Promise<StatusChangeResult> {
  validateAuthor(author);
  const text = messageText({ author, body: '', status });
  const thread = await requireThread(tree, threadId);
  if (thread.status === status) return { changed: false };
  const messageId = await writeMessage(tree, threadDir(tree, threadId), author.kind, text);
  return { messageId, changed: true };
}

export function resolve(tree: Tree, threadId: string, author: Author): Promise<StatusChangeResult> {
  return setStatus(tree, threadId, author, 'resolved');
}

export function reopen(tree: Tree, threadId: string, author: Author): Promise<StatusChangeResult> {
  return setStatus(tree, threadId, author, 'open');
}
