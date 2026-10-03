import { stat } from 'node:fs/promises';
import { LhrError } from './errors.js';
import { checkTree, type CheckResult } from './check.js';
import { checkFormat } from './format.js';
import { GitExitError, runGit, type GitBatch } from './git.js';
import { Repo, RepoSet } from './repos.js';
import { createId, createMessageFileName, defaultRandom, type AuthorKind } from './ids.js';
import { computeAnchors } from './anchoring.js';
import type { AnchorOptions, AnchorResult, Author, ThreadView, TreeSnapshot } from './model.js';
import { readTree } from './read.js';
import { buildSnapshot } from './snapshot.js';
import {
  addDraftMessage,
  createDraftThread,
  discardDraft,
  submitRound,
  updateDraft,
  type AddDraftMessageInput,
  type CreateDraftThreadInput,
  type CreateDraftThreadResult,
  type DraftPatch,
  type SubmitRoundInput,
  type SubmitRoundResult,
} from './drafts.js';
import {
  guardFs,
  createThread,
  reopen,
  reply,
  resolve,
  type CreateThreadInput,
  type CreateThreadResult,
  type ReplyInput,
  type ReplyResult,
  type StatusChangeResult,
} from './write.js';

export interface Host {
  /** Review root (the directory holding .lhr/); not necessarily a git repo. */
  root: string;
  /** Clock. Default: () => new Date(). */
  now?: () => Date;
  /** 6 chars from [a-z2-7]. Default: crypto-backed. */
  random?: () => string;
  /** Git executable. Default: "git" on PATH. */
  gitPath?: string;
}

export interface LhrTree {
  readonly root: string;
  newId(): string;
  newMessageFileName(kind: AuthorKind): string;
  /**
   * Reads the whole tree into an immutable snapshot. Broken files become
   * `problems` on the snapshot; this never throws for file content.
   */
  load(): Promise<TreeSnapshot>;
  /**
   * Validates the whole tree, drafts included, against file-format-v2
   * § Validation. Content problems become diagnostics; never throws for them.
   */
  check(): Promise<CheckResult>;
  /** `{ kind: "human", name: <git user.name> }`. */
  humanAuthor(): Promise<Author>;
  /** Writes an agent (or other) reply immediately, with no round. */
  reply(threadId: string, input: ReplyInput): Promise<ReplyResult>;
  /** Starts a thread immediately; it is never part of a round. */
  createThread(input: CreateThreadInput): Promise<CreateThreadResult>;
  /** Writes an empty-bodied `status: resolved` message unless already resolved. */
  resolve(threadId: string, author: Author): Promise<StatusChangeResult>;
  /** Writes an empty-bodied `status: open` message unless already open. */
  reopen(threadId: string, author: Author): Promise<StatusChangeResult>;
  /**
   * Where each thread sits in the current code (ADR 0006), keyed by thread
   * ID. Calculated, never written back. All threads on a file share one diff.
   */
  anchors(threads: ThreadView[], opts?: AnchorOptions): Promise<Map<string, AnchorResult>>;
  /** Starts a draft thread (hidden from agents until `submitRound`). */
  createDraftThread(input: CreateDraftThreadInput): Promise<CreateDraftThreadResult>;
  /** Adds a draft message to a submitted or draft thread. */
  addDraftMessage(threadId: string, input: AddDraftMessageInput): Promise<{ messageId: string }>;
  /** Rewrites a draft message in place; submitted messages throw NOT_A_DRAFT. */
  updateDraft(messageId: string, patch: DraftPatch): Promise<void>;
  /** Deletes a draft message, or a draft thread with its messages. */
  discardDraft(id: string): Promise<void>;
  /** Submits all drafts as one review round; safe to rerun after an interruption. */
  submitRound(input: SubmitRoundInput): Promise<SubmitRoundResult>;
  /** Releases the long-lived git process. Idempotent. */
  dispose(): Promise<void>;
}

export class Tree implements LhrTree {
  constructor(
    readonly root: string,
    readonly repos: RepoSet,
    private readonly rootRepo: Repo | undefined,
    private readonly now: () => Date,
    private readonly random: () => string,
    readonly gitPath: string = 'git',
  ) {}

  /** The `cat-file` process of the repo holding the review root. */
  get git(): GitBatch {
    if (!this.rootRepo) {
      throw new LhrError('NOT_A_REPO', `${this.root} is not inside a git repository`);
    }
    return this.rootRepo.git;
  }

  newId(): string {
    return createId(this.now(), this.random());
  }

  newMessageFileName(kind: AuthorKind): string {
    return createMessageFileName(this.now(), kind, this.random());
  }

  async load(): Promise<TreeSnapshot> {
    return buildSnapshot(await readTree(this.root));
  }

  check(): Promise<CheckResult> {
    return checkTree(this.root);
  }

  async humanAuthor(): Promise<Author> {
    let name: string;
    try {
      name = (await runGit(this.gitPath, this.root, ['config', 'user.name'])).trim();
    } catch (err) {
      if (err instanceof GitExitError) name = '';
      else throw err;
    }
    if (name === '') throw new LhrError('GIT_FAILED', 'git user.name is not set');
    return { kind: 'human', name };
  }

  reply(threadId: string, input: ReplyInput): Promise<ReplyResult> {
    return guardFs(() => reply(this, threadId, input));
  }

  createThread(input: CreateThreadInput): Promise<CreateThreadResult> {
    return guardFs(() => createThread(this, input));
  }

  resolve(threadId: string, author: Author): Promise<StatusChangeResult> {
    return guardFs(() => resolve(this, threadId, author));
  }

  reopen(threadId: string, author: Author): Promise<StatusChangeResult> {
    return guardFs(() => reopen(this, threadId, author));
  }

  anchors(threads: ThreadView[], opts?: AnchorOptions): Promise<Map<string, AnchorResult>> {
    return computeAnchors({ root: this.root, gitPath: this.gitPath, repos: this.repos }, threads, opts);
  }

  createDraftThread(input: CreateDraftThreadInput): Promise<CreateDraftThreadResult> {
    return guardFs(() => createDraftThread(this, input));
  }

  addDraftMessage(threadId: string, input: AddDraftMessageInput): Promise<{ messageId: string }> {
    return guardFs(() => addDraftMessage(this, threadId, input));
  }

  updateDraft(messageId: string, patch: DraftPatch): Promise<void> {
    return guardFs(() => updateDraft(this, messageId, patch));
  }

  discardDraft(id: string): Promise<void> {
    return guardFs(() => discardDraft(this, id));
  }

  submitRound(input: SubmitRoundInput): Promise<SubmitRoundResult> {
    return guardFs(() => submitRound(this, input));
  }

  dispose(): Promise<void> {
    return this.repos.dispose();
  }
}

export async function openTree(host: Host): Promise<LhrTree> {
  const now = host.now ?? (() => new Date());
  const random = host.random ?? defaultRandom;
  const gitPath = host.gitPath ?? 'git';
  const { root } = host;

  try {
    if (!(await stat(root)).isDirectory()) {
      throw new LhrError('NOT_A_REPO', `${root} is not a directory`);
    }
  } catch (err) {
    if (err instanceof LhrError) throw err;
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new LhrError('NOT_A_REPO', `${root} does not exist`);
    }
    throw new LhrError('NOT_A_REPO', `cannot access ${root}: ${String(code)}`);
  }

  await checkFormat(root);
  const repos = new RepoSet(root, gitPath);
  // Fails fast with GIT_FAILED when git itself can't run.
  const rootRepo = await repos.forDir('');
  return new Tree(root, repos, rootRepo, now, random, gitPath);
}
