// Serializers for `lhr mcp` (docs/spec/cli.md § Thread object, ADR 0007 handles).
// Kept local to the MCP server until the CLI thread/inbox serializers land;
// then both should share one module.
import type {
  AnchorResult,
  Author,
  MessageView,
  ThreadView,
  TreeSnapshot,
} from '../../../core/src/index.js';
import { CliError } from '../errors.js';

const HANDLE_MIN = 4;
const HANDLE_RE = /^[a-z2-7]{4,6}$/;

const randomPart = (id: string): string => id.slice(id.lastIndexOf('-') + 1);

/** ISO-8601 UTC without milliseconds: IDs carry whole seconds. */
export const isoSeconds = (d: Date): string => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * Handle per thread ID: the shortest prefix of the random part, at least 4
 * characters, that no other thread in `all` shares.
 */
export function handles(all: readonly ThreadView[]): Map<string, string> {
  const randoms = all.map((t) => randomPart(t.id));
  const out = new Map<string, string>();
  all.forEach((t, i) => {
    const r = randoms[i];
    let n = HANDLE_MIN;
    while (n < r.length && randoms.some((o, j) => j !== i && o.startsWith(r.slice(0, n)))) n++;
    out.set(t.id, r.slice(0, n));
  });
  return out;
}

/** A full ID, a prefix of one, or a 4 to 6 character handle -> one submitted thread. */
export function resolveThread(snap: TreeSnapshot, input: string): ThreadView {
  const exact = snap.thread(input);
  if (exact) return exact;
  const all = snap.threads();
  const matches = HANDLE_RE.test(input)
    ? all.filter((t) => randomPart(t.id).startsWith(input))
    : all.filter((t) => t.id.startsWith(input));
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) {
    throw new CliError('THREAD_NOT_FOUND', `no thread matches "${input}"`);
  }
  const ids = matches.map((t) => t.id);
  throw new CliError(
    'INVALID_INPUT',
    `"${input}" matches ${ids.length} threads: ${ids.join(', ')}`,
    { details: { threadId: ids[0] } },
  );
}

export interface ThreadAnchorJson {
  path: string;
  kind: 'line' | 'file';
  side: 'new' | 'old';
  startLine?: number;
  endLine?: number;
  state: AnchorResult['state'];
  method: AnchorResult['method'];
}

export interface ThreadJson {
  id: string;
  shortId: string;
  isDraft: boolean;
  status: ThreadView['status'];
  severity: ThreadView['severity'];
  whoseTurn: ThreadView['whoseTurn'];
  reviewer: Author;
  createdAt: string;
  location: string;
  anchor: ThreadAnchorJson;
  messageCount: number;
}

export interface MessageJson {
  id: string;
  createdAt: string;
  author: Author;
  body: string;
  round?: string;
  status?: MessageView['status'];
  severity?: MessageView['severity'];
}

export interface ThreadShowJson extends ThreadJson {
  snapshot?: string;
  savedStartLine?: number;
  savedEndLine?: number;
  messages: MessageJson[];
}

const author = (a: Author): Author => {
  const out: Author = { kind: a.kind, name: a.name };
  if (a.session !== undefined) out.session = a.session;
  if (a.githubLogin !== undefined) out.githubLogin = a.githubLogin;
  return out;
};

/** List-shaped thread: re-anchored location, no bodies. */
export function threadJson(t: ThreadView, at: AnchorResult, shortId: string): ThreadJson {
  const anchor: ThreadAnchorJson = {
    path: at.path,
    kind: t.anchor.kind,
    side: t.anchor.side,
    state: at.state,
    method: at.method,
  };
  let location = at.path;
  if (t.anchor.kind === 'line' && at.startLine !== undefined) {
    anchor.startLine = at.startLine;
    anchor.endLine = at.endLine ?? at.startLine;
    location += `:${anchor.startLine}`;
    if (anchor.endLine !== anchor.startLine) location += `-${anchor.endLine}`;
  }
  return {
    id: t.id,
    shortId,
    isDraft: t.isDraft,
    status: t.status,
    severity: t.severity,
    whoseTurn: t.whoseTurn,
    reviewer: author(t.reviewer),
    createdAt: isoSeconds(t.createdAt),
    location,
    anchor,
    messageCount: t.messages.length,
  };
}

/** Show-shaped thread: adds messages, the snapshot and saved lines when moved. */
export function threadShowJson(t: ThreadView, at: AnchorResult, shortId: string): ThreadShowJson {
  const out: ThreadShowJson = { ...threadJson(t, at, shortId), messages: [] };
  if (t.snapshot !== undefined) out.snapshot = t.snapshot;
  if (t.anchor.kind === 'line' && at.state !== 'current') {
    out.savedStartLine = t.anchor.startLine;
    out.savedEndLine = t.anchor.endLine;
  }
  out.messages = t.messages.map((m) => {
    const j: MessageJson = {
      id: m.id,
      createdAt: isoSeconds(m.createdAt),
      author: author(m.author),
      body: m.body,
    };
    if (m.round !== undefined) j.round = m.round;
    if (m.status !== undefined) j.status = m.status;
    if (m.severity !== undefined) j.severity = m.severity;
    return j;
  });
  return out;
}
