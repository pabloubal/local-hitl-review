// Shared fixtures for the scenario tests (see .claude/skills/verify-lhr/features/).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { lhr, tmpDir } from './helper.mjs';

export const BASE = 'export const a = 1;\nexport function add(a, b) {\n  return a + b;\n}\n';
export const AGENT = {
  LHR_SESSION_ID: 'scenario-session',
  LHR_AGENT_NAME: 'scenario-agent',
};

/** Message IDs have one-second resolution (#155): put each write in its own second. */
export const nextSecond = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1100);

/** A git repo with a committed `src/app.ts` and a `.lhr/` from `lhr init`. */
export function session() {
  const dir = tmpDir('lhr-scenario-');
  const git = (...a) =>
    spawnSync('git', ['-c', 'user.name=Test Human', '-c', 'user.email=t@example.com', ...a], {
      cwd: dir,
      encoding: 'utf8',
    });
  git('init', '-q', '-b', 'main');
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src/app.ts'), BASE);
  writeFileSync(join(dir, 'README.md'), '# fixture\n');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  const init = lhr(['init'], { cwd: dir });
  assert.equal(init.status, 0, init.stderr);
  return { dir, git };
}

export const run = (dir, args, extra = {}) => lhr(args, { cwd: dir, ...extra });
export const ok = (r) => (assert.equal(r.status, 0, `${r.stdout}${r.stderr}`), r);
export const handle = (r) => r.stdout.match(/^thread (\w+)$/m)[1];
export const threads = (dir, args = [], extra) =>
  JSON.parse(ok(run(dir, ['thread', 'list', '--json', ...args], extra)).stdout).data.threads;
