import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LhrError } from '../src/errors.js';
import {
  createId,
  createMessageFileName,
  createMessageId,
  defaultRandom,
  formatTimestamp,
  parseId,
  parseMessageFileName,
  parseMessageId,
} from '../src/ids.js';

const NOW = new Date(Date.UTC(2026, 9, 1, 9, 30, 5, 999));

function invalidInput(fn: () => unknown): void {
  assert.throws(fn, (err: unknown) => err instanceof LhrError && err.code === 'INVALID_INPUT');
}

describe('formatTimestamp', () => {
  it('formats UTC, truncating milliseconds', () => {
    assert.equal(formatTimestamp(NOW), '20261001T093005Z');
  });
  it('zero pads', () => {
    assert.equal(formatTimestamp(new Date(Date.UTC(2026, 0, 2, 3, 4, 5))), '20260102T030405Z');
    const early = new Date(0);
    early.setUTCFullYear(5, 0, 1);
    early.setUTCHours(0, 0, 0, 0);
    assert.equal(formatTimestamp(early), '00050101T000000Z');
  });
  it('rejects invalid dates and out-of-range years', () => {
    invalidInput(() => formatTimestamp(new Date(NaN)));
    const big = new Date(0);
    big.setUTCFullYear(10000);
    invalidInput(() => formatTimestamp(big));
    const neg = new Date(0);
    neg.setUTCFullYear(-1);
    invalidInput(() => formatTimestamp(neg));
  });
});

describe('defaultRandom', () => {
  it('returns 6 chars from [a-z2-7]', () => {
    for (let i = 0; i < 2000; i++) {
      assert.match(defaultRandom(), /^[a-z2-7]{6}$/);
    }
  });
  it('varies', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) seen.add(defaultRandom());
    assert.ok(seen.size > 1);
  });
});

describe('create*', () => {
  it('createId', () => {
    assert.equal(createId(NOW, 'abc234'), '20261001T093005Z-abc234');
  });
  it('createMessageId', () => {
    assert.equal(createMessageId(NOW, 'human', 'abc234'), '20261001T093005Z-human-abc234');
    assert.equal(createMessageId(NOW, 'agent', 'abc234'), '20261001T093005Z-agent-abc234');
  });
  it('createMessageFileName', () => {
    assert.equal(createMessageFileName(NOW, 'agent', 'abc234'), '20261001T093005Z-agent-abc234.md');
  });
  it('rejects bad random', () => {
    for (const bad of ['', 'abc23', 'abc2345', 'ABC234', 'abc231', 'abc 23', 'abc238']) {
      invalidInput(() => createId(NOW, bad));
      invalidInput(() => createMessageId(NOW, 'human', bad));
      invalidInput(() => createMessageFileName(NOW, 'human', bad));
    }
  });
  it('rejects bad kind', () => {
    invalidInput(() => createMessageId(NOW, 'robot' as never, 'abc234'));
    invalidInput(() => createMessageFileName(NOW, 'robot' as never, 'abc234'));
  });
  it('rejects invalid date', () => {
    invalidInput(() => createId(new Date(NaN), 'abc234'));
  });
});

describe('parseId', () => {
  it('round-trips', () => {
    const id = createId(NOW, 'abc234');
    const parsed = parseId(id);
    assert.ok(parsed);
    assert.equal(parsed.id, id);
    assert.equal(parsed.random, 'abc234');
    assert.equal(parsed.timestamp.toISOString(), '2026-10-01T09:30:05.000Z');
  });
  it('returns undefined for malformed input', () => {
    const bad = [
      '',
      '20261001T093005Z',
      '20261001T093005Z-ABC234',
      '20261001T093005Z-abc23',
      '20261001T093005Z-abc2345',
      '20261001T093005Z-abc231',
      ' 20261001T093005Z-abc234',
      '20261001T093005Z-abc234 ',
      '20261001T093005Z-abc234\n',
      '20261001T093005Z-abc234.md',
      '20261301T093005Z-abc234',
      '20260230T093005Z-abc234',
      '20261001T240005Z-abc234',
      '20261001T093060Z-abc234',
      '20261001T096005Z-abc234',
      '20261001T093005-abc234',
      '20261001T093005Z-human-abc234',
    ];
    for (const b of bad) assert.equal(parseId(b), undefined, JSON.stringify(b));
  });
  it('accepts leap day only in leap years', () => {
    assert.ok(parseId('20280229T000000Z-abc234'));
    assert.equal(parseId('20270229T000000Z-abc234'), undefined);
  });
});

describe('parseMessageId / parseMessageFileName', () => {
  it('round-trips ids', () => {
    for (const kind of ['human', 'agent'] as const) {
      const id = createMessageId(NOW, kind, 'abc234');
      const parsed = parseMessageId(id);
      assert.ok(parsed);
      assert.equal(parsed.id, id);
      assert.equal(parsed.kind, kind);
      assert.equal(parsed.random, 'abc234');
      assert.equal(parsed.timestamp.toISOString(), '2026-10-01T09:30:05.000Z');
    }
  });
  it('round-trips file names', () => {
    const name = createMessageFileName(NOW, 'agent', 'xyz567');
    const parsed = parseMessageFileName(name);
    assert.ok(parsed);
    assert.equal(parsed.id, '20261001T093005Z-agent-xyz567');
    assert.equal(parsed.kind, 'agent');
    assert.equal(parsed.random, 'xyz567');
  });
  it('rejects malformed', () => {
    assert.equal(parseMessageId('20261001T093005Z-abc234'), undefined);
    assert.equal(parseId('20261001T093005Z-human-abc234'), undefined);
    assert.equal(parseMessageId('20261001T093005Z-robot-abc234'), undefined);
    assert.equal(parseMessageId('20261001T093005Z-human-ABC234'), undefined);
    assert.equal(parseMessageId('20261001T093005Z-human-abc23'), undefined);
    assert.equal(parseMessageId('20261001T093005Z-human-abc2345'), undefined);
    assert.equal(parseMessageId('20261301T093005Z-human-abc234'), undefined);
    assert.equal(parseMessageId('20261001T093005Z-human-abc234\n'), undefined);
    assert.equal(parseMessageFileName('20261001T093005Z-human-abc234'), undefined);
    assert.equal(parseMessageFileName('20261001T093005Z-human-abc234.md.md'), undefined);
    assert.equal(parseMessageFileName('20261001T093005Z-human-abc234.txt'), undefined);
    assert.equal(parseMessageFileName('20261001T093005Z-abc234.md'), undefined);
    assert.equal(parseMessageFileName('.md'), undefined);
  });
});

describe('sort order', () => {
  it('lexical order equals time order', () => {
    const times = [
      Date.UTC(2025, 11, 31, 23, 59, 59),
      Date.UTC(2026, 0, 1, 0, 0, 0),
      Date.UTC(2026, 9, 1, 9, 30, 5),
      Date.UTC(2026, 9, 1, 9, 30, 6),
      Date.UTC(2026, 9, 1, 10, 0, 0),
      Date.UTC(2027, 1, 3, 4, 5, 6),
    ];
    const ids = times.map((t) => createId(new Date(t), defaultRandom()));
    const shuffled = [ids[3], ids[0], ids[5], ids[2], ids[4], ids[1]].sort();
    assert.deepEqual(shuffled, ids);
    const names = times.map((t) => createMessageFileName(new Date(t), 'human', defaultRandom()));
    assert.deepEqual([...names].reverse().sort(), names);
  });
});
