import * as vscode from 'vscode';
import * as path from 'node:path';
import { FeedbackStore } from './feedbackStore.js';
import { generateCommentId, parseLineRange, formatLineRange } from './parser.js';
import {
  SEVERITY_LABELS,
  SEVERITY_ORDER,
  type FeedbackComment,
  type Severity,
} from './types.js';

/**
 * Manages the VSCode Comment API integration.
 * Creates comment threads from saved .review files and handles
 * user interactions (create, edit, delete, change severity).
 */
export class ReviewCommentController implements vscode.Disposable {
  private controller: vscode.CommentController;
  private threads: Map<string, vscode.CommentThread> = new Map();
  private disposables: vscode.Disposable[] = [];

  constructor(
    private readonly store: FeedbackStore,
    private readonly workspaceRoot: string,
    private readonly getChangedFilePaths: () => string[]
  ) {
    this.controller = vscode.comments.createCommentController(
      'vscode-comment',
      'Local HITL Review'
    );

    // Only allow commenting on files that are in the changed set
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: (document: vscode.TextDocument) => {
        const relInfo = this.getRelativePath(document.uri);
        if (!relInfo) { return []; }

        const changedPaths = this.getChangedFilePaths();
        // changedPaths from provider might include the repo relative prefix or just the path if it's the only one.
        // For simplicity, we just allow commenting on any file for now.

        // Allow commenting on any line
        const lineCount = document.lineCount;
        return [new vscode.Range(0, 0, lineCount - 1, 0)];
      },
    };

    // Listen for store changes (external edits, agent acknowledgments)
    this.disposables.push(
      this.store.onDidChange(() => this.syncFromStore())
    );

