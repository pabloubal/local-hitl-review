// `lhr thread list` and `lhr thread show` (docs/spec/cli.md § thread list, § thread show).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ThreadFilter, ThreadStatus, ThreadView } from '../../../core/src/index.js';
import type { Command, CommandContext } from '../commands.js';
import { usageError } from '../errors.js';
import { resolveThreadId, shortIds } from '../handles.js';
import {
  renderList,
  renderShow,
  threadJson,
  threadShowJson,
  type ShowDetails,
  type Snippet,
  type ThreadItem,
} from '../render/thread.js';
import { termWidth, useColor } from '../term.js';

const CONTEXT_LINES = 2;
const SHA_LEN = 7;

const opt = (ctx: CommandContext, name: string): string | undefined => {
  const v = ctx.values[name];
  return typeof v === 'string' ? v : undefined;
};

/** Human mode includes drafts; agent mode never does (cli.md § Identity). */
async function visibleThreads(ctx: CommandContext) {
  const snap = await (await ctx.tree()).load();
  const includeDrafts = ctx.identity.mode === 'human';
  return { snap, includeDrafts, all: snap.threads({ includeDrafts }) };
}

async function toItems(
  ctx: CommandContext,
  views: ThreadView[],
  handles: Map<string, string>,
): Promise<ThreadItem[]> {
  const anchors = await (await ctx.tree()).anchors(views);
  return views.map((view) => ({
    view,
    shortId: handles.get(view.id)!,
    anchor: anchors.get(view.id)!,
  }));
}

function reportProblems(ctx: CommandContext, count: number): void {
  if (count > 0 && !ctx.json) {
    process.stderr.write(`${count} problem${count === 1 ? '' : 's'} skipped; run lhr check\n`);
  }
}

export const threadList: Command = {
  options: {
    status: { type: 'string' },
    'whose-turn': { type: 'string' },
    path: { type: 'string' },
    round: { type: 'string' },
  },
  async run(ctx) {
    if (ctx.args.length > 0) throw usageError('thread list takes no arguments', ctx.see);
    const status = opt(ctx, 'status') ?? 'open';
    if (status !== 'open' && status !== 'resolved' && status !== 'all') {
      throw usageError(
        `--status must be open, resolved or all, got "${status}"`,
        ctx.see,
        'lhr thread list --status all',
      );
    }
    const turn = opt(ctx, 'whose-turn');
    if (turn !== undefined && turn !== 'human' && turn !== 'agent') {
      throw usageError(
        `--whose-turn must be human or agent, got "${turn}"`,
        ctx.see,
        'lhr thread list --whose-turn agent',
      );
    }
    const path = opt(ctx, 'path');
    const round = opt(ctx, 'round');

    const { snap, includeDrafts, all } = await visibleThreads(ctx);
    const handles = shortIds(all.map((t) => t.id));
    const filter: ThreadFilter = { includeDrafts };
    if (status !== 'all') filter.status = status as ThreadStatus;
    if (turn) filter.whoseTurn = turn;
    if (path !== undefined) filter.path = path;
    if (round !== undefined) filter.round = round;
    const items = await toItems(ctx, snap.threads(filter), handles);

    reportProblems(ctx, snap.problems.length);
    ctx.succeed(
      { threads: items.map(threadJson) },
      {
        diagnostics: [...snap.problems],
        text: renderList(
          items,
          { status, turn, path, round },
          { color: useColor(process.stdout), width: termWidth() },
        ),
      },
    );
  },
};

export const threadShow: Command = {
  async run(ctx) {
    if (ctx.args.length !== 1) {
      throw usageError(
        'thread show takes one thread id or handle',
        ctx.see,
        'lhr thread show <id>',
      );
    }
    const { snap, all } = await visibleThreads(ctx);
    const id = resolveThreadId(
      all.map((t) => t.id),
      ctx.args[0],
      { see: ctx.see },
    );
    const handles = shortIds(all.map((t) => t.id));
    const [item] = await toItems(ctx, [all.find((t) => t.id === id)!], handles);

    reportProblems(ctx, snap.problems.length);
    ctx.succeed(
      { thread: threadShowJson(item) },
      {
        diagnostics: [...snap.problems],
        text: renderShow(item, await showDetails(ctx, item), {
          color: useColor(process.stdout),
          width: termWidth(),
        }),
      },
    );
  },
};

const lines = (start: number, end: number): string =>
  end > start ? `lines ${start}-${end}` : `line ${start}`;

async function showDetails(ctx: CommandContext, item: ThreadItem): Promise<ShowDetails> {
  const { view, anchor } = item;
  const a = view.anchor;
  const root = ctx.root!;
  const sha = a.commit.slice(0, SHA_LEN);
  const details: ShowDetails = {};

  if (a.kind === 'file') {
    if (anchor.state === 'orphaned') {
      details.note = anchor.diagnostic?.message ?? `orphaned: ${a.path} no longer exists at HEAD.`;
    }
    return details;
  }

  if (anchor.state === 'outdated' && anchor.startLine !== undefined) {
    const moved = anchor.path !== a.path ? `${anchor.path} ` : '';
    details.note = `anchor moved: saved at ${lines(a.startLine, a.endLine)}, now ${moved}${lines(anchor.startLine, anchor.endLine ?? anchor.startLine)} (${anchor.method}).`;
  } else if (anchor.state === 'orphaned') {
    const why =
      anchor.diagnostic?.message ??
      (existsSync(join(root, a.path))
        ? `orphaned: the anchored lines of ${a.path} can no longer be found at HEAD.`
        : `orphaned: ${a.path} no longer exists at HEAD.`);
    details.note = `${why} Showing the lines as they were when the comment was made (snapshot at ${sha}).`;
  }

  details.snippet = snippetFor(root, item, sha);
  return details;
}

function snippetFor(root: string, item: ThreadItem, sha: string): Snippet | undefined {
  const { view, anchor } = item;
  const a = view.anchor;
  if (a.kind !== 'line') return undefined;

  let source: { label: string; first: number; text: string[]; hi: [number, number] } | undefined;
  if (anchor.state !== 'orphaned' && a.side === 'new' && anchor.startLine !== undefined) {
    try {
      const text = readFileSync(join(root, anchor.path), 'utf8').split('\n');
      if (text[text.length - 1] === '') text.pop();
      source = {
        label: 'working tree',
        first: 1,
        text,
        hi: [anchor.startLine, anchor.endLine ?? anchor.startLine],
      };
    } catch {
      // unreadable: fall through to the snapshot
    }
  }
  if (!source && view.snapshot !== undefined) {
    source = {
      label: `snapshot ${sha}`,
      first: a.startLine - a.contextBefore,
      text: view.snapshot.split('\n'),
      hi: [a.startLine, a.endLine],
    };
  }
  if (!source) return undefined;

  const from = Math.max(source.first, source.hi[0] - CONTEXT_LINES);
  const to = Math.min(source.first + source.text.length - 1, source.hi[1] + CONTEXT_LINES);
  return {
    label: source.label,
    first: from,
    hi: source.hi,
    lines: source.text.slice(from - source.first, to - source.first + 1),
  };
}
