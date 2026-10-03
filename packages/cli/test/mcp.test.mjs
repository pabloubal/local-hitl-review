// lhr mcp (docs/spec/mcp.md): an in-process client against the server module,
// plus a handshake against the built binary over stdio.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { binPath, build, lhr, mkRepo, pkgVersion, tmpDir } from './helper.mjs';

const pkgDir = fileURLToPath(new URL('..', import.meta.url));

// Bundles the server module and core once, so the tests import the TS sources.
const bundleDir = tmpDir('lhr-mcp-bundle-');
const bundle = join(bundleDir, 'mcp.mjs');
await esbuild.build({
  stdin: {
    contents: [
      "export { createLhrServer } from './src/mcp/server.ts';",
      "export { openTree } from '../core/src/index.ts';",
    ].join('\n'),
    resolveDir: pkgDir,
    loader: 'ts',
  },
  bundle: true,
  outfile: bundle,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  define: { __LHR_VERSION__: JSON.stringify(pkgVersion) },
  logLevel: 'silent',
});
const { createLhrServer, openTree } = await import(pathToFileURL(bundle).href);
after(() => rmSync(bundleDir, { recursive: true, force: true }));

const HUMAN = { kind: 'human', name: 'Test Human' };

// One clock for core and server: messages are ordered by name, which starts
// with a whole-second timestamp, so every write gets its own second.
let tick = Date.UTC(2026, 0, 1);
const now = () => new Date((tick += 1000));
const TOOLS = [
  'inbox',
  'thread_create',
  'thread_list',
  'thread_reopen',
  'thread_reply',
  'thread_resolve',
  'thread_show',
];

/** A git review root with one committed file, `src/a.ts`. */
function mkRoot() {
  const dir = mkRepo();
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'a.ts'), 'one\ntwo\nthree\nfour\nfive\n');
  writeFileSync(join(dir, 'README.md'), '# r\n');
  const git = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
  git('add', '.');
  git('commit', '-qm', 'init');
  return dir;
}

/** Writes through core directly, as the human (or anyone) would. */
async function withTree(root, fn, host = {}) {
  const tree = await openTree({ root, now, ...host });
  try {
    return await fn(tree);
  } finally {
    await tree.dispose();
  }
}

const humanThread = (root, body = 'please fix', anchor = {}) =>
  withTree(root, (t) =>
    t.createThread({
      anchor: { path: 'src/a.ts', kind: 'line', startLine: 2, endLine: 3, ...anchor },
      body,
      author: HUMAN,
      severity: 'high',
    }),
  );

/** Connects an in-process client; returns { client, call, close }. */
async function connect({ start, env = {}, clientName = 'test-client' } = {}) {
  const srv = createLhrServer({ start, env, version: pkgVersion, host: { now } });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: clientName, version: '1.0.0' });
  await srv.server.connect(a);
  await client.connect(b);
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const text = JSON.parse(r.content[0].text);
    return { ...r, text };
  };
  return {
    client,
    call,
    async close() {
      await client.close();
      await srv.dispose();
    },
  };
}

async function session(opts, fn) {
  const c = await connect(opts);
  try {
    return await fn(c);
  } finally {
    await c.close();
  }
}

const ok = (r) => {
  assert.ok(!r.isError, JSON.stringify(r.content));
  assert.deepEqual(r.structuredContent, r.text, 'text block mirrors structuredContent');
  assert.equal(r.structuredContent.version, 1);
  assert.ok(Array.isArray(r.structuredContent.diagnostics));
  return r.structuredContent.data;
};

const err = (r, code) => {
  assert.equal(r.isError, true, JSON.stringify(r.content));
  assert.equal(r.structuredContent, undefined, 'errors carry text content only');
  assert.equal(r.content.length, 1);
  assert.equal(r.text.version, 1);
  assert.equal(r.text.error.code, code, r.text.error.message);
  assert.doesNotMatch(r.text.error.example ?? '', /^lhr /, 'never an lhr command');
  return r.text.error;
};

// ---- Handshake over stdio (built binary)

function stdioEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('LHR_') || k === 'CLAUDE_CODE_SESSION_ID') continue;
    if (v !== undefined) env[k] = v;
  }
  return { ...env, ...extra };
}

