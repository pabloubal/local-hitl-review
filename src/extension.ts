import * as vscode from 'vscode';
import { FeedbackStore } from './feedbackStore.js';
import { ChangedFilesProvider, ReviewFileDecorationProvider } from './changedFilesProvider.js';
import { FeedbackSummaryProvider } from './feedbackSummaryProvider.js';
import { ReviewCommentController } from './commentController.js';
import { log } from './logger.js';
import { registerAllCommands } from './commands.js';

class EmptyContentProvider implements vscode.TextDocumentContentProvider {
  provideTextDocumentContent(uri: vscode.Uri): string {
    return '';
  }
}

export async function activate(context: vscode.ExtensionContext) {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    return;
  }

  const workspaceRoot = workspaceFolder.uri.fsPath;

  // --- Services ---
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider('empty', new EmptyContentProvider()),
  );
  const store = new FeedbackStore(workspaceRoot);
  await store.initialize();

  // --- Changed Files TreeView ---
  const changedFilesProvider = new ChangedFilesProvider(workspaceRoot, context, store);
  await changedFilesProvider.initialize();
  const fileDecorationProvider = new ReviewFileDecorationProvider(store, workspaceRoot);
  context.subscriptions.push(vscode.window.registerFileDecorationProvider(fileDecorationProvider));
  context.subscriptions.push(fileDecorationProvider);

  // --- Feedback Summary TreeView ---
  const feedbackSummaryProvider = new FeedbackSummaryProvider(store, workspaceRoot);
  const feedbackSummaryTreeView = vscode.window.createTreeView('vscodeComment.feedbackSummary', {
    treeDataProvider: feedbackSummaryProvider,
    showCollapseAll: true,
  });
  context.subscriptions.push(feedbackSummaryTreeView, feedbackSummaryProvider);

  const treeView = vscode.window.createTreeView('vscodeComment.changedFiles', {
    treeDataProvider: changedFilesProvider,
    showCollapseAll: false,
  });

  // --- Auto-refresh on Git State Change ---
  const gitExtension = vscode.extensions.getExtension('vscode.git');
  if (gitExtension) {
    try {
      const gitExt = gitExtension.isActive ? gitExtension.exports : await gitExtension.activate();
      const git = gitExt.getAPI(1);

      let refreshTimeout: NodeJS.Timeout | undefined;
      const debouncedRefresh = () => {
        if (refreshTimeout) clearTimeout(refreshTimeout);
        refreshTimeout = setTimeout(() => {
          changedFilesProvider.refresh();
        }, 1000);
      };

      const bindRepoListener = (repo: any) => {
        context.subscriptions.push(repo.state.onDidChange(() => debouncedRefresh()));
      };

      git.repositories.forEach(bindRepoListener);
      context.subscriptions.push(git.onDidOpenRepository(bindRepoListener));
    } catch (e) {
      log('Failed to connect to Git extension API for auto-refresh: ' + e);
    }
  }

  // --- Comment Controller ---
  const commentController = new ReviewCommentController(store, workspaceRoot, () =>
    changedFilesProvider.getChangedFilePaths(),
  );

  // --- Commands ---
  registerAllCommands(context, {
    workspaceRoot,
    store,
    changedFilesProvider,
    commentController,
  });

  // --- Cleanup ---
  context.subscriptions.push(treeView, changedFilesProvider, commentController, store);

  // --- Initial Load ---
  await changedFilesProvider.refresh();
  await commentController.initialize();

  // Update tree view title with compare info
  changedFilesProvider.onDidChangeTreeData(() => {
    const label = changedFilesProvider.getCompareLabel();
    if (label) {
      treeView.description = label;
      treeView.title = 'Local HITL Review';
    }
  });
}

export function deactivate() {}
