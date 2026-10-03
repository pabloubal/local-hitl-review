// stdout/stderr discipline (docs/spec/cli.md § JSON output). With --json,
// stdout is exactly one envelope plus a newline; prose and warnings go to stderr.
import type { Diagnostic } from '../../core/src/index.js';

/** Envelope version: bumped only on breaking changes. */
export const ENVELOPE_VERSION = 1;

export function successEnvelope(
  root: string | undefined,
  data: Record<string, unknown>,
  diagnostics: Diagnostic[] = [],
): object {
  // `root` leads `data` on every successful response.
  return {
    version: ENVELOPE_VERSION,
    data: root === undefined ? data : { root, ...data },
    diagnostics,
  };
}

export function writeJson(envelope: object): void {
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
}

export function warn(message: string): void {
  process.stderr.write(`warning: ${message}\n`);
}
