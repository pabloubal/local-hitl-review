import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { parseReviewFile, serializeReviewFile } from './parser.js';
import type { FeedbackComment } from './types.js';

export class FeedbackStore implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  private watchers: vscode.FileSystemWatcher[] = [];
  private comments: Map<string, FeedbackComment> = new Map();
  private disposables: vscode.Disposable[] = [];
  private repoRoots: string[] = [];
  private scope: 'global' | 'local' = 'global';

  constructor(private readonly workspaceRoot: string) {
    this.updateConfig();

    const configWatcher = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('vscodeComment.feedbackDirectory') || e.affectsConfiguration('vscodeComment.feedbackScope')) {
        this.updateConfig();
        this.initialize().then(() => this._onDidChange.fire());
      }
    });
    this.disposables.push(configWatcher);
  }

  private updateConfig() {
    const config = vscode.workspace.getConfiguration('vscodeComment');
    this.scope = config.get<'global'|'local'>('feedbackScope') || 'global';
  }

  public getRepoRoots(): string[] {
    return this.repoRoots;
  }

  public async setRepoRoots(roots: string[]) {
    this.repoRoots = roots;
    if (this.scope === 'local') {
      this.setupWatchers();
      await this.loadAll();
      this._onDidChange.fire();
    }
  }

  async initialize(): Promise<void> {
    await this.initializeWorkspace();
    this.setupWatchers();
    await this.loadAll();
  }

  getAll(): FeedbackComment[] {
    return Array.from(this.comments.values()).sort(
      (a, b) => a.timestamp - b.timestamp
    );
  }

  getForFile(filePath: string, repoName?: string): FeedbackComment[] {
    return this.getAll().filter((c) => c.file === filePath && (!repoName || c.repo === repoName || this.scope === 'local'));
  }

  get(id: string): FeedbackComment | undefined {
    return this.comments.get(id);
  }

  async save(comment: FeedbackComment, repoRoot?: string): Promise<void> {
    await this.initializeWorkspace();
    let resolvedRepo = repoRoot;
    if (!resolvedRepo && comment.repo && this.repoRoots.length > 0) {
      resolvedRepo = this.repoRoots.find(r => require('node:path').basename(r) === comment.repo);
    }
    const dir = this.getFeedbackDirForRepo(resolvedRepo || this.workspaceRoot);

    const filePath = path.join(dir, `${comment.id}.review`);
    const content = serializeReviewFile(comment);
    await fs.writeFile(filePath, content, 'utf-8');
    this.comments.set(comment.id, comment);
    this._onDidChange.fire();
  }

  async delete(id: string): Promise<void> {
    // Find where this comment is stored
    for (const dir of this.getAllFeedbackDirs()) {
      const filePath = path.join(dir, `${id}.review`);
      try {
        await fs.unlink(filePath);
        break;
      } catch {
        // File may be in a different dir, or already gone
      }
    }
    this.comments.delete(id);
    this._onDidChange.fire();
  }

  async loadAll(): Promise<void> {
    this.comments.clear();
    const dirs = this.getAllFeedbackDirs();

    for (const dir of dirs) {
      try {
        const entries = await fs.readdir(dir);
        for (const entry of entries) {
          if (!entry.endsWith('.review')) { continue; }
          try {
            const filePath = path.join(dir, entry);
            const content = await fs.readFile(filePath, 'utf-8');
            const id = path.basename(entry, '.review');
            const comment = parseReviewFile(content, id);
            
            // Auto-tag repo if loaded from a local dir and not specified
            if (this.scope === 'local' && !comment.repo) {
               // Find matching repo name
               const repoRoot = this.repoRoots.find(r => dir.startsWith(r));
               if (repoRoot) {
                  comment.repo = path.basename(repoRoot);
               }
            }
            this.comments.set(id, comment);
          } catch (e) {
            console.warn(`Failed to parse review file ${entry}:`, e);
          }
        }
      } catch {
        // Directory may not exist yet
      }
    }
  }

  getFeedbackDirForRepo(repoRoot: string, forceLocal: boolean = false): string {
    const config = vscode.workspace.getConfiguration('vscodeComment');
    const dir = config.get<string>('feedbackDirectory') || '.feedback';
    if (!forceLocal && this.scope === 'global') {
      return path.join(this.workspaceRoot, dir);
    }
    return path.join(repoRoot, dir);
  }

  getAllFeedbackDirs(): string[] {
    if (this.scope === 'global') {
      return [this.getFeedbackDirForRepo(this.workspaceRoot)];
    }
    return this.repoRoots.length > 0 
      ? this.repoRoots.map(r => this.getFeedbackDirForRepo(r))
      : [this.getFeedbackDirForRepo(this.workspaceRoot)];
  }

  getAgentsFilePath(repoRoot?: string, forceLocal: boolean = false): string {
    const config = vscode.workspace.getConfiguration('vscodeComment');
    const agentsFile = config.get<string>('agentsFile') || 'AGENTS.md';
    const dir = this.getFeedbackDirForRepo(repoRoot || this.workspaceRoot, forceLocal);
    return path.join(dir, agentsFile);
  }

  dispose(): void {
    for (const w of this.watchers) w.dispose();
    this.watchers = [];
    this._onDidChange.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }

  async initializeDir(dir: string): Promise<void> {
    try {
        await fs.mkdir(dir, { recursive: true });
        
        // Create .gitignore inside the feedback directory
        const feedbackGitignore = path.join(dir, '.gitignore');
        try {
          // Check if it exists first to avoid overwriting unnecessarily
          await fs.access(feedbackGitignore);
        } catch {
          try {
            await fs.writeFile(feedbackGitignore, '*\n');
          } catch (e) {
            console.warn('Failed to write feedback .gitignore:', e);
          }
        }
        
        // Agents file
        const config = vscode.workspace.getConfiguration('vscodeComment');
        const agentsFile = config.get<string>('agentsFile') || 'AGENTS.md';
        const agentsFilePath = path.join(dir, agentsFile);
        try {
          await fs.access(agentsFilePath);
        } catch {
          try {
            const customContent = config.get<string>('agentsTemplateContent');
            if (customContent && customContent.trim() !== '') {
              await fs.writeFile(agentsFilePath, customContent);
            } else {
              const templatePath = path.join(__dirname, '..', 'assets', 'AGENTS_template.md');
              const templateContent = await fs.readFile(templatePath, 'utf-8');
              await fs.writeFile(agentsFilePath, templateContent);
            }
          } catch (e) {
            console.warn('Failed to write agents file:', e);
          }
        }

        // Review template
        const reviewTemplateFile = path.join(dir, 'review_template.md');
        try {
          await fs.access(reviewTemplateFile);
        } catch {
          try {
            const templatePath = path.join(__dirname, '..', 'assets', 'REVIEW_template.md');
            const templateContent = await fs.readFile(templatePath, 'utf-8');
            await fs.writeFile(reviewTemplateFile, templateContent);
          } catch (e) {
            console.warn('Failed to read or write REVIEW_template.md:', e);
          }
        }
        } catch {
          // Ignore directory creation errors
        }
  }

  async initializeWorkspace(): Promise<void> {
    const dirs = this.getAllFeedbackDirs();
    for (const dir of dirs) {
      await this.initializeDir(dir);
    }
  }

  private setupWatchers(): void {
    for (const w of this.watchers) w.dispose();
    this.watchers = [];

    const dirs = this.getAllFeedbackDirs();
    const reload = () => {
      this.loadAll().then(() => this._onDidChange.fire());
    };

    for (const dir of dirs) {
      const pattern = new vscode.RelativePattern(dir, '*.review');
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);
      watcher.onDidCreate(reload);
      watcher.onDidChange(reload);
      watcher.onDidDelete(reload);
      this.watchers.push(watcher);
    }
  }
}
