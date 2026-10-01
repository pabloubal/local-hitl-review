// Fails when a workspace package's version differs from the root version.
// The release job stamps one version into every package (ADR 0004), and the
// release tag is the root version, so this keeps every package on the release.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const rootDir = new URL('..', import.meta.url).pathname;
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

const root = readJson(join(rootDir, 'package.json'));
const mismatches = [];

for (const pattern of root.workspaces) {
  if (!pattern.endsWith('/*')) {
    throw new Error(`check-versions: unsupported workspace pattern "${pattern}"`);
  }
  const parent = join(rootDir, pattern.slice(0, -2));
  for (const entry of readdirSync(parent, { withFileTypes: true })) {
    const manifest = join(parent, entry.name, 'package.json');
    if (!entry.isDirectory() || !existsSync(manifest)) continue;
    const pkg = readJson(manifest);
    if (pkg.version !== root.version) {
      mismatches.push(`${pkg.name} (${pattern.slice(0, -2)}/${entry.name}): ${pkg.version}`);
    }
  }
}

if (mismatches.length > 0) {
  console.error(`Package versions must match the root version ${root.version}:`);
  for (const line of mismatches) console.error(`  ${line}`);
  process.exit(1);
}
console.log(`All workspace packages are at ${root.version}.`);
