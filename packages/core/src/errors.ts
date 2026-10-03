export type LhrErrorCode =
  | 'NOT_A_REPO'
  | 'PATH_NOT_IN_REPO'
  | 'FORMAT_MISSING'
  | 'FORMAT_VERSION'
  | 'THREAD_NOT_FOUND'
  | 'MESSAGE_NOT_FOUND'
  | 'DRAFT_NOT_FOUND'
  | 'NOT_A_DRAFT'
  | 'INVALID_INPUT'
  | 'GIT_FAILED'
  | 'IO_FAILED';

export class LhrError extends Error {
  readonly code: LhrErrorCode;

  constructor(code: LhrErrorCode, message: string) {
    super(message);
    this.name = 'LhrError';
    this.code = code;
  }
}

export interface Diagnostic {
  severity: 'error' | 'warning';
  /** Stable identifier, one per rule in file-format-v2.md § Validation. */
  code: string;
  /** Repo-relative path of the offending file. */
  path: string;
  line?: number;
  message: string;
}
