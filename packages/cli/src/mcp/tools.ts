// The seven `lhr mcp` tools (docs/spec/mcp.md § Tools): zod inputs, output
// schemas, annotations and thin handlers over core.
import { z } from 'zod';
import type {
  AnchorInput,
  Author,
  Diagnostic,
  LhrTree,
  ThreadView,
  TreeSnapshot,
} from '../../../core/src/index.js';
import { CliError } from '../errors.js';
import { resolveThreadId, shortIds } from '../handles.js';
import { threadJson, threadShowJson, type ThreadItem } from '../render/thread.js';

export interface ToolContext {
  /** Resolves the review root for this call and returns its (cached) tree. */
  open(): Promise<{ root: string; tree: LhrTree }>;
  author(): Author;
  /** The server's session, if any; scopes `inbox`. */
  session?: string;
}

export interface ToolOutput {
  root: string;
  data: Record<string, unknown>;
  diagnostics: readonly Diagnostic[];
}

export interface ToolDef {
  name: string;
  description: string;
  input: z.ZodObject;
  output: z.ZodType;
  annotations: {
    readOnlyHint: boolean;
    idempotentHint?: boolean;
    destructiveHint: false;
    openWorldHint: false;
  };
  /** A correct call for this tool, shown on INVALID_INPUT. */
  example(details: { threadId?: string; path?: string }): Record<string, unknown>;
  run(ctx: ToolContext, args: never): Promise<ToolOutput>;
}

// ---- Output schemas (loose objects: additive fields don't break clients)

const authorZ = z.looseObject({
  kind: z.enum(['human', 'agent']),
  name: z.string(),
  session: z.string().optional(),
  githubLogin: z.string().optional(),
});
const threadZ = z.looseObject({
  id: z.string(),
  shortId: z.string(),
  isDraft: z.boolean(),
  status: z.enum(['open', 'resolved']),
  severity: z.enum(['critical', 'high', 'medium', 'low']),
  whoseTurn: z.enum(['human', 'agent']),
  reviewer: authorZ,
  createdAt: z.string(),
  location: z.string(),
  anchor: z.looseObject({
    path: z.string(),
    kind: z.enum(['line', 'file']),
    side: z.enum(['new', 'old']),
    startLine: z.number().int().optional(),
    endLine: z.number().int().optional(),
    state: z.enum(['current', 'outdated', 'orphaned']),
    method: z.string(),
  }),
  messageCount: z.number().int(),
});
const threadShowZ = threadZ.extend({
  snapshot: z.string().optional(),
  savedStartLine: z.number().int().optional(),
  savedEndLine: z.number().int().optional(),
  messages: z.array(
    z.looseObject({
      id: z.string(),
      createdAt: z.string(),
      author: authorZ,
      body: z.string(),
      round: z.string().optional(),
      status: z.enum(['open', 'resolved']).optional(),
      severity: z.enum(['critical', 'high', 'medium', 'low']).optional(),
    }),
  ),
});
const diagnosticZ = z.looseObject({
  severity: z.enum(['error', 'warning']),
  code: z.string(),
  path: z.string(),
  line: z.number().int().optional(),
  message: z.string(),
});
const envelope = (data: z.ZodRawShape) =>
  z.object({
    version: z.number().int(),
    data: z.looseObject({ root: z.string(), ...data }),
    diagnostics: z.array(diagnosticZ),
  });

const listOut = envelope({ threads: z.array(threadZ) });
const showOut = envelope({ thread: threadShowZ });
const writeOut = envelope({
  thread: threadZ,
  message: z.object({ id: z.string() }),
  created: z.boolean(),
});
const statusOut = envelope({
  thread: threadZ,
  message: z.object({ id: z.string() }).optional(),
  created: z.boolean(),
  changed: z.boolean(),
});

// ---- Input schemas

const severity = z.enum(['critical', 'high', 'medium', 'low']);
const id = z.string().min(1);
const body = z.string().min(1);

const inboxIn = z.object({ allSessions: z.boolean().optional() }).strict();
const listIn = z
  .object({
    status: z.enum(['open', 'resolved', 'all']).default('open'),
    whoseTurn: z.enum(['human', 'agent']).optional(),
    path: z.string().optional(),
    round: z.string().optional(),
  })
  .strict();
const showIn = z.object({ id }).strict();
const createIn = z
  .object({
    path: z.string().min(1),
    line: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
    side: z.enum(['new', 'old']).optional(),
    baseCommit: z.string().optional(),
    body,
    severity: severity.optional(),
    clientId: z.string().min(1).optional(),
  })
  .strict();
const replyIn = z.object({ id, body, clientId: z.string().min(1).optional() }).strict();
const statusIn = z.object({ id, body: body.optional() }).strict();

