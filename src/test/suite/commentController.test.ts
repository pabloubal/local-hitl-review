import * as assert from 'assert';
import * as vscode from 'vscode';
import { ReviewCommentController } from '../../commentController';
import { FeedbackStore } from '../../feedbackStore';

suite('ReviewCommentController', () => {
    let store: FeedbackStore;
    let controller: ReviewCommentController;
    let originalWorkspaceRoot: string;

    setup(() => {
        originalWorkspaceRoot = '/rootdir';
        store = new FeedbackStore(originalWorkspaceRoot);
        // Mock getRepoRoots and getScope
        store.getRepoRoots = () => ['/rootdir/repo1', '/rootdir/repo2'];
        store.getScope = () => 'global';
        
        controller = new ReviewCommentController(store, originalWorkspaceRoot, () => []);
    });

    teardown(() => {
        controller.dispose();
        store.dispose();
    });

    suite('getRelativePath', () => {
        test('gets relative path from workspace root when scope is global', () => {
            const fileUri = vscode.Uri.file('/rootdir/repo1/file.md');
            const relInfo = controller.getRelativePath(fileUri);
            
            assert.strictEqual(relInfo?.relativePath, 'repo1/file.md', 'Path should be relative to workspace root (rootdir) for global scope');
            assert.strictEqual(relInfo?.repoRoot, '/rootdir/repo1', 'repoRoot should be identified as repo1');
        });

        test('gets relative path from repo root when scope is local', () => {
            store.getScope = () => 'local';
            const fileUri = vscode.Uri.file('/rootdir/repo1/file.md');
            const relInfo = controller.getRelativePath(fileUri);
            
            assert.strictEqual(relInfo?.relativePath, 'file.md', 'Path should be relative to repo root (repo1) for local scope');
            assert.strictEqual(relInfo?.repoRoot, '/rootdir/repo1', 'repoRoot should be identified as repo1');
        });
    });
});
