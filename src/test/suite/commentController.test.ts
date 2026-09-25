import * as assert from 'assert';
import * as vscode from 'vscode';
import { ReviewCommentController } from '../../commentController';
import { FeedbackStore } from '../../feedbackStore';
import * as path from 'path';
import * as fs from 'fs/promises';

suite('ReviewCommentController Tests', () => {
  let tempDir: string;
  let store: FeedbackStore;
  let controller: ReviewCommentController;

  setup(async () => {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri.fsPath || __dirname;
    tempDir = await fs.mkdtemp(path.join(workspaceRoot, 'comment-controller-test-'));
    store = new FeedbackStore(tempDir);
    await store.initialize();

    controller = new ReviewCommentController(
      store,
      tempDir,
      () => []
    );
  });

  teardown(async () => {
    controller.dispose();
    store.dispose();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('syncFromStore preserves threads with editing comments', async () => {
    const id = 'test-id-1';
    await store.save({
      id,
      repo: 'repo1',
      file: 'file1.ts',
      severity: 'medium',
      status: 'open',
      reviewer: 'human',
      lines: '1',
      body: 'initial body',
      timestamp: Date.now()
    });

    await controller.initialize();

    const threadsMap = (controller as any).threads as Map<string, vscode.CommentThread>;
    const thread = threadsMap.get(id);
    assert.ok(thread, 'Thread should have been created');
    
    const comment = thread.comments[0];
    (comment as any).mode = vscode.CommentMode.Editing;
    const originalComment = thread.comments[0];

    (controller as any).syncFromStore();

    const threadAfterSync = threadsMap.get(id);
    assert.strictEqual(threadAfterSync, thread, 'Thread reference should be preserved');
    assert.strictEqual(threadAfterSync.comments[0], originalComment, 'Comment reference should not be replaced if in Editing mode');
  });

  test('syncFromStore preserves threads with draft comments', async () => {
    const id = 'test-id-2';
    await store.save({
      id,
      repo: 'repo1',
      file: 'file2.ts',
      severity: 'medium',
      status: 'open',
      reviewer: 'human',
      lines: '1',
      body: 'initial body',
      timestamp: Date.now()
    });

    await controller.initialize();

    const threadsMap = (controller as any).threads as Map<string, vscode.CommentThread>;
    const thread = threadsMap.get(id);
    assert.ok(thread, 'Thread should have been created');
    
    const comment = thread.comments[0];
    (comment as any).isDraft = true;
    const originalComment = thread.comments[0];

    (controller as any).syncFromStore();

    const threadAfterSync = threadsMap.get(id);
    assert.strictEqual(threadAfterSync, thread, 'Thread reference should be preserved');
    assert.strictEqual(threadAfterSync.comments[0], originalComment, 'Comment reference should not be replaced if isDraft is true');
  });
});