test('binary: handshake, server info, instructions and the seven tools', async () => {
  build();
  const root = mkRoot();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [binPath, 'mcp', '--repo', root],
    env: stdioEnv(),
    stderr: 'pipe',
  });
  const client = new Client({ name: 'claude-code', version: '1.0.0' });
  await client.connect(transport);
  try {
    assert.deepEqual(client.getServerVersion(), { name: 'lhr', version: pkgVersion });
    const caps = client.getServerCapabilities();
    assert.deepEqual(Object.keys(caps), ['tools']);
    assert.equal(caps.tools.listChanged, undefined);
    const ins = client.getInstructions();
    for (const s of [
      'inbox -> thread_show -> thread_reply or thread_resolve',
      'whoseTurn is "agent"',
      'clientId',
      'cannot submit reviews or see drafts',
      'lhr init',
    ]) {
      assert.ok(ins.includes(s), s);
    }
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), TOOLS);
    for (const t of tools) {
      assert.equal(t.annotations.openWorldHint, false, t.name);
      assert.equal(t.annotations.destructiveHint, false, t.name);
      assert.ok(t.outputSchema, `${t.name} has an outputSchema`);
      assert.equal(t.inputSchema.additionalProperties, false, `${t.name} is strict`);
    }
    const by = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
    for (const n of ['inbox', 'thread_list', 'thread_show']) {
      assert.equal(by[n].readOnlyHint, true, n);
      assert.equal(by[n].idempotentHint, undefined, n);
    }
    for (const n of ['thread_resolve', 'thread_reopen']) {
      assert.equal(by[n].readOnlyHint, false, n);
      assert.equal(by[n].idempotentHint, true, n);
    }
    for (const n of ['thread_reply', 'thread_create']) {
      assert.equal(by[n].readOnlyHint, false, n);
      assert.equal(by[n].idempotentHint, false, n);
    }
    // A real call over stdio writes as the agent named by clientInfo.
    const r = await client.callTool({
      name: 'thread_create',
      arguments: { path: 'README.md', body: 'question' },
    });
    assert.ok(!r.isError, JSON.stringify(r.content));
    assert.deepEqual(r.structuredContent.data.thread.reviewer, {
      kind: 'agent',
      name: 'claude-code',
    });
  } finally {
    await client.close();
  }
});

test('binary: starts without .lhr/ and reports NOT_A_REPO per call', async () => {
  build();
  const dir = tmpDir();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [binPath, 'mcp'],
    cwd: dir,
    env: stdioEnv(),
    stderr: 'pipe',
  });
  const client = new Client({ name: 'c', version: '1' });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 7);
    const r = await client.callTool({ name: 'inbox', arguments: {} });
    assert.equal(r.isError, true);
    const e = JSON.parse(r.content[0].text).error;
    assert.equal(e.code, 'NOT_A_REPO');
    assert.equal(e.example, undefined);
    assert.ok(e.message.includes(dir), e.message);
    assert.match(e.message, /lhr init/);
  } finally {
    await client.close();
  }
  assert.equal(spawnSync('ls', ['-A', dir], { encoding: 'utf8' }).stdout, '', 'never inits');
});

