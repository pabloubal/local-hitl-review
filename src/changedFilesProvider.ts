import * as vscode from 'vscode';
import * as path from 'node:path';
import { GitService } from './gitService.js';
import type { ChangedFile, FileStatus } from './types.js';

/**
 * Compare mode determines what set of changes to show.
 */
export type CompareMode =
  | { type: 'branch' }                         // All changes: merge-base → working tree
  | { type: 'commit'; hash: string; label: string }  // Since a specific commit → working tree
  | { type: 'uncommitted' };                    // HEAD → working tree (uncommitted only)

export type ReviewTreeNode = ChangedFileItem | FolderItem;

/**
 * TreeView data provider that shows files changed based on the
 * selected compare mode (entire branch, since commit, or uncommitted).
 */
export class ChangedFilesProvider
  implements vscode.TreeDataProvider<ReviewTreeNode>, vscode.Disposable
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private changedFiles: ChangedFile[] = [];
  private isTreeView: boolean = false;
  private compareRef: string = '';  // The ref we're comparing against (for diff URIs)
  private baseBranch: string = '';
  private compareMode: CompareMode = { type: 'branch' };
  private disposables: vscode.Disposable[] = [];

  constructor(
    private readonly gitService: GitService,
    private readonly workspaceRoot: string
  ) {}

  /**
   * Refresh the list of changed files based on the current compare mode.
   */
  async refresh(baseBranch?: string): Promise<void> {
    try {
      if (baseBranch) {
        this.baseBranch = baseBranch;
      } else if (!this.baseBranch) {
        const config = vscode.workspace.getConfiguration('vscodeComment');
        const configured = config.get<string>('baseBranch');
        if (configured) {
          this.baseBranch = configured;
        } else {
          const detected = await this.gitService.detectBaseBranch();
          if (detected) {
            this.baseBranch = detected;
          } else {
            vscode.window.showWarningMessage(
              'Local HITL Review: Could not detect base branch. Use "Select Base Branch" to set one.'
            );
            this.changedFiles = [];
            this._onDidChangeTreeData.fire();
            return;
          }
        }
      }

      switch (this.compareMode.type) {
        case 'branch': {
          this.compareRef = await this.gitService.getMergeBase(this.baseBranch);
          this.changedFiles = await this.gitService.getChangedFiles(this.compareRef);
          break;
        }
        case 'commit': {
          this.compareRef = this.compareMode.hash;
          // Diff from that commit to working tree
          this.changedFiles = await this.gitService.getChangedFiles(this.compareRef);
          break;
        }
        case 'uncommitted': {
          this.compareRef = 'HEAD';
          this.changedFiles = await this.gitService.getUncommittedChanges();
          break;
        }
      }

      this._onDidChangeTreeData.fire();
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      vscode.window.showErrorMessage(`Local HITL Review: Failed to get changes — ${message}`);
      this.changedFiles = [];
      this._onDidChangeTreeData.fire();
    }
  }

  /**
   * Set the compare mode and refresh.
   */
  async setCompareMode(mode: CompareMode): Promise<void> {
    this.compareMode = mode;
    await this.refresh();
  }

  /**
   * Get the current compare mode.
   */
  getCompareMode(): CompareMode {
    return this.compareMode;
  }

  /**
   * Get the ref being compared against (for diff URIs).
   */
  getCompareRef(): string {
    return this.compareRef;
  }

  /**
   * Toggle between Tree View and List View.
   */
  toggleTreeView(isTree: boolean): void {
    this.isTreeView = isTree;
    vscode.commands.executeCommand('setContext', 'vscodeComment.isTreeView', this.isTreeView);
    this._onDidChangeTreeData.fire();
  }

  /**
   * Get the current base branch name.
   */
  getBaseBranch(): string {
    return this.baseBranch;
  }

  /**
   * Get a human-readable label for the current compare mode.
   */
  getCompareLabel(): string {
    switch (this.compareMode.type) {
      case 'branch':
        return `vs ${this.baseBranch}`;
      case 'commit':
        return `since ${this.compareMode.label}`;
      case 'uncommitted':
        return 'uncommitted';
    }
  }

  /**
   * Get all changed file paths (repo-relative).
   */
  getChangedFilePaths(): string[] {
    return this.changedFiles.map((f) => f.path);
  }

  getTreeItem(element: ReviewTreeNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: ReviewTreeNode): ReviewTreeNode[] {
    if (!element) {
      if (!this.isTreeView) {
        return this.changedFiles.map((file) => new ChangedFileItem(file, this.workspaceRoot, false));
      } else {
        return this.buildTreeNodes(this.changedFiles);
      }
    } else if (element instanceof FolderItem) {
      return element.children;
    }
    return [];
  }

  private buildTreeNodes(files: ChangedFile[]): ReviewTreeNode[] {
    const rootNodes: ReviewTreeNode[] = [];
    const folderMap = new Map<string, FolderItem>();

    for (const file of files) {
      const parts = file.path.split('/');
      let currentMap = folderMap;
      let currentPath = '';

      for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i];
        currentPath = currentPath ? `${currentPath}/${part}` : part;

        let folder = currentMap.get(part);
        if (!folder) {
          folder = new FolderItem(part, currentPath, []);
          currentMap.set(part, folder);
          if (i === 0) {
            rootNodes.push(folder);
          } else {
            const parentPath = currentPath.substring(0, currentPath.lastIndexOf('/'));
            const parentName = parentPath.split('/').pop()!;
            // Find parent and add this folder to its children.
            // A more robust way is tracking parents.
          }
        }
      }
    }
    
    // Better algorithm for tree building
    return this.buildTreeLevel(files, 0, '');
  }

  private buildTreeLevel(files: ChangedFile[], depth: number, parentPrefix: string): ReviewTreeNode[] {
    const nodes: ReviewTreeNode[] = [];
    const folderGroups = new Map<string, ChangedFile[]>();
    const rootFiles: ChangedFile[] = [];

    for (const file of files) {
      // Ensure file path matches the parent prefix (for safety, though they should)
      if (parentPrefix && !file.path.startsWith(parentPrefix + '/')) continue;
      
      const relativePath = parentPrefix ? file.path.substring(parentPrefix.length + 1) : file.path;
      const parts = relativePath.split('/');

      if (parts.length === 1) {
        rootFiles.push(file);
      } else {
        const folderName = parts[0];
        if (!folderGroups.has(folderName)) {
          folderGroups.set(folderName, []);
        }
        folderGroups.get(folderName)!.push(file);
      }
    }

    for (const [folderName, folderFiles] of folderGroups.entries()) {
      const currentPrefix = parentPrefix ? `${parentPrefix}/${folderName}` : folderName;
      const children = this.buildTreeLevel(folderFiles, depth + 1, currentPrefix);
      nodes.push(new FolderItem(folderName, currentPrefix, children));
    }

    for (const file of rootFiles) {
      nodes.push(new ChangedFileItem(file, this.workspaceRoot, true));
    }

    return nodes;
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

// --- TreeItem ---

const STATUS_ICONS: Record<FileStatus, vscode.ThemeIcon> = {
  M: new vscode.ThemeIcon('diff-modified', new vscode.ThemeColor('gitDecoration.modifiedResourceForeground')),
  A: new vscode.ThemeIcon('diff-added', new vscode.ThemeColor('gitDecoration.addedResourceForeground')),
  D: new vscode.ThemeIcon('diff-removed', new vscode.ThemeColor('gitDecoration.deletedResourceForeground')),
  R: new vscode.ThemeIcon('diff-renamed', new vscode.ThemeColor('gitDecoration.renamedResourceForeground')),
  C: new vscode.ThemeIcon('diff-added', new vscode.ThemeColor('gitDecoration.addedResourceForeground')),
};

export class ChangedFileItem extends vscode.TreeItem {
  constructor(
    public readonly changedFile: ChangedFile,
    workspaceRoot: string,
    inTree: boolean
  ) {
    const label = inTree ? path.basename(changedFile.path) : changedFile.path;
    super(label, vscode.TreeItemCollapsibleState.None);

    this.iconPath = STATUS_ICONS[changedFile.status] ?? STATUS_ICONS.M;
    this.description = changedFile.originalPath
      ? `← ${changedFile.originalPath}`
      : undefined;
    this.tooltip = `${changedFile.status} ${changedFile.path}`;
    this.resourceUri = vscode.Uri.file(path.join(workspaceRoot, changedFile.path));

    // Click opens the diff
    this.command = {
      command: 'vscodeComment.openDiff',
      title: 'Open Diff',
      arguments: [changedFile],
    };

    this.contextValue = 'changedFile';
  }
}

export class FolderItem extends vscode.TreeItem {
  constructor(
    public readonly name: string,
    public readonly relativePath: string,
    public readonly children: ReviewTreeNode[]
  ) {
    super(name, vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = 'folder';
    this.iconPath = vscode.ThemeIcon.Folder;
    this.resourceUri = vscode.Uri.file(relativePath);
  }
}
