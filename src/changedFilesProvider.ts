import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { GitService } from './gitService.js';
import type { ChangedFile, FileStatus, GitCommit } from './types.js';

export type CompareMode =
  | { type: 'branch' }
  | { type: 'commit'; hash: string; label: string }
  | { type: 'commits' };

export type ReviewTreeNode = RepositoryItem | ChangedFileItem | FolderItem | CommitItem | WorkInProgressItem;

interface RepoState {
  gitService: GitService;
  name: string;
  relativePath: string;
  changedFiles: ChangedFile[];
  commits: GitCommit[];
  uncommittedFiles: ChangedFile[];
  baseBranch: string;
  compareRef: string;
  currentBranch: string;
  overrideBaseBranch?: string;
  overrideCompareMode?: CompareMode;
  isLoaded?: boolean;
}

export class ChangedFilesProvider implements vscode.TreeDataProvider<ReviewTreeNode>, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private repos: RepoState[] = [];
  private isTreeView: boolean = true;
  private compareMode: CompareMode;
  private globalBaseBranch: string = '';
  private disposables: vscode.Disposable[] = [];

  constructor(
    private readonly workspaceRoot: string,
    private readonly context: vscode.ExtensionContext,
    private readonly feedbackStore: any
  ) {
    vscode.commands.executeCommand('setContext', 'vscodeComment.isTreeView', this.isTreeView);
    const config = vscode.workspace.getConfiguration('vscodeComment');
    const defaultMode = config.get<string>('defaultCompareMode') === 'commits' ? 'commits' : 'branch';
    this.compareMode = { type: defaultMode };
  }

  async initialize(): Promise<void> {
    const gitRoots = await this.discoverGitRepos(this.workspaceRoot);
    await this.feedbackStore?.setRepoRoots(gitRoots);
    for (const root of gitRoots) {
      const gitService = new GitService(root);
      const name = path.basename(root);
      const relativePath = path.relative(this.workspaceRoot, root).replace(/\\/g, '/');
      this.repos.push({
        gitService,
        name: relativePath === '' ? name : relativePath,
        relativePath,
        changedFiles: [],
        commits: [],
        uncommittedFiles: [],
        baseBranch: '',
        compareRef: '',
        currentBranch: '',
      });
    }
  }

  private async discoverGitRepos(primaryWorkspaceRoot: string): Promise<string[]> {
    const repos: string[] = [];
    const folders = vscode.workspace.workspaceFolders || [];
    for (const folder of folders) {
      const root = folder.uri.fsPath;
      try {
        try {
          await fs.access(path.join(root, '.git'));
          repos.push(root);
        } catch {}

        const entries = await fs.readdir(root, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            try {
              await fs.access(path.join(root, entry.name, '.git'));
              repos.push(path.join(root, entry.name));
            } catch {}
          }
        }
      } catch (e) {
        console.error('Error discovering git repos in ' + root, e);
      }
    }
    return Array.from(new Set(repos));
  }

  async refresh(baseBranch?: string): Promise<void> {
    try {
      if (baseBranch) {
        this.globalBaseBranch = baseBranch;
      }

      for (const repo of this.repos) {
        repo.currentBranch = await repo.gitService.getCurrentBranch().catch(() => '');

        if (this.repos.length === 1 || repo.isLoaded) {
          await this.loadRepoChanges(repo);
        }
      }

      this._onDidChangeTreeData.fire();
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      vscode.window.showErrorMessage(`Local HITL Review: Failed to get changes — ${message}`);
      for (const repo of this.repos) repo.changedFiles = [];
      this._onDidChangeTreeData.fire();
    }
  }

  public async loadRepoChanges(repo: RepoState): Promise<void> {
    if (repo.overrideBaseBranch) {
      repo.baseBranch = repo.overrideBaseBranch;
    } else if (!this.globalBaseBranch) {
      const config = vscode.workspace.getConfiguration('vscodeComment');
      const configured = config.get<string>('baseBranch');
      if (configured) {
        repo.baseBranch = configured;
      } else {
        const detected = await repo.gitService.detectBaseBranch();
        repo.baseBranch = detected || 'main'; // fallback
      }
    } else {
      repo.baseBranch = this.globalBaseBranch;
    }

    const mode = repo.overrideCompareMode || this.compareMode;
    switch (mode.type) {
      case 'branch': {
        repo.compareRef = await repo.gitService.getMergeBase(repo.baseBranch);
        repo.changedFiles = this.toWorkspaceRelative(repo, await repo.gitService.getChangedFiles(repo.compareRef));
        break;
      }
      case 'commit': {
        repo.compareRef = (mode as any).hash;
        repo.changedFiles = this.toWorkspaceRelative(repo, await repo.gitService.getChangedFiles(repo.compareRef));
        break;
      }
      case 'commits': {
        repo.compareRef = await repo.gitService.getMergeBase(repo.baseBranch);
        repo.commits = await repo.gitService.listCommits(repo.baseBranch);
        repo.uncommittedFiles = this.toWorkspaceRelative(repo, await repo.gitService.getUncommittedChanges());
        repo.changedFiles = this.toWorkspaceRelative(repo, await repo.gitService.getChangedFiles(repo.compareRef));
        break;
      }
    }
    repo.isLoaded = true;
  }

  public isFileViewed(repoRoot: string, commitOrBranch: string, filePath: string): boolean {
    const key = `viewed:${repoRoot}:${commitOrBranch}:${filePath}`;
    return !!this.context.workspaceState.get(key);
  }
  
  public setFileViewed(repoRoot: string, commitOrBranch: string, filePath: string, viewed: boolean): void {
    const key = `viewed:${repoRoot}:${commitOrBranch}:${filePath}`;
    this.context.workspaceState.update(key, viewed ? true : undefined);
    this._onDidChangeTreeData.fire();
  }
  
  private toWorkspaceRelative(repo: RepoState, files: ChangedFile[]): ChangedFile[] {
    if (!repo.relativePath) return files;
    
    return files.map(f => {
      const p = `${repo.relativePath}/${f.path}`;
      const o = f.originalPath ? `${repo.relativePath}/${f.originalPath}` : undefined;
      return { ...f, path: p, originalPath: o, repoRoot: repo.gitService.repoRoot };
    });
  }

  async setCompareMode(mode: CompareMode): Promise<void> {
    this.compareMode = mode;
    await this.refresh();
  }

  getCompareMode(): CompareMode {
    return this.compareMode;
  }

  getCompareRef(repoRoot?: string): string {
    if (!repoRoot && this.repos.length === 1) return this.repos[0].compareRef;
    const repo = this.repos.find(r => r.gitService.repoRoot === repoRoot);
    return repo?.compareRef || '';
  }

  toggleTreeView(isTree: boolean): void {
    this.isTreeView = isTree;
    vscode.commands.executeCommand('setContext', 'vscodeComment.isTreeView', this.isTreeView);
    this._onDidChangeTreeData.fire();
  }

  getBaseBranch(): string {
    return this.globalBaseBranch || (this.repos.length > 0 ? this.repos[0].baseBranch : '');
  }

  getCompareLabel(): string {
    const base = this.getBaseBranch();
    switch (this.compareMode.type) {
      case 'branch': return `vs ${base}`;
      case 'commit': return `since ${this.compareMode.label}`;
      case 'commits': return `commits vs ${base}`;
    }
  }

  getChangedFilePaths(): string[] {
    return this.repos.flatMap(r => r.changedFiles.map(f => f.path));
  }

  async loadAllRepos(): Promise<void> {
    for (const repo of this.repos) {
      if (!repo.isLoaded) {
        await this.loadRepoChanges(repo);
      }
    }
  }

  getChangedFiles(): ChangedFile[] {
    return this.repos.flatMap(r => r.changedFiles);
  }

  getFirstGitService(): GitService | undefined {
    return this.repos.length > 0 ? this.repos[0].gitService : undefined;
  }

  getTreeItem(element: ReviewTreeNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: ReviewTreeNode): Promise<ReviewTreeNode[]> {
    if (!element) {
      if (this.repos.length === 0) return [];
      
      if (this.repos.length === 1) {
        return this.getRepoChildren(this.repos[0]);
      } else {
        return this.repos.map(r => new RepositoryItem(r));
      }
    } else if (element instanceof RepositoryItem) {
      if (!element.repo.isLoaded) {
        await this.loadRepoChanges(element.repo);
      }
      return this.getRepoChildren(element.repo);
    } else if (element instanceof FolderItem) {
      return element.children;
    } else if (element instanceof CommitItem) {
      const commitHash = element.commit.hash;
      const files = await element.gitService.getCommitChanges(commitHash);
      const relativeFiles = this.toWorkspaceRelative(element.repo, files);
      if (!this.isTreeView) {
        return relativeFiles.map((file) => new ChangedFileItem(file, this.workspaceRoot, false, commitHash, element.gitService, this.isFileViewed(element.gitService.repoRoot, commitHash, file.originalPath || file.path)));
      } else {
        return this.buildTreeNodes(relativeFiles, commitHash, element.gitService);
      }
    } else if (element instanceof WorkInProgressItem) {
      if (!this.isTreeView) {
        return element.repo.uncommittedFiles.map((file) => new ChangedFileItem(file, this.workspaceRoot, false, 'UNCOMMITTED', element.gitService, this.isFileViewed(element.gitService.repoRoot, 'UNCOMMITTED', file.originalPath || file.path)));
      } else {
        return this.buildTreeNodes(element.repo.uncommittedFiles, 'UNCOMMITTED', element.gitService);
      }
    }
    return [];
  }

  private getRepoChildren(repo: RepoState): ReviewTreeNode[] {
    if (this.compareMode.type === 'commits') {
      const nodes: ReviewTreeNode[] = [];
      if (repo.uncommittedFiles.length > 0) {
        nodes.push(new WorkInProgressItem(repo.uncommittedFiles.length, repo.gitService, repo));
      }
      nodes.push(...repo.commits.map((commit) => new CommitItem(commit, repo.gitService, repo)));
      return nodes;
    }
    if (!this.isTreeView) {
      return repo.changedFiles.map((file) => new ChangedFileItem(file, this.workspaceRoot, false, undefined, repo.gitService, this.isFileViewed(repo.gitService.repoRoot, repo.compareRef, file.path)));
    } else {
      return this.buildTreeNodes(repo.changedFiles, undefined, repo.gitService);
    }
  }

  private buildTreeNodes(files: ChangedFile[], commitHash?: string, gitService?: GitService): ReviewTreeNode[] {
    return this.buildTreeLevel(files, 0, '', commitHash, gitService);
  }

  private buildTreeLevel(files: ChangedFile[], depth: number, parentPrefix: string, commitHash?: string, gitService?: GitService): ReviewTreeNode[] {
    const nodes: ReviewTreeNode[] = [];
    const folderGroups = new Map<string, ChangedFile[]>();
    const rootFiles: ChangedFile[] = [];

    for (const file of files) {
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
      let children = this.buildTreeLevel(folderFiles, depth + 1, currentPrefix, commitHash, gitService);
      
      let compactName = folderName;
      let compactPrefix = currentPrefix;
      
      while (children.length === 1 && children[0] instanceof FolderItem) {
        const onlyChild = children[0];
        compactName = `${compactName}/${onlyChild.name}`;
        compactPrefix = onlyChild.relativePath;
        children = onlyChild.children;
      }
      
      nodes.push(new FolderItem(compactName, compactPrefix, children));
    }

    for (const file of rootFiles) {
      const viewed = gitService ? this.isFileViewed(gitService.repoRoot, commitHash || 'UNCOMMITTED', file.originalPath || file.path) : false;
      nodes.push(new ChangedFileItem(file, this.workspaceRoot, true, commitHash, gitService, viewed));
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

const STATUS_ICONS: Record<FileStatus, vscode.ThemeIcon> = {
  M: new vscode.ThemeIcon('diff-modified', new vscode.ThemeColor('gitDecoration.modifiedResourceForeground')),
  A: new vscode.ThemeIcon('diff-added', new vscode.ThemeColor('gitDecoration.addedResourceForeground')),
  D: new vscode.ThemeIcon('diff-removed', new vscode.ThemeColor('gitDecoration.deletedResourceForeground')),
  R: new vscode.ThemeIcon('diff-renamed', new vscode.ThemeColor('gitDecoration.renamedResourceForeground')),
  C: new vscode.ThemeIcon('diff-added', new vscode.ThemeColor('gitDecoration.addedResourceForeground')),
};

export class RepositoryItem extends vscode.TreeItem {
  constructor(public readonly repo: RepoState) {
    super(repo.name, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = 'repository';
    this.iconPath = new vscode.ThemeIcon('repo');
    this.description = repo.currentBranch;
    this.tooltip = `Repository: ${repo.gitService.repoRoot}\nBranch: ${repo.currentBranch}`;
  }
}

export class ChangedFileItem extends vscode.TreeItem {
  public isViewed = false;
  constructor(
    public readonly changedFile: ChangedFile,
    workspaceRoot: string,
    inTree: boolean,
    public readonly commitHash?: string,
    public readonly gitService?: GitService,
    isViewed: boolean = false
  ) {
    const label = inTree ? path.basename(changedFile.path) : changedFile.path;
    super(label, vscode.TreeItemCollapsibleState.None);
    this.isViewed = isViewed;

    // iconPath is removed to let VS Code show the file icon based on resourceUri
    this.description = changedFile.originalPath ? `← ${changedFile.originalPath}` : undefined;
    this.tooltip = `${changedFile.status} ${changedFile.path}`;
    this.resourceUri = vscode.Uri.file(path.join(workspaceRoot, changedFile.path)).with({ scheme: 'vscode-comment-review', query: `${changedFile.status}${isViewed ? '-viewed' : ''}` });

    this.command = {
      command: 'vscodeComment.openDiff',
      title: 'Open Diff',
      arguments: [changedFile, commitHash, gitService],
    };
    this.contextValue = isViewed ? 'changedFileItemViewed' : 'changedFileItem';
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

export class CommitItem extends vscode.TreeItem {
  constructor(
    public readonly commit: GitCommit,
    public readonly gitService: GitService,
    public readonly repo: RepoState
  ) {
    super(commit.subject, vscode.TreeItemCollapsibleState.Collapsed);
    this.description = `${commit.author} • ${commit.date}`;
    this.tooltip = `${commit.shortHash} - ${commit.subject}\nBy ${commit.author} (${commit.date})`;
    this.iconPath = new vscode.ThemeIcon('git-commit', new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'));
    this.contextValue = 'commitItem';
  }
}

export class WorkInProgressItem extends vscode.TreeItem {
  constructor(
    public readonly filesCount: number,
    public readonly gitService: GitService,
    public readonly repo: RepoState
  ) {
    super('Work in progress', vscode.TreeItemCollapsibleState.Collapsed);
    this.description = `${filesCount} uncommitted changes`;
    this.iconPath = new vscode.ThemeIcon('files');
    this.contextValue = 'workInProgressItem';
  }
}

export class ReviewFileDecorationProvider implements vscode.FileDecorationProvider {
  provideFileDecoration(uri: vscode.Uri): vscode.ProviderResult<vscode.FileDecoration> {
    if (uri.scheme === 'vscode-comment-review') {
      const isViewed = uri.query.endsWith('-viewed');
      const status = uri.query.replace('-viewed', '');
      
      let badge = '';
      let tooltip = '';
      let color: vscode.ThemeColor | undefined;
      
      if (status === 'A') { badge = 'A'; tooltip = 'Added'; color = new vscode.ThemeColor('gitDecoration.addedResourceForeground'); }
      else if (status === 'M') { badge = 'M'; tooltip = 'Modified'; color = new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'); }
      else if (status === 'D') { badge = 'D'; tooltip = 'Deleted'; color = new vscode.ThemeColor('gitDecoration.deletedResourceForeground'); }
      else if (status === 'R') { badge = 'R'; tooltip = 'Renamed'; color = new vscode.ThemeColor('gitDecoration.renamedResourceForeground'); }
      else if (status === 'C') { badge = 'C'; tooltip = 'Copied'; color = new vscode.ThemeColor('gitDecoration.addedResourceForeground'); }

      if (isViewed) {
        // If viewed, we fade it out by using a subtle color, and strike it through if desired.
        // There's a built-in 'gitDecoration.ignoredResourceForeground' that is faded gray.
        color = new vscode.ThemeColor('gitDecoration.ignoredResourceForeground');
      }

      return new vscode.FileDecoration(badge, tooltip, color);
    }
  }
}
