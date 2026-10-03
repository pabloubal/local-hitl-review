import type { AuthorKind } from './ids.js';
import type { Diagnostic } from './errors.js';
import { FRONTMATTER_SYNTAX } from './frontmatter.js';

export type Severity = 'critical' | 'high' | 'medium' | 'low';
export type ThreadStatus = 'open' | 'resolved';
export type Verdict = 'approve' | 'comment' | 'request-changes';

export interface Author {
  kind: AuthorKind;
  name: string;
  session?: string;
  githubLogin?: string;
}

interface AnchorBase {
  path: string;
  side: 'new' | 'old';
  commit: string;
  branch?: string;
}

export interface FileAnchor extends AnchorBase {
  kind: 'file';
}

export interface LineAnchor extends AnchorBase {
  kind: 'line';
  blob: string;
  startLine: number;
  endLine: number;
  contextBefore: number;
  contextAfter: number;
}

export type Anchor = FileAnchor | LineAnchor;

export type AnchorState = 'current' | 'outdated' | 'orphaned';
export type AnchorMethod = 'diff' | 'text-search' | 'moved' | 'path' | 'pinned';

/** Where a thread sits in the code in front of you (ADR 0006). */
export interface AnchorResult {
  state: AnchorState;
  /** May differ from anchor.path after a rename. */
  path: string;
  /** Absent when orphaned and for file threads. */
  startLine?: number;
  endLine?: number;
  /** "from branch X" label, only while X exists. */
  fromBranch?: string;
  method: AnchorMethod;
  /** Why the thread is orphaned when its repo is gone (`REPO_MISSING`). */
  diagnostic?: Diagnostic;
}

export interface AnchorOptions {
  /** Repo-relative path -> unsaved editor text; replaces the content on disk. */
  overrides?: Map<string, string>;
}

export interface MessageView {
  id: string;
  createdAt: Date;
  author: Author;
  body: string;
  round?: string;
  status?: ThreadStatus;
  severity?: Severity;
  clientId?: string;
  isDraft: boolean;
}

export interface ThreadView {
  id: string;
  createdAt: Date;
  anchor: Anchor;
  snapshot?: string;
  messages: MessageView[];
  isDraft: boolean;
  status: ThreadStatus;
  severity: Severity;
  whoseTurn: AuthorKind;
  reviewer: Author;
}

export interface RoundView {
  id: string;
  createdAt: Date;
  verdict: Verdict;
  author: Author;
  body: string;
}

export interface ThreadFilter {
  status?: ThreadStatus;
  whoseTurn?: AuthorKind;
  path?: string;
  round?: string;
  includeDrafts?: boolean;
}

export interface InboxOptions {
  session?: string;
}

export interface TreeSnapshot {
  readonly problems: readonly Diagnostic[];
  threads(filter?: ThreadFilter): ThreadView[];
  thread(id: string): ThreadView | undefined;
  rounds(): RoundView[];
  inbox(opts?: InboxOptions): ThreadView[];
}

/** Internal: what the reader hands to the snapshot builder. */
export interface ThreadRecord {
  id: string;
  createdAt: Date;
  isDraft: boolean;
  anchor: Anchor;
  snapshot?: string;
  /** severity from thread.md, if set */
  severity?: Severity;
  /** submitted and draft messages, sorted by id; draft ones have isDraft: true */
  messages: MessageView[];
}

export interface TreeRecords {
  threads: ThreadRecord[];
  rounds: RoundView[];
  problems: Diagnostic[];
}

export const DiagnosticCode = {
  FrontmatterSyntax: FRONTMATTER_SYNTAX,
  MissingKey: 'MISSING_KEY',
  InvalidValue: 'INVALID_VALUE',
  InvalidFileName: 'INVALID_FILE_NAME',
  AuthorKindMismatch: 'AUTHOR_KIND_MISMATCH',
  MissingThreadMd: 'MISSING_THREAD_MD',
  EmptyThread: 'EMPTY_THREAD',
  EmptyBody: 'EMPTY_BODY',
  UnreadableFile: 'UNREADABLE_FILE',
  RepoMissing: 'REPO_MISSING',
  Symlink: 'SYMLINK',
  FormatMissing: 'FORMAT_MISSING',
  FormatVersion: 'FORMAT_VERSION',
  UnknownKey: 'UNKNOWN_KEY',
  MissingAuthorSession: 'MISSING_AUTHOR_SESSION',
  MissingLineAnchorKey: 'MISSING_LINE_ANCHOR_KEY',
  EndLineBeforeStart: 'END_LINE_BEFORE_START',
  SnapshotLineCount: 'SNAPSHOT_LINE_COUNT',
  UnknownRound: 'UNKNOWN_ROUND',
  DuplicateClientId: 'DUPLICATE_CLIENT_ID',
  InvalidPushBody: 'INVALID_PUSH_BODY',
  PushUnknownThread: 'PUSH_UNKNOWN_THREAD',
  PushUnknownMessage: 'PUSH_UNKNOWN_MESSAGE',
} as const;

export type DiagnosticCode =
  (typeof DiagnosticCode)[keyof typeof DiagnosticCode];
