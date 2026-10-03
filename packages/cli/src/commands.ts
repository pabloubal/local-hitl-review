// Command registry. Each command declares its own option set (merged with the
// global flags by main.ts) and a handler. Later slices replace the stubs.
import type { ParseArgsConfig } from 'node:util';
import type { Author, Diagnostic, LhrTree } from '../../core/src/index.js';
import { CliError, usageError } from './errors.js';
import { authorFor, readStdin, type Identity } from './context.js';
import { ruleWidth, termWidth, useColor } from './term.js';
import { threadList, threadShow } from './commands/thread-read.js';

export type OptionsConfig = NonNullable<ParseArgsConfig['options']>;

export interface CommandContext {
  /** Words that selected the command, e.g. `['thread', 'reply']`. */
  path: string[];
  /** Positionals after the command words. */
  args: string[];
  /** Parsed flag values (global and command-specific). */
  values: Record<string, string | boolean | undefined>;
  json: boolean;
  dryRun: boolean;
  /** Where discovery started. */
  start: string;
  /** Review root; absent only for commands that don't need one (`init`). */
  root?: string;
  identity: Identity;
  /** Opens the tree at the root; disposed by the runner after the handler. */
  tree(): Promise<LhrTree>;
  author(): Promise<Author>;
  /** `lhr <path> --help`, for `see:` lines. */
  see: string;
  /** Prints success: the envelope under --json, else `text` on stdout. */
  succeed(
    data: Record<string, unknown>,
    opts?: { text?: string; diagnostics?: Diagnostic[] },
  ): void;
}

export interface Command {
  /** Command-specific flags; the global ones are always accepted. */
  options?: OptionsConfig;
  /** False for commands that don't walk up to a review root (`init`). */
  needsRoot?: boolean;
  run(ctx: CommandContext): Promise<void>;
}

export const GLOBAL_OPTIONS = {
  repo: { type: 'string' },
  json: { type: 'boolean' },
  as: { type: 'string' },
  name: { type: 'string' },
  'dry-run': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const satisfies OptionsConfig;

const notImplemented = (name: string): Command => ({
  async run(ctx) {
    throw usageError(`lhr ${name} is not implemented yet`, ctx.see);
  },
});

/**
 * Internal diagnostics for the foundations: not in help, not a public
 * interface. Lets built-binary tests reach context, errors, stdin and term
 * before the real commands land.
 */
const debug: Command = {
  options: { probe: { type: 'string' } },
  async run(ctx) {
    const [sub, arg] = ctx.args;
    switch (sub) {
      case 'context': {
        const tree = await ctx.tree();
        ctx.succeed({
          mode: ctx.identity.mode,
          author: await authorFor(ctx.identity, tree),
          dryRun: ctx.dryRun,
        });
        return;
      }
      case 'flags':
        ctx.succeed({
          probe: ctx.values.probe ?? null,
          positionals: ctx.args.slice(1),
        });
        return;
      case 'fail':
        throw new CliError(arg as never, `simulated ${arg}`, {});
      case 'stdin':
        ctx.succeed({ body: await readStdin(ctx.see) });
        return;
      case 'term':
        ctx.succeed({
          width: termWidth(),
          ruleWidth: ruleWidth(),
          color: useColor(process.stdout),
        });
        return;
      case 'wait':
        process.stderr.write('ready\n');
        await new Promise<void>((done) => setTimeout(done, 30_000));
        return;
      default:
        throw usageError(`unknown debug step ${sub ?? ''}`, ctx.see);
    }
  },
};

export const HANDLERS: Record<string, Command> = {
  init: { ...notImplemented('init'), needsRoot: false },
  inbox: notImplemented('inbox'),
  'thread list': threadList,
  'thread show': threadShow,
  'thread create': notImplemented('thread create'),
  'thread reply': notImplemented('thread reply'),
  'thread resolve': notImplemented('thread resolve'),
  'thread reopen': notImplemented('thread reopen'),
  'review submit': notImplemented('review submit'),
  check: notImplemented('check'),
  mcp: notImplemented('mcp'),
  __debug: debug,
};
