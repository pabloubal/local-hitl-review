import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { binMode, binPath, build, lhr, pkgVersion } from './helper.mjs';

const COMMANDS = [
  ['init'],
  ['inbox'],
  ['thread', 'list'],
  ['thread', 'show'],
  ['thread', 'create'],
  ['thread', 'reply'],
  ['thread', 'resolve'],
  ['thread', 'reopen'],
  ['review', 'submit'],
  ['check'],
  ['mcp'],
];

test('bundle is one file with shebang and exec bit', () => {
  build();
  assert.equal(readFileSync(binPath, 'utf8').split('\n')[0], '#!/usr/bin/env node');
  assert.ok(binMode() & 0o100, 'owner exec bit set');
});

test('--version prints the bare semver', () => {
  const r = lhr(['--version']);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, `${pkgVersion}\n`);
  assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+/);
});

test('top-level --help lists commands, global flags and examples', () => {
  for (const args of [['--help'], ['-h'], []]) {
    const r = lhr(args);
    assert.equal(r.status, 0, args.join(' '));
    assert.match(r.stdout, /^Usage:/m);
    assert.match(r.stdout, /^Commands:/m);
    assert.match(r.stdout, /^Flags:/m);
    assert.match(r.stdout, /^Examples:/m);
    for (const c of ['init', 'inbox', 'thread', 'review', 'check', 'mcp']) {
      assert.match(r.stdout, new RegExp(`^  ${c}\\b`, 'm'), c);
    }
    assert.doesNotMatch(r.stdout, /\u001b\[/);
    assert.equal(r.stderr, '');
  }
});

test('group help lists verbs', () => {
  const t = lhr(['thread', '--help']);
  assert.equal(t.status, 0);
  for (const v of ['list', 'show', 'create', 'reply', 'resolve', 'reopen']) {
    assert.match(t.stdout, new RegExp(`^  ${v}\\b`, 'm'), v);
  }
  const r = lhr(['review', '--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^  submit\b/m);
});

for (const cmd of COMMANDS) {
  test(`help for lhr ${cmd.join(' ')}`, () => {
    for (const flag of ['--help', '-h']) {
      const r = lhr([...cmd, flag]);
      assert.equal(r.status, 0);
      assert.match(r.stdout, new RegExp(`^Usage: lhr ${cmd.join(' ')}\\b`, 'm'));
      assert.match(r.stdout, /^Flags:/m);
      assert.match(r.stdout, /^Examples:/m);
      assert.match(r.stdout, new RegExp(`^  lhr ${cmd.join(' ')}\\b`, 'm'));
      assert.equal(r.stderr, '');
    }
  });
}

test('--help works after the subcommand and ignores other args', () => {
  const r = lhr(['thread', 'reply', 'abc', '--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^Usage: lhr thread reply/m);
});

test('unknown command exits 2 with a try: line on stderr', () => {
  const r = lhr(['frobnicate']);
  assert.equal(r.status, 2);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /unknown command/);
  assert.match(r.stderr, /^try: lhr --help$/m);
  assert.ok(r.stderr.split('\n').length <= 4, 'does not dump full help');
});

test('unknown verb exits 2 pointing at the group help', () => {
  const r = lhr(['thread', 'frobnicate']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /^try: lhr thread --help$/m);
});

test('unknown flag exits 2 with a try: line', () => {
  const r = lhr(['inbox', '--nope']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /^try: lhr inbox --help$/m);
});

test('recognised command without an implementation exits 2 and says so', () => {
  const r = lhr(['inbox']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /not implemented/);
  assert.match(r.stderr, /^try: lhr inbox --help$/m);
});

test('global flags include --name', () => {
  assert.match(lhr(['inbox', '--help']).stdout, /^  --name <name>/m);
  assert.match(lhr(['--help']).stdout, /^  --name <name>/m);
});

const SPEC_FLAGS = {
  'thread list': ['--status', '--round', '--whose-turn', '--path'],
  'thread create': ['--side', '--base-commit', '--path', '--line', '--end-line', '--severity'],
  'thread reply': ['--severity', '--body', '--client-id'],
  'review submit': ['--verdict', '--summary', '--body', '--client-id'],
};
for (const [cmd, flags] of Object.entries(SPEC_FLAGS)) {
  test(`help for lhr ${cmd} lists spec flags`, () => {
    const out = lhr([...cmd.split(' '), '--help']).stdout;
    for (const f of flags) assert.match(out, new RegExp(`^  ${f}\\b`, 'm'), f);
  });
}

test('review submit help documents --summary, alias --body and all verdicts', () => {
  const out = lhr(['review', 'submit', '--help']).stdout;
  assert.match(out, /^  --summary <text>/m);
  assert.match(out, /^  --body <text>.*alias/im);
  assert.match(out, /approve\|comment\|request-changes/);
});

test('check help has an Exit codes section', () => {
  const out = lhr(['check', '--help']).stdout;
  assert.match(out, /^Exit codes:$/m);
  assert.doesNotMatch(out, /^Notes:/m);
});

test('mcp help lists only --repo and --help', () => {
  const out = lhr(['mcp', '--help']).stdout;
  assert.match(out, /^  --repo <path>/m);
  for (const f of ['--json', '--as', '--dry-run', '--name']) {
    assert.doesNotMatch(out, new RegExp(`^  ${f}`, 'm'));
  }
});
