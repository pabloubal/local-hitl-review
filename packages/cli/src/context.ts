// Review-root discovery and identity (docs/spec/cli.md § Review root
// discovery, § Identity), plus stdin handling for `-`.
import { realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Author } from '../../core/src/index.js';
import { CliError } from './errors.js';

export const DEFAULT_AGENT_NAME = 'claude-code';

/** `--repo` > `LHR_REPO` > the current directory, made absolute. */
export function resolveStart(
  repoFlag: string | undefined,
  env: NodeJS.ProcessEnv,
  cwd: string,
): string {
  const raw = repoFlag ?? (env.LHR_REPO ? env.LHR_REPO : undefined);
  const abs = resolve(cwd, raw ?? '.');
  try {
    return realpathSync(abs);
  } catch {
    return abs; // missing path: discovery reports NOT_A_REPO against what the user typed
  }
}

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** Nearest ancestor (or self) holding `.lhr/`; NOT_A_REPO when there is none. */
export function discoverRoot(start: string): string {
  for (let dir = start; ; dir = dirname(dir)) {
    if (isDir(join(dir, '.lhr'))) return dir;
    if (dirname(dir) === dir) break;
  }
  throw new CliError('NOT_A_REPO', `no .lhr/ found from ${start}`, {
    details: { start },
  });
}

export type Mode = 'human' | 'agent';

export interface Identity {
  mode: Mode;
  /** Agent mode only. */
  name?: string;
  session?: string;
  warnings: string[];
}

/** Agent mode when `LHR_SESSION_ID` is set (non-empty), else human; `--as` beats the environment. */
export function resolveIdentity(
  flags: { as?: string; name?: string },
  env: NodeJS.ProcessEnv,
  write = true,
): Identity {
  const session = env.LHR_SESSION_ID ? env.LHR_SESSION_ID : undefined;
  const wanted = flags.as ?? (session ? 'agent' : 'human');
  const mode: Mode = wanted === 'agent' ? 'agent' : 'human';
  const warnings: string[] = [];
  if (mode === 'human') {
    if (flags.name !== undefined) warnings.push('--name is ignored in human mode');
    return { mode, warnings };
  }
  if (!session && write) {
    warnings.push('--as agent without LHR_SESSION_ID: writes will carry no session');
  }
  const name = flags.name ?? (env.LHR_AGENT_NAME ? env.LHR_AGENT_NAME : DEFAULT_AGENT_NAME);
  return { mode, name, session, warnings };
}

/** The Author for a write; human names come from `git config user.name` at the root. */
export async function authorFor(
  id: Identity,
  tree: { humanAuthor(): Promise<Author> },
): Promise<Author> {
  if (id.mode === 'human') return tree.humanAuthor();
  const author: Author = { kind: 'agent', name: id.name! };
  if (id.session) author.session = id.session;
  return author;
}

/** Reads stdin to EOF for `-`; a terminal stdin is a usage error, not a hang. */
export async function readStdin(see: string): Promise<string> {
  if (process.stdin.isTTY) {
    throw new CliError('INVALID_INPUT', 'stdin is a terminal; pipe the body in or use --body', {
      see,
    });
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}
