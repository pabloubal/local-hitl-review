import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { lhr, mkRepo, tmpDir } from './helper.mjs';

const read = (p) => readFileSync(p, 'utf8');

test('init: fresh git repo gets .lhr/format and .gitignore', () => {
  const repo = mkRepo({ lhr: false });
  const r = lhr(['init'], { cwd: repo });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `created .lhr/ in ${repo}\n`);
  assert.equal(read(join(repo, '.lhr', 'format')), '2\n');
  assert.equal(read(join(repo, '.lhr', '.gitignore')), 'drafts/\n');
});

test('init: re-run changes nothing and exits 0', () => {
  const repo = mkRepo({ lhr: false });
  lhr(['init'], { cwd: repo });
  const r = lhr(['init'], { cwd: repo });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `.lhr/ already exists in ${repo} (nothing to do)\n`);
  assert.equal(read(join(repo, '.lhr', 'format')), '2\n');
  assert.equal(read(join(repo, '.lhr', '.gitignore')), 'drafts/\n');
});

test('init: re-run restores a missing .gitignore without touching format', () => {
  const repo = mkRepo(); // has .lhr/format, no .gitignore
  const r = lhr(['init', '--json'], { cwd: repo });
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.deepEqual(j.data.created, ['.lhr/.gitignore']);
  assert.equal(read(join(repo, '.lhr', '.gitignore')), 'drafts/\n');
});

test('init: an existing .gitignore keeps its lines and gains drafts/', () => {
  const repo = mkRepo();
  writeFileSync(join(repo, '.lhr', '.gitignore'), 'tmp/');
  lhr(['init'], { cwd: repo });
  assert.equal(read(join(repo, '.lhr', '.gitignore')), 'tmp/\ndrafts/\n');
});

test('init: an ancestor .lhr/ is reported on stderr and in JSON', () => {
  const outer = mkRepo();
  const inner = join(outer, 'sub');
  mkdirSync(inner);
  const r = lhr(['init'], { cwd: inner });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `created .lhr/ in ${inner}\n`);
  assert.equal(r.stderr, `note: ${outer} already has a .lhr/ above this directory\n`);
  const j = JSON.parse(lhr(['init', '--json'], { cwd: inner }).stdout);
  assert.equal(j.data.ancestor, outer);
  assert.equal(j.data.root, inner);
});

test('init: works in a non-git directory', () => {
  const dir = tmpDir();
  const r = lhr(['init'], { cwd: dir });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(read(join(dir, '.lhr', 'format')), '2\n');
});

test('init: path argument targets exactly that directory, no walk up', () => {
  const dir = tmpDir();
  const target = join(dir, 'proj');
  mkdirSync(target);
  const r = lhr(['init', 'proj'], { cwd: dir });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(target, '.lhr', 'format')));
  assert.ok(!existsSync(join(dir, '.lhr')));
});

test('init: missing path is INVALID_INPUT, exit 2', () => {
  const dir = tmpDir();
  const r = lhr(['init', 'nope', '--json'], { cwd: dir });
  assert.equal(r.status, 2);
  assert.equal(JSON.parse(r.stdout).error.code, 'INVALID_INPUT');
});

test('init: a bad existing format is FORMAT_VERSION, exit 4, and is not rewritten', () => {
  const repo = mkRepo();
  writeFileSync(join(repo, '.lhr', 'format'), '9\n');
  const r = lhr(['init'], { cwd: repo });
  assert.equal(r.status, 4);
  assert.equal(read(join(repo, '.lhr', 'format')), '9\n');
});

test('init: --dry-run lists what it would create and writes nothing', () => {
  const dir = tmpDir();
  const r = lhr(['init', '--dry-run'], { cwd: dir });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^would create \.lhr\/ in /);
  assert.match(r.stdout, /\.lhr\/format/);
  assert.match(r.stdout, /\.lhr\/\.gitignore/);
  assert.ok(!existsSync(join(dir, '.lhr')));
  const j = JSON.parse(lhr(['init', '--dry-run', '--json'], { cwd: dir }).stdout);
  assert.equal(j.data.dryRun, true);
  assert.deepEqual(j.data.created, ['.lhr/format', '.lhr/.gitignore']);
  assert.ok(!existsSync(join(dir, '.lhr')));
});

test('init: --json envelope carries root and created files', () => {
  const dir = tmpDir();
  const j = JSON.parse(lhr(['init', '--json'], { cwd: dir }).stdout);
  assert.equal(j.version, 1);
  assert.equal(j.data.root, dir);
  assert.deepEqual(j.data.created, ['.lhr/format', '.lhr/.gitignore']);
  assert.equal(j.data.dryRun, false);
  assert.equal(j.data.ancestor, undefined);
});

test('init: --repo sets the default directory', () => {
  const dir = tmpDir();
  const r = lhr(['init', '--repo', dir], { cwd: tmpDir() });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(dir, '.lhr', 'format')));
});
