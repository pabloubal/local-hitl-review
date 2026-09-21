export type Severity = 'critical' | 'high' | 'medium' | 'low';
export type Status = 'open' | 'acknowledged';
export type FileStatus = 'M' | 'A' | 'D' | 'R' | 'C';
export type Reviewer = 'human' | 'agent';

export interface FeedbackComment {
  /** Filename stem, e.g. "1726588988-a3f2" */
  id: string;
  severity: Severity;
  status: Status;
  reviewer: Reviewer;
  /** Repo-relative file path */
  file: string;
  /** Line range string: "10" or "10-50" */
  lines: string;
  /** Markdown body (may include ```suggestion blocks) */
  body: string;
  /** Unix timestamp (seconds) when the comment was created */
  timestamp: number;
}

export interface ChangedFile {
  /** Repo-relative file path */
  path: string;
  status: FileStatus;
  /** For renames: the original path */
  originalPath?: string;
  /** The absolute path to the repository this file belongs to (added for multi-repo support) */
  repoRoot?: string;
}

export interface GitCommit {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  date: string;
}

export const SEVERITY_LABELS: Record<Severity, string> = {
  critical: '🔴 Critical',
  high: '🟠 High',
  medium: '🟡 Medium',
  low: '🟢 Low',
};

export const SEVERITY_ORDER: Severity[] = ['critical', 'high', 'medium', 'low'];