// ---- Shared helpers

const READ = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
} as const;
const write = (idempotentHint: boolean) =>
  ({ readOnlyHint: false, idempotentHint, destructiveHint: false, openWorldHint: false }) as const;

const EXAMPLE_ID = 'k3m9';

// Agents never see drafts, so handles and ID resolution use submitted threads only
// (`snap.threads()` without `includeDrafts`), as the CLI does in agent mode.

/** A full ID, a prefix of one, or a handle -> one submitted thread (ADR 0007). */
function resolveThread(snap: TreeSnapshot, input: string): ThreadView {
  const id = resolveThreadId(
    snap.threads().map((t) => t.id),
    input,
    { see: 'thread_list' },
  );
  return snap.thread(id)!;
}

/** Thread items for `threads`, re-anchored against the code on disk. */
async function items(tree: LhrTree, snap: TreeSnapshot, threads: ThreadView[]) {
  const at = await tree.anchors(threads);
  const h = shortIds(snap.threads().map((t) => t.id));
  return threads.map((view): ThreadItem => ({
    view,
    shortId: h.get(view.id)!,
    anchor: at.get(view.id)!,
  }));
}

/** List-shaped thread objects, the CLI's serializer (cli.md § Thread object). */
const listed = async (tree: LhrTree, snap: TreeSnapshot, threads: ThreadView[]) =>
  (await items(tree, snap, threads)).map(threadJson);

/** Reloads after a write so the returned thread reflects it. */
async function written(tree: LhrTree, threadId: string) {
  const snap = await tree.load();
  const t = snap.thread(threadId);
  if (!t) throw new CliError('THREAD_NOT_FOUND', `no thread matches "${threadId}"`);
  return (await listed(tree, snap, [t]))[0];
}

type In<S extends z.ZodType> = z.output<S>;

async function setStatus(
  ctx: ToolContext,
  args: In<typeof statusIn>,
  status: 'open' | 'resolved',
): Promise<ToolOutput> {
  const { root, tree } = await ctx.open();
  const snap = await tree.load();
  const t = resolveThread(snap, args.id);
  const author = ctx.author();
  const data: Record<string, unknown> = {};
  if (args.body !== undefined) {
    const r = await tree.reply(t.id, { body: args.body, author, status });
    Object.assign(data, { message: { id: r.messageId }, created: r.created });
    data.changed = t.status !== status;
  } else {
    const r =
      status === 'resolved' ? await tree.resolve(t.id, author) : await tree.reopen(t.id, author);
    if (r.messageId !== undefined) data.message = { id: r.messageId };
    Object.assign(data, { created: r.changed, changed: r.changed });
  }
  const thread = await written(tree, t.id);
  return { root, data: { thread, ...data }, diagnostics: snap.problems };
}

const invalid = (message: string, path: string) =>
  new CliError('INVALID_INPUT', message, { details: { path } });

/** Checks the anchor arguments the schema can't express; returns core's AnchorInput. */
function anchorInput(a: In<typeof createIn>): AnchorInput {
  if (a.line === undefined) {
    for (const k of ['endLine', 'side', 'baseCommit'] as const) {
      if (a[k] !== undefined)
        throw invalid(`${k} needs line (file threads take only path)`, a.path);
    }
    return { path: a.path, kind: 'file' };
  }
  if (a.endLine !== undefined && a.endLine < a.line) {
    throw invalid(`endLine ${a.endLine} is before line ${a.line}`, a.path);
  }
  if (a.side === 'old' && !a.baseCommit) throw invalid('side "old" needs baseCommit', a.path);
  const anchor: AnchorInput = {
    path: a.path,
    kind: 'line',
    startLine: a.line,
    endLine: a.endLine ?? a.line,
  };
  if (a.side !== undefined) anchor.side = a.side;
  if (a.baseCommit !== undefined) anchor.baseCommit = a.baseCommit;
  return anchor;
}

// ---- Tools

