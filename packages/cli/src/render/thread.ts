// Human and JSON renderings of threads (docs/spec/cli.md § Thread object,
// § Human-readable output). Pure: callers pass in everything, including the
// colour switch and the width, so the layout is testable byte for byte.
import type { AnchorResult, MessageView, Severity, ThreadView } from '../../../core/src/index.js';
import { paint, ruleWidth, type Style } from '../term.js';

export interface ThreadItem {
  view: ThreadView;
  /** The handle (ADR 0007). */
  shortId: string;
  anchor: AnchorResult;
}

export interface Snippet {
  /** `working tree` or `snapshot <sha>`. */
  label: string;
  /** Line number of `lines[0]`. */
  first: number;
  /** Anchored (highlighted) range, inclusive. */
  hi: [number, number];
  lines: string[];
}

export interface ShowDetails {
  /** Anchor note shown with `!` when the anchor is not current. */
  note?: string;
  snippet?: Snippet;
}

/** ISO-8601 UTC without milliseconds, as in the thread object. */
export const isoTime = (d: Date): string => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

/** `YYYY-MM-DD HH:MM`, UTC (the clock the IDs use). */
export const shortTime = (d: Date): string => isoTime(d).slice(0, 16).replace('T', ' ');

function lineRange(start: number, end: number): string {
  return end > start ? `${start}-${end}` : `${start}`;
}

/** Ready-to-print location: `path:line[-end]`, `path (file)`, with ` (old)` for the old side. */
export function locationOf(view: ThreadView, anchor: AnchorResult): string {
  const a = view.anchor;
  if (a.kind === 'file') return `${anchor.path} (file)`;
  const start = anchor.startLine ?? a.startLine;
  const end = anchor.endLine ?? a.endLine;
  return `${anchor.path}:${lineRange(start, end)}${a.side === 'old' ? ' (old)' : ''}`;
}

/** The thread object of docs/spec/cli.md § JSON output. */
export function threadJson(item: ThreadItem): Record<string, unknown> {
  const { view, anchor } = item;
  const a = view.anchor;
  const anchorJson: Record<string, unknown> = {
    path: anchor.path,
    kind: a.kind,
    side: a.side,
  };
  if (anchor.startLine !== undefined) anchorJson.startLine = anchor.startLine;
  if (anchor.endLine !== undefined) anchorJson.endLine = anchor.endLine;
  anchorJson.state = anchor.state;
  anchorJson.method = anchor.method;
  return {
    id: view.id,
    shortId: item.shortId,
    isDraft: view.isDraft,
    status: view.status,
    severity: view.severity,
    whoseTurn: view.whoseTurn,
    reviewer: view.reviewer,
    createdAt: isoTime(view.createdAt),
    location: locationOf(view, anchor),
    anchor: anchorJson,
    messageCount: view.messages.length,
  };
}

function messageJson(m: MessageView): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: m.id,
    createdAt: isoTime(m.createdAt),
    author: m.author,
    body: m.body,
  };
  if (m.round !== undefined) out.round = m.round;
  if (m.status !== undefined) out.status = m.status;
  if (m.severity !== undefined) out.severity = m.severity;
  if (m.isDraft) out.isDraft = true;
  return out;
}

/** The thread object plus what `thread show` adds. */
export function threadShowJson(item: ThreadItem): Record<string, unknown> {
  const { view, anchor } = item;
  const out = threadJson(item);
  if (view.snapshot !== undefined) out.snapshot = view.snapshot;
  if (view.anchor.kind === 'line' && anchor.state !== 'current') {
    out.savedStartLine = view.anchor.startLine;
    out.savedEndLine = view.anchor.endLine;
  }
  out.messages = view.messages.map(messageJson);
  return out;
}

// ---- helpers

const trunc = (s: string, n: number): string =>
  s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s;

/** Wraps at `w` on spaces; lines that already fit are kept as they are (indentation survives). */
export function wrap(text: string, w: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    if (para.length <= w) {
      out.push(para);
      continue;
    }
    const indent = /^ */.exec(para)![0];
    let line = '';
    for (const word of para.slice(indent.length).split(' ')) {
      if (line && indent.length + `${line} ${word}`.length > w) {
        out.push(indent + line);
        line = word;
      } else line = line ? `${line} ${word}` : word;
    }
    out.push(indent + line);
  }
  return out;
}

const SEVERITY_STYLE: Record<Severity, Style[]> = {
  critical: ['bold', 'red'],
  high: ['red'],
  medium: ['yellow'],
  low: ['dim'],
};
const TURN_STYLE = { agent: 'cyan', human: 'magenta' } as const;

export interface RenderOptions {
  color: boolean;
  width: number;
}

/** Fixed-width cell: styled text followed by padding to `width`. */
function cell(color: boolean, text: string, width: number, ...styles: Style[]): string {
  return paint(color, text, ...styles) + ' '.repeat(Math.max(0, width - text.length));
}

function anchorMarker(a: AnchorResult): { text: string; style: Style } | undefined {
  if (a.state === 'outdated') return { text: 'moved', style: 'yellow' };
  if (a.state === 'orphaned') return { text: 'orphaned', style: 'red' };
  return undefined;
}

function turnCell(item: ThreadItem): { text: string; style: Style } {
  if (item.view.isDraft) return { text: 'draft', style: 'yellow' };
  return { text: item.view.whoseTurn, style: TURN_STYLE[item.view.whoseTurn] };
}

export interface ListSummary {
  /** `open`, `resolved` or `all`. */
  status: string;
  turn?: string;
  path?: string;
  round?: string;
}

