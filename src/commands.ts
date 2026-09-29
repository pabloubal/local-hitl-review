import * as vscode from 'vscode';
import * as path from 'node:path';
import { GitService } from './gitService.js';
import { FeedbackStore } from './feedbackStore.js';
import { ChangedFilesProvider, CompareMode } from './changedFilesProvider.js';
import { ReviewCommentController } from './commentController.js';
import { generateAgentPrompt } from './promptGenerator.js';
import { outputChannel } from './logger.js';
import { filterState } from './filterState.js';
import { Status, Severity, SEVERITY_ORDER } from './types.js';

export interface CommandContext {
  workspaceRoot: string;
  store: FeedbackStore;
  changedFilesProvider: ChangedFilesProvider;
  commentController: ReviewCommentController;
}

/**
 * Create a URI for a file at a specific git ref using the git-show scheme.
 * VSCode's git extension registers a content provider for this scheme.
 */
export function createGitUri(workspaceRoot: string, filePath: string, ref: string): vscode.Uri {
  const absolutePath = path.join(workspaceRoot, filePath);
  const query = JSON.stringify({ path: absolutePath, ref });
  return vscode.Uri.parse(`git:${absolutePath}`).with({ query });
}

export function registerAllCommands(context: vscode.ExtensionContext, cmdCtx: CommandContext) {
  const register = (id: string, handler: (...args: any[]) => any) => {
    context.subscriptions.push(vscode.commands.registerCommand(id, handler));
  };

  // -- Repo commands --
  register('vscodeComment.repo.refresh', (item) => {
    if (item && item.repo) {
      cmdCtx.changedFilesProvider.refresh();
    }
  });

  register('vscodeComment.repo.selectBaseBranch', async (item) => {
    if (!item || !item.repo) return;
    const branches = await item.repo.gitService.listBranches();
    const current = await item.repo.gitService.getCurrentBranch();
    const options = branches.filter((b: string) => b !== current);
    const selected = await vscode.window.showQuickPick(options, {
      placeHolder: `Select base branch for ${item.repo.name}`,
    });
    if (selected) {
      item.repo.overrideBaseBranch = selected;
      cmdCtx.changedFilesProvider.refresh();
    }
  });

  register('vscodeComment.repo.selectCompareMode', async (item) => {
    if (!item || !item.repo) return;
    const options = [
      {
        label: 'Commits vs Base',
        description: 'Show graph of commits',
        mode: 'commits' as const,
      },
      {
        label: 'All Changes vs Base',
        description: 'Show single diff for all changes',
        mode: 'branch' as const,
      },
    ];
    const selected = await vscode.window.showQuickPick(options, {
      placeHolder: `Select compare mode for ${item.repo.name}`,
    });
    if (selected) {
      item.repo.overrideCompareMode = { type: selected.mode };
      cmdCtx.changedFilesProvider.refresh();
    }
  });

  register('vscodeComment.repo.openChanges', async (item) => {
    if (!item || !item.repo) return;
    const changes = item.repo.changedFiles;
    if (changes.length === 0) {
      vscode.window.showInformationMessage('No changes found.');
      return;
    }
    for (const file of changes) {
      vscode.commands.executeCommand(
        'vscodeComment.openDiff',
        file,
        item.repo.compareRef,
        item.repo.gitService,
      );
    }
  });

  register('vscodeComment.repo.initFeedback', async (item) => {
    if (!item || !item.repo) return;
    const dir = cmdCtx.store.getFeedbackDirForRepo(item.repo.gitService.repoRoot, true);
    await cmdCtx.store.initializeDir(dir);
    const agentsFile = cmdCtx.store.getAgentsFilePath(item.repo.gitService.repoRoot, true);
    const uri = vscode.Uri.file(agentsFile);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);
  });

  // -- File marking --
  register('vscodeComment.file.markViewed', (item) => {
    if (item && item.changedFile && item.gitService) {
      cmdCtx.changedFilesProvider.setFileViewed(
        item.gitService.repoRoot,
        item.commitHash || 'UNCOMMITTED',
        item.changedFile.originalPath || item.changedFile.path,
        true,
      );
    }
  });

  register('vscodeComment.file.unmarkViewed', (item) => {
    if (item && item.changedFile && item.gitService) {
      cmdCtx.changedFilesProvider.setFileViewed(
        item.gitService.repoRoot,
        item.commitHash || 'UNCOMMITTED',
        item.changedFile.originalPath || item.changedFile.path,
        false,
      );
    }
  });

  // -- Filters and refresh --
  register('vscodeComment.filterFeedbackTree', async () => {
    const allStatuses: Status[] = ['open', 'acknowledged', 'resolved', 'wontfix'];
    const statusItems: vscode.QuickPickItem[] = allStatuses.map((s) => ({
      label: `Status: ${s}`,
      description: filterState.statuses.has(s) ? 'Active' : '',
      picked: filterState.statuses.has(s),
    }));

    const severityItems: vscode.QuickPickItem[] = SEVERITY_ORDER.map((s) => ({
      label: `Severity: ${s}`,
      description: filterState.severities.has(s) ? 'Active' : '',
      picked: filterState.severities.has(s),
    }));

    const items = [...statusItems, { label: '', kind: vscode.QuickPickItemKind.Separator }, ...severityItems];
    const selected = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      placeHolder: 'Select statuses and severities to show (if a category is empty, it does not filter)',
    });

    if (selected !== undefined) {
      const statuses = selected
        .filter((i) => i.label.startsWith('Status: '))
        .map((i) => i.label.replace('Status: ', '') as Status);
      const severities = selected
        .filter((i) => i.label.startsWith('Severity: '))
        .map((i) => i.label.replace('Severity: ', '') as Severity);
      filterState.update(severities, statuses);
    }
  });

  register('vscodeComment.refreshChanges', () => {
    cmdCtx.changedFilesProvider.refresh();
  });

  register('vscodeComment.viewAsTree', () => {
    cmdCtx.changedFilesProvider.toggleTreeView(true);
  });

  register('vscodeComment.viewAsList', () => {
    cmdCtx.changedFilesProvider.toggleTreeView(false);
  });

  register('vscodeComment.initFeedbackWorkspace', async () => {
    await cmdCtx.store.initializeWorkspace();
    vscode.window.showInformationMessage(
      'Local HITL Review workspace initialized (.feedback directory created).',
    );
  });

  // -- Diff and Branch selection --
  register('vscodeComment.selectBaseBranch', async () => {
    const gitService = cmdCtx.changedFilesProvider.getFirstGitService();
    if (!gitService) {
      vscode.window.showErrorMessage('No git repository found');
      return;
    }
    const branches = await gitService.listBranches();
    const currentBranch = await gitService.getCurrentBranch();
    const items = branches
      .filter((b) => b !== currentBranch)
      .map((b) => ({
        label: b,
        description: b === cmdCtx.changedFilesProvider.getBaseBranch() ? '(current base)' : undefined,
      }));

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select the base branch to compare against',
      title: 'Base Branch',
    });

    if (picked) {
      await cmdCtx.changedFilesProvider.refresh(picked.label);
    }
  });

  register('vscodeComment.showLogs', () => {
    outputChannel.show(true);
  });

  register('vscodeComment.selectCompareMode', async () => {
    const baseBranch = cmdCtx.changedFilesProvider.getBaseBranch();
    const currentMode = cmdCtx.changedFilesProvider.getCompareMode();

    interface CompareModeItem extends vscode.QuickPickItem {
      mode: CompareMode;
    }

    const items: CompareModeItem[] = [
      {
        label: '$(git-merge) Entire branch',
        description: `All changes since branching from ${baseBranch || 'base'}`,
        detail: currentMode.type === 'branch' ? '$(check) Currently selected' : undefined,
        mode: { type: 'branch' },
      },
      {
        label: '$(history) Commits (Graph)',
        description: 'View commits in this branch',
        detail: currentMode.type === 'commits' ? '$(check) Currently selected' : undefined,
        mode: { type: 'commits' },
      },
    ];

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'What changes do you want to review?',
      title: 'Compare Mode',
    });

    if (picked) {
      await cmdCtx.changedFilesProvider.setCompareMode(picked.mode);
    }
  });

  register('vscodeComment.setFeedbackDir', async () => {
    const current = cmdCtx.store.getAllFeedbackDirs()[0];
    const relative = path.relative(cmdCtx.workspaceRoot, current);

    const input = await vscode.window.showInputBox({
      prompt: 'Feedback directory (relative to workspace root)',
      value: relative,
      placeHolder: '.feedback',
    });

    if (input !== undefined) {
      const config = vscode.workspace.getConfiguration('vscodeComment');
      await config.update('feedbackDirectory', input, vscode.ConfigurationTarget.Workspace);
    }
  });

  register('vscodeComment.copyAgentPrompt', async () => {
    const agentsFile = cmdCtx.store.getAgentsFilePath();
    const text = generateAgentPrompt(cmdCtx.workspaceRoot, agentsFile, cmdCtx.store.getAll());
    await vscode.env.clipboard.writeText(text);
    vscode.window.showInformationMessage(`Copied agent prompt to clipboard`);
  });

  register('vscodeComment.finishReview', async () => {
    const allComments = cmdCtx.store.getAll();
    const byRepo = new Map<string, typeof allComments>();
    for (const comment of allComments) {
      const repo = comment.repo || cmdCtx.workspaceRoot;
      if (!byRepo.has(repo)) {
        byRepo.set(repo, []);
      }
      byRepo.get(repo)!.push(comment);
    }

    if (byRepo.size === 0) {
      byRepo.set(cmdCtx.workspaceRoot, []);
    }

    for (const [repoRoot, comments] of byRepo.entries()) {
      const feedbackDir = cmdCtx.store.getFeedbackDirForRepo(repoRoot, true);
      const summaryPath = path.join(feedbackDir, 'review-complete.md');

      const openComments = comments.filter((c) => c.status === 'open');
      const bySeverity = { critical: 0, high: 0, medium: 0, low: 0 };
      for (const c of openComments) {
        bySeverity[c.severity]++;
      }

      const content = [
        `# Review Complete`,
        `Date: ${new Date().toISOString()}`,
        ``,
        `## Summary`,
        `- **Critical**: ${bySeverity.critical}`,
        `- **High**: ${bySeverity.high}`,
        `- **Medium**: ${bySeverity.medium}`,
        `- **Low**: ${bySeverity.low}`,
        ``,
        `## Open Findings`,
        ...openComments.map((c) => `- [${c.severity}] ${c.file}:${c.lines}`),
      ].join('\n');

      const fs = await import('node:fs/promises');
      await fs.mkdir(feedbackDir, { recursive: true });
      await fs.writeFile(summaryPath, content, 'utf8');
    }

    vscode.window.showInformationMessage('Review finished. Summary generated.');
  });

  register('vscodeComment.openAllChanges', async () => {
    await cmdCtx.changedFilesProvider.loadAllRepos();
    const files = cmdCtx.changedFilesProvider.getChangedFiles();
    if (files.length === 0) {
      vscode.window.showInformationMessage('No changes to show.');
      return;
    }
    const resources: any[] = [];
    for (const f of files) {
      const filePath = f.path;
      const originalPath = f.originalPath ?? filePath;
      const workingUri = vscode.Uri.file(path.join(cmdCtx.workspaceRoot, filePath));
      const compareRef = cmdCtx.changedFilesProvider.getCompareRef(f.repoRoot);
      if (!compareRef) {
        vscode.window.showWarningMessage('No compare reference for ' + f.path);
        continue;
      }
      const baseUri = createGitUri(cmdCtx.workspaceRoot, originalPath, compareRef);

      let title = path.basename(filePath);
      if (f.status === 'A') title = `${title} (Added)`;
      else if (f.status === 'D') title = `${title} (Deleted)`;
      else if (f.status === 'R') title = `${title} (Renamed)`;

      resources.push([
        workingUri,
        f.status === 'A' ? vscode.Uri.parse('empty:empty') : baseUri,
        f.status === 'D' ? vscode.Uri.parse('empty:empty') : workingUri,
      ]);
    }

    const title = `All Changes (${cmdCtx.changedFilesProvider.getCompareLabel()})`;
    await vscode.commands.executeCommand('vscode.changes', title, resources);
  });

  register('vscodeComment.openCommitChanges', async (item: any) => {
    if (item.contextValue === 'workInProgressItem') {
      const itemGitService: GitService = item.gitService;
      if (!itemGitService) return;
      const files = await itemGitService.getUncommittedChanges();
      if (files.length === 0) {
        vscode.window.showInformationMessage('No uncommitted changes.');
        return;
      }
      const relativePrefix = require('node:path')
        .relative(cmdCtx.workspaceRoot, itemGitService.repoRoot)
        .replace(/\\/g, '/');
      const toWorkspacePath = (p: string) => (relativePrefix ? `${relativePrefix}/${p}` : p);
      const resources: any[] = [];
      for (const f of files) {
        const filePath = toWorkspacePath(f.path);
        const originalPath = toWorkspacePath(f.originalPath ?? f.path);
        const baseUri = createGitUri(cmdCtx.workspaceRoot, originalPath, 'HEAD');
        const currentUri = vscode.Uri.file(require('node:path').join(cmdCtx.workspaceRoot, filePath));

        resources.push([
          currentUri,
          f.status === 'A' ? vscode.Uri.parse('empty:empty') : baseUri,
          f.status === 'D' ? vscode.Uri.parse('empty:empty') : currentUri,
        ]);
      }
      await vscode.commands.executeCommand('vscode.changes', 'Work in progress', resources);
      return;
    }

    const commit = item.commit;
    const itemGitService: GitService = item.gitService;
    if (!itemGitService) return;
    const files = await itemGitService.getCommitChanges(commit.hash);
    if (files.length === 0) {
      vscode.window.showInformationMessage('No changes in this commit.');
      return;
    }

    const relativePrefix = require('node:path')
      .relative(cmdCtx.workspaceRoot, itemGitService.repoRoot)
      .replace(/\\/g, '/');
    const toWorkspacePath = (p: string) => (relativePrefix ? `${relativePrefix}/${p}` : p);
    const resources: any[] = [];
    for (const f of files) {
      const filePath = toWorkspacePath(f.path);
      const originalPath = toWorkspacePath(f.originalPath ?? f.path);

      const baseUri = createGitUri(cmdCtx.workspaceRoot, originalPath, `${commit.hash}~1`);
      const commitUri = createGitUri(cmdCtx.workspaceRoot, filePath, commit.hash);

      resources.push([
        commitUri,
        f.status === 'A' ? vscode.Uri.parse('empty:empty') : baseUri,
        f.status === 'D' ? vscode.Uri.parse('empty:empty') : commitUri,
      ]);
    }

    const title = `Commit: ${commit.shortHash} - ${commit.subject}`;
    await vscode.commands.executeCommand('vscode.changes', title, resources);
  });

  register('vscodeComment.nextUnreviewedFile', async () => {
    let currentFilePath: string | undefined;
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      currentFilePath = editor.document.uri.fsPath;
    }

    const next = await cmdCtx.changedFilesProvider.getNextUnreviewedFile(currentFilePath);
    if (!next) {
      vscode.window.showInformationMessage('No unreviewed files left.');
      return;
    }

    await vscode.commands.executeCommand(
      'vscodeComment.openDiff',
      next.file,
      next.commitHash,
      next.gitService,
    );
  });

  register('vscodeComment.openDiff', async (changedFile: any, commitHash?: string) => {
    let compareRef = cmdCtx.changedFilesProvider.getCompareRef(changedFile.repoRoot);
    if (commitHash) {
      if (commitHash === 'UNCOMMITTED') {
        compareRef = 'HEAD';
      } else {
        compareRef = `${commitHash}~1`;
      }
    } else if (!compareRef) {
      vscode.window.showWarningMessage('No compare reference computed yet. Refresh first.');
      return;
    }

    const filePath = changedFile.path;
    let rightUri = vscode.Uri.file(path.join(cmdCtx.workspaceRoot, filePath));
    if (commitHash && commitHash !== 'UNCOMMITTED') {
      rightUri = createGitUri(cmdCtx.workspaceRoot, filePath, commitHash);
    }

    if (changedFile.status === 'A') {
      await vscode.window.showTextDocument(rightUri);
      return;
    }

    if (changedFile.status === 'D') {
      const gitUri = createGitUri(cmdCtx.workspaceRoot, filePath, compareRef);
      await vscode.window.showTextDocument(gitUri);
      return;
    }

    const originalPath = changedFile.originalPath ?? filePath;
    const baseUri = createGitUri(cmdCtx.workspaceRoot, originalPath, compareRef);

    let title = `${path.basename(filePath)} (${cmdCtx.changedFilesProvider.getCompareLabel()} ↔ Working)`;
    if (commitHash) {
      if (commitHash === 'UNCOMMITTED') {
        title = `${path.basename(filePath)} (Work in progress)`;
      } else {
        title = `${path.basename(filePath)} (Commit ${commitHash.substring(0, 7)})`;
      }
    }

    await vscode.commands.executeCommand('vscode.diff', baseUri, rightUri, title);
  });

  // -- Comment Actions --
  register('vscodeComment.createComment', (reply: vscode.CommentReply) => {
    cmdCtx.commentController.createComment(reply);
  });

  register('vscodeComment.createCommentWithSuggestion', (reply: vscode.CommentReply) => {
    cmdCtx.commentController.createCommentWithSuggestion(reply);
  });

  register('vscodeComment.insertSuggestionIntoComment', (comment: any) => {
    cmdCtx.commentController.insertSuggestionIntoComment(comment);
  });

  register('vscodeComment.deleteComment', (comment: any) => {
    cmdCtx.commentController.deleteComment(comment);
  });

  register('vscodeComment.editComment', (comment: any) => {
    cmdCtx.commentController.editComment(comment);
  });

  register('vscodeComment.saveComment', (comment: any) => {
    cmdCtx.commentController.saveComment(comment);
  });

  register('vscodeComment.applySuggestion', (comment: any) => {
    cmdCtx.commentController.applySuggestion(comment);
  });

  register('vscodeComment.cancelEdit', (comment: any) => {
    cmdCtx.commentController.cancelEdit(comment);
  });

  register('vscodeComment.setSeverityCritical', (comment: any) => {
    cmdCtx.commentController.setSeverity(comment, 'critical');
  });

  register('vscodeComment.setSeverityHigh', (comment: any) => {
    cmdCtx.commentController.setSeverity(comment, 'high');
  });

  register('vscodeComment.setSeverityMedium', (comment: any) => {
    cmdCtx.commentController.setSeverity(comment, 'medium');
  });

  register('vscodeComment.setSeverityLow', (comment: any) => {
    cmdCtx.commentController.setSeverity(comment, 'low');
  });

  register('vscodeComment.setStatusOpen', (comment: any) => {
    cmdCtx.commentController.setStatus(comment, 'open');
  });

  register('vscodeComment.setStatusResolved', (comment: any) => {
    cmdCtx.commentController.setStatus(comment, 'resolved');
  });

  register('vscodeComment.setStatusWontfix', (comment: any) => {
    cmdCtx.commentController.setStatus(comment, 'wontfix');
  });

  register('vscodeComment.discardNewThread', (reply: vscode.CommentReply) => {
    if (reply && reply.thread) {
      reply.thread.dispose();
    }
  });
}
