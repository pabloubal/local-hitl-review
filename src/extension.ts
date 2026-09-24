import * as vscode from 'vscode';
import * as path from 'node:path';
import { GitService } from './gitService.js';
import { FeedbackStore } from './feedbackStore.js';
import { ChangedFilesProvider, ReviewFileDecorationProvider } from './changedFilesProvider.js';
import { ReviewCommentController } from './commentController.js';
import { outputChannel, log } from './logger.js';
import type { ChangedFile } from './types.js';
import type { CompareMode } from './changedFilesProvider.js';


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
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('empty', new EmptyContentProvider()));
  const store = new FeedbackStore(workspaceRoot);
  await store.initialize();

  // --- Changed Files TreeView ---
  const changedFilesProvider = new ChangedFilesProvider(workspaceRoot, context, store);
  await changedFilesProvider.initialize();
  context.subscriptions.push(vscode.window.registerFileDecorationProvider(new ReviewFileDecorationProvider()));

  context.subscriptions.push(
    vscode.commands.registerCommand('vscodeComment.repo.refresh', (item) => {
      if (item && item.repo) {
        // We could just refresh everything, or add a targeted refresh.
        // For simplicity, we just trigger a full refresh but we can optimize later.
        changedFilesProvider.refresh();
      }
    }),
    vscode.commands.registerCommand('vscodeComment.repo.selectBaseBranch', async (item) => {
      if (!item || !item.repo) return;
      const branches = await item.repo.gitService.listBranches();
      const current = await item.repo.gitService.getCurrentBranch();
      const options = branches.filter((b: string) => b !== current);
      const selected = await vscode.window.showQuickPick(options, {
        placeHolder: `Select base branch for ${item.repo.name}`,
      });
      if (selected) {
        item.repo.overrideBaseBranch = selected;
        changedFilesProvider.refresh();
      }
    }),
    vscode.commands.registerCommand('vscodeComment.repo.selectCompareMode', async (item) => {
      if (!item || !item.repo) return;
      const options = [
        { label: 'Commits vs Base', description: 'Show graph of commits', mode: 'commits' as const },
        { label: 'All Changes vs Base', description: 'Show single diff for all changes', mode: 'branch' as const }
      ];
      const selected = await vscode.window.showQuickPick(options, {
        placeHolder: `Select compare mode for ${item.repo.name}`,
      });
      if (selected) {
        item.repo.overrideCompareMode = { type: selected.mode };
        changedFilesProvider.refresh();
      }
    }),
    vscode.commands.registerCommand('vscodeComment.repo.openChanges', async (item) => {
      if (!item || !item.repo) return;
      const changes = item.repo.changedFiles;
      if (changes.length === 0) {
        vscode.window.showInformationMessage('No changes found.');
        return;
      }
      for (const file of changes) {
        vscode.commands.executeCommand('vscodeComment.openDiff', file, item.repo.compareRef, item.repo.gitService);
      }
    }),
    vscode.commands.registerCommand('vscodeComment.repo.initFeedback', async (item) => {
      if (!item || !item.repo) return;
      // Force local folder creation for this repository, bypassing global scope
      const dir = store.getFeedbackDirForRepo(item.repo.gitService.repoRoot, true);
      await store.initializeDir(dir);
      const agentsFile = store.getAgentsFilePath(item.repo.gitService.repoRoot, true);
      const uri = vscode.Uri.file(agentsFile);
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('vscodeComment.file.markViewed', (item) => {
      if (item && item.changedFile && item.gitService) {
        changedFilesProvider.setFileViewed(item.gitService.repoRoot, item.commitHash || 'UNCOMMITTED', item.changedFile.originalPath || item.changedFile.path, true);
      }
    }),
    vscode.commands.registerCommand('vscodeComment.file.unmarkViewed', (item) => {
      if (item && item.changedFile && item.gitService) {
        changedFilesProvider.setFileViewed(item.gitService.repoRoot, item.commitHash || 'UNCOMMITTED', item.changedFile.originalPath || item.changedFile.path, false);
      }
    })
  );

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
        context.subscriptions.push(
          repo.state.onDidChange(() => debouncedRefresh())
        );
      };

      git.repositories.forEach(bindRepoListener);
      context.subscriptions.push(git.onDidOpenRepository(bindRepoListener));
    } catch (e) {
      log('Failed to connect to Git extension API for auto-refresh: ' + e);
    }
  }

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
      const gitService = changedFilesProvider.getFirstGitService();
      if (!gitService) { vscode.window.showErrorMessage('No git repository found'); return; }
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
    vscode.commands.registerCommand('vscodeComment.showLogs', () => {
      outputChannel.show(true);
    }),
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

      if (!picked) { return; }

      await changedFilesProvider.setCompareMode(picked.mode);
    })
  );

  // Set feedback directory
  context.subscriptions.push(
    vscode.commands.registerCommand('vscodeComment.setFeedbackDir', async () => {
      const current = store.getAllFeedbackDirs()[0]; // Fallback to first dir or we could ask which repo
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

  // Copy agent prompt to clipboard
  context.subscriptions.push(
    vscode.commands.registerCommand('vscodeComment.copyAgentPrompt', async () => {
      const agentsFile = store.getAgentsFilePath();
      const relative = path.relative(workspaceRoot, agentsFile).replace(/\\/g, '/');
      const text = `@${relative}`;
      await vscode.env.clipboard.writeText(text);
      vscode.window.showInformationMessage(`Copied to clipboard: ${text}`);
    })
  );

  // Open all changes in a multi-file diff editor
  context.subscriptions.push(
    vscode.commands.registerCommand('vscodeComment.openAllChanges', async () => {
      // Load all lazy repos before getting all changes
      await changedFilesProvider.loadAllRepos();
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
        const compareRef = changedFilesProvider.getCompareRef(f.repoRoot);
        if (!compareRef) { vscode.window.showWarningMessage('No compare reference for ' + f.path); continue; }
        const baseUri = createGitUri(workspaceRoot, originalPath, compareRef);
        
        let title = path.basename(filePath);
        if (f.status === 'A') title = `${title} (Added)`;
        else if (f.status === 'D') title = `${title} (Deleted)`;
        else if (f.status === 'R') title = `${title} (Renamed)`;
        
        resources.push([
          workingUri,
          f.status === 'A' ? vscode.Uri.parse('empty:empty') : baseUri,
          f.status === 'D' ? vscode.Uri.parse('empty:empty') : workingUri
        ]);
      }
      
      const title = `All Changes (${changedFilesProvider.getCompareLabel()})`;
      await vscode.commands.executeCommand('vscode.changes', title, resources);
    })
  );

  // Open changes for a specific commit in a multi-file diff editor
  context.subscriptions.push(
    vscode.commands.registerCommand('vscodeComment.openCommitChanges', async (item: any) => {
      if (item.contextValue === 'workInProgressItem') {
        const itemGitService: GitService = item.gitService;
        if (!itemGitService) return;
        const files = await itemGitService.getUncommittedChanges();
        if (files.length === 0) {
          vscode.window.showInformationMessage('No uncommitted changes.');
          return;
        }
        const relativePrefix = require('node:path').relative(workspaceRoot, itemGitService.repoRoot).replace(/\\/g, '/');
        const toWorkspacePath = (p: string) => relativePrefix ? `${relativePrefix}/${p}` : p;
        const resources: any[] = [];
        for (const f of files) {
          const filePath = toWorkspacePath(f.path);
          const originalPath = toWorkspacePath(f.originalPath ?? f.path);
          const baseUri = createGitUri(workspaceRoot, originalPath, 'HEAD');
          const currentUri = vscode.Uri.file(require('node:path').join(workspaceRoot, filePath));
          
          resources.push([
            currentUri,
            f.status === 'A' ? vscode.Uri.parse('empty:empty') : baseUri,
            f.status === 'D' ? vscode.Uri.parse('empty:empty') : currentUri
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
      
      const relativePrefix = require('node:path').relative(workspaceRoot, itemGitService.repoRoot).replace(/\\/g, '/');
      const toWorkspacePath = (p: string) => relativePrefix ? `${relativePrefix}/${p}` : p;
      const resources: any[] = [];
      for (const f of files) {
        const filePath = toWorkspacePath(f.path);
        const originalPath = toWorkspacePath(f.originalPath ?? f.path);
        
        const baseUri = createGitUri(workspaceRoot, originalPath, `${commit.hash}~1`);
        const commitUri = createGitUri(workspaceRoot, filePath, commit.hash);
        
        resources.push([
          commitUri,
          f.status === 'A' ? vscode.Uri.parse('empty:empty') : baseUri,
          f.status === 'D' ? vscode.Uri.parse('empty:empty') : commitUri
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
      async (changedFile: ChangedFile, commitHash?: string) => {
        let compareRef = changedFilesProvider.getCompareRef(changedFile.repoRoot);
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
        let rightUri = vscode.Uri.file(path.join(workspaceRoot, filePath));
        if (commitHash && commitHash !== 'UNCOMMITTED') {
          rightUri = createGitUri(workspaceRoot, filePath, commitHash);
        }

        if (changedFile.status === 'A') {
          // New file — just open it
          await vscode.window.showTextDocument(rightUri);
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
        
        let title = `${path.basename(filePath)} (${changedFilesProvider.getCompareLabel()} ↔ Working)`;
        if (commitHash) {
          if (commitHash === 'UNCOMMITTED') {
            title = `${path.basename(filePath)} (Work in progress)`;
          } else {
            title = `${path.basename(filePath)} (Commit ${commitHash.substring(0, 7)})`;
          }
        }

        await vscode.commands.executeCommand('vscode.diff', baseUri, rightUri, title);
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
      treeView.description = label;
      treeView.title = 'Local HITL Review'; // Restore original title if it was changed
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
