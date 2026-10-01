import { readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { LhrError } from './errors.js';
import { serializeFrontmatter, type FrontmatterData } from './frontmatter.js';
import { GitExitError, runGit, runGitWithInput } from './git.js';
import type { Anchor, Severity } from './model.js';

export interface AnchorInput {
  path: string;
  kind: 'line' | 'file';
  /** Default "new". */
  side?: 'new' | 'old';
  startLine?: number;
  endLine?: number;
  /** Unsaved content. Default: the file on disk. Ignored for the old side. */
  text?: string;
  /** Required for side "old". */
  baseCommit?: string;
}

/** What the core needs to run git in a repo. */
export interface CaptureEnv {
  root: string;
  gitPath: string;
}

export interface CapturedAnchor {
  anchor: Anchor;
  /** The snapshot lines joined with "\n"; line anchors only. */
  snapshot?: string;
}

const CONTEXT_LINES = 3;

const LANGUAGES: Record<string, string> = {
  '.ts': 'ts',
  '.tsx': 'tsx',
  '.js': 'js',
  '.jsx': 'jsx',
  '.mjs': 'js',
  '.cjs': 'js',
  '.json': 'json',
  '.md': 'md',
  '.py': 'py',
  '.rb': 'rb',
  '.go': 'go',
  '.rs': 'rs',
  '.java': 'java',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.cs': 'cs',
  '.sh': 'sh',
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.css': 'css',
  '.html': 'html',
};

function invalid(message: string): LhrError {
  return new LhrError('INVALID_INPUT', message);
}

function validatePath(p: string): void {
  if (
    p === '' ||
    p.includes('\\') ||
    p.startsWith('/') ||
    /^[A-Za-z]:/.test(p) ||
    p.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')
  ) {
    throw invalid(`path must be a repo-relative POSIX path: ${p}`);
  }
}

/** Splits on \n only, like git diff; lone \r endings are not line breaks. */
function splitLines(content: string): string[] {
  const lines = content.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Output of a git command, or undefined when it exits non-zero. */
async function orUndefined(promise: Promise<string>): Promise<string | undefined> {
  try {
    return await promise;
  } catch (err) {
    if (err instanceof GitExitError) return undefined;
    throw err;
  }
}

async function currentBranch(env: CaptureEnv): Promise<string | undefined> {
  const out = await orUndefined(
    runGit(env.gitPath, env.root, ['symbolic-ref', '--short', '-q', 'HEAD']),
  );
  const name = out?.trim();
  return name === undefined || name === '' ? undefined : name;
}

async function resolveCommit(env: CaptureEnv, rev: string): Promise<string> {
  if (rev.startsWith('-')) throw invalid(`invalid baseCommit: ${rev}`);
  const out = await orUndefined(
    runGit(env.gitPath, env.root, ['rev-parse', '--verify', '-q', `${rev}^{commit}`]),
  );
  if (out === undefined) throw invalid(`baseCommit does not name a commit: ${rev}`);
  return out.trim();
}

async function requireBlobAt(env: CaptureEnv, commit: string, file: string): Promise<string> {
  const out = await runGit(env.gitPath, env.root, ['ls-tree', commit, '--', file]);
  const m = /^(\d+) (\w+) ([0-9a-f]+)\t/.exec(out);
  if (!m) throw invalid(`${file} does not exist at ${commit}`);
  // 040000 is a directory and 160000 a submodule; only regular files and symlinks are blobs.
  if (!['100644', '100755', '120000'].includes(m[1]!)) {
    throw invalid(`${file} is not a file at ${commit}`);
  }
  return m[3]!;
}

async function requireFileOnDisk(env: CaptureEnv, file: string): Promise<void> {
  try {
    if ((await stat(path.join(env.root, file))).isFile()) return;
  } catch {
    // fall through to the error below
  }
  throw invalid(`${file} is not a file on disk`);
}

/** Content and blob ID the line numbers refer to. */
async function sourceContent(
  env: CaptureEnv,
  input: AnchorInput,
  side: 'new' | 'old',
  commit: string,
): Promise<{ content: string; blob: string }> {
  if (side === 'old') {
    const id = await requireBlobAt(env, commit, input.path);
    return { content: await runGit(env.gitPath, env.root, ['cat-file', 'blob', id]), blob: id };
  }
  let bytes: Buffer;
  if (input.text !== undefined) {
    bytes = Buffer.from(input.text, 'utf8');
  } else {
    try {
      bytes = await readFile(path.join(env.root, input.path));
    } catch (err) {
      throw invalid(`cannot read ${input.path}: ${String((err as NodeJS.ErrnoException).code)}`);
    }
  }
  // One read feeds both the blob and the snapshot, so they always agree.
  const blob = await runGitWithInput(
    env.gitPath,
    env.root,
    ['hash-object', '-w', '--no-filters', '--stdin'],
    bytes,
  );
  return { content: bytes.toString('utf8'), blob: blob.trim() };
}

/**
 * Turns an AnchorInput into the saved anchor fields and the snapshot text.
 * Shared by immediate writes and drafts. Throws INVALID_INPUT for bad input.
 */
export async function captureAnchor(env: CaptureEnv, input: AnchorInput): Promise<CapturedAnchor> {
  validatePath(input.path);
  const side = input.side ?? 'new';
  if (side !== 'new' && side !== 'old') {
    throw invalid(`side must be "new" or "old": ${String(side)}`);
  }
  if (input.kind !== 'line' && input.kind !== 'file') {
    throw invalid(`kind must be "line" or "file": ${String(input.kind)}`);
  }
  if (side === 'old' && !input.baseCommit) throw invalid('baseCommit is required for side "old"');
  if (input.kind === 'file' && (input.startLine !== undefined || input.endLine !== undefined)) {
    throw invalid('a file anchor has no startLine or endLine');
  }
  const commit =
    side === 'old' && input.baseCommit
      ? await resolveCommit(env, input.baseCommit)
      : (await runGit(env.gitPath, env.root, ['rev-parse', 'HEAD'])).trim();
  const branch = await currentBranch(env);
  const base = {
    path: input.path,
    side,
    commit,
    ...(branch !== undefined ? { branch } : {}),
  };

  if (input.kind === 'file') {
    if (side === 'old') await requireBlobAt(env, commit, input.path);
    else await requireFileOnDisk(env, input.path);
    return { anchor: { kind: 'file', ...base } };
  }

  const startLine = input.startLine;
  if (startLine === undefined || !Number.isSafeInteger(startLine) || startLine < 1) {
    throw invalid('startLine must be an integer >= 1');
  }
  const endLine = input.endLine ?? startLine;
  if (!Number.isSafeInteger(endLine) || endLine < startLine) {
    throw invalid('endLine must be an integer >= startLine');
  }
  const { content, blob } = await sourceContent(env, input, side, commit);
  const lines = splitLines(content);
  if (endLine > lines.length) {
    throw invalid(`endLine ${endLine} is past the end of ${input.path} (${lines.length} lines)`);
  }
  const contextBefore = Math.min(CONTEXT_LINES, startLine - 1);
  const contextAfter = Math.min(CONTEXT_LINES, lines.length - endLine);
  const snapshot = lines.slice(startLine - 1 - contextBefore, endLine + contextAfter).join('\n');
  return {
    anchor: {
      kind: 'line',
      ...base,
      blob,
      startLine,
      endLine,
      contextBefore,
      contextAfter,
    },
    snapshot,
  };
}

/** The full text of thread.md for a captured anchor. */
export function threadMdText(captured: CapturedAnchor, severity?: Severity): string {
  const a = captured.anchor;
  const data: FrontmatterData = {
    'anchor.kind': a.kind,
    'anchor.path': a.path,
    'anchor.side': a.side,
    'anchor.commit': a.commit,
  };
  if (a.branch !== undefined) data['anchor.branch'] = a.branch;
  if (a.kind === 'line') {
    data['anchor.blob'] = a.blob;
    data['anchor.startLine'] = a.startLine;
    data['anchor.endLine'] = a.endLine;
    data['anchor.contextBefore'] = a.contextBefore;
    data['anchor.contextAfter'] = a.contextAfter;
  }
  if (severity !== undefined) data.severity = severity;
  return serializeFrontmatter(data, snapshotBody(a.path, captured.snapshot));
}

function snapshotBody(file: string, snapshot: string | undefined): string {
  if (snapshot === undefined) return '';
  const longest = Math.max(0, ...(snapshot.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  const lang = LANGUAGES[path.posix.extname(file).toLowerCase()] ?? '';
  return `${fence}${lang}\n${snapshot}\n${fence}\n`;
}
