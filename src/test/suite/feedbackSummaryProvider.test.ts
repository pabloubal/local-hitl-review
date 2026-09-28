import * as assert from 'assert';
import { FeedbackSummaryProvider, FileSummaryItem, CommentSummaryItem } from '../../feedbackSummaryProvider.js';
import { filterState } from '../../filterState.js';
import { FeedbackStore } from '../../feedbackStore.js';
import * as vscode from 'vscode';

class MockFeedbackStore {
  private comments: any[] = [];
  
  // mock methods
  getAll() { return this.comments; }
  setComments(comments: any[]) { this.comments = comments; }
  onDidChange = new vscode.EventEmitter<void>().event;
}

suite('FeedbackSummaryProvider Tests', () => {
  let provider: FeedbackSummaryProvider;
  let mockStore: MockFeedbackStore;
  const workspaceRoot = '/mock/workspace';

  setup(() => {
    mockStore = new MockFeedbackStore();
    provider = new FeedbackSummaryProvider(mockStore as unknown as FeedbackStore, workspaceRoot);
    // Reset filter state
    filterState.update([], ['open']);
  });

  test('getChildren groups open comments by file when no filter applied', async () => {
    mockStore.setComments([
      { id: '1', file: 'fileA.ts', status: 'open', severity: 'critical', body: 'A' },
      { id: '2', file: 'fileA.ts', status: 'open', severity: 'low', body: 'B' },
      { id: '3', file: 'fileB.ts', status: 'resolved', severity: 'high', body: 'C' }
    ]);

    const children = await provider.getChildren();
    assert.strictEqual(children.length, 1);
    const fileNode = children[0] as FileSummaryItem;
    assert.strictEqual(fileNode.file, 'fileA.ts');
    assert.strictEqual(fileNode.comments.length, 2);
  });

  test('getChildren respects filterState for status', async () => {
    mockStore.setComments([
      { id: '1', file: 'fileA.ts', status: 'open', severity: 'critical', body: 'A' },
      { id: '2', file: 'fileA.ts', status: 'resolved', severity: 'low', body: 'B' },
      { id: '3', file: 'fileB.ts', status: 'wontfix', severity: 'high', body: 'C' }
    ]);

    // Show resolved only
    filterState.update([], ['resolved']);

    const children = await provider.getChildren();
    assert.strictEqual(children.length, 1);
    const fileNode = children[0] as FileSummaryItem;
    assert.strictEqual(fileNode.file, 'fileA.ts');
    assert.strictEqual(fileNode.comments.length, 1);
    assert.strictEqual(fileNode.comments[0].status, 'resolved');
  });

  test('getChildren respects filterState for severity', async () => {
    mockStore.setComments([
      { id: '1', file: 'fileA.ts', status: 'open', severity: 'critical', body: 'A' },
      { id: '2', file: 'fileB.ts', status: 'open', severity: 'low', body: 'B' }
    ]);

    // Show critical only
    filterState.update(['critical'], ['open']);

    const children = await provider.getChildren();
    assert.strictEqual(children.length, 1);
    const fileNode = children[0] as FileSummaryItem;
    assert.strictEqual(fileNode.file, 'fileA.ts');
  });
});
