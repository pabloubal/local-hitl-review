import * as assert from 'assert';
import * as vscode from 'vscode';
import { ChangedFilesProvider } from '../../changedFilesProvider.js';

class MockWorkspaceState {
  private data = new Map<string, any>();
  get(key: string) { return this.data.get(key); }
  update(key: string, value: any) { this.data.set(key, value); }
}

suite('ChangedFilesProvider Tests', () => {
  let provider: ChangedFilesProvider;
  let mockContext: vscode.ExtensionContext;
  const workspaceRoot = '/mock/workspace';

  setup(() => {
    mockContext = {
      workspaceState: new MockWorkspaceState(),
    } as any;
    provider = new ChangedFilesProvider(workspaceRoot, mockContext, {});
  });

  test('getNextUnreviewedFile returns first unviewed file', async () => {
    const mockRepo = {
      isLoaded: true,
      compareRef: 'main',
      gitService: { repoRoot: '/mock/workspace' } as any,
      changedFiles: [
        { path: 'file1.ts', originalPath: 'file1.ts', status: 'M' },
        { path: 'file2.ts', originalPath: 'file2.ts', status: 'M' },
        { path: 'file3.ts', originalPath: 'file3.ts', status: 'M' }
      ]
    };
    (provider as any).repos = [mockRepo];

    const next = await provider.getNextUnreviewedFile();
    assert.ok(next);
    assert.strictEqual(next.file.path, 'file1.ts');
  });

  test('getNextUnreviewedFile skips viewed files', async () => {
    const mockRepo = {
      isLoaded: true,
      compareRef: 'main',
      gitService: { repoRoot: '/mock/workspace' } as any,
      changedFiles: [
        { path: 'file1.ts', originalPath: 'file1.ts', status: 'M' },
        { path: 'file2.ts', originalPath: 'file2.ts', status: 'M' }
      ]
    };
    (provider as any).repos = [mockRepo];
    
    provider.setFileViewed('/mock/workspace', 'main', 'file1.ts', true);

    const next = await provider.getNextUnreviewedFile();
    assert.ok(next);
    assert.strictEqual(next.file.path, 'file2.ts');
  });

  test('getNextUnreviewedFile returns next unviewed file after current', async () => {
    const mockRepo = {
      isLoaded: true,
      compareRef: 'main',
      gitService: { repoRoot: '/mock/workspace' } as any,
      changedFiles: [
        { path: 'file1.ts', originalPath: 'file1.ts', status: 'M' },
        { path: 'file2.ts', originalPath: 'file2.ts', status: 'M' },
        { path: 'file3.ts', originalPath: 'file3.ts', status: 'M' }
      ]
    };
    (provider as any).repos = [mockRepo];

    const next = await provider.getNextUnreviewedFile('file1.ts');
    assert.ok(next);
    assert.strictEqual(next.file.path, 'file2.ts');
  });

  test('getNextUnreviewedFile wraps around to first unviewed file', async () => {
    const mockRepo = {
      isLoaded: true,
      compareRef: 'main',
      gitService: { repoRoot: '/mock/workspace' } as any,
      changedFiles: [
        { path: 'file1.ts', originalPath: 'file1.ts', status: 'M' },
        { path: 'file2.ts', originalPath: 'file2.ts', status: 'M' },
        { path: 'file3.ts', originalPath: 'file3.ts', status: 'M' }
      ]
    };
    (provider as any).repos = [mockRepo];
    
    provider.setFileViewed('/mock/workspace', 'main', 'file2.ts', true);

    const next = await provider.getNextUnreviewedFile('file3.ts');
    assert.ok(next);
    assert.strictEqual(next.file.path, 'file1.ts');
  });

  test('getNextUnreviewedFile returns undefined if all viewed', async () => {
    const mockRepo = {
      isLoaded: true,
      compareRef: 'main',
      gitService: { repoRoot: '/mock/workspace' } as any,
      changedFiles: [
        { path: 'file1.ts', originalPath: 'file1.ts', status: 'M' }
      ]
    };
    (provider as any).repos = [mockRepo];
    
    provider.setFileViewed('/mock/workspace', 'main', 'file1.ts', true);

    const next = await provider.getNextUnreviewedFile();
    assert.strictEqual(next, undefined);
  });

  test('loadRepoChanges resets viewed flags when HEAD changes', async () => {
    const mockRepo = {
      isLoaded: false,
      baseBranch: 'main',
      currentBranch: 'feature',
      gitService: { 
        repoRoot: '/mock/workspace',
        getMergeBase: async () => 'base-hash',
        getChangedFiles: async () => [],
        getHeadHash: async () => 'new-head-hash',
        detectBaseBranch: async () => 'main'
      } as any,
      changedFiles: []
    };

    (provider as any).repos = [mockRepo];
    (provider as any).compareMode = { type: 'branch' };

    // Simulate state from previous load
    const branchKey = 'headHash:/mock/workspace:feature';
    mockContext.workspaceState.update(branchKey, 'old-head-hash');
    provider.setFileViewed('/mock/workspace', 'base-hash', 'file1.ts', true);
    provider.setFileViewed('/mock/workspace', 'base-hash', 'file2.ts', true);

    // Provide a mocked keys() function for MockWorkspaceState
    (mockContext.workspaceState as any).keys = () => {
      return Array.from((mockContext.workspaceState as any).data.keys());
    };

    assert.strictEqual(provider.isFileViewed('/mock/workspace', 'base-hash', 'file1.ts'), true);

    await provider.loadRepoChanges(mockRepo as any);

    assert.strictEqual(provider.isFileViewed('/mock/workspace', 'base-hash', 'file1.ts'), false);
    assert.strictEqual(provider.isFileViewed('/mock/workspace', 'base-hash', 'file2.ts'), false);
    assert.strictEqual(mockContext.workspaceState.get(branchKey), 'new-head-hash');
  });
});
