// End-to-end scenarios against the built binary: the flows in
// .claude/skills/verify-lhr/features/*.md as assertions. Keep recipe and scenario in step.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AGENT, handle, nextSecond, ok, run, session, threads } from './scenario-helper.mjs';

test('agent-loop: reply, resolve, reopen, idempotent retries, identity', () => {
  const { dir } = session();
  const T = handle(
    ok(
      run(dir, ['thread', 'create', 'src/app.ts:2', '-'], {
        input: 'Validate.',
      }),
    ),
  );
  nextSecond();
  ok(run(dir, ['review', 'submit', '--verdict', 'request-changes', '--summary', 's']));
  nextSecond();

  const reply = ['thread', 'reply', T, '--client-id', 'r1', '-'];
  const first = ok(run(dir, reply, { env: AGENT, input: 'Added the guard.' }));
  assert.match(first.stdout, /^added message \S+-agent-\S+ on thread/);
  const again = ok(run(dir, reply, { env: AGENT, input: 'Added the guard.' }));
  assert.match(again.stdout, /^exists message/);
  assert.match(ok(run(dir, ['inbox'], { env: AGENT })).stdout, /0 threads in the inbox/);
  assert.equal(threads(dir)[0].whoseTurn, 'human');
  assert.equal(threads(dir)[0].messageCount, 2);

  nextSecond();
  ok(run(dir, ['thread', 'resolve', T, '--body', 'Done.'], { env: AGENT }));
  assert.equal(threads(dir).length, 0);
  assert.equal(threads(dir, ['--status', 'all'])[0].status, 'resolved');
  nextSecond();
  ok(run(dir, ['thread', 'reopen', T, '--body', 'Not done.'], { env: AGENT }));
  assert.equal(threads(dir)[0].status, 'open');

  nextSecond();
  ok(
    run(dir, ['thread', 'reply', T, '-'], {
      env: { LHR_SESSION_ID: 's2', LHR_AGENT_NAME: 'other-agent' },
      input: 'x',
    }),
  );
  assert.match(ok(run(dir, ['thread', 'show', T])).stdout, /other-agent \(agent\)/);
});

test('agent-loop: an agent can start a thread, idempotently', () => {
  const { dir } = session();
  const create = ['thread', 'create', 'README.md', '--client-id', 'c1', '-'];
  const first = ok(run(dir, create, { env: AGENT, input: 'Agent thread.' }));
  assert.match(first.stdout, /^created thread/);
  assert.match(
    ok(run(dir, create, { env: AGENT, input: 'Agent thread.' })).stdout,
    /^exists thread/,
  );
  assert.equal(threads(dir).length, 1);
});

test('human replies and resolves are drafts the agent cannot see', () => {
  const { dir } = session();
  const T = handle(
    ok(
      run(dir, ['thread', 'create', 'src/app.ts:2', '-'], {
        input: 'Validate.',
      }),
    ),
  );
  nextSecond();
  ok(run(dir, ['review', 'submit', '--verdict', 'comment', '--summary', 's']));
  nextSecond();
  const r = ok(run(dir, ['thread', 'reply', T, '--body', 'more']));
  assert.match(r.stdout, /^draft saved/);
  const shown = ok(run(dir, ['thread', 'show', T], { env: AGENT })).stdout;
  assert.doesNotMatch(shown, /more/);
});

// Known bug (#155): two writes in the same second can be read back out of order.
// Remove `todo` once core orders same-second messages by write order.
test('same-second reopen after resolve keeps the latest status (#155)', { todo: '#155' }, () => {
  const { dir } = session();
  const T = handle(ok(run(dir, ['thread', 'create', 'src/app.ts:2', '-'], { input: 'v' })));
  nextSecond();
  ok(run(dir, ['review', 'submit', '--verdict', 'comment', '--summary', 's']));
  nextSecond();
  ok(run(dir, ['thread', 'resolve', T], { env: AGENT }));
  ok(run(dir, ['thread', 'reopen', T], { env: AGENT }));
  assert.equal(threads(dir)[0]?.status, 'open');
});

const readdirAgent = (dirOf) =>
  readdirSync(dirOf)
    .filter((f) => f.includes('-agent-'))
    .pop();
