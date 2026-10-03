import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { binPath, build, context, lhr, mkRepo, tmpDir } from './helper.mjs';

// ---- Review root discovery (cli.md § Review root discovery)

test('discovery: walks up from cwd to the nearest .lhr/', () => {
  const repo = mkRepo();
  const sub = join(repo, 'a', 'b');
  mkdirSync(sub, { recursive: true });
  const r = context([], { cwd: sub });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.data.root, repo);
});

test('discovery: --repo beats LHR_REPO beats cwd', () => {
  const a = mkRepo();
  const b = mkRepo();
  const c = mkRepo();
  assert.equal(context([], { cwd: a, env: { LHR_REPO: b } }).json.data.root, b);
  assert.equal(context(['--repo', c], { cwd: a, env: { LHR_REPO: b } }).json.data.root, c);
  assert.equal(context([`--repo=${c}`], { cwd: a }).json.data.root, c);
});

test('discovery: the nearest .lhr/ shadows one in a parent', () => {
  const outer = mkRepo();
  const inner = join(outer, 'inner');
  mkdirSync(join(inner, '.lhr'), { recursive: true });
  writeFileSync(join(inner, '.lhr', 'format'), '2\n');
  assert.equal(context([], { cwd: inner }).json.data.root, inner);
});

test('discovery: a non-git directory holding .lhr/ is a valid root', () => {
  const dir = tmpDir();
  mkdirSync(join(dir, '.lhr'));
  writeFileSync(join(dir, '.lhr', 'format'), '2\n');
  const r = context([], { cwd: dir });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.data.root, dir);
});

test('discovery: no .lhr/ is exit 2 NOT_A_REPO with try: lhr init --repo <start>', () => {
  const dir = tmpDir();
  const r = lhr(['__debug', 'context'], { cwd: dir });
  assert.equal(r.status, 2);
  assert.equal(r.stdout, '');
  const lines = r.stderr.trimEnd().split('\n');
  assert.equal(lines[0], `error: no .lhr/ found from ${dir} (NOT_A_REPO)`);
  assert.equal(lines[1], `  try: lhr init --repo ${dir}`);
});

test('discovery: a mistyped --repo is NOT_A_REPO, never an empty result', () => {
  const dir = tmpDir();
  const missing = join(dir, 'nope');
  const r = lhr(['__debug', 'context', '--json', '--repo', missing]);
  assert.equal(r.status, 2);
  assert.equal(JSON.parse(r.stdout).error.code, 'NOT_A_REPO');
});

test('discovery: .lhr/ without a valid format file is FORMAT_MISSING, exit 4', () => {
  const dir = tmpDir();
  mkdirSync(join(dir, '.lhr'));
  const r = lhr(['__debug', 'context', '--json'], { cwd: dir });
  assert.equal(r.status, 4);
  assert.equal(JSON.parse(r.stdout).error.code, 'FORMAT_MISSING');
});

test('init does not walk up: it needs no existing .lhr/', () => {
  const dir = tmpDir();
  const r = lhr(['init'], { cwd: dir });
  // init itself is a later slice; it must get past root discovery.
  assert.doesNotMatch(r.stderr, /NOT_A_REPO/);
});

// ---- Identity (cli.md § Identity)

test('identity: human by default, name from git config at the root', () => {
  const repo = mkRepo({ name: 'Ada Lovelace' });
  const { json, status } = context([], { cwd: repo });
  assert.equal(status, 0);
  assert.equal(json.data.mode, 'human');
  assert.deepEqual(json.data.author, { kind: 'human', name: 'Ada Lovelace' });
});

test('identity: LHR_SESSION_ID makes an agent named claude-code', () => {
  const repo = mkRepo();
  const { json } = context([], { cwd: repo, env: { LHR_SESSION_ID: 's-1' } });
  assert.equal(json.data.mode, 'agent');
  assert.deepEqual(json.data.author, {
    kind: 'agent',
    name: 'claude-code',
    session: 's-1',
  });
});

