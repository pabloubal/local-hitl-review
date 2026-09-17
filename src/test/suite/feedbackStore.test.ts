import * as assert from 'assert';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import { FeedbackStore } from '../../feedbackStore';
import * as vscode from 'vscode';

suite('FeedbackStore Integration Tests', () => {
  let tempDir: string;
  let feedbackDir: string;
  let store: FeedbackStore;

  setup(async () => {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
    if (!workspaceRoot) {
      assert.fail('No workspace folder found');
    }
    tempDir = await fs.mkdtemp(path.join(workspaceRoot, 'vscode-comment-store-'));
    // FeedbackStore will append '.feedback' internally
    store = new FeedbackStore(tempDir);
    await store.initialize();
    feedbackDir = store.getFeedbackDir();
  });

  teardown(async () => {
    store.dispose();
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test('detects newly created .review files', async function () {
    this.timeout(5000);
    
    const reviewContent = `---
id: 12345-abcd
file: src/test.ts
lines: 10-20
severity: critical
status: open
timestamp: 1672531200
---
This is a test comment.
`;

    // Wait for the store to fire onDidChange
    const changePromise = new Promise<void>((resolve) => {
      const disposable = store.onDidChange(() => {
        disposable.dispose();
        resolve();
      });
    });

    const reviewFile = path.join(feedbackDir, '12345-abcd.review');
    
    // Give VS Code's file watcher a moment to initialize with the OS
    await new Promise(resolve => setTimeout(resolve, 500));
    
    await fs.writeFile(reviewFile, reviewContent);

    // Wait for the event to fire (with a timeout)
    const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout waiting for event')), 4000));
    await Promise.race([changePromise, timeoutPromise]);

    const comments = store.getAll();
    assert.strictEqual(comments.length, 1);
    assert.strictEqual(comments[0].id, '12345-abcd');
    assert.strictEqual(comments[0].severity, 'critical');
    assert.strictEqual(comments[0].body.trim(), 'This is a test comment.');
  });
});
