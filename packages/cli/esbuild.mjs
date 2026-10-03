import * as esbuild from 'esbuild';
import { chmodSync, readFileSync } from 'node:fs';

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

await esbuild.build(buildOptions);
chmodSync('dist/lhr.mjs', 0o755);
console.log('Build complete.');