export const TOOLS: ToolDef[] = [
  {
    name: 'inbox',
    description:
      'Start here. Lists open review threads waiting for your reply. A thread leaves the inbox ' +
      'when an agent replies in it, not when it is read. By default only threads for your own ' +
      'session (plus threads no agent has answered yet) are shown; pass allSessions to see all.',
    input: inboxIn,
    output: listOut,
    annotations: READ,
    example: () => ({ allSessions: true }),
    async run(ctx, args: In<typeof inboxIn>) {
      const { root, tree } = await ctx.open();
      const snap = await tree.load();
      const session = args.allSessions ? undefined : ctx.session;
      const threads = snap.inbox(session === undefined ? {} : { session });
      return {
        root,
        data: { threads: await listed(tree, snap, threads) },
        diagnostics: snap.problems,
      };
    },
  },
  {
    name: 'thread_list',
    description:
      'List review threads without message bodies. Use thread_show for the conversation. ' +
      'Defaults to open threads. Drafts are never listed.',
    input: listIn,
    output: listOut,
    annotations: READ,
    example: () => ({ status: 'open' }),
    async run(ctx, args: In<typeof listIn>) {
      const { root, tree } = await ctx.open();
      const snap = await tree.load();
      const threads = snap.threads({
        ...(args.status === 'all' ? {} : { status: args.status }),
        ...(args.whoseTurn ? { whoseTurn: args.whoseTurn } : {}),
        ...(args.path !== undefined ? { path: args.path } : {}),
        ...(args.round !== undefined ? { round: args.round } : {}),
      });
      return {
        root,
        data: { threads: await listed(tree, snap, threads) },
        diagnostics: snap.problems,
      };
    },
  },
  {
    name: 'thread_show',
    description:
      'Show one thread: every message, the code snapshot it was written against, and where ' +
      'that code is now (location and anchor state: current, outdated or orphaned). `id` may ' +
      'be a full ID, a prefix, or the short handle shown by thread_list.',
    input: showIn,
    output: showOut,
    annotations: READ,
    example: (d) => ({ id: d.threadId ?? EXAMPLE_ID }),
    async run(ctx, args: In<typeof showIn>) {
      const { root, tree } = await ctx.open();
      const snap = await tree.load();
      const t = resolveThread(snap, args.id);
      const thread = threadShowJson((await items(tree, snap, [t]))[0]);
      return { root, data: { thread }, diagnostics: snap.problems };
    },
  },
  {
    name: 'thread_create',
    description:
      'Open a new thread on a file or line when you need a human decision. Omit `line` for a ' +
      'file-level thread. Always pass a `clientId` (any unique string) so a retried call does ' +
      'not create a duplicate. Use side `old` with `baseCommit` only to comment on deleted code.',
    input: createIn,
    output: writeOut,
    annotations: write(false),
    example: (d) => ({
      path: d.path ?? 'src/app.ts',
      line: 1,
      body: 'Should this handle the empty case?',
      clientId: 'question-1',
    }),
    async run(ctx, args: In<typeof createIn>) {
      const anchor = anchorInput(args);
      const { root, tree } = await ctx.open();
      const snap = await tree.load();
      const r = await tree.createThread({
        anchor,
        body: args.body,
        author: ctx.author(),
        ...(args.severity ? { severity: args.severity } : {}),
        ...(args.clientId ? { clientId: args.clientId } : {}),
      });
      const thread = await written(tree, r.threadId);
      return {
        root,
        data: { thread, message: { id: r.messageId }, created: r.created },
        diagnostics: snap.problems,
      };
    },
  },
  {
    name: 'thread_reply',
    description:
      'Reply to a thread as the agent. Pass a `clientId` so a retry is safe. Replying passes ' +
      'the turn to the human. To also close the thread, use thread_resolve with a body.',
    input: replyIn,
    output: writeOut,
    annotations: write(false),
    example: (d) => ({
      id: d.threadId ?? EXAMPLE_ID,
      body: 'Fixed in 3f2a9c1.',
      clientId: 'reply-1',
    }),
    async run(ctx, args: In<typeof replyIn>) {
      const { root, tree } = await ctx.open();
      const snap = await tree.load();
      const t = resolveThread(snap, args.id);
      const r = await tree.reply(t.id, {
        body: args.body,
        author: ctx.author(),
        ...(args.clientId ? { clientId: args.clientId } : {}),
      });
      const thread = await written(tree, t.id);
      return {
        root,
        data: { thread, message: { id: r.messageId }, created: r.created },
        diagnostics: snap.problems,
      };
    },
  },
  {
    name: 'thread_resolve',
    description:
      'Mark a thread resolved. With `body`, posts that text as a reply and resolves in one ' +
      'step. Resolving an already resolved thread succeeds and does nothing.',
    input: statusIn,
    output: statusOut,
    annotations: write(true),
    example: (d) => ({ id: d.threadId ?? EXAMPLE_ID }),
    run: (ctx, args: In<typeof statusIn>) => setStatus(ctx, args, 'resolved'),
  },
  {
    name: 'thread_reopen',
    description:
      'Reopen a resolved thread. With `body`, posts that text and reopens in one step. ' +
      'Reopening an open thread succeeds and does nothing.',
    input: statusIn,
    output: statusOut,
    annotations: write(true),
    example: (d) => ({ id: d.threadId ?? EXAMPLE_ID }),
    run: (ctx, args: In<typeof statusIn>) => setStatus(ctx, args, 'open'),
  },
];
