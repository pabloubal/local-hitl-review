// thread create / reply / resolve / reopen (docs/spec/cli.md § thread create,
// reply, resolve and reopen). Agent mode writes immediately; human mode writes
// drafts for anything carrying a body.
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve as resolvePath, sep } from 'node:path';
import { LhrError, type Severity, type ThreadStatus } from '../../../core/src/index.js';
import type { Command, CommandContext } from '../commands.js';
import { readStdin } from '../context.js';
import { usageError } from '../errors.js';
import { resolveThreadId } from '../handles.js';

const SEVERITIES = ['critical', 'high', 'medium', 'low'];
const DRAFT_TEXT = 'draft saved; run lhr review submit to send it\n';

/** Resolves a handle, full ID or prefix among the threads this identity can see. */
export async function resolveThread(ctx: CommandContext, input: string): Promise<string> {
  const snapshot = await (await ctx.tree()).load();
  const ids = snapshot.threads({ includeDrafts: ctx.identity.mode === 'human' }).map((t) => t.id);
  return resolveThreadId(ids, input, {
    see: ctx.see,
    example: (id) => `lhr ${ctx.path.join(' ')} ${id}`,
  });
}

function str(ctx: CommandContext, key: string): string | undefined {
  const v = ctx.values[key];
  return typeof v === 'string' ? v : undefined;
}

/** Body from `--body` or `-` (stdin); undefined when neither is given. */
async function readBody(ctx: CommandContext): Promise<string | undefined> {
  const flag = str(ctx, 'body');
  const dash = ctx.args.includes('-');
  if (flag !== undefined && dash) {
    throw usageError('give the body with --body or - (stdin), not both', ctx.see);
  }
  const body = dash ? await readStdin(ctx.see) : flag;
  if (body !== undefined && body.trim() === '') throw usageError('the body is empty', ctx.see);
  return body;
}

function positionals(ctx: CommandContext, max: number): string[] {
  const words = ctx.args.filter((a) => a !== '-');
  if (words.length > max) throw usageError(`unexpected argument ${words[max]}`, ctx.see);
  return words;
}

function severity(ctx: CommandContext): Severity | undefined {
  const s = str(ctx, 'severity');
  if (s !== undefined && !SEVERITIES.includes(s)) {
    throw usageError(`--severity must be critical, high, medium or low, got "${s}"`, ctx.see);
  }
  return s as Severity | undefined;
}

function rejectClientIdInHumanMode(ctx: CommandContext): void {
  if (ctx.identity.mode === 'human' && str(ctx, 'client-id') !== undefined) {
    throw usageError(
      '--client-id applies to immediate agent writes; human mode saves drafts, which have no idempotency key',
      ctx.see,
    );
  }
}

function intFlag(ctx: CommandContext, key: string): number | undefined {
  const v = str(ctx, key);
  if (v === undefined) return undefined;
  if (!/^\d+$/.test(v) || Number(v) < 1) {
    throw usageError(`--${key} must be an integer >= 1, got "${v}"`, ctx.see);
  }
  return Number(v);
}

/** cwd-relative (or absolute) path -> root-relative with `/` separators. */
function toRootRelative(ctx: CommandContext, p: string): string {
  let cwd = process.cwd();
  try {
    cwd = realpathSync(cwd);
  } catch {
    // keep the unresolved cwd
  }
  const rel = relative(ctx.root!, resolvePath(cwd, p));
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw usageError(`${p} is outside the review root ${ctx.root}`, ctx.see);
  }
  return rel.split(sep).join('/');
}

interface ParsedAnchor {
  path: string;
  startLine?: number;
  endLine?: number;
}