function summaryLine(count: number, f: ListSummary): string {
  const things = count === 1 ? 'thread' : 'threads';
  const subject = f.status === 'all' ? `${count} ${things}` : `${count} ${f.status} ${things}`;
  const parts = [`status: ${f.status}`];
  if (f.turn) parts.push(`turn: ${f.turn}`);
  if (f.path) parts.push(`path: ${f.path}`);
  if (f.round) parts.push(`round: ${f.round}`);
  const widen = f.status === 'all' ? '' : '; --status all to widen';
  return `${subject} (${parts.join(', ')}${widen})`;
}

export function renderList(items: ThreadItem[], filter: ListSummary, o: RenderOptions): string {
  const { color, width } = o;
  const out: string[] = [paint(color, summaryLine(items.length, filter), 'dim')];
  if (items.length === 0) return `${out.join('\n')}\n`;
  out.push('');
  if (width >= 80) {
    const idW = Math.max(...items.map((i) => i.shortId.length)) + 2;
    const locW = Math.max(20, width - idW - 10 - 7 - 10 - 5);
    out.push(
      paint(
        color,
        `${'ID'.padEnd(idW)}${'SEV'.padEnd(10)}${'TURN'.padEnd(7)}${'LOCATION'.padEnd(locW)}${'ANCHOR'.padEnd(10)}MSGS`,
        'dim',
      ),
    );
    for (const item of items) {
      const turn = turnCell(item);
      const marker = anchorMarker(item.anchor);
      const loc = trunc(locationOf(item.view, item.anchor), locW - 1);
      out.push(
        cell(color, item.shortId, idW, 'bold') +
          cell(color, item.view.severity, 10, ...SEVERITY_STYLE[item.view.severity]) +
          cell(color, turn.text, 7, turn.style) +
          cell(color, loc, locW) +
          cell(color, marker?.text ?? '', 10, ...(marker ? [marker.style] : [])) +
          String(item.view.messages.length),
      );
    }
  } else {
    for (const item of items) {
      const turn = turnCell(item);
      const marker = anchorMarker(item.anchor);
      const bits = [
        paint(color, item.shortId, 'bold'),
        paint(color, item.view.severity, ...SEVERITY_STYLE[item.view.severity]),
        paint(color, turn.text, turn.style),
      ];
      if (marker) bits.push(paint(color, marker.text, marker.style));
      out.push(bits.join('  '));
      out.push(`  ${trunc(locationOf(item.view, item.anchor), width - 2)}`);
    }
  }
  out.push('');
  out.push(paint(color, 'lhr thread show <id>   (the handle in the ID column is enough)', 'dim'));
  return `${out.join('\n')}\n`;
}

export function renderShow(item: ThreadItem, details: ShowDetails, o: RenderOptions): string {
  const { color, width } = o;
  const { view, shortId, anchor } = item;
  const rule = paint(color, '─'.repeat(ruleWidth(width)), 'dim');
  const out: string[] = [];

  const at = view.id.length - 6;
  const handleEnd = at + shortId.length;
  const id =
    paint(color, view.id.slice(0, at), 'dim') +
    paint(color, shortId, 'bold') +
    paint(color, view.id.slice(handleEnd), 'dim');
  const status = view.isDraft
    ? paint(color, 'draft', 'yellow')
    : view.status === 'open'
      ? paint(color, 'open', 'green')
      : paint(color, 'resolved', 'dim');
  out.push(
    `${id}  ${status}  ${paint(color, view.severity, ...SEVERITY_STYLE[view.severity])}  ` +
      `${paint(color, 'turn:', 'dim')} ${paint(color, view.whoseTurn, TURN_STYLE[view.whoseTurn])}  ` +
      `${paint(color, 'reviewer:', 'dim')} ${view.reviewer.name}`,
  );
  out.push(paint(color, locationOf(view, anchor), 'bold'));
  if (details.note) {
    const style: Style = anchor.state === 'orphaned' ? 'red' : 'yellow';
    for (const l of wrap(details.note, width - 2)) out.push(paint(color, `! ${l}`, style));
  }
  out.push(rule);

  const s = details.snippet;
  if (s) {
    const gw = String(s.first + s.lines.length - 1).length;
    out.push(paint(color, `  ${s.label}`, 'dim'));
    s.lines.forEach((ln, i) => {
      const n = s.first + i;
      const hit = n >= s.hi[0] && n <= s.hi[1];
      const text = trunc(ln.trimEnd(), width - gw - 5);
      const gutter = `${hit ? paint(color, '>', 'bold') : ' '} ${paint(color, String(n).padStart(gw), 'dim')}`;
      const bar = paint(color, text === '' ? ' │' : ' │ ', 'dim');
      out.push(gutter + bar + (hit ? paint(color, text, 'bold') : paint(color, text, 'dim')));
    });
    out.push(rule);
  }

  for (const m of view.messages) {
    const meta = [m.round, m.severity && `severity: ${m.severity}`].filter(Boolean).join(', ');
    out.push(
      `${paint(color, `${m.author.name} (${m.author.kind})`, 'bold')}  ` +
        paint(color, shortTime(m.createdAt), 'dim') +
        (m.isDraft ? ` ${paint(color, '[draft]', 'yellow')}` : '') +
        (meta ? `  ${paint(color, meta, 'dim')}` : ''),
    );
    const body = m.body.trim();
    if (body) for (const l of wrap(body, width - 2)) out.push(`  ${l}`.trimEnd());
    out.push('');
  }
  out.push(
    paint(color, `lhr thread reply ${shortId} -   |   lhr thread resolve ${shortId}`, 'dim'),
  );
  return `${out.join('\n')}\n`;
}