test('binary: exits 0 when stdin closes, nothing on stdout', () => {
  const root = mkRoot();
  const r = lhr(['mcp', '--repo', root], { input: '', timeout: 10_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
});

// ---- Reads

test('inbox: open threads waiting for the agent, no bodies, root echoed', async () => {
  const root = mkRoot();
  const { threadId } = await humanThread(root);
  await session({ start: root }, async ({ call }) => {
    const data = ok(await call('inbox'));
    assert.equal(data.root, root);
    assert.equal(data.threads.length, 1);
    const t = data.threads[0];
    assert.equal(t.id, threadId);
    assert.equal(t.shortId, threadId.split('-')[1].slice(0, 4));
    assert.equal(t.isDraft, false);
    assert.equal(t.status, 'open');
    assert.equal(t.severity, 'high');
    assert.equal(t.whoseTurn, 'agent');
    assert.deepEqual(t.reviewer, HUMAN);
    assert.match(t.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    assert.equal(t.location, 'src/a.ts:2-3');
    assert.deepEqual(t.anchor, {
      path: 'src/a.ts',
      kind: 'line',
      side: 'new',
      startLine: 2,
      endLine: 3,
      state: 'current',
      method: t.anchor.method,
    });
    assert.equal(t.messageCount, 1);
    assert.equal(t.messages, undefined);
  });
});

test('thread_list: default open, status all, whoseTurn and path filters', async () => {
  const root = mkRoot();
  const a = await humanThread(root, 'a');
  const b = await humanThread(root, 'b', {
    path: 'README.md',
    kind: 'file',
    startLine: undefined,
    endLine: undefined,
  });
  await withTree(root, (t) => t.resolve(b.threadId, HUMAN));
  await session({ start: root }, async ({ call }) => {
    const ids = (d) => d.threads.map((t) => t.id);
    assert.deepEqual(ids(ok(await call('thread_list'))), [a.threadId]);
    assert.deepEqual(ids(ok(await call('thread_list', { status: 'all' }))), [
      a.threadId,
      b.threadId,
    ]);
    assert.deepEqual(ids(ok(await call('thread_list', { status: 'resolved' }))), [b.threadId]);
    assert.deepEqual(ids(ok(await call('thread_list', { whoseTurn: 'human' }))), []);
    assert.deepEqual(ids(ok(await call('thread_list', { status: 'all', path: 'src' }))), [
      a.threadId,
    ]);
    const file = ok(await call('thread_list', { status: 'all', path: 'README.md' })).threads[0];
    assert.equal(file.location, 'README.md');
    assert.equal(file.anchor.kind, 'file');
    assert.equal(file.anchor.startLine, undefined);
  });
});

test('thread_show: by handle, prefix or full id; messages and snapshot', async () => {
  const root = mkRoot();
  const { threadId } = await humanThread(root, 'look here');
  await session({ start: root }, async ({ call }) => {
    for (const id of [threadId, threadId.slice(0, 10), threadId.split('-')[1].slice(0, 4)]) {
      const { thread } = ok(await call('thread_show', { id }));
      assert.equal(thread.id, threadId, id);
      assert.equal(thread.messageCount, 1);
      assert.equal(thread.messages.length, 1);
      const m = thread.messages[0];
      assert.equal(m.body.trimEnd(), 'look here');
      assert.deepEqual(m.author, HUMAN);
      assert.equal(m.severity, 'high');
      assert.match(m.createdAt, /Z$/);
      assert.match(thread.snapshot, /two/);
    }
  });
});

test('thread ids: unknown is THREAD_NOT_FOUND, ambiguous handle lists candidates', async () => {
  const root = mkRoot();
  let n = 0;
  const random = () => `aaaa${'bcdefghijk'[Math.floor(n / 10) % 10]}${'bcdefghijk'[n++ % 10]}`;
  const one = await withTree(
    root,
    (t) =>
      t.createThread({ anchor: { path: 'README.md', kind: 'file' }, body: 'x', author: HUMAN }),
    { random },
  );
  const two = await withTree(
    root,
    (t) =>
      t.createThread({ anchor: { path: 'README.md', kind: 'file' }, body: 'y', author: HUMAN }),
    { random },
  );
  await session({ start: root }, async ({ call }) => {
    const nf = err(await call('thread_show', { id: 'zzzz' }), 'THREAD_NOT_FOUND');
    assert.equal(nf.example, 'thread_list {"status":"open"}');
    const amb = err(await call('thread_show', { id: 'aaaa' }), 'INVALID_INPUT');
    assert.ok(
      amb.message.includes(one.threadId) && amb.message.includes(two.threadId),
      amb.message,
    );
    assert.match(amb.example, /^thread_show \{"id":"/);
    // Handles grow until unique among the threads in the tree.
    const list = ok(await call('thread_list')).threads;
    assert.deepEqual(
      list.map((t) => t.shortId),
      [one.threadId, two.threadId].map((id) => id.split('-')[1]),
    );
  });
});

// ---- Writes and identity

test('thread_reply: agent reply passes the turn, clientId retry is created:false', async () => {
  const root = mkRoot();
  const { threadId } = await humanThread(root);
  const env = { LHR_SESSION_ID: 's1' };
  await session({ start: root, env, clientName: 'claude-code' }, async ({ call }) => {
    const args = { id: threadId, body: 'fixed', clientId: 'r1' };
    const d = ok(await call('thread_reply', args));
    assert.equal(d.root, root);
    assert.equal(d.created, true);
    assert.match(d.message.id, /-agent-/);
    assert.equal(d.thread.whoseTurn, 'human');
    assert.equal(d.thread.messageCount, 2);
    const again = ok(await call('thread_reply', args));
    assert.equal(again.created, false);
    assert.equal(again.message.id, d.message.id);
    assert.deepEqual(ok(await call('inbox')).threads, []);
    const { thread } = ok(await call('thread_show', { id: threadId }));
    assert.deepEqual(thread.messages[1].author, {
      kind: 'agent',
      name: 'claude-code',
      session: 's1',
    });
  });
});

test('thread_resolve / thread_reopen: idempotent, with and without body', async () => {
  const root = mkRoot();
  const { threadId } = await humanThread(root);
  await session({ start: root }, async ({ call }) => {
    const r1 = ok(await call('thread_resolve', { id: threadId }));
    assert.equal(r1.changed, true);
    assert.equal(r1.created, true);
    assert.ok(r1.message.id);
    assert.equal(r1.thread.status, 'resolved');
    const r2 = ok(await call('thread_resolve', { id: threadId }));
    assert.deepEqual([r2.changed, r2.created, r2.message], [false, false, undefined]);
    const o1 = ok(await call('thread_reopen', { id: threadId, body: 'not yet' }));
    assert.deepEqual([o1.changed, o1.created], [true, true]);
    assert.equal(o1.thread.status, 'open');
    const o2 = ok(await call('thread_reopen', { id: threadId }));
    assert.equal(o2.changed, false);
    const r3 = ok(await call('thread_resolve', { id: threadId, body: 'done' }));
    assert.equal(r3.thread.status, 'resolved');
    const { thread } = ok(await call('thread_show', { id: threadId }));
    assert.deepEqual(
      thread.messages.map((m) => [m.body.trimEnd(), m.status]),
      [
        ['please fix', undefined],
        ['', 'resolved'],
        ['not yet', 'open'],
        ['done', 'resolved'],
      ],
    );
  });
});

test('thread_create: file and line threads, clientId retry, bad anchors', async () => {
  const root = mkRoot();
  await session({ start: root }, async ({ call }) => {
    const f = ok(await call('thread_create', { path: 'README.md', body: 'q', clientId: 'c1' }));
    assert.equal(f.created, true);
    assert.equal(f.thread.anchor.kind, 'file');
    assert.equal(f.thread.whoseTurn, 'human');
    assert.equal(f.thread.reviewer.kind, 'agent');
    const again = ok(await call('thread_create', { path: 'README.md', body: 'q', clientId: 'c1' }));
    assert.equal(again.created, false);
    assert.equal(again.thread.id, f.thread.id);
    const l = ok(
      await call('thread_create', {
        path: 'src/a.ts',
        line: 2,
        endLine: 4,
        body: 'q',
        severity: 'low',
      }),
    );
    assert.equal(l.thread.location, 'src/a.ts:2-4');
    assert.equal(l.thread.severity, 'low');
    for (const bad of [
      { path: 'src/a.ts', endLine: 2, body: 'q' },
      { path: 'src/a.ts', line: 3, endLine: 2, body: 'q' },
      { path: 'src/a.ts', line: 3, side: 'old', body: 'q' },
      { path: 'README.md', side: 'new', body: 'q' },
      { path: 'README.md', baseCommit: 'abc', body: 'q' },
    ]) {
      const e = err(await call('thread_create', bad), 'INVALID_INPUT');
      assert.match(e.example, /^thread_create \{/, JSON.stringify(bad));
    }
  });
});

test('identity: LHR_AGENT_NAME > clientInfo.name > mcp-agent; session fallbacks', async () => {
  const cases = [
    [
      { LHR_AGENT_NAME: 'env-name', LHR_SESSION_ID: 's1', CLAUDE_CODE_SESSION_ID: 'cc' },
      'cli',
      { name: 'env-name', session: 's1' },
    ],
    [
      { LHR_AGENT_NAME: '  ', CLAUDE_CODE_SESSION_ID: 'cc' },
      ' claude-code ',
      { name: 'claude-code', session: 'cc' },
    ],
    [{ LHR_SESSION_ID: '' }, '   ', { name: 'mcp-agent' }],
  ];
  for (const [env, clientName, want] of cases) {
    const root = mkRoot();
    await session({ start: root, env, clientName }, async ({ call }) => {
      const d = ok(await call('thread_create', { path: 'README.md', body: 'q' }));
      assert.deepEqual(d.thread.reviewer, { kind: 'agent', ...want }, JSON.stringify(env));
    });
  }
});

test('inbox: scoped to the session unless allSessions or no session', async () => {
  const root = mkRoot();
  const mine = await humanThread(root, 'mine');
  const theirs = await humanThread(root, 'theirs');
  const fresh = await humanThread(root, 'fresh');
  const other = { kind: 'agent', name: 'x', session: 's2' };
  const self = { kind: 'agent', name: 'x', session: 's1' };
  await withTree(root, async (t) => {
    await t.reply(theirs.threadId, { body: 'a', author: other });
    await t.reply(theirs.threadId, { body: 'h', author: HUMAN });
    await t.reply(mine.threadId, { body: 'a', author: self });
    await t.reply(mine.threadId, { body: 'h', author: HUMAN });
  });
  const ids = (d) => d.threads.map((t) => t.id).sort();
  await session({ start: root, env: { LHR_SESSION_ID: 's1' } }, async ({ call }) => {
    assert.deepEqual(ids(ok(await call('inbox'))), [mine.threadId, fresh.threadId].sort());
    assert.deepEqual(
      ids(ok(await call('inbox', { allSessions: true }))),
      [mine.threadId, theirs.threadId, fresh.threadId].sort(),
    );
  });
  await session({ start: root }, async ({ call }) => {
    assert.equal(ok(await call('inbox')).threads.length, 3);
  });
});

// ---- Errors and lifecycle

test('schema failures become INVALID_INPUT tool errors with an example', async () => {
  const root = mkRoot();
  await session({ start: root }, async ({ call, client }) => {
    const unknown = err(await call('thread_list', { bogus: 1 }), 'INVALID_INPUT');
    assert.match(unknown.message, /bogus/);
    assert.match(unknown.example, /^thread_list \{/);
    err(await call('thread_reply', { id: 'abcd', body: '' }), 'INVALID_INPUT');
    err(await call('thread_show', {}), 'INVALID_INPUT');
    err(await call('thread_list', { status: 'closed' }), 'INVALID_INPUT');
    err(await call('thread_create', { path: 'README.md', line: 0, body: 'q' }), 'INVALID_INPUT');
    await assert.rejects(client.callTool({ name: 'nope', arguments: {} }), /nope/);
  });
});

test('per-call root: lhr init while running, new threads visible next call', async () => {
  const dir = tmpDir();
  await session({ start: dir }, async ({ call }) => {
    const e = err(await call('thread_list'), 'NOT_A_REPO');
    assert.equal(e.example, undefined);
    assert.ok(e.message.includes(dir));
    mkdirSync(join(dir, '.lhr'));
    writeFileSync(join(dir, '.lhr', 'format'), '2\n');
    const d = ok(await call('thread_list'));
    assert.equal(d.root, dir);
    assert.deepEqual(d.threads, []);
    // A non-git root: creating a thread has no repo for the path.
    writeFileSync(join(dir, 'x.md'), 'x\n');
    const p = err(await call('thread_create', { path: 'x.md', body: 'q' }), 'PATH_NOT_IN_REPO');
    assert.equal(p.example, 'thread_create {"path":"x.md","line":1}');
  });
  const root = mkRoot();
  await session({ start: join(root, 'src') }, async ({ call }) => {
    assert.equal(ok(await call('inbox')).threads.length, 0);
    await humanThread(root);
    assert.equal(ok(await call('inbox')).threads.length, 1);
  });
});
