// `lhr inbox` (docs/spec/cli.md § lhr inbox). The thread object and the text
// table are exported as one unit so `thread list` can share the layout.
import type { AnchorResult, ThreadView } from '../../../core/src/index.js';
import type { Command } from '../commands.js';
import { paint, termWidth, useColor, type Style } from '../term.js';

const SHORT_MIN = 4;
const SHORT_MAX = 6;

/** Handles per ADR 0007: 4+ characters of the random part, grown until unique. */
export function shortIds(all: string[]): Map<string, string> {
  const random = (id: string): string => id.slice(id.lastIndexOf('-') + 1);
  const out = new Map<string, string>();
  for (const id of all) {
    let n = SHORT_MIN;
    while (
      n < SHORT_MAX &&
      all.some((o) => o !== id && random(o).slice(0, n) === random(id).slice(0, n))
    ) {
      n++;
    }
    out.set(id, random(id).slice(0, n));
  }
  return out;
}

export function locationOf(
  thread: ThreadView,
  anchor: Pick<AnchorResult, 'path' | 'startLine' | 'endLine'>,
): string {
  const old = thread.anchor.side === 'old' ? ' (old)' : '';
  if (thread.anchor.kind === 'file') return `${anchor.path} (file)${old}`;
  const { startLine, endLine } = anchor;
  if (startLine === undefined) return `${anchor.path}${old}`;
  const range =
    endLine !== undefined && endLine !== startLine ? `${startLine}-${endLine}` : startLine;
  return `${anchor.path}:${range}${old}`;
}

/** The spec's Thread object without message bodies (the `thread list` shape). */
export function threadObject(
  thread: ThreadView,
  shortId: string,
  anchor: AnchorResult,
): Record<string, unknown> {
  return {
    id: thread.id,
    shortId,
    isDraft: thread.isDraft,
    status: thread.status,
    severity: thread.severity,
    whoseTurn: thread.whoseTurn,
    reviewer: thread.reviewer,
    createdAt: thread.createdAt.toISOString(),
    location: locationOf(thread, anchor),
    anchor: {
      path: anchor.path,
      kind: thread.anchor.kind,
      side: thread.anchor.side,
      ...(anchor.startLine !== undefined && { startLine: anchor.startLine }),
      ...(anchor.endLine !== undefined && { endLine: anchor.endLine }),
      state: anchor.state,
      method: anchor.method,
    },
    messageCount: thread.messages.length,
  };
}

const SEVERITY_STYLE: Record<string, Style[]> = {
  critical: ['bold', 'red'],
  high: ['red'],
  medium: ['yellow'],
  low: ['dim'],
};

/** Plain table (wide layout only): ID, SEV, TURN, LOCATION, ANCHOR, MSGS. */
export function renderThreadTable(threads: Record<string, unknown>[], color: boolean): string {
  const idw = Math.max(2, ...threads.map((t) => String(t.shortId).length));
  const locw = Math.max(20, termWidth() - (idw + 2) - 10 - 7 - 10 - 5);
  const pad = (s: string, w: number): string => s + ' '.repeat(Math.max(0, w - s.length));
  const cut = (s: string, w: number): string => (s.length > w ? `${s.slice(0, w - 1)}…` : s);
  const header = `${pad('ID', idw)}  ${pad('SEV', 10)}${pad('TURN', 7)}${pad('LOCATION', locw)}${pad('ANCHOR', 10)}MSGS`;
  const rows = [paint(color, header, 'dim')];
  for (const t of threads) {
    const state = (t.anchor as { state: string }).state;
    const marker = state === 'outdated' ? 'moved' : state === 'orphaned' ? 'orphaned' : '';
    const turn = t.isDraft ? 'draft' : String(t.whoseTurn);
    const turnStyle: Style = t.isDraft ? 'yellow' : t.whoseTurn === 'agent' ? 'cyan' : 'magenta';
    rows.push(
      [
        paint(color, pad(String(t.shortId), idw), 'bold'),
        '  ',
        paint(color, pad(String(t.severity), 10), ...(SEVERITY_STYLE[String(t.severity)] ?? [])),
        paint(color, pad(turn, 7), turnStyle),
        pad(cut(String(t.location), locw), locw),
        paint(color, pad(marker, 10), marker === 'orphaned' ? 'red' : 'yellow'),
        String(t.messageCount),
      ].join(''),
    );
  }
  return rows.join('\n');
}

export const inbox: Command = {
  options: { 'all-sessions': { type: 'boolean' } },
  async run(ctx) {
    const tree = await ctx.tree();
    const snapshot = await tree.load();
    const scoped = ctx.identity.mode === 'agent' && ctx.values['all-sessions'] !== true;
    const session = scoped ? ctx.identity.session : undefined;
    const threads = snapshot.inbox(session === undefined ? undefined : { session });
    const anchors = await tree.anchors(threads);
    const handles = shortIds(snapshot.threads({ includeDrafts: true }).map((t) => t.id));
    const objects = threads.map((t) =>
      threadObject(t, handles.get(t.id) ?? t.id.slice(-SHORT_MIN), anchors.get(t.id)!),
    );

    const problems = [...snapshot.problems];
    if (!ctx.json && problems.length > 0) {
      process.stderr.write(
        `${problems.length} problem${problems.length === 1 ? '' : 's'} skipped; run lhr check\n`,
      );
    }
    const n = objects.length;
    const headline = `${n} thread${n === 1 ? '' : 's'} in the inbox\n`;
    const color = useColor(process.stdout);
    const hint = 'lhr thread show <id>   (the handle in the ID column is enough)';
    const text =
      n === 0
        ? headline
        : `${headline}\n${renderThreadTable(objects, color)}\n\n${paint(color, hint, 'dim')}\n`;
    ctx.succeed({ threads: objects }, { text, diagnostics: problems });
  },
};
