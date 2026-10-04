// `lhr review submit` (docs/spec/cli.md § lhr review submit): submits every
// draft as one review round with a verdict (core `submitRound`). Humans only.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Command } from '../commands.js';
import { usageError } from '../errors.js';
import { readStdin } from '../context.js';

const VERDICTS = ['approve', 'comment', 'request-changes'] as const;
type Verdict = (typeof VERDICTS)[number];

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

export const reviewSubmit: Command = {
  options: {
    verdict: { type: 'string' },
    body: { type: 'string' },
    summary: { type: 'string' },
    'client-id': { type: 'string' },
  },
  async run(ctx) {
    const given = ctx.values.verdict as string | undefined;
    const withVerdict = `lhr review submit --verdict ${given ?? '<approve|comment|request-changes>'}`;

    if (ctx.identity.mode === 'agent') {
      throw usageError(
        'review submit is for human reviewers; agent mode cannot submit a round',
        ctx.see,
        `${withVerdict} --as human`,
      );
    }
    if (given === undefined) {
      throw usageError('missing --verdict', ctx.see, 'lhr review submit --verdict approve');
    }
    if (!(VERDICTS as readonly string[]).includes(given)) {
      throw usageError(
        `--verdict must be approve, comment or request-changes, got "${given}"`,
        ctx.see,
        'lhr review submit --verdict approve',
      );
    }
    const verdict = given as Verdict;

    const flagBody = (ctx.values.body ?? ctx.values.summary) as string | undefined;
    if (ctx.values.body !== undefined && ctx.values.summary !== undefined) {
      throw usageError('--body and --summary are the same flag; give one', ctx.see);
    }
    const fromStdin = ctx.args.includes('-');
    if (ctx.args.some((a) => a !== '-')) {
      throw usageError(`unexpected argument ${ctx.args.find((a) => a !== '-')}`, ctx.see);
    }
    if (fromStdin && flagBody !== undefined) {
      throw usageError('give the summary as - or --body, not both', ctx.see);
    }
    const clientId = ctx.values['client-id'] as string | undefined;
    if (clientId !== undefined && clientId.trim() === '') {
      throw usageError('--client-id must not be empty', ctx.see);
    }
    const summary = fromStdin ? await readStdin(ctx.see) : (flagBody ?? '');

    const tree = await ctx.tree();

    if (ctx.dryRun) {
      const snap = await tree.load();
      const known =
        clientId === undefined ? undefined : await roundWithClientId(ctx.root, clientId);
      if (known !== undefined) {
        // The real call would be a no-op returning this round untouched.
        const stored = snap.rounds().find((r) => r.id === known)?.verdict ?? verdict;
        const all = snap.threads();
        ctx.succeed(
          {
            dryRun: true,
            round: {
              id: known,
              verdict: stored,
              threadIds: all.filter((t) => t.messages[0]?.round === known).map((t) => t.id),
              messageIds: all.flatMap((t) =>
                t.messages.filter((m) => m.round === known).map((m) => m.id),
              ),
            },
            created: false,
            resumed: false,
            skippedDraftIds: [],
          },
          {
            text: `round already submitted ${known} (${stored}): a real run would change nothing (--client-id ${clientId} exists)\n`,
          },
        );
        return;
      }
      const threadIds: string[] = [];
      const messageIds: string[] = [];
      const skippedDraftIds: string[] = [];
      for (const t of snap.threads({ includeDrafts: true })) {
        let listed = false;
        for (const m of t.messages) {
          if (!t.isDraft && !m.isDraft) continue;
          messageIds.push(m.id);
          listed = true;
        }
        // Core lists only threads whose first message is in the round (new threads).
        if (listed && t.isDraft) threadIds.push(t.id);
      }
      // A draft message core cannot read (empty body, bad front matter) has no view; it
      // surfaces as a problem on its file, and a real submit would leave it in drafts/.
      for (const p of snap.problems) {
        const id = /(?:^|\/)\.lhr\/drafts\/threads\/[^/]+\/([^/]+)\.md$/.exec(p.path)?.[1];
        if (id !== undefined && p.severity === 'error' && !skippedDraftIds.includes(id)) {
          skippedDraftIds.push(id);
        }
      }
      skippedDraftIds.sort();
      const lines = [
        `would submit a round (${verdict}): ${plural(threadIds.length, 'thread')}, ${plural(messageIds.length, 'message')}`,
        ...threadIds.map((id) => `  thread ${id}`),
        ...messageIds.map((id) => `  message ${id}`),
        ...skippedLines(skippedDraftIds, 'would skip'),
      ];
      ctx.succeed(
        {
          dryRun: true,
          round: { verdict, threadIds, messageIds },
          created: true,
          resumed: false,
          skippedDraftIds,
        },
        { text: `${lines.join('\n')}\n` },
      );
      return;
    }

    const author = await ctx.author();
    const res = await tree.submitRound({
      verdict,
      summary,
      author,
      ...(clientId !== undefined ? { clientId } : {}),
    });
    // The stored round decides the verdict: an idempotent retry or a resume ignores the flag.
    const storedVerdict =
      (await tree.load()).rounds().find((r) => r.id === res.roundId)?.verdict ?? verdict;
    const head = res.resumed
      ? 'resumed round'
      : res.created
        ? 'submitted round'
        : 'round already submitted';
    const lines = [
      `${head} ${res.roundId} (${storedVerdict}): ${plural(res.threadIds.length, 'thread')}, ${plural(res.messageIds.length, 'message')}`,
      ...skippedLines(res.skippedDraftIds, 'skipped'),
    ];
    ctx.succeed(
      {
        round: {
          id: res.roundId,
          verdict: storedVerdict,
          threadIds: res.threadIds,
          messageIds: res.messageIds,
        },
        created: res.created,
        resumed: res.resumed,
        skippedDraftIds: res.skippedDraftIds,
      },
      { text: `${lines.join('\n')}\n` },
    );
  },
};

function skippedLines(ids: string[], verb: string): string[] {
  if (ids.length === 0) return [];
  return [
    `${verb} ${plural(ids.length, 'invalid draft')} (still in drafts/; fix or discard):`,
    ...ids.map((id) => `  message ${id}`),
  ];
}

/** The ID of the round file that stores `clientId`, if any (a read-only lookup for --dry-run). */
async function roundWithClientId(
  root: string | undefined,
  clientId: string,
): Promise<string | undefined> {
  if (root === undefined) return undefined;
  const dir = join(root, '.lhr', 'rounds');
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith('.md')).sort();
  } catch {
    return undefined;
  }
  for (const name of names) {
    const text = await readFile(join(dir, name), 'utf8').catch(() => '');
    const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? '';
    const m = /^clientId:\s*(.*)$/m.exec(front);
    if (m === null) continue;
    const raw = m[1].trim();
    let value = raw;
    try {
      value = raw.startsWith('"') ? (JSON.parse(raw) as string) : raw.replace(/^'(.*)'$/, '$1');
    } catch {
      // keep the raw text
    }
    if (value === clientId) return name.slice(0, -3);
  }
  return undefined;
}