function parseAnchor(ctx: CommandContext, arg: string | undefined): ParsedAnchor {
  const flagPath = str(ctx, 'path');
  let file = flagPath;
  let startLine = intFlag(ctx, 'line');
  let endLine = intFlag(ctx, 'end-line');
  if (flagPath === undefined) {
    if (arg === undefined) {
      throw usageError('missing <path>', ctx.see, 'lhr thread create src/file.ts:10 --body "..."');
    }
    const m = /^(.*):(\d+)(?:-(\d+))?$/.exec(arg);
    file = m ? m[1] : arg;
    if (m) {
      startLine = Number(m[2]);
      if (m[3] !== undefined) endLine = Number(m[3]);
    }
  } else if (arg !== undefined) {
    throw usageError('give the path as <path> or --path, not both', ctx.see);
  }
  if (startLine !== undefined && startLine < 1) {
    throw usageError('line must be an integer >= 1', ctx.see);
  }
  if (endLine !== undefined && startLine === undefined) {
    throw usageError('--end-line needs --line', ctx.see);
  }
  if (endLine !== undefined && startLine !== undefined && endLine < startLine) {
    throw usageError('end line must not be before the start line', ctx.see);
  }
  return { path: toRootRelative(ctx, file!), startLine, endLine };
}

const BODY_OPTIONS = { body: { type: 'string' } } as const;

const create: Command = {
  options: {
    ...BODY_OPTIONS,
    side: { type: 'string' },
    'base-commit': { type: 'string' },
    severity: { type: 'string' },
    'client-id': { type: 'string' },
    path: { type: 'string' },
    line: { type: 'string' },
    'end-line': { type: 'string' },
  },
  async run(ctx) {
    const [target] = positionals(ctx, 1);
    const body = await readBody(ctx);
    if (body === undefined) {
      throw usageError(
        'a body is required: use --body <text> or -',
        ctx.see,
        'lhr thread create src/file.ts:10 --body "..."',
      );
    }
    rejectClientIdInHumanMode(ctx);
    const anchor = parseAnchor(ctx, target);
    const sideArg = str(ctx, 'side') ?? 'new';
    if (sideArg !== 'new' && sideArg !== 'old') {
      throw usageError(`--side must be new or old, got "${sideArg}"`, ctx.see);
    }
    const side: 'new' | 'old' = sideArg;
    const baseCommit = str(ctx, 'base-commit');
    if (side === 'old' && !baseCommit) {
      throw usageError('--side old needs --base-commit <sha>', ctx.see);
    }
    const sev = severity(ctx);
    const clientId = str(ctx, 'client-id');
    const human = ctx.identity.mode === 'human';
    if (ctx.dryRun) {
      ctx.succeed(
        { dryRun: true, created: true, ...(human ? { draft: true } : {}) },
        {
          text: `dry run: would ${human ? 'save a draft thread' : 'create a thread'} on ${anchor.path}\n`,
        },
      );
      return;
    }
    const tree = await ctx.tree();
    const author = await ctx.author();
    const input = {
      anchor: {
        path: anchor.path,
        kind: anchor.startLine === undefined ? ('file' as const) : ('line' as const),
        side,
        ...(anchor.startLine !== undefined ? { startLine: anchor.startLine } : {}),
        ...(anchor.endLine !== undefined ? { endLine: anchor.endLine } : {}),
        ...(baseCommit ? { baseCommit } : {}),
      },
      body,
      author,
      ...(sev ? { severity: sev } : {}),
    };
    if (human) {
      const r = await tree.createDraftThread(input);
      ctx.succeed(
        { thread: { id: r.threadId }, message: { id: r.messageId }, created: true, draft: true },
        { text: `${DRAFT_TEXT}thread ${r.threadId}\n` },
      );
      return;
    }
    const r = await tree.createThread({ ...input, ...(clientId ? { clientId } : {}) });
    ctx.succeed(
      { thread: { id: r.threadId }, message: { id: r.messageId }, created: r.created },
      { text: `${r.created ? 'created' : 'exists'} thread ${r.threadId}\n` },
    );
  },
};