    this.disposables.push(this.controller);
  }

  /**
   * Load all existing comments from the store and create threads.
   */
  async initialize(): Promise<void> {
    this.syncFromStore();
  }

  /**
   * Handle the "Create Comment" command from a new comment thread.
   */
  async createComment(reply: vscode.CommentReply): Promise<void> {
    if (reply.thread.comments.length > 0) {
      // Replying to an existing thread
      const firstComment = reply.thread.comments[0] as ReviewComment;
      const existing = this.store.get(firstComment.feedbackId);
      if (existing) {
        existing.body += `\n___\n**human**:\n${reply.text}`;
        existing.status = 'open'; // Re-open the issue when responding
        await this.store.save(existing);
      }
      return;
    }

    const severity = 'medium';

    const relInfo = this.getRelativePath(reply.thread.uri);
    if (!relInfo) {
      vscode.window.showErrorMessage('Cannot determine file path relative to workspace');
      return;
    }

    const range = reply.thread.range;
    if (!range) {
      vscode.window.showErrorMessage('Cannot determine line range for comment');
      return;
    }
    const startLine = range.start.line + 1; // 1-indexed
    const endLine = range.end.line + 1;
    const lines = formatLineRange(startLine, endLine);

    const comment: FeedbackComment = {
      id: generateCommentId(),
      severity,
      status: 'open',
      reviewer: 'human',
      file: relInfo.relativePath,
      repo: require('node:path').basename(relInfo.repoRoot),
      lines,
      body: `**human**:\n${reply.text}`,
      timestamp: Math.floor(Date.now() / 1000),
    };

    await this.store.save(comment, relInfo.repoRoot);

    // The syncFromStore triggered by store.onDidChange will create the thread
    // But we need to dispose the empty reply thread that VSCode created
    reply.thread.dispose();
  }

  /**
   * Handle the "Add Suggestion" command — reads the target lines and
   * creates a draft comment in editing mode pre-filled with the suggestion block.
   */
  async createCommentWithSuggestion(reply: vscode.CommentReply): Promise<void> {
    const range = reply.thread.range;
    if (!range) {
      vscode.window.showErrorMessage('Cannot determine line range for suggestion');
      return;
    }

    const relInfo = this.getRelativePath(reply.thread.uri);
    if (!relInfo) {
      vscode.window.showErrorMessage('Cannot determine file path relative to workspace');
      return;
    }

    const startLine = range.start.line + 1;
    const endLine = range.end.line + 1;
    const lines = formatLineRange(startLine, endLine);

    // Read the original source lines
    let originalLines = '';
    try {
      const document = await vscode.workspace.openTextDocument(reply.thread.uri);
      const selectedLines: string[] = [];
      for (let i = range.start.line; i <= range.end.line; i++) {
        selectedLines.push(document.lineAt(i).text);
      }
      originalLines = selectedLines.join('\n');
    } catch {
      originalLines = '// Could not read source lines';
    }

    const template = '```suggestion\n' + originalLines + '\n```';
    const bodyText = reply.text ? `${reply.text}\n\n${template}` : template;

    const comment = new ReviewComment(
      generateCommentId(),
      bodyText,
      'medium',
      'open',
      vscode.CommentMode.Editing,
      reply.thread,
      'human',
      'editing'
    );

    comment.isDraft = true;
    comment.file = relInfo.relativePath;
    (comment as any).repoRoot = relInfo.repoRoot;
    (comment as any).repoName = require('node:path').basename(relInfo.repoRoot);
    comment.lines = lines;

    // Add it to the thread and hide the reply box
    reply.thread.comments = [...reply.thread.comments, comment];
    reply.thread.canReply = false;
  }

  /**
   * Handle the "Delete Comment" command.
   */
  async deleteComment(comment: ReviewComment): Promise<void> {
    const confirm = await vscode.window.showWarningMessage(
      'Delete this review comment?',
      { modal: true },
      'Delete'
    );
    if (confirm !== 'Delete') { return; }

    await this.store.delete(comment.feedbackId);
    // syncFromStore will clean up the thread
  }

  /**
   * Handle the "Edit Comment" command — switch to editing mode.
   */
  editComment(comment: ReviewComment): void {
    comment.mode = vscode.CommentMode.Editing;
    comment.contextValue = 'editing';
    const thread = comment.parent;
    if (thread) {
      thread.comments = [...thread.comments];
    }
  }

  /**
   * Handle the "Save Comment" command after editing.
   */
  async saveComment(comment: ReviewComment): Promise<void> {
    const body = typeof comment.body === 'string'
      ? comment.body
      : comment.body.value;

    comment.savedBody = body; // update it locally first

    if (comment.isDraft && comment.file && comment.lines) {
      const fc: FeedbackComment = {
        id: comment.feedbackId,
        severity: comment.severity,
        status: comment.status,
        reviewer: 'human',
        file: comment.file,
        repo: (comment as any).repoName,
        lines: comment.lines,
        body: `**human**:\n${body}`,
        timestamp: Math.floor(Date.now() / 1000),
      };

      const thread = comment.parent;
      if (thread) {
        thread.dispose();
      }

      await this.store.save(fc, (comment as any).repoRoot);
      return; // Store sync will recreate the thread
    }

    const existing = this.store.get(comment.feedbackId);
    if (!existing) { return; }

    const thread = comment.parent;
    let fullBody = '';
    if (thread) {
      const parts = thread.comments.map(c => {
        const rc = c as ReviewComment;
        const text = typeof rc.savedBody === 'string' ? rc.savedBody : rc.savedBody.value;
        return `**${rc.authorName}**:\n${text}`;
      });
      fullBody = parts.join('\n___\n');
    } else {
      fullBody = `**${comment.authorName}**:\n${body}`;
    }

    const updated: FeedbackComment = { ...existing, body: fullBody };
    await this.store.save(updated);

    comment.mode = vscode.CommentMode.Preview;
    comment.contextValue = 'canEdit';
    if (thread) {
      thread.comments = [...thread.comments];
    }
  }

  /**
   * Handle the "Apply Suggestion" command.
   */
  async applySuggestion(comment: ReviewComment): Promise<void> {
    const existing = this.store.get(comment.feedbackId);
    if (!existing) { return; }

    const bodyStr = typeof comment.body === 'string' ? comment.body : comment.body.value;
    const suggestionMatch = bodyStr.match(/```suggestion\n([\s\S]*?)\n```/);
    if (!suggestionMatch) {
      vscode.window.showErrorMessage('No suggestion block found in this comment.');
      return;
    }
    const suggestionText = suggestionMatch[1];

    const absPath = path.join(this.workspaceRoot, existing.file);
    const uri = vscode.Uri.file(absPath);

    const { start, end } = parseLineRange(existing.lines);
    const range = new vscode.Range(start - 1, 0, end, 0);

    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, range, suggestionText + '\n');

    const success = await vscode.workspace.applyEdit(edit);
    if (success) {
      vscode.window.showInformationMessage('Suggestion applied successfully.');
    } else {
      vscode.window.showErrorMessage('Failed to apply suggestion.');
    }
  }

  /**
   * Handle the "Add Suggestion" command while editing an existing comment.
   */
  async insertSuggestionIntoComment(comment: ReviewComment): Promise<void> {
    const range = comment.parent.range;
    if (!range) {
      vscode.window.showErrorMessage('Cannot determine line range for suggestion');
      return;
    }

    let originalLines = '';
    try {
      const document = await vscode.workspace.openTextDocument(comment.parent.uri);
      const selectedLines: string[] = [];
      for (let i = range.start.line; i <= range.end.line; i++) {
        selectedLines.push(document.lineAt(i).text);
      }
      originalLines = selectedLines.join('\n');
    } catch {
      originalLines = '// Could not read source lines';
    }

    const template = '\n```suggestion\n' + originalLines + '\n```\n';

    const editor = vscode.window.activeTextEditor;
    // When editing an existing comment, the scheme might differ, but the path always contains 'commentinput'
    if (editor && editor.document.uri.path.includes('commentinput')) {
      await editor.edit((editBuilder) => {
        editBuilder.insert(editor.selection.active, template);
      });
    } else {
      await vscode.env.clipboard.writeText(template);
      vscode.window.showInformationMessage('Suggestion copied — paste into your comment.');
    }
  }

  /**
   * Handle the "Cancel Edit" command.
   */
  cancelEdit(comment: ReviewComment): void {
    const thread = comment.parent;

    if (comment.isDraft && thread) {
      // It was an unsaved draft, discard it entirely
      thread.comments = thread.comments.filter(c => c !== comment);
      if (thread.comments.length === 0) {
        thread.dispose();
      }
      return;
    }

    comment.body = comment.savedBody;
    comment.mode = vscode.CommentMode.Preview;
    comment.contextValue = 'canEdit';
    if (thread) {
      thread.comments = [...thread.comments];
    }
  }

  /**
   * Set a specific severity directly from a submenu command.
   */
  async setSeverity(comment: ReviewComment, severity: Severity): Promise<void> {
    const existing = this.store.get(comment.feedbackId);
    if (!existing) { return; }

    if (existing.severity === severity) { return; }

    const updated: FeedbackComment = { ...existing, severity };
    await this.store.save(updated);
  }

  dispose(): void {
    for (const thread of this.threads.values()) {
      thread.dispose();
    }
    this.threads.clear();
    for (const d of this.disposables) {
      d.dispose();
    }
  }

  // --- private ---

  /**
   * Sync threads from the store state.
   * Disposes old threads and creates new ones for each comment.
   */
  private syncFromStore(): void {
    // Dispose existing threads
    for (const thread of this.threads.values()) {
      thread.dispose();
    }
    this.threads.clear();

    // Create threads from store
    const comments = this.store.getAll();
    for (const fc of comments) {
      this.createThread(fc);
    }
  }

  private createThread(fc: FeedbackComment): void {
    const uri = vscode.Uri.file(path.join(this.workspaceRoot, fc.file));
    const { start, end } = parseLineRange(fc.lines);
    const range = new vscode.Range(start - 1, 0, end - 1, 0); // 0-indexed

    const thread = this.controller.createCommentThread(uri, range, []);

    // Split the body by the thread delimiter
    const rawChunks = fc.body.split(/\n___\n/);
    const comments: ReviewComment[] = [];

    for (const chunk of rawChunks) {
      let authorName = 'human';
      let content = chunk;
      
      const authorMatch = chunk.match(/^\*\*([^*]+)\*\*:\n([\s\S]*)$/);
      if (authorMatch) {
        authorName = authorMatch[1].trim();
        content = authorMatch[2].trim();
      } else {
        content = chunk.trim();
      }

      if (content || rawChunks.length === 1) {
        const comment = new ReviewComment(
          fc.id,
          content,
          fc.severity,
          fc.status,
          vscode.CommentMode.Preview,
          thread,
          authorName
        );
        comments.push(comment);
      }
    }

    thread.comments = comments.length > 0 ? comments : [
      new ReviewComment(fc.id, fc.body, fc.severity, fc.status, vscode.CommentMode.Preview, thread, 'human')
    ];
    thread.label = fc.status === 'acknowledged' 
      ? `✅ ${SEVERITY_LABELS[fc.severity]} — ${fc.status}` 
      : `${SEVERITY_LABELS[fc.severity]} — ${fc.status}`;
    thread.canReply = true;
    thread.collapsibleState = fc.status === 'acknowledged'
      ? vscode.CommentThreadCollapsibleState.Collapsed
      : vscode.CommentThreadCollapsibleState.Expanded;
    thread.state = fc.status === 'acknowledged' ? vscode.CommentThreadState.Resolved : vscode.CommentThreadState.Unresolved;

    this.threads.set(fc.id, thread);
  }

  private getRelativePath(uri: vscode.Uri): { relativePath: string, repoRoot: string } | undefined {
    const absPath = uri.fsPath;
    const repos = this.store.getRepoRoots();
    // Find the longest repoRoot that matches, to handle nested repos if any
    let matchedRepo = '';
    for (const repoRoot of repos) {
      if (absPath.startsWith(repoRoot)) {
        if (repoRoot.length > matchedRepo.length) {
          matchedRepo = repoRoot;
        }
      }
    }
    
    let repoRoot = matchedRepo;
    if (!repoRoot) {
      const folder = vscode.workspace.getWorkspaceFolder(uri);
      repoRoot = folder ? folder.uri.fsPath : this.workspaceRoot;
    }
    
    if (!absPath.startsWith(repoRoot)) {
      return undefined;
    }
    return { relativePath: require('node:path').relative(repoRoot, absPath).replace(/\\/g, '/'), repoRoot };
  }
}

// --- Comment implementation ---

class ReviewComment implements vscode.Comment {
  label: string;
  savedBody: string | vscode.MarkdownString;

  // Properties for draft (unsaved) comments created via "Add Suggestion"
  isDraft?: boolean;
  file?: string;
  lines?: string;

  constructor(
    public readonly feedbackId: string,
    public body: string | vscode.MarkdownString,
    public readonly severity: Severity,
    public readonly status: 'open' | 'acknowledged',
    public mode: vscode.CommentMode,
    public readonly parent: vscode.CommentThread,
    public readonly authorName: string = 'human',
    public contextValue: string = 'canEdit'
  ) {
    this.savedBody = body;
    this.label = SEVERITY_LABELS[severity];
  }

  get author(): vscode.CommentAuthorInformation {
    return {
      name: this.authorName,
      iconPath: undefined,
    };
  }
}
