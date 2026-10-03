import * as esbuild from 'esbuild';
import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

/** @type {esbuild.BuildOptions} */
const buildOptions = {
  entryPoints: ['src/main.ts'],
  bundle: true,
  outfile: 'dist/lhr.mjs',
  format: 'esm',
  platform: 'node',
  target: 'node20',
  banner: { js: '#!/usr/bin/env node' },
  define: { __LHR_VERSION__: JSON.stringify(version) },
  sourcemap: true,
  minify: false,
};

// Write each output to a temp file and rename it into place. esbuild truncates its outfile before
// rewriting it, and several test files rebuild in parallel: a process spawning the binary
// mid-write would run an empty script (exit 0, no output).
const result = await esbuild.build({ ...buildOptions, write: false });
for (const out of result.outputFiles) {
  const tmp = `${dirname(out.path)}/.${basename(out.path)}.${process.pid}.tmp`;
  writeFileSync(tmp, out.contents);
  if (out.path.endsWith('lhr.mjs')) chmodSync(tmp, 0o755);
  renameSync(tmp, out.path);
}
console.log('Build complete.');
