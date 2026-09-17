import * as vscode from 'vscode';
import * as path from 'node:path';
import { GitService } from './gitService.js';
import { FeedbackStore } from './feedbackStore.js';
import { ChangedFilesProvider } from './changedFilesProvider.js';
import { ReviewCommentController } from './commentController.js';
import type { ChangedFile } from './types.js';
import type { CompareMode } from './changedFilesProvider.js';

export async function activate(context: vscode.ExtensionContext) {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    return;
  }

  const workspaceRoot = workspaceFolder.uri.fsPath;

  // --- Services ---
  const gitService = new GitService(workspaceRoot);
  const store = new FeedbackStore(workspaceRoot);
  await store.initialize();

  // --- Changed Files TreeView ---
  const changedFilesProvider = new ChangedFilesProvider(gitService, workspaceRoot);
  const treeView = vscode.window.createTreeView('vscodeComment.changedFiles', {
    treeDataProvider: changedFilesProvider,
    showCollapseAll: false,
  });

  // --- Comment Controller ---
  const commentController = new ReviewCommentController(
    store,
    workspaceRoot,
    () => changedFilesProvider.getChangedFilePaths()
  );

  // --- Commands ---

  // Refresh changed files
  context.subscriptions.push(
    vscode.commands.registerCommand('vscodeComment.refreshChanges', () => {
      changedFilesProvider.refresh();
    })
  );

  // Toggle view modes
  context.subscriptions.push(
    vscode.commands.registerCommand('vscodeComment.viewAsTree', () => {
      changedFilesProvider.toggleTreeView(true);
    }),
    vscode.commands.registerCommand('vscodeComment.viewAsList', () => {
      changedFilesProvider.toggleTreeView(false);
    })
  );

  // Initialize feedback workspace
  context.subscriptions.push(
    vscode.commands.registerCommand('vscodeComment.initFeedbackWorkspace', async () => {
      await store.initializeWorkspace();
      vscode.window.showInformationMessage('Local HITL Review workspace initialized (.feedback directory created).');
    })
  );

  // Select base branch
  context.subscriptions.push(
    vscode.commands.registerCommand('vscodeComment.selectBaseBranch', async () => {
      const branches = await gitService.listBranches();
      const currentBranch = await gitService.getCurrentBranch();
      const items = branches
        .filter((b) => b !== currentBranch)
        .map((b) => ({
          label: b,
          description: b === changedFilesProvider.getBaseBranch() ? '(current base)' : undefined,
        }));

      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select the base branch to compare against',
        title: 'Base Branch',
      });

      if (picked) {
        await changedFilesProvider.refresh(picked.label);
      }
    })
  );

  // Select compare mode (entire branch / specific commit / uncommitted)
  context.subscriptions.push(
    vscode.commands.registerCommand('vscodeComment.selectCompareMode', async () => {
      const baseBranch = changedFilesProvider.getBaseBranch();
      const currentMode = changedFilesProvider.getCompareMode();

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
          label: '$(git-commit) Uncommitted changes',
          description: 'Staged + unstaged changes vs HEAD',
          detail: currentMode.type === 'uncommitted' ? '$(check) Currently selected' : undefined,
          mode: { type: 'uncommitted' },
        },
        {
          label: '$(history) Commits (Graph)',
          description: 'View commits in this branch',
          mode: { type: 'commits' },
        },
      ];

      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: 'What changes do you want to review?',
        title: 'Compare Mode',
      });

      if (!picked) { return; }

      await changedFilesProvider.setCompareMode(picked.mode);
    })
  );

  // Set feedback directory
  context.subscriptions.push(
    vscode.commands.registerCommand('vscodeComment.setFeedbackDir', async () => {
      const current = store.getFeedbackDir();
      const relative = path.relative(workspaceRoot, current);

      const input = await vscode.window.showInputBox({
        prompt: 'Feedback directory (relative to workspace root)',
        value: relative,
        placeHolder: '.feedback',
      });

      if (input !== undefined) {
        const config = vscode.workspace.getConfiguration('vscodeComment');
        await config.update('feedbackDirectory', input, vscode.ConfigurationTarget.Workspace);
      }
    })
  );

  // Open all changes in a multi-file diff editor
  context.subscriptions.push(
    vscode.commands.registerCommand('vscodeComment.openAllChanges', async () => {
      const compareRef = changedFilesProvider.getCompareRef();
      if (!compareRef) {
        vscode.window.showWarningMessage('No compare reference computed yet. Refresh first.');
        return;
      }
      const files = changedFilesProvider.getChangedFiles();
      if (files.length === 0) {
        vscode.window.showInformationMessage('No changes to show.');
        return;
      }
      
      const resources: any[] = [];
      for (const f of files) {
        const filePath = f.path;
        const originalPath = f.originalPath ?? filePath;
        const workingUri = vscode.Uri.file(path.join(workspaceRoot, filePath));
        const baseUri = createGitUri(workspaceRoot, originalPath, compareRef);
        
        let title = path.basename(filePath);
        if (f.status === 'A') title = `${title} (Added)`;
        else if (f.status === 'D') title = `${title} (Deleted)`;
        else if (f.status === 'R') title = `${title} (Renamed)`;
        
        resources.push([
          workingUri,
          f.status === 'A' ? vscode.Uri.file(path.join(workspaceRoot, '.git', 'empty')) : baseUri,
          f.status === 'D' ? vscode.Uri.file(path.join(workspaceRoot, '.git', 'empty')) : workingUri
        ]);
      }
      
      const title = `All Changes (${changedFilesProvider.getCompareLabel()})`;
      await vscode.commands.executeCommand('vscode.changes', title, resources);
    })
  );

  // Open changes for a specific commit in a multi-file diff editor
  context.subscriptions.push(
    vscode.commands.registerCommand('vscodeComment.openCommitChanges', async (commitItem: any) => {
      const commit = commitItem.commit;
      const files = await gitService.getCommitChanges(commit.hash);
      if (files.length === 0) {
        vscode.window.showInformationMessage('No changes in this commit.');
        return;
      }
      
      const resources: any[] = [];
      for (const f of files) {
        const filePath = f.path;
        const originalPath = f.originalPath ?? filePath;
        
        const baseUri = createGitUri(workspaceRoot, originalPath, `${commit.hash}~1`);
        const commitUri = createGitUri(workspaceRoot, filePath, commit.hash);
        
        let title = path.basename(filePath);
        if (f.status === 'A') title = `${title} (Added)`;
        else if (f.status === 'D') title = `${title} (Deleted)`;
        else if (f.status === 'R') title = `${title} (Renamed)`;
        
        resources.push([
          commitUri,
          f.status === 'A' ? vscode.Uri.file(path.join(workspaceRoot, '.git', 'empty')) : baseUri,
          f.status === 'D' ? vscode.Uri.file(path.join(workspaceRoot, '.git', 'empty')) : commitUri
        ]);
      }
      
      const title = `Commit: ${commit.shortHash} - ${commit.subject}`;
      await vscode.commands.executeCommand('vscode.changes', title, resources);
    })
  );

  // Open diff for a changed file
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'vscodeComment.openDiff',
      async (changedFile: ChangedFile) => {
        const compareRef = changedFilesProvider.getCompareRef();
        if (!compareRef) {
          vscode.window.showWarningMessage('No compare reference computed yet. Refresh first.');
          return;
        }

        const filePath = changedFile.path;
        const workingUri = vscode.Uri.file(path.join(workspaceRoot, filePath));

        if (changedFile.status === 'A') {
          // New file — just open it
          await vscode.window.showTextDocument(workingUri);
          return;
        }

        if (changedFile.status === 'D') {
          // Deleted file — show the old version
          const gitUri = createGitUri(workspaceRoot, filePath, compareRef);
          await vscode.window.showTextDocument(gitUri);
          return;
        }

        // Modified, renamed, copied — show diff
        const originalPath = changedFile.originalPath ?? filePath;
        const baseUri = createGitUri(workspaceRoot, originalPath, compareRef);
        const title = `${path.basename(filePath)} (${changedFilesProvider.getCompareLabel()} ↔ Working)`;

        await vscode.commands.executeCommand('vscode.diff', baseUri, workingUri, title);
      }
    )
  );

  // Comment actions
  context.subscriptions.push(
    vscode.commands.registerCommand('vscodeComment.createComment', (reply: vscode.CommentReply) => {
      commentController.createComment(reply);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('vscodeComment.createCommentWithSuggestion', (reply: vscode.CommentReply) => {
      commentController.createCommentWithSuggestion(reply);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('vscodeComment.insertSuggestionIntoComment', (comment: any) => {
      commentController.insertSuggestionIntoComment(comment);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('vscodeComment.deleteComment', (comment: any) => {
      commentController.deleteComment(comment);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('vscodeComment.editComment', (comment: any) => {
      commentController.editComment(comment);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('vscodeComment.saveComment', (comment: any) => {
      commentController.saveComment(comment);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('vscodeComment.applySuggestion', (comment: any) => {
      commentController.applySuggestion(comment);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('vscodeComment.cancelEdit', (comment: any) => {
      commentController.cancelEdit(comment);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('vscodeComment.setSeverityCritical', (comment: any) => {
      commentController.setSeverity(comment, 'critical');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('vscodeComment.setSeverityHigh', (comment: any) => {
      commentController.setSeverity(comment, 'high');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('vscodeComment.setSeverityMedium', (comment: any) => {
      commentController.setSeverity(comment, 'medium');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('vscodeComment.setSeverityLow', (comment: any) => {
      commentController.setSeverity(comment, 'low');
    })
  );

  // --- Cleanup ---
  context.subscriptions.push(treeView, changedFilesProvider, commentController, store);

  // --- Initial Load ---
  await changedFilesProvider.refresh();
  await commentController.initialize();

  // Update tree view title with compare info
  changedFilesProvider.onDidChangeTreeData(() => {
    const label = changedFilesProvider.getCompareLabel();
    if (label) {
      treeView.title = `Review: ${label}`;
    }
  });
}

export function deactivate() {}

// --- Helpers ---

/**
 * Create a URI for a file at a specific git ref using the git-show scheme.
 * VSCode's git extension registers a content provider for this scheme.
 */
function createGitUri(
  workspaceRoot: string,
  filePath: string,
  ref: string
): vscode.Uri {
  const absolutePath = path.join(workspaceRoot, filePath);
  const query = JSON.stringify({ path: absolutePath, ref });
  return vscode.Uri.parse(`git:${absolutePath}`).with({ query });
}
