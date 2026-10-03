import { parseArgs } from 'node:util';
import { COMMANDS, GROUPS, commandHelp, groupHelp, topLevelHelp } from './help.js';

declare const __LHR_VERSION__: string;

const EXIT_USAGE = 2;

function usageError(message: string, tryCmd: string): number {
  process.stderr.write(`error: ${message}\ntry: ${tryCmd}\n`);
  return EXIT_USAGE;
}

export function run(argv: string[]): number {
  // Global flags are accepted before or after the subcommand, so parse them
  // permissively here and let each command validate its own flags later.
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false,
  });

  if (positionals.length === 0 && values.version === true) {
    process.stdout.write(`${__LHR_VERSION__}\n`);
    return 0;
  }

  const wantsHelp = values.help === true || values.h === true;
  if (positionals.length === 0) {
    if (wantsHelp || Object.keys(values).length === 0) {
      process.stdout.write(topLevelHelp());
      return 0;
    }
    return usageError(`unknown flag --${Object.keys(values)[0]}`, 'lhr --help');
  }

  const [first, second] = positionals;
  if (first in GROUPS) {
    const cmd = COMMANDS.find((c) => c.path[0] === first && c.path[1] === second);
    if (!cmd) {
      if (second === undefined && wantsHelp) {
        process.stdout.write(groupHelp(first));
        return 0;
      }
      const what =
        second === undefined
          ? `missing command for ${first}`
          : `unknown command ${first} ${second}`;
      return usageError(what, `lhr ${first} --help`);
    }
    return runCommand(cmd.path, argv, wantsHelp);
  }

  const cmd = COMMANDS.find((c) => c.path.length === 1 && c.path[0] === first);
  if (!cmd) return usageError(`unknown command ${first}`, 'lhr --help');
  return runCommand(cmd.path, argv, wantsHelp);
}

function runCommand(path: string[], argv: string[], wantsHelp: boolean): number {
  const cmd = COMMANDS.find((c) => c.path.join(' ') === path.join(' '))!;
  const name = path.join(' ');
  if (wantsHelp) {
    process.stdout.write(commandHelp(cmd));
    return 0;
  }
  // Skeleton: strict flag validation will live with each real command.
  try {
    parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        repo: { type: 'string' },
        json: { type: 'boolean' },
        as: { type: 'string' },
        name: { type: 'string' },
        'dry-run': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (err) {
    return usageError((err as Error).message.split('. ')[0], `lhr ${name} --help`);
  }
  return usageError(`lhr ${name} is not implemented yet`, `lhr ${name} --help`);
}

process.exitCode = run(process.argv.slice(2));