test('identity: agent name is --name > LHR_AGENT_NAME > claude-code', () => {
  const repo = mkRepo();
  const env = { LHR_SESSION_ID: 's-1', LHR_AGENT_NAME: 'from-env' };
  assert.equal(context([], { cwd: repo, env }).json.data.author.name, 'from-env');
  assert.equal(context(['--name', 'flag'], { cwd: repo, env }).json.data.author.name, 'flag');
});

test('identity: --as human beats LHR_SESSION_ID', () => {
  const repo = mkRepo({ name: 'Grace' });
  const { json } = context(['--as', 'human'], {
    cwd: repo,
    env: { LHR_SESSION_ID: 's-1' },
  });
  assert.equal(json.data.mode, 'human');
  assert.deepEqual(json.data.author, { kind: 'human', name: 'Grace' });
});

test('identity: --as agent without a session warns on stderr for writes only', () => {
  const repo = mkRepo();
  const read = context(['--as', 'agent'], { cwd: repo });
  assert.equal(read.status, 0);
  assert.doesNotMatch(read.stderr, /LHR_SESSION_ID/);
  const r = context(['--as', 'agent', '--write'], { cwd: repo });
  assert.equal(r.status, 0);
  assert.deepEqual(r.json.data.author, { kind: 'agent', name: 'claude-code' });
  assert.match(r.stderr, /^warning: .*LHR_SESSION_ID/m);
});

test('identity: --as with another value is a usage error', () => {
  const repo = mkRepo();
  const r = lhr(['__debug', 'context', '--as', 'robot'], { cwd: repo });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /\(INVALID_INPUT\)/);
});

test('identity: empty LHR_SESSION_ID counts as unset', () => {
  const repo = mkRepo();
  assert.equal(context([], { cwd: repo, env: { LHR_SESSION_ID: '' } }).json.data.mode, 'human');
});

// ---- Global flags

test('global flags are accepted before and after the subcommand', () => {
  const repo = mkRepo();
  const before = lhr(['--json', '--repo', repo, '__debug', 'context']);
  const after = lhr(['__debug', 'context', '--json', '--repo', repo]);
  assert.equal(before.status, 0, before.stderr);
  assert.deepEqual(JSON.parse(before.stdout), JSON.parse(after.stdout));
});

test('--dry-run reaches the command context', () => {
  const repo = mkRepo();
  assert.equal(context(['--dry-run'], { cwd: repo }).json.data.dryRun, true);
  assert.equal(context([], { cwd: repo }).json.data.dryRun, false);
});

test('a command-specific flag is rejected by commands that do not declare it', () => {
  const repo = mkRepo();
  const r = lhr(['__debug', 'context', '--client-id', 'x'], { cwd: repo });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /see: lhr /);
});

test('a command declaring its own flags accepts them', () => {
  const repo = mkRepo();
  const r = lhr(['__debug', 'flags', '--json', '--probe', 'yes'], {
    cwd: repo,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).data.probe, 'yes');
});

test('-- ends flag parsing', () => {
  const repo = mkRepo();
  const r = lhr(['__debug', 'flags', '--json', '--', '--json'], { cwd: repo });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).data.positionals, ['--json']);
});

// ---- stdin `-`

test('stdin: - reads stdin to EOF', () => {
  const repo = mkRepo();
  const r = lhr(['__debug', 'stdin', '-', '--json'], {
    cwd: repo,
    input: 'line1\nline2\n',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).data.body, 'line1\nline2\n');
});

// ---- JSON envelope

test('envelope: success is {version, data, diagnostics} + newline, root first', () => {
  const repo = mkRepo();
  const r = context([], { cwd: repo });
  assert.ok(r.stdout.endsWith('}\n'));
  assert.deepEqual(Object.keys(r.json), ['version', 'data', 'diagnostics']);
  assert.equal(r.json.version, 1);
  assert.deepEqual(r.json.diagnostics, []);
  assert.equal(Object.keys(r.json.data)[0], 'root');
});

