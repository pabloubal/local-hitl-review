// `lhr init [path]` (docs/spec/cli.md § lhr init): the only command that
// creates `.lhr/`. It never walks up and never prompts.
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { checkFormat } from '../../../core/src/format.js';
import type { Command } from '../commands.js';
import { CliError, usageError } from '../errors.js';
import { discoverRoot } from '../context.js';

const FORMAT_FILE = '.lhr/format';
const GITIGNORE_FILE = '.lhr/.gitignore';
const IGNORE_LINE = 'drafts/';

const exists = async (p: string): Promise<boolean> => {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
};

export const init: Command = {
  needsRoot: false,
  async run(ctx) {
    if (ctx.args.length > 1) {
      throw usageError('init takes at most one path', ctx.see, 'lhr init ../other-repo');
    }
    const arg = ctx.args[0];
    // An explicit path is relative to the shell's directory; the default is the start path.
    const wanted = arg === undefined ? ctx.start : resolve(process.cwd(), arg);
    let target: string;
    try {
      target = await realpath(wanted);
      if (!(await stat(target)).isDirectory()) throw new Error('not a directory');
    } catch {
      throw usageError(`path does not exist or is not a directory: ${wanted}`, ctx.see);
    }

    const lhrDir = join(target, '.lhr');
    const dirExists = await exists(lhrDir);
    // An existing `.lhr/` must hold a valid format; init never overwrites a bad one.
    if (dirExists) {
      try {
        await checkFormat(target);
      } catch (err) {
        throw new CliError(
          (err as { code: 'FORMAT_MISSING' | 'FORMAT_VERSION' }).code,
          (err as Error).message,
          { details: { start: ctx.start, root: target } },
        );
      }
    }

    const ignorePath = join(target, GITIGNORE_FILE);
    let ignoreText: string | undefined;
    try {
      ignoreText = await readFile(ignorePath, 'utf8');
    } catch {
      ignoreText = undefined;
    }
    const ignored = ignoreText?.split(/\r?\n/).some((l) => l.trim() === IGNORE_LINE) ?? false;

    const created: string[] = [];
    if (!dirExists) created.push(FORMAT_FILE);
    if (!ignored) created.push(GITIGNORE_FILE);

    let ancestor: string | undefined;
    try {
      const parent = dirname(target);
      if (parent !== target) ancestor = discoverRoot(parent);
    } catch {
      ancestor = undefined;
    }

    if (!ctx.dryRun) {
      if (!dirExists) {
        await mkdir(lhrDir, { recursive: true });
        await writeFile(join(target, FORMAT_FILE), '2\n');
      }
      if (!ignored) {
        const prefix =
          ignoreText && !ignoreText.endsWith('\n') ? `${ignoreText}\n` : (ignoreText ?? '');
        await writeFile(ignorePath, `${prefix}${IGNORE_LINE}\n`);
      }
    }

    let text: string;
    if (created.length === 0) {
      text = `.lhr/ already exists in ${target} (nothing to do)\n`;
    } else if (ctx.dryRun) {
      text = `would create .lhr/ in ${target}\n${created.map((f) => `  ${f}\n`).join('')}`;
    } else if (dirExists) {
      text = `updated .lhr/ in ${target} (added ${created.join(', ')})\n`;
    } else {
      text = `created .lhr/ in ${target}\n`;
    }
    if (ancestor !== undefined && !ctx.json) {
      process.stderr.write(`note: ${ancestor} already has a .lhr/ above this directory\n`);
    }
    ctx.succeed(
      { root: target, created, dryRun: ctx.dryRun, ...(ancestor ? { ancestor } : {}) },
      { text },
    );
  },
};
