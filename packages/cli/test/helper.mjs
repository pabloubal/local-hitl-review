// Builds the bundle once per test process and runs the built binary.
import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
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
  const res = spawnSync(process.execPath, [binPath, ...args], {
    encoding: 'utf8',
    env: { ...env, NO_COLOR: '1' },
    ...opts,
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

export function binMode() {
  build();
  return statSync(binPath).mode;
}
