import * as assert from 'assert';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { GitService } from '../../gitService';

const execFileAsync = promisify(execFile);

suite('GitService Integration Tests', () => {
  let tempDir: string;
  let gitService: GitService;

  async function git(...args: string[]) {
    await execFileAsync('git', args, { cwd: tempDir });
  }

  setup(async () => {
    // Create a temporary directory for the git repository
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vscode-comment-test-'));
    gitService = new GitService(tempDir);

    // Initialize git repo
    await git('init');
    await git('config', 'user.name', 'Test User');
    await git('config', 'user.email', 'test@example.com');

    // Create an initial commit (merge base)
    await fs.writeFile(path.join(tempDir, 'file1.txt'), 'initial content\n');
    await git('add', 'file1.txt');
    await git('commit', '-m', 'Initial commit');
  });

  teardown(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('getMergeBase returns a valid commit hash', async () => {
    const baseBranch = 'main'; // Since we are on master/main, HEAD is the base branch effectively
    // First, let's create a new branch
    await git('checkout', '-b', 'feature-branch');
    await fs.writeFile(path.join(tempDir, 'file2.txt'), 'feature content\n');
    await git('add', 'file2.txt');
    await git('commit', '-m', 'Feature commit');

    const mergeBase = await gitService.getMergeBase('main');
    
    // Check that it returned a hash (40 hex chars)
    assert.match(mergeBase, /^[0-9a-f]{40}$/);
  });

  test('getChangedFiles returns M for modified files', async () => {
    const mergeBase = await gitService.getMergeBase('HEAD'); // Use current HEAD as merge base

    // Modify a file
    await fs.writeFile(path.join(tempDir, 'file1.txt'), 'modified content\n');
    await git('add', 'file1.txt');

    const changedFiles = await gitService.getChangedFiles(mergeBase);
    
    assert.strictEqual(changedFiles.length, 1);
    assert.strictEqual(changedFiles[0].path, 'file1.txt');
    assert.strictEqual(changedFiles[0].status, 'M');
  });
});
