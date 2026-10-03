// Thread handles (ADR 0007, docs/spec/cli.md § Input conventions). A handle is
// the first N characters of the 6-character random part of a thread ID, N >= 4,
// grown until it is unique among the threads in the tree.
import { CliError } from './errors.js';

// Handles are computed over the mode-visible threads only: callers pass the IDs the
// current identity can see (drafts included in human mode, excluded in agent mode), so a
// handle shown in one mode is unique within that mode's view, not across all threads.
export const MIN_HANDLE = 4;
/** Most candidates named in an ambiguity message; the rest are counted. */
export const MAX_CANDIDATES = 10;
const RANDOM_LEN = 6;
const HANDLE_RE = /^[a-z2-7]{1,6}$/;

const randomPart = (id: string): string => id.slice(id.length - RANDOM_LEN);

/** Handle for each ID, keyed by full ID: the shortest unique random-part prefix, 4 to 6 long. */
export function shortIds(ids: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const id of ids) {
    const mine = randomPart(id);
    let n = MIN_HANDLE;
    while (n < RANDOM_LEN) {
      const prefix = mine.slice(0, n);
      if (!ids.some((o) => o !== id && randomPart(o).startsWith(prefix))) break;
      n++;
    }
    out.set(id, mine.slice(0, n));
  }
  return out;
}

export interface ResolveOptions {
  /** `lhr <cmd> --help`, for the `see:` line. */
  see: string;
  /** A correct invocation for an ambiguity error, given one candidate's full ID. */
  example?: (fullId: string) => string;
}

/**
 * Resolves a full ID, an ID prefix or a handle to one full ID among `ids`.
 * No match is THREAD_NOT_FOUND (exit 3); several matches are INVALID_INPUT
 * (exit 2) listing the candidates. The forms cannot collide: a full ID has `0`
 * at position 2 and `0` is not in the random alphabet.
 */
export function resolveThreadId(
  ids: readonly string[],
  input: string,
  opts: ResolveOptions,
): string {
  const wanted = input.trim();
  if (ids.includes(wanted)) return wanted;
  const isHandle = HANDLE_RE.test(wanted) && wanted.length >= MIN_HANDLE;
  const matches =
    wanted === ''
      ? []
      : ids.filter((id) => (isHandle ? randomPart(id).startsWith(wanted) : id.startsWith(wanted)));
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) {
    throw new CliError('THREAD_NOT_FOUND', `no thread matches "${input}"`, { see: opts.see });
  }
  const example = (opts.example ?? ((id) => `lhr thread show ${id}`))(matches[0]);
  const shown = matches.slice(0, MAX_CANDIDATES).join(', ');
  const more =
    matches.length > MAX_CANDIDATES ? `, and ${matches.length - MAX_CANDIDATES} more` : '';
  throw new CliError(
    'INVALID_INPUT',
    `"${input}" matches ${matches.length} threads: ${shown}${more}`,
    // details.threadId lets other front ends (lhr mcp) build their own example.
    { see: opts.see, example, details: { threadId: matches[0] } },
  );
}
