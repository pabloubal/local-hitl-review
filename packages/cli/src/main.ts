import { parseArgs } from 'node:util';
import { openTree, type LhrTree } from '../../core/src/index.js';
import { COMMANDS, GROUPS, commandHelp, groupHelp, topLevelHelp } from './help.js';
import { GLOBAL_OPTIONS, HANDLERS, type Command, type CommandContext } from './commands.js';
import { authorFor, discoverRoot, resolveIdentity, resolveStart } from './context.js';
import {
  CliError,
  EXIT,
  describeError,
  errorEnvelope,
  formatErrorText,
  usageError,
  type ErrorDetails,
} from './errors.js';
import { ENVELOPE_VERSION, successEnvelope, warn, writeJson } from './output.js';

declare const __LHR_VERSION__: string;

/** Routing parse: globals are typed so `--repo x` doesn't leak `x` into positionals. */
function route(argv: string[]) {
  return parseArgs({
    args: argv,
    options: GLOBAL_OPTIONS,
    allowPositionals: true,
    strict: false,
  });
}

export async function run(argv: string[]): Promise<number> {
  const pre = route(argv);
  const json = pre.values.json === true;
  const details: ErrorDetails = {};
  try {
    return await dispatch(argv, pre, details);
  } catch (err) {
    const e = describeError(err, details);
    if (json) writeJson(errorEnvelope(e, ENVELOPE_VERSION));
    else process.stderr.write(formatErrorText(e));
    return e.exit;
  }
}

async function dispatch(
  argv: string[],
  pre: ReturnType<typeof route>,
  details: ErrorDetails,
): Promise<number> {
  const { values, positionals } = pre;
  if (positionals.length === 0 && values.version === true) {
    process.stdout.write(`${__LHR_VERSION__}\n`);
    return EXIT.OK;
  }

  const wantsHelp = values.help === true;
  if (positionals.length === 0) {
    const unknown = Object.keys(values).find((k) => !(k in GLOBAL_OPTIONS) && k !== 'version');
    if (unknown) throw usageError(`unknown flag --${unknown}`, 'lhr --help');
    process.stdout.write(topLevelHelp());
    return EXIT.OK;
  }

  const [first, second] = positionals;
  let path: string[];
  if (first in GROUPS) {
    const known = COMMANDS.some((c) => c.path[0] === first && c.path[1] === second);
    if (!known) {
      if (second === undefined && wantsHelp) {
        process.stdout.write(groupHelp(first));
        return EXIT.OK;
      }
      const what =
        second === undefined
          ? `missing command for ${first}`
          : `unknown command ${first} ${second}`;
      throw usageError(what, `lhr ${first} --help`);
    }
    path = [first, second];
  } else if (
    first === '__debug' ||
    COMMANDS.some((c) => c.path.length === 1 && c.path[0] === first)
  ) {
    path = [first];
  } else {
    throw usageError(`unknown command ${first}`, 'lhr --help');
  }

  const name = path.join(' ');
  if (wantsHelp) {
    const help = COMMANDS.find((c) => c.path.join(' ') === name);
    if (help) {
      process.stdout.write(commandHelp(help));
      return EXIT.OK;
    }
  }
  const command = HANDLERS[name];
  return execute(argv, path, command, details);
}

async function execute(
  argv: string[],
  path: string[],
  command: Command,
  details: ErrorDetails,
): Promise<number> {
  const name = path.join(' ');
  const see = `lhr ${name} --help`;
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: { ...GLOBAL_OPTIONS, ...command.options },
      allowPositionals: true,
      strict: true,
    });
  } catch (err) {
    throw usageError((err as Error).message.split('. ')[0], see);
  }
  const values = parsed.values as CommandContext['values'];
  const args = parsed.positionals.slice(path.length);

  const as = values.as as string | undefined;
  if (as !== undefined && as !== 'human' && as !== 'agent') {
    throw usageError(`--as must be human or agent, got "${as}"`, see, `lhr ${name} --as agent`);
  }

  const env = process.env;
  const start = resolveStart(values.repo as string | undefined, env, process.cwd());
  details.start = start;
  const root = command.needsRoot === false ? undefined : discoverRoot(start);
  details.root = root;

  const identity = resolveIdentity({ as, name: values.name as string | undefined }, env);
  for (const w of identity.warnings) warn(w);

  const json = values.json === true;
  let tree: LhrTree | undefined;
  const ctx: CommandContext = {
    path,
    args,
    values,
    json,
    dryRun: values['dry-run'] === true,
    start,
    root,
    identity,
    see,
    async tree() {
      if (!root)
        throw new CliError('NOT_A_REPO', `no review root for lhr ${name}`, {
          details,
        });
      return (tree ??= await openTree({ root }));
    },
    async author() {
      return authorFor(identity, await ctx.tree());
    },
    succeed(data, opts = {}) {
      if (json) writeJson(successEnvelope(root, data, opts.diagnostics));
      else if (opts.text !== undefined) process.stdout.write(opts.text);
    },
  };

  try {
    await command.run(ctx);
  } finally {
    await tree?.dispose();
  }
  return ctx.exitCode ?? EXIT.OK;
}

// Ctrl-C: a newline on stderr, nothing on stdout (so no partial JSON), exit 130.
process.on('SIGINT', () => {
  process.stderr.write('\n');
  process.exit(EXIT.SIGINT);
});

process.exitCode = await run(process.argv.slice(2));
