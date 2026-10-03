// `lhr check` (docs/spec/cli.md § lhr check): the only command that exits 1.
import { LhrError, type Diagnostic } from '../../../core/src/index.js';
import type { Command } from '../commands.js';
import { EXIT } from '../errors.js';

const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export function diagnosticLine(d: Diagnostic): string {
  const where = d.line === undefined ? d.path : `${d.path}:${d.line}`;
  return `${d.severity} ${d.code} ${where} ${d.message}`;
}

/**
 * `openTree` refuses a tree with a bad `.lhr/format`, so `check` could never
 * report it. Turn that refusal into the same diagnostic core `check()` yields.
 */
function formatDiagnostic(err: unknown): Diagnostic | undefined {
  if (err instanceof LhrError && (err.code === 'FORMAT_MISSING' || err.code === 'FORMAT_VERSION')) {
    return { severity: 'error', code: err.code, path: '.lhr/format', message: err.message };
  }
  return undefined;
}

export const check: Command = {
  async run(ctx) {
    let diagnostics: Diagnostic[];
    try {
      diagnostics = (await (await ctx.tree()).check()).diagnostics;
    } catch (err) {
      const d = formatDiagnostic(err);
      if (!d) throw err;
      diagnostics = [d];
    }
    const errors = diagnostics.filter((d) => d.severity === 'error').length;
    const warnings = diagnostics.length - errors;
    const summary = `${count(errors, 'error', 'errors')}, ${count(warnings, 'warning', 'warnings')}`;
    const lines = [...diagnostics.map(diagnosticLine), summary];
    ctx.succeed({ errors, warnings }, { text: `${lines.join('\n')}\n`, diagnostics });
    if (errors > 0) ctx.exitCode = EXIT.CHECK_FAILED;
  },
};
