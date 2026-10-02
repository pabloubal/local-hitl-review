import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { downloadAndUnzipVSCode } from '@vscode/test-electron';

const EXT = path.resolve(__dirname, '..');
const REPO = path.resolve(EXT, '../..');

// Build the extension bundle and fetch VS Code once per run; workers read the
// binary path from the environment.
export default async function globalSetup(): Promise<void> {
  execFileSync('npm', ['run', 'build', '--silent'], { cwd: EXT, stdio: 'inherit' });
  process.env.E2E_CODE_PATH ??= await downloadAndUnzipVSCode({
    version: process.env.E2E_VSCODE_VERSION ?? 'stable',
    cachePath: path.join(REPO, '.vscode-test'),
  });
}
