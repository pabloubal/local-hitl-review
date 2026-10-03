// `lhr review submit` (docs/spec/cli.md § lhr review submit): submits every
// draft as one review round with a verdict (core `submitRound`). Humans only.
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
      const threadIds: string[] = [];
      const messageIds: string[] = [];
      for (const t of snap.threads({ includeDrafts: true })) {
        const drafts = t.messages.filter((m) => t.isDraft || m.isDraft);
        if (drafts.length === 0) continue;
        threadIds.push(t.id);
        for (const m of drafts) messageIds.push(m.id);
      }
      const lines = [
        `would submit a round (${verdict}): ${plural(threadIds.length, 'thread')}, ${plural(messageIds.length, 'message')}`,
        ...threadIds.map((id) => `  thread ${id}`),
        ...messageIds.map((id) => `  message ${id}`),
      ];
      ctx.succeed(
        { dryRun: true, verdict, summary, threadIds, messageIds },
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
    const head = res.created ? 'submitted round' : 'round already submitted';
    ctx.succeed(
      { ...res, verdict },
      {
        text: `${head} ${res.roundId} (${verdict}): ${plural(res.threadIds.length, 'thread')}, ${plural(res.messageIds.length, 'message')}\n`,
      },
    );
  },
};
