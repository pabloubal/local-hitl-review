// Unit tests for the shared renderers (render/thread.ts), bundled on the fly so the
// functions the inbox, thread-write and MCP PRs import are tested directly.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { build } from 'esbuild';

let r;
before(async () => {
  const outfile = join(mkdtempSync(join(tmpdir(), 'lhr-render-')), 'render.mjs');
  await build({
    entryPoints: [fileURLToPath(new URL('../src/render/thread.ts', import.meta.url))],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile,
    logLevel: 'silent',
  });
  r = await import(pathToFileURL(outfile).href);
});

const item = (id, shortId) => ({
  view: {
    id,
    isDraft: false,
    status: 'open',
    severity: 'high',
    whoseTurn: 'agent',
    reviewer: { kind: 'human', name: 'p' },
    createdAt: new Date('2026-10-02T10:15:00.123Z'),
    anchor: { kind: 'file', path: 'a.txt', side: 'new' },
    messages: [{}],
  },
  shortId,
  anchor: { path: 'a.txt', state: 'current', method: 'exact' },
});

test('threadJson: createdAt has no milliseconds', () => {
  const j = r.threadJson(item('20261002T101500Z-abcdef', 'abcd'));
  assert.equal(j.createdAt, '2026-10-02T10:15:00Z');
});

test('renderList: takes a caller-supplied summary line, wide and narrow', () => {
  const items = [item('20261002T101500Z-abcdef', 'abcd')];
  const wide = r.renderList(items, '1 thread in the inbox', { color: false, width: 100 });
  assert.match(wide, /^1 thread in the inbox\n\nID +SEV +TURN +LOCATION +ANCHOR +MSGS\n/);
  const narrow = r.renderList(items, '1 thread in the inbox', { color: false, width: 60 });
  assert.match(narrow, /^1 thread in the inbox\n\nabcd {2}high {2}agent\n {2}a\.txt \(file\)\n/);
  assert.doesNotMatch(narrow, /LOCATION/);
});

test('listSummaryLine: the thread list summary', () => {
  assert.equal(
    r.listSummaryLine(2, { status: 'open', turn: 'agent' }),
    '2 open threads (status: open, turn: agent; --status all to widen)',
  );
});
