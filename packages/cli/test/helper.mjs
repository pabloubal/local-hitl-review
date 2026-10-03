// Builds the bundle once per test process and runs the built binary.
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
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
/** Newest mtime under `dir` (0 when missing). */
function newest(dir) {
  let t = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    t = Math.max(t, e.isDirectory() ? newest(p) : statSync(p).mtimeMs);
  }
  return t;
}
const upToDate = () => {
  try {
    return (
      statSync(binPath).mtimeMs >=
      Math.max(newest(join(pkgDir, 'src')), newest(join(pkgDir, '../core/src')))
    );
  } catch {
    return false;
  }
};
export function build() {
  if (built) return;
  // `npm test` builds first; test files run in parallel, so don't rebuild a fresh bundle.
  if (upToDate()) {
    built = true;
    return;
  }
  const res = spawnSync(process.execPath, ['esbuild.mjs'], {
    cwd: pkgDir,
    encoding: 'utf8',
  });
  if (res.status !== 0) throw new Error(`build failed:\n${res.stdout}\n${res.stderr}`);
  built = true;
}

let gitConfigPath;
/**
 * A global git config that sets only `user.name`, so a run never depends on the
 * host's git identity (CI runners have none; a developer's machine does).
 */
function hermeticGitConfig() {
  if (!gitConfigPath) {
    gitConfigPath = join(tmpDir('lhr-gitconfig-'), 'config');
    writeFileSync(gitConfigPath, '[user]\n\tname = Test Human\n');
  }
  return gitConfigPath;
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
    env: {
      ...env,
      GIT_CONFIG_GLOBAL: hermeticGitConfig(),
      GIT_CONFIG_NOSYSTEM: '1',
      NO_COLOR: '1',
      LHR_DEBUG: '1',
      ...extra,
    },
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
