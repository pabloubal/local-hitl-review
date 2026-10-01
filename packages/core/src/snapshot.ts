import type {
  Author,
  MessageView,
  RoundView,
  ThreadRecord,
  ThreadView,
  TreeRecords,
  TreeSnapshot,
} from './model.js';

function freezeMessage(m: MessageView): MessageView {
  return Object.freeze({ ...m, author: Object.freeze({ ...m.author }) });
}

function byId<T extends { id: string }>(a: T, b: T): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Derive a frozen thread view from a record. Derived values come only from
 * the basis messages (non-draft for a submitted thread, all for a draft
 * thread); `includeDraftMessages` only controls which messages are listed.
 * Returns undefined when the record has no basis messages.
 */
export function deriveThread(
  record: ThreadRecord,
  includeDraftMessages: boolean,
): ThreadView | undefined {
  const basis = record.isDraft
    ? record.messages
    : record.messages.filter((m) => !m.isDraft);
  const first = basis[0];
  const last = basis[basis.length - 1];
  if (first === undefined || last === undefined) return undefined;

  let severity = record.severity ?? 'medium';
  for (let i = basis.length - 1; i >= 0; i--) {
    const s = basis[i]?.severity;
    if (s !== undefined) {
      severity = s;
      break;
    }
  }

  const listed = includeDraftMessages ? record.messages : basis;
  const view: ThreadView = {
    id: record.id,
    createdAt: record.createdAt,
    anchor: Object.freeze({ ...record.anchor }),
    ...(record.snapshot === undefined ? {} : { snapshot: record.snapshot }),
    messages: Object.freeze(listed.map(freezeMessage)) as MessageView[],
    isDraft: record.isDraft,
    status: last.status === 'resolved' ? 'resolved' : 'open',
    severity,
    whoseTurn: last.author.kind === 'human' ? 'agent' : 'human',
    reviewer: Object.freeze({ ...first.author }) as Author,
  };
  return Object.freeze(view);
}

/**
 * Pure: build an immutable snapshot from the reader's records.
 * Views are frozen except `createdAt` Date instances, which callers must not mutate.
 */
export function buildSnapshot(records: TreeRecords): TreeSnapshot {
  const submitted: ThreadView[] = [];
  const withDrafts: ThreadView[] = [];
  for (const rec of records.threads) {
    const visible = deriveThread(rec, false);
    const full = deriveThread(rec, true);
    if (visible && !rec.isDraft) submitted.push(visible);
    if (full) withDrafts.push(full);
  }
  submitted.sort(byId);
  withDrafts.sort(byId);
  const rounds = Object.freeze(
    records.rounds.map((r) =>
      Object.freeze({ ...r, author: Object.freeze({ ...r.author }) }),
    ),
  ) as RoundView[];
  const sortedRounds = rounds.slice().sort(byId);
  const submittedById = new Map(submitted.map((t) => [t.id, t]));
  const problems = Object.freeze([...records.problems]);

  return {
    problems,
    threads(filter = {}) {
      const source = filter.includeDrafts ? withDrafts : submitted;
      return source.filter(
        (t) =>
          (filter.status === undefined || t.status === filter.status) &&
          (filter.whoseTurn === undefined ||
            t.whoseTurn === filter.whoseTurn) &&
          (filter.path === undefined || t.anchor.path === filter.path) &&
          (filter.round === undefined ||
            t.messages.some((m) => m.round === filter.round)),
      );
    },
    /** Submitted threads only; draft threads are hidden (agents use this). */
    thread(id) {
      return submittedById.get(id);
    },
    rounds() {
      return sortedRounds.slice();
    },
    inbox(opts = {}) {
      return submitted.filter((t) => {
        if (t.status !== 'open' || t.whoseTurn !== 'agent') return false;
        if (opts.session === undefined) return true;
        const lastAgent = [...t.messages]
          .reverse()
          .find((m) => m.author.kind === 'agent');
        return (
          lastAgent === undefined || lastAgent.author.session === opts.session
        );
      });
    },
  };
}
