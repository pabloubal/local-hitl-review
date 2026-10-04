// Exit codes and the error-template table (docs/spec/cli.md § Exit codes,
// § Error text). One table holds the fixed per-code example.
import { LhrError, type LhrErrorCode } from '../../core/src/index.js';
import { paint, useColor } from './term.js';

export const EXIT = {
  OK: 0,
  /** `lhr check` found errors (only). */
  CHECK_FAILED: 1,
  USAGE: 2,
  NOT_FOUND: 3,
  CONFLICT: 4,
  ENVIRONMENT: 5,
  SIGINT: 130,
} as const;

/** Facts an example may need; whatever is unknown makes the example absent. */
export interface ErrorDetails {
  /** Where review-root discovery started. */
  start?: string;
  root?: string;
  threadId?: string;
  /** Root-relative path the user gave. */
  path?: string;
}

interface Template {
  exit: number;
  /** A correct invocation, or undefined when none can be constructed. */
  example?: (d: ErrorDetails) => string | undefined;
}

export const ERROR_TABLE: Record<LhrErrorCode, Template> = {
  INVALID_INPUT: { exit: EXIT.USAGE },
  NOT_A_REPO: {
    exit: EXIT.USAGE,
    example: (d) => (d.start ? `lhr init --repo ${d.start}` : undefined),
  },
  PATH_NOT_IN_REPO: {
    exit: EXIT.USAGE,
    example: (d) => (d.path ? `lhr thread create ${d.path}:1` : undefined),
  },
  THREAD_NOT_FOUND: {
    exit: EXIT.NOT_FOUND,
    example: () => 'lhr thread list --status all',
  },
  MESSAGE_NOT_FOUND: {
    exit: EXIT.NOT_FOUND,
    example: (d) => (d.threadId ? `lhr thread show ${d.threadId}` : undefined),
  },
  DRAFT_NOT_FOUND: { exit: EXIT.NOT_FOUND, example: () => 'lhr thread list' },
  NOT_A_DRAFT: {
    exit: EXIT.CONFLICT,
    example: (d) => (d.threadId ? `lhr thread reply ${d.threadId} -` : undefined),
  },
  FORMAT_MISSING: { exit: EXIT.CONFLICT, example: () => 'lhr check' },
  FORMAT_VERSION: { exit: EXIT.CONFLICT },
  GIT_FAILED: { exit: EXIT.ENVIRONMENT },
  IO_FAILED: { exit: EXIT.ENVIRONMENT },
};

/** An LhrError raised by the CLI itself, carrying what the example needs. */
export class CliError extends LhrError {
  constructor(
    code: LhrErrorCode,
    message: string,
    readonly opts: {
      details?: ErrorDetails;
      /** Overrides the table's example (e.g. "the command with the missing piece filled in"). */
      example?: string;
      /** Help pointer printed as `see:` on usage errors. */
      see?: string;
    } = {},
  ) {
    super(code, message);
    this.name = 'CliError';
  }
}

/** A usage error (exit 2, INVALID_INPUT) pointing at `see`. */
export function usageError(
  message: string,
  see: string,
  example?: string,
  details?: ErrorDetails,
): CliError {
  return new CliError('INVALID_INPUT', message, { see, example, details });
}

export interface RenderedError {
  exit: number;
  code: LhrErrorCode;
  message: string;
  example?: string;
  see?: string;
}

const isLhrError = (e: unknown): e is LhrError =>
  e instanceof LhrError ||
  (e instanceof Error &&
    e.name === 'LhrError' &&
    typeof (e as { code?: unknown }).code === 'string');

/** First line, first sentence, no trailing period: parseArgs messages carry long hints. */
export function oneLine(message: string): string {
  return message
    .split('\n')[0]
    .split(/\.(?:\s|$)/)[0]
    .trim();
}

/** Maps anything thrown to a code, message, example and exit status. */
export function describeError(err: unknown, ctx: ErrorDetails = {}): RenderedError {
  if (isLhrError(err)) {
    const code = err.code;
    const tpl = ERROR_TABLE[code] ?? ERROR_TABLE.IO_FAILED;
    const own = err instanceof CliError ? err.opts : {};
    const details = { ...ctx, ...own.details };
    return {
      exit: tpl.exit,
      code,
      message: err.message,
      example: own.example ?? tpl.example?.(details),
      see: own.see,
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  // A bug, not a user error. The spec has no INTERNAL code, so keep exit 5 / IO_FAILED
  // and say plainly what happened.
  return {
    exit: EXIT.ENVIRONMENT,
    code: 'IO_FAILED',
    message: `unexpected internal error: ${message}`,
  };
}

/** Text form for stderr: `error: <message> (<CODE>)` then indented try:/see: lines. */
export function formatErrorText(
  e: RenderedError,
  color: boolean = useColor(process.stderr),
): string {
  const lines = [`${paint(color, 'error:', 'red')} ${e.message} (${e.code})`];
  if (e.example) lines.push(`  try: ${e.example}`);
  if (e.see) lines.push(`  see: ${e.see}`);
  return `${lines.join('\n')}\n`;
}

/** JSON form: `{version, error:{code,message,example?}}`; no diagnostics. */
export function errorEnvelope(e: RenderedError, version: number): object {
  const error: { code: string; message: string; example?: string } = {
    code: e.code,
    message: e.message,
  };
  if (e.example) error.example = e.example;
  return { version, error };
}
