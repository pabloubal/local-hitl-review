import * as vscode from 'vscode';
import * as path from 'node:path';
import type { FeedbackStore } from './feedbackStore.js';
import { type FeedbackComment, SEVERITY_ORDER } from './types.js';
import { filterState } from './filterState.js';

export class FeedbackSummaryProvider
  implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable
{
  private _onDidChangeTreeData: vscode.EventEmitter<vscode.TreeItem | undefined | void> =
    new vscode.EventEmitter<vscode.TreeItem | undefined | void>();
  readonly onDidChangeTreeData: vscode.Event<vscode.TreeItem | undefined | void> =
    this._onDidChangeTreeData.event;
  private disposables: vscode.Disposable[] = [];

  constructor(
    private readonly store: FeedbackStore,
    private readonly workspaceRoot: string,
  ) {
    this.disposables.push(
      this.store.onDidChange(() => {
        this.refresh();
      }),
      filterState.onDidChange(() => {
        this.refresh();
      }),
    );
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (element === undefined) {
      // Root level: Group by file
      const comments = this.store.getAll().filter((c) => filterState.matches(c.severity, c.status));
      const fileGroups = new Map<string, FeedbackComment[]>();

      for (const comment of comments) {
        if (!fileGroups.has(comment.file)) {
          fileGroups.set(comment.file, []);
        }
        fileGroups.get(comment.file)!.push(comment);
      }

      const fileNodes: FileSummaryItem[] = [];
      for (const [file, fileComments] of fileGroups.entries()) {
        fileNodes.push(new FileSummaryItem(file, fileComments, this.workspaceRoot));
      }

      // Sort alphabetically by file
      return fileNodes.sort((a, b) => a.file.localeCompare(b.file));
    } else if (element instanceof FileSummaryItem) {
      // Second level: Comments for the file
      const comments = element.comments.sort((a, b) => {
        // Sort by severity (critical first) then by line
        const sevA = SEVERITY_ORDER.indexOf(a.severity);
        const sevB = SEVERITY_ORDER.indexOf(b.severity);
        if (sevA !== sevB) {
          return sevA - sevB;
        }
        return a.timestamp - b.timestamp; // fallback to timestamp
      });
      return comments.map((c) => new CommentSummaryItem(c, element.file, this.workspaceRoot));
    }
    return [];
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

export class FileSummaryItem extends vscode.TreeItem {
  constructor(
    public readonly file: string,
    public readonly comments: FeedbackComment[],
    workspaceRoot: string,
  ) {
    super(path.basename(file), vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = 'feedbackSummaryFile';
    this.description =
      comments.length === 1 ? '1 open comment' : `${comments.length} open comments`;
    this.tooltip = file;
    this.resourceUri = vscode.Uri.file(path.join(workspaceRoot, file));
    // Use standard theme icon for files, handled by VSCode automatically if resourceUri is set and iconPath is undefined
  }
}

export class CommentSummaryItem extends vscode.TreeItem {
  constructor(
    public readonly comment: FeedbackComment,
    file: string,
    workspaceRoot: string,
  ) {
    // Generate a short label from the body
    const firstLine = comment.body.split('\n')[0].trim();
    const maxLength = 50;
    const label =
      firstLine.length > maxLength ? firstLine.substring(0, maxLength) + '...' : firstLine;

    super(label, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'feedbackSummaryComment';
    this.description = `Line ${comment.lines}`;
    this.tooltip = comment.body;

    // Convert string severity into colors
    const colors: Record<string, string> = {
      critical: 'charts.red',
      high: 'charts.orange',
      medium: 'charts.yellow',
      low: 'charts.green',
    };

    this.iconPath = new vscode.ThemeIcon(
      'comment',
      new vscode.ThemeColor(colors[comment.severity] || 'foreground'),
    );

    const uri = vscode.Uri.file(path.join(workspaceRoot, file));
    // Command to jump to comment: maybe we can just open the file
    // To properly jump, we could execute 'vscode.open' with selection
    const lineNum = parseInt(comment.lines.split('-')[0], 10) || 1;
    this.command = {
      command: 'vscode.open',
      title: 'Open File',
      arguments: [
        uri,
        {
          selection: new vscode.Range(lineNum - 1, 0, lineNum - 1, 0),
        },
      ],
    };
  }
}