/** Shared by reply (no status) and resolve/reopen with a body. */
async function writeMessage(
  ctx: CommandContext,
  threadId: string,
  body: string,
  status?: ThreadStatus,
): Promise<void> {
  const tree = await ctx.tree();
  const author = await ctx.author();
  const sev = severity(ctx);
  const clientId = str(ctx, 'client-id');
  const extra = { ...(status ? { status } : {}), ...(sev ? { severity: sev } : {}) };
  if (ctx.identity.mode === 'human') {
    const r = await tree.addDraftMessage(threadId, { body, author, ...extra });
    ctx.succeed(
      { thread: { id: threadId }, message: { id: r.messageId }, created: true, draft: true },
      { text: `${DRAFT_TEXT}message ${r.messageId}\n` },
    );
    return;
  }
  const r = await tree.reply(threadId, {
    body,
    author,
    ...extra,
    ...(clientId ? { clientId } : {}),
  });
  ctx.succeed(
    {
      thread: { id: threadId },
      message: { id: r.messageId },
      created: r.created,
      ...(status ? { changed: r.created } : {}),
    },
    { text: `${r.created ? 'added' : 'exists'} message ${r.messageId}\n` },
  );
}

function dryRunReport(ctx: CommandContext, threadId: string, extra: Record<string, unknown>) {
  const human = ctx.identity.mode === 'human';
  ctx.succeed(
    { thread: { id: threadId }, dryRun: true, ...(human ? { draft: true } : {}), ...extra },
    { text: `dry run: nothing written (thread ${threadId})\n` },
  );
}

const reply: Command = {
  options: { ...BODY_OPTIONS, 'client-id': { type: 'string' }, severity: { type: 'string' } },
  async run(ctx) {
    const [idArg] = positionals(ctx, 1);
    if (idArg === undefined) throw usageError('missing <id>', ctx.see, 'lhr thread reply <id> -');
    const body = await readBody(ctx);
    if (body === undefined) {
      throw usageError(
        'a body is required: use --body <text> or -',
        ctx.see,
        `lhr thread reply ${idArg} -`,
      );
    }
    rejectClientIdInHumanMode(ctx);
    severity(ctx);
    const threadId = await resolveThread(ctx, idArg);
    if (ctx.dryRun) return dryRunReport(ctx, threadId, { created: true });
    await writeMessage(ctx, threadId, body);
  },
};

function statusCommand(status: ThreadStatus): Command {
  const verb = status === 'resolved' ? 'resolve' : 'reopen';
  return {
    options: BODY_OPTIONS,
    async run(ctx) {
      const [idArg] = positionals(ctx, 1);
      if (idArg === undefined) throw usageError('missing <id>', ctx.see, `lhr thread ${verb} <id>`);
      const body = await readBody(ctx);
      const threadId = await resolveThread(ctx, idArg);
      if (body !== undefined) {
        if (ctx.dryRun) return dryRunReport(ctx, threadId, { created: true });
        await writeMessage(ctx, threadId, body, status);
        return;
      }
      const tree = await ctx.tree();
      if (ctx.dryRun) {
        const t = (await tree.load()).thread(threadId);
        if (!t) throw new LhrError('THREAD_NOT_FOUND', `no thread ${threadId}`);
        const changed = t.status !== status;
        return dryRunReport(ctx, threadId, { created: changed, changed });
      }
      const author = await ctx.author();
      const r =
        status === 'resolved'
          ? await tree.resolve(threadId, author)
          : await tree.reopen(threadId, author);
      ctx.succeed(
        {
          thread: { id: threadId },
          ...(r.messageId ? { message: { id: r.messageId } } : {}),
          created: r.changed,
          changed: r.changed,
        },
        {
          text: r.changed
            ? `${status} thread ${threadId}\n`
            : `thread ${threadId} already ${status}\n`,
        },
      );
    },
  };
}

export const THREAD_WRITE_HANDLERS: Record<string, Command> = {
  'thread create': create,
  'thread reply': reply,
  'thread resolve': statusCommand('resolved'),
  'thread reopen': statusCommand('open'),
};