test('envelope: error is {version, error:{code,message,example?}} with no diagnostics', () => {
  const dir = tmpDir();
  const r = lhr(['__debug', 'context', '--json'], { cwd: dir });
  assert.equal(r.stderr, '', 'json errors keep stderr free of duplicate prose');
  const j = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(j), ['version', 'error']);
  assert.equal(j.version, 1);
  assert.equal(j.error.code, 'NOT_A_REPO');
  assert.equal(j.error.message, `no .lhr/ found from ${dir}`);
  assert.equal(j.error.example, `lhr init --repo ${dir}`);
});

test('envelope: usage errors honour --json too', () => {
  const r = lhr(['inbox', '--nope', '--json']);
  assert.equal(r.status, 2);
  const j = JSON.parse(r.stdout);
  assert.equal(j.error.code, 'INVALID_INPUT');
  assert.equal(r.stderr, '');
});

// ---- Exit codes and error template table

const CODES = [
  ['INVALID_INPUT', 2, undefined],
  ['NOT_A_REPO', 2, /^lhr init --repo /],
  ['PATH_NOT_IN_REPO', 2, undefined],
  ['THREAD_NOT_FOUND', 3, 'lhr thread list --status all'],
  ['MESSAGE_NOT_FOUND', 3, undefined],
  ['DRAFT_NOT_FOUND', 3, 'lhr thread list'],
  ['NOT_A_DRAFT', 4, undefined],
  ['FORMAT_MISSING', 4, 'lhr check'],
  ['FORMAT_VERSION', 4, undefined],
  ['GIT_FAILED', 5, undefined],
  ['IO_FAILED', 5, undefined],
];
for (const [code, exit, example] of CODES) {
  test(`exit ${exit} and error shape for ${code}`, () => {
    const repo = mkRepo();
    const r = lhr(['__debug', 'fail', code, '--json'], { cwd: repo });
    assert.equal(r.status, exit);
    const j = JSON.parse(r.stdout);
    assert.equal(j.error.code, code);
    if (typeof example === 'string') assert.equal(j.error.example, example);
    else if (example) assert.match(j.error.example, example);
    else assert.equal(j.error.example, undefined);
    const t = lhr(['__debug', 'fail', code], { cwd: repo });
    assert.equal(t.status, exit);
    assert.equal(t.stdout, '');
    assert.match(t.stderr.split('\n')[0], new RegExp(`^error: .+ \\(${code}\\)$`));
    if (typeof example === 'string') {
      assert.match(t.stderr, new RegExp(`^  try: ${example}$`, 'm'));
    }
  });
}

test('exit 5 when git cannot run (GIT_FAILED)', () => {
  const repo = mkRepo();
  const r = lhr(['__debug', 'context', '--json'], {
    cwd: repo,
    env: { PATH: '/nonexistent' },
  });
  assert.equal(r.status, 5);
  assert.equal(JSON.parse(r.stdout).error.code, 'GIT_FAILED');
});

test('exit 0 for help and success; unknown command still exits 2', () => {
  assert.equal(lhr(['--help']).status, 0);
  assert.equal(lhr(['nope']).status, 2);
});

