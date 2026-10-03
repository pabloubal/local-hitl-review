// End-to-end scenarios against the built binary: the flows in
// .claude/skills/verify-lhr/features/*.md as assertions. Keep recipe and scenario in step.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { binPath, build, tmpDir } from './helper.mjs';
import { nextSecond, ok, run, session, threads } from './scenario-helper.mjs';

// ---- MCP over stdio against the built binary

async function mcp(dir, env = { LHR_SESSION_ID: 'scenario-mcp' }) {
  build();
  const { FORCE_COLOR: _drop, ...base } = process.env;
  for (const k of Object.keys(base))
    if (k.startsWith('LHR_') || k === 'CLAUDE_CODE_SESSION_ID') delete base[k];
  const client = new Client({ name: 'scenario-client', version: '0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [binPath, 'mcp', '--repo', dir],
      cwd: dir,
      env: { ...base, NO_COLOR: '1', ...env },
    }),
  );
  return client;
}
const readdirAgent = (dirOf) =>
  readdirSync(dirOf)
    .filter((f) => f.includes('-agent-'))
    .pop();
const call = async (c, name, args) => {
  const r = await c.callTool({ name, arguments: args });
  return {
    isError: !!r.isError,
    data: r.structuredContent ?? JSON.parse(r.content[0].text),
  };
};

test('mcp-server: all seven tools through a real stdio session', async () => {
  const { dir } = session();
  ok(run(dir, ['thread', 'create', 'src/app.ts:2', '-'], { input: 'Validate.' }));
  nextSecond();
  ok(run(dir, ['review', 'submit', '--verdict', 'request-changes', '--summary', 's']));
  nextSecond();

  const c = await mcp(dir);
  try {
    assert.equal(c.getServerVersion().name, 'lhr');
    const tools = (await c.listTools()).tools;
    assert.deepEqual(tools.map((t) => t.name).sort(), [
      'inbox',
      'thread_create',
      'thread_list',
      'thread_reopen',
      'thread_reply',
      'thread_resolve',
      'thread_show',
    ]);
    for (const t of tools) assert.equal(t.annotations.destructiveHint, false);

    const inbox = await call(c, 'inbox', {});
    const tid = inbox.data.data.threads[0].shortId;
    assert.equal(
      (await call(c, 'thread_list', { status: 'open', whoseTurn: 'agent' })).data.data.threads
        .length,
      1,
    );
    assert.equal((await call(c, 'thread_show', { id: tid })).data.data.thread.messages.length, 1);

    nextSecond();
    const reply = { id: tid, body: 'Added the guard.', clientId: 'mcp-r1' };
    const r1 = await call(c, 'thread_reply', reply);
    assert.equal(r1.data.data.created, true);
    assert.equal(r1.data.data.thread.whoseTurn, 'human');
    const r2 = await call(c, 'thread_reply', reply);
    assert.equal(r2.data.data.created, false);
    assert.equal(r2.data.data.message.id, r1.data.data.message.id);

    nextSecond();
    const created = await call(c, 'thread_create', {
      path: 'src/app.ts',
      line: 3,
      body: 'Agent thread.',
      severity: 'low',
      clientId: 'mcp-c1',
    });
    assert.deepEqual(created.data.data.thread.reviewer, {
      kind: 'agent',
      name: 'scenario-client',
      session: 'scenario-mcp',
    });
    nextSecond();
    assert.equal(
      (await call(c, 'thread_resolve', { id: tid, body: 'Done.' })).data.data.thread.status,
      'resolved',
    );
    nextSecond();
    assert.equal(
      (await call(c, 'thread_reopen', { id: tid, body: 'Not done.' })).data.data.thread.status,
      'open',
    );

    const nf = await call(c, 'thread_show', { id: 'nope-nope' });
    assert.ok(nf.isError);
    assert.equal(nf.data.error.code, 'THREAD_NOT_FOUND');
    const bad = await call(c, 'thread_reply', { id: tid });
    assert.ok(bad.isError);
    assert.equal(bad.data.error.code, 'INVALID_INPUT');
  } finally {
    await c.close();
  }
  // The CLI sees what MCP wrote.
  assert.equal(threads(dir, ['--status', 'all']).length, 2);
});

test('mcp-server: identity comes from LHR_AGENT_NAME and the session env', async () => {
  const { dir } = session();
  ok(run(dir, ['thread', 'create', 'src/app.ts:2', '-'], { input: 'Validate.' }));
  nextSecond();
  ok(run(dir, ['review', 'submit', '--verdict', 'comment', '--summary', 's']));
  nextSecond();
  const c = await mcp(dir, {
    LHR_AGENT_NAME: 'named-agent',
    LHR_SESSION_ID: 'sess-9',
  });
  try {
    const tid = (await call(c, 'inbox', {})).data.data.threads[0].shortId;
    await call(c, 'thread_reply', { id: tid, body: 'named reply' });
  } finally {
    await c.close();
  }
  const dirOf = join(dir, '.lhr/threads', threads(dir)[0].id);
  const msg = readFileSync(join(dirOf, readdirAgent(dirOf)), 'utf8');
  assert.match(msg, /author\.name: named-agent/);
  assert.match(msg, /author\.session: sess-9/);
});

test('mcp-server: no .lhr/ gives NOT_A_REPO telling the user to run lhr init', async () => {
  const bare = tmpDir('lhr-mcp-nostore-');
  spawnSync('git', ['init', '-q'], { cwd: bare });
  const c = await mcp(bare);
  try {
    const r = await call(c, 'inbox', {});
    assert.ok(r.isError);
    assert.equal(r.data.error.code, 'NOT_A_REPO');
    assert.match(r.data.error.message, /lhr init/);
  } finally {
    await c.close();
  }
});
