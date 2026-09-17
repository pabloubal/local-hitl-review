import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { parseReviewFile, serializeReviewFile } from './parser.js';
import type { FeedbackComment } from './types.js';

/**
 * Manages reading, writing, and watching .review feedback files.
 * Emits events when comments change so the UI can refresh.
 */
export class FeedbackStore implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  private watcher: vscode.FileSystemWatcher | undefined;
  private comments: Map<string, FeedbackComment> = new Map();
  private feedbackDir: string;
  private disposables: vscode.Disposable[] = [];

  constructor(private readonly workspaceRoot: string) {
    this.feedbackDir = this.resolveFeedbackDir();

    // Watch for config changes
    const configWatcher = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('vscodeComment.feedbackDirectory')) {
        this.feedbackDir = this.resolveFeedbackDir();
        this.setupWatcher();
        this.loadAll().then(() => this._onDidChange.fire());
      }
    });
    this.disposables.push(configWatcher);
  }

  /**
   * Initialize the store: ensure directory exists, set up file watcher, load existing comments.
   */
  async initialize(): Promise<void> {
    await this.initializeWorkspace();
    this.setupWatcher();
    await this.loadAll();
  }

  /**
   * Get all loaded comments.
   */
  getAll(): FeedbackComment[] {
    return Array.from(this.comments.values()).sort(
      (a, b) => a.timestamp - b.timestamp
    );
  }

  /**
   * Get comments for a specific file.
   */
  getForFile(filePath: string): FeedbackComment[] {
    return this.getAll().filter((c) => c.file === filePath);
  }

  /**
   * Get a single comment by ID.
   */
  get(id: string): FeedbackComment | undefined {
    return this.comments.get(id);
  }

  /**
   * Save a new or updated comment to disk.
   */
  async save(comment: FeedbackComment): Promise<void> {
    await this.initializeWorkspace();
    const filePath = this.commentFilePath(comment.id);
    const content = serializeReviewFile(comment);
    await fs.writeFile(filePath, content, 'utf-8');
    this.comments.set(comment.id, comment);
    this._onDidChange.fire();
  }

  /**
   * Delete a comment from disk.
   */
  async delete(id: string): Promise<void> {
    const filePath = this.commentFilePath(id);
    try {
      await fs.unlink(filePath);
    } catch {
      // File may already be gone
    }
    this.comments.delete(id);
    this._onDidChange.fire();
  }

  /**
   * Load all .review files from the feedback directory.
   */
  async loadAll(): Promise<void> {
    this.comments.clear();

    try {
      const entries = await fs.readdir(this.feedbackDir);
      for (const entry of entries) {
        if (!entry.endsWith('.review')) { continue; }
        try {
          const filePath = path.join(this.feedbackDir, entry);
          const content = await fs.readFile(filePath, 'utf-8');
          const id = path.basename(entry, '.review');
          const comment = parseReviewFile(content, id);
          this.comments.set(id, comment);
        } catch (e) {
          console.warn(`Failed to parse review file ${entry}:`, e);
        }
      }
    } catch {
      // Directory may not exist yet
    }
  }

  /**
   * Get the feedback directory path.
   */
  getFeedbackDir(): string {
    return this.feedbackDir;
  }

  dispose(): void {
    this.watcher?.dispose();
    this._onDidChange.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }

  // --- private ---

  private resolveFeedbackDir(): string {
    const config = vscode.workspace.getConfiguration('vscodeComment');
    const dir = config.get<string>('feedbackDirectory') || '.feedback';
    return path.join(this.workspaceRoot, dir);
  }

  private commentFilePath(id: string): string {
    return path.join(this.feedbackDir, `${id}.review`);
  }

  async initializeWorkspace(): Promise<void> {
    try {
      await fs.mkdir(this.feedbackDir, { recursive: true });
      
      const rootGitignore = path.join(this.workspaceRoot, '.gitignore');
      try {
        const content = await fs.readFile(rootGitignore, 'utf-8');
        if (!content.includes('.feedback')) {
          await fs.appendFile(rootGitignore, '\n# Local HITL Review\n.feedback/\n');
        }
      } catch {
        // Root .gitignore doesn't exist, create it
        try {
          await fs.writeFile(rootGitignore, '# Local HITL Review\n.feedback/\n');
        } catch (e) {
          console.warn('Failed to write root .gitignore:', e);
        }
      }
      
      const agentsFile = path.join(this.feedbackDir, 'AGENTS.md');
      try {
        await fs.access(agentsFile);
      } catch {
        // AGENTS.md doesn't exist, create it from the template
        try {
          const templatePath = path.join(__dirname, '..', 'assets', 'AGENTS_template.md');
          const templateContent = await fs.readFile(templatePath, 'utf-8');
          await fs.writeFile(agentsFile, templateContent);
        } catch (e) {
          console.warn('Failed to read or write AGENTS_template.md:', e);
        }
      }

      const reviewTemplateFile = path.join(this.feedbackDir, 'review_template.md');
      try {
        await fs.access(reviewTemplateFile);
      } catch {
        // review_template.md doesn't exist, create it from the template
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

  private setupWatcher(): void {
    this.watcher?.dispose();

    const pattern = new vscode.RelativePattern(this.feedbackDir, '*.review');
    this.watcher = vscode.workspace.createFileSystemWatcher(pattern);

    // Reload on any external change
    const reload = () => {
      this.loadAll().then(() => this._onDidChange.fire());
    };
    this.watcher.onDidCreate(reload);
    this.watcher.onDidChange(reload);
    this.watcher.onDidDelete(reload);
  }
}
