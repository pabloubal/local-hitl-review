import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import threadSchema from '../schema/thread.schema.json';
import messageSchema from '../schema/message.schema.json';
import roundSchema from '../schema/round.schema.json';
import pushSchema from '../schema/push.schema.json';
import { compileSchema, loadSchemas, unknownKeys, validate } from '../src/schemaCheck.js';

const base = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://example.test/x.schema.json',
};

describe('compileSchema', () => {
  it('throws on an unsupported keyword at the root', () => {
    assert.throws(() => compileSchema({ ...base, oneOf: [] }), /oneOf/);
  });

  it('throws on an unsupported keyword in a property', () => {
    assert.throws(
      () =>
        compileSchema({
          ...base,
          properties: { n: { type: 'integer', minimum: 1 } },
        }),
      /minimum/,
    );
  });

  it('throws on an unsupported type', () => {
    assert.throws(() => compileSchema({ ...base, properties: { n: { type: 'number' } } }), /type/);
  });

  it('throws on an invalid pattern', () => {
    assert.throws(() => compileSchema({ ...base, properties: { n: { pattern: '(' } } }));
  });

  it('throws when the schema is not an object', () => {
    assert.throws(() => compileSchema([]));
  });
});

describe('validate', () => {
  const schema = compileSchema({
    ...base,
    required: ['a'],
    properties: {
      a: { type: 'string', pattern: '^x' },
      b: { type: 'integer' },
      c: { type: 'boolean' },
      d: { enum: ['p', 'q'] },
    },
    additionalProperties: true,
  });

  it('accepts valid data', () => {
    assert.deepEqual(validate(schema, { a: 'xy', b: 3, c: true, d: 'p' }), []);
  });

  it('reports a missing required key', () => {
    assert.deepEqual(
      validate(schema, {}).map((i) => [i.key, i.kind]),
      [['a', 'missing']],
    );
  });

  it('reports wrong types', () => {
    const kinds = validate(schema, { a: 1, b: 'x', c: 'true' }).map((i) => [i.key, i.kind]);
    assert.deepEqual(kinds, [
      ['a', 'type'],
      ['b', 'type'],
      ['c', 'type'],
    ]);
  });

  it('reports enum and pattern violations', () => {
    const kinds = validate(schema, { a: 'nope', d: 'z' }).map((i) => [i.key, i.kind]);
    assert.deepEqual(kinds, [
      ['a', 'pattern'],
      ['d', 'enum'],
    ]);
  });

  it('lists unknown keys', () => {
    assert.deepEqual(unknownKeys(schema, { a: 'x', zzz: 1 }), ['zzz']);
  });

  it('reports unknown keys when additionalProperties is false', () => {
    const strict = compileSchema({
      ...base,
      properties: { a: { type: 'string' } },
      additionalProperties: false,
    });
    assert.deepEqual(
      validate(strict, { zzz: 1 }).map((i) => i.kind),
      ['unknown'],
    );
  });
});

describe('shipped schemas', () => {
  it('load without throwing', () => {
    const s = loadSchemas();
    assert.deepEqual(Object.keys(s).sort(), ['message', 'push', 'round', 'thread']);
    assert.ok(s.thread.properties['anchor.path']);
    assert.deepEqual(s.thread.required, [
      'anchor.kind',
      'anchor.path',
      'anchor.side',
      'anchor.commit',
    ]);
  });

  it('compile from the imported JSON objects', () => {
    for (const raw of [threadSchema, messageSchema, roundSchema, pushSchema]) {
      assert.ok(compileSchema(raw).id.endsWith('.schema.json'));
    }
  });
});
