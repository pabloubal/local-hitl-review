// `lhr inbox` (docs/spec/cli.md § lhr inbox): `thread list`'s layouts and thread object,
// over the threads where it is the agent's turn.
import type { Command } from '../commands.js';
import { shortIds } from '../handles.js';
import { renderList, threadJson, type ThreadItem } from '../render/thread.js';
import { termWidth, useColor } from '../term.js';

export const inbox: Command = {
  options: { 'all-sessions': { type: 'boolean' } },
  async run(ctx) {
    const tree = await ctx.tree();
    const snapshot = await tree.load();
    const scoped = ctx.identity.mode === 'agent' && ctx.values['all-sessions'] !== true;
    const session = scoped ? ctx.identity.session : undefined;
    const views = snapshot.inbox(session === undefined ? undefined : { session });
    const anchors = await tree.anchors(views);
    // Handles are unique among the threads this mode can see (drafts: human mode only).
    const visible = snapshot.threads({ includeDrafts: ctx.identity.mode === 'human' });
    const handles = shortIds(visible.map((t) => t.id));
    const items: ThreadItem[] = views.map((view) => ({
      view,
      shortId: handles.get(view.id)!,
      anchor: anchors.get(view.id)!,
    }));

    const problems = [...snapshot.problems];
    if (!ctx.json && problems.length > 0) {
      process.stderr.write(
        `${problems.length} problem${problems.length === 1 ? '' : 's'} skipped; run lhr check\n`,
      );
    }
    const n = items.length;
    const summary = `${n} thread${n === 1 ? '' : 's'} in the inbox`;
    ctx.succeed(
      { threads: items.map(threadJson) },
      {
        diagnostics: problems,
        text: renderList(items, summary, { color: useColor(process.stdout), width: termWidth() }),
      },
    );
  },
};
