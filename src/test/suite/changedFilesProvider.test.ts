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
});
