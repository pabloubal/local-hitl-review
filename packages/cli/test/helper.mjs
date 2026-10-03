// Builds the bundle once per test process and runs the built binary.
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgDir = fileURLToPath(new URL('..', import.meta.url));
export const binPath = fileURLToPath(new URL('../dist/lhr.mjs', import.meta.url));
export const pkgVersion = JSON.parse(readFileSync(`${pkgDir}/package.json`, 'utf8')).version;

let built = false;
export function build() {
  if (built) return;
  const res = spawnSync(process.execPath, ['esbuild.mjs'], {
    cwd: pkgDir,
    encoding: 'utf8',
  });
  if (res.status !== 0) throw new Error(`build failed:\n${res.stdout}\n${res.stderr}`);
  built = true;
}

/** Runs the built binary; returns { status, stdout, stderr }. */
export function lhr(args, opts = {}) {
  build();
  // node:test sets FORCE_COLOR for children; drop it so the run is deterministic.
  const { FORCE_COLOR: _drop, ...env } = process.env;
  // Keep the host's LHR_* out so a real agent session can't leak into tests.
  for (const k of Object.keys(env)) if (k.startsWith('LHR_')) delete env[k];
  const { env: extra, ...rest } = opts;
  const res = spawnSync(process.execPath, [binPath, ...args], {
    encoding: 'utf8',
    env: { ...env, NO_COLOR: '1', LHR_DEBUG: '1', ...extra },
    ...rest,
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

export function binMode() {
  build();
  return statSync(binPath).mode;
}

/** Real temp directory (symlinks resolved, as the CLI reports roots). */
export function tmpDir(prefix = 'lhr-cli-') {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

/** Real git repo with a valid `.lhr/` and a configured human name. */
export function mkRepo({ lhr: withLhr = true, name = 'Test Human' } = {}) {
  const dir = tmpDir();
  const git = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.name', name);
  git('config', 'user.email', 't@example.com');
  if (withLhr) {
    mkdirSync(join(dir, '.lhr'));
    writeFileSync(join(dir, '.lhr', 'format'), '2\n');
  }
  return dir;
}

/** Runs the hidden `lhr __debug context` and parses the JSON envelope. */
export function context(args, opts) {
  const r = lhr(['__debug', 'context', '--json', ...args], opts);
  return { ...r, json: r.stdout ? JSON.parse(r.stdout) : undefined };
}