test('exit 130 on SIGINT with only a newline and no partial JSON', async () => {
  build();
  const repo = mkRepo();
  const child = spawn(process.execPath, [binPath, '__debug', 'wait', '--json'], {
    cwd: repo,
    env: { ...process.env, LHR_DEBUG: '1', NO_COLOR: '1', FORCE_COLOR: '' },
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => {
    err += d;
    if (err.includes('ready')) child.kill('SIGINT');
  });
  const code = await new Promise((res) => child.on('close', (c) => res(c)));
  assert.equal(code, 130);
  assert.equal(out, '');
  assert.ok(err.endsWith('\n'));
});

// ---- Colour and width helpers

test('width: COLUMNS when stdout is not a terminal, else 80; rules cap at 100', () => {
  const repo = mkRepo();
  const w = (env) => JSON.parse(lhr(['__debug', 'term', '--json'], { cwd: repo, env }).stdout).data;
  assert.equal(w({ COLUMNS: '60' }).width, 60);
  assert.equal(w({ COLUMNS: '60' }).ruleWidth, 60);
  assert.equal(w({ COLUMNS: '250' }).ruleWidth, 100);
  assert.equal(w({ COLUMNS: 'abc' }).width, 80);
  assert.equal(w({ COLUMNS: '0' }).width, 80);
  assert.equal(w({}).width, 80);
});

test('colour is off when piped, whatever the environment says', () => {
  const repo = mkRepo();
  const r = lhr(['__debug', 'term', '--json'], {
    cwd: repo,
    env: { NO_COLOR: '', FORCE_COLOR: '1' },
  });
  assert.equal(JSON.parse(r.stdout).data.color, false);
});

// ---- review fixes

test('__debug is unavailable without LHR_DEBUG=1', () => {
  for (const v of ['', '0']) {
    const r = lhr(['__debug', 'context'], { env: { LHR_DEBUG: v } });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /^error: unknown command __debug \(INVALID_INPUT\)$/m);
  }
});

test('parse errors are one line: error: <msg> (CODE)', () => {
  const repo = mkRepo();
  for (const args of [
    ['inbox', '--repo'],
    ['inbox', '--bogus'],
  ]) {
    const r = lhr(args, { cwd: repo });
    assert.equal(r.status, 2);
    const first = r.stderr.split('\n')[0];
    assert.match(first, /^error: .+ \(INVALID_INPUT\)$/, r.stderr);
    assert.doesNotMatch(r.stderr, /To specify/);
  }
});

test('--json is honoured even when a value-less option swallows it', () => {
  const repo = mkRepo();
  const r = lhr(['inbox', '--repo', '--json'], { cwd: repo });
  assert.equal(r.status, 2);
  assert.equal(r.stderr, '');
  const env = JSON.parse(r.stdout);
  assert.equal(env.error.code, 'INVALID_INPUT');
  assert.doesNotMatch(env.error.message, /\n/);
});

test('mcp starts without a review root and rejects --name', () => {
  const dir = tmpDir();
  const r = lhr(['mcp'], { cwd: dir });
  assert.doesNotMatch(r.stderr, /NOT_A_REPO/);
  const n = lhr(['mcp', '--name', 'x'], { cwd: dir });
  assert.equal(n.status, 2);
  assert.match(n.stderr, /^error: .*--name.* \(INVALID_INPUT\)$/m);
});

test('a non-LhrError is reported as an unexpected internal error', () => {
  const repo = mkRepo();
  const r = lhr(['__debug', 'crash', '--json'], { cwd: repo });
  assert.equal(r.status, 5);
  const e = JSON.parse(r.stdout).error;
  assert.match(e.message, /^unexpected internal error: boom/);
});

test('stdin: - on a terminal exits 2 instead of blocking', (t) => {
  const probe = spawnSync('script', ['-q', '/dev/null', 'true'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) return t.skip('script(1) unavailable');
  build();
  const repo = mkRepo();
  const cmd = [process.execPath, binPath, '__debug', 'stdin', '-', '--json'];
  const args =
    process.platform === 'darwin'
      ? ['-q', '/dev/null', ...cmd]
      : ['-qec', cmd.map((c) => `'${c}'`).join(' '), '/dev/null'];
  const r = spawnSync('script', args, {
    cwd: repo,
    encoding: 'utf8',
    timeout: 10_000,
    env: { ...process.env, LHR_DEBUG: '1', NO_COLOR: '1', FORCE_COLOR: '' },
  });
  assert.equal(r.signal, null, 'did not hang');
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stdout, /INVALID_INPUT/);
});
