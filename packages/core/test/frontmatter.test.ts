import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  FRONTMATTER_SYNTAX,
  parseFrontmatter,
  serializeFrontmatter,
  type FrontmatterData,
} from '../src/frontmatter.js';
import { LhrError } from '../src/errors.js';

const P = '.lhr/threads/x.md';

function parse(text: string) {
  return parseFrontmatter(text, P);
}

function assertSingleError(text: string, line: number, expectedData: FrontmatterData) {
  const r = parse(text);
  assert.equal(r.diagnostics.length, 1, JSON.stringify(r.diagnostics));
  const d = r.diagnostics[0];
  assert.equal(d.severity, 'error');
  assert.equal(d.code, FRONTMATTER_SYNTAX);
  assert.equal(d.path, P);
  assert.equal(d.line, line);
  assert.ok(d.message.length > 5);
  assert.deepEqual(r.data, expectedData);
}

describe('parseFrontmatter basics', () => {
  it('parses typed values and body', () => {
    const r = parse('---\na: 1\nb: -5\nc: true\nd: false\ne: hello world\nf: "42"\n---\nBody\n');
    assert.deepEqual(r.data, { a: 1, b: -5, c: true, d: false, e: 'hello world', f: '42' });
    assert.equal(r.body, 'Body\n');
    assert.deepEqual(r.diagnostics, []);
  });

  it('accepts dotted keys, blank lines and unknown keys', () => {
    const r = parse('---\nanchor.path: src/a.ts\n\n   \nfooBar: x\n---\n');
    assert.deepEqual(r.data, { 'anchor.path': 'src/a.ts', fooBar: 'x' });
    assert.equal(r.body, '');
    assert.deepEqual(r.diagnostics, []);
  });

  it('keeps the body unchanged, including further --- lines', () => {
    const r = parse('---\na: 1\n---\n---\nx: y\n---\n');
    assert.equal(r.body, '---\nx: y\n---\n');
    assert.deepEqual(r.data, { a: 1 });
  });

  it('handles CRLF input', () => {
    const r = parse('---\r\na: 1\r\nb: "x"\r\n---\r\nBody\r\nmore\r\n');
    assert.deepEqual(r.data, { a: 1, b: 'x' });
    assert.equal(r.body, 'Body\r\nmore\r\n');
    assert.deepEqual(r.diagnostics, []);
  });

  it('decodes escapes in quoted strings', () => {
    const r = parse('---\na: "say \\"hi\\" back\\\\slash"\n---\n');
    assert.deepEqual(r.data, { a: 'say "hi" back\\slash' });
  });
});

describe('parseFrontmatter syntax errors', () => {
  it('missing opening delimiter', () => {
    const text = 'a: 1\n---\n';
    const r = parse(text);
    assert.equal(r.diagnostics.length, 1);
    assert.equal(r.diagnostics[0].line, 1);
    assert.equal(r.diagnostics[0].code, FRONTMATTER_SYNTAX);
    assert.deepEqual(r.data, {});
    assert.equal(r.body, text);
  });

  it('empty input', () => {
    const r = parse('');
    assert.equal(r.diagnostics.length, 1);
    assert.deepEqual(r.data, {});
    assert.equal(r.body, '');
  });

  it('missing closing delimiter', () => {
    const r = parse('---\na: 1\nb: 2\n');
    assert.equal(r.diagnostics.length, 1);
    assert.equal(r.diagnostics[0].line, 1);
    assert.equal(r.diagnostics[0].code, FRONTMATTER_SYNTAX);
    assert.equal(r.diagnostics[0].severity, 'error');
    assert.deepEqual(r.data, {});
    assert.equal(r.body, '');
  });

  it('indentation', () => {
    assertSingleError('---\na: 1\n  b: 2\nc: 3\n---\n', 3, { a: 1, c: 3 });
  });

  it('no colon', () => {
    assertSingleError('---\na: 1\njustwords\nc: 3\n---\n', 3, { a: 1, c: 3 });
  });

  it('invalid key', () => {
    assertSingleError('---\nA: 1\nb: 2\n---\n', 2, { b: 2 });
    assertSingleError('---\nb: 2\nfoo-bar: 1\n---\n', 3, { b: 2 });
    assertSingleError('---\nb: 2\na..b: 1\n---\n', 3, { b: 2 });
  });

  it('missing space after colon', () => {
    assertSingleError('---\na:1\nb: 2\n---\n', 2, { b: 2 });
  });

  it('empty value', () => {
    assertSingleError('---\na:\nb: 2\n---\n', 2, { b: 2 });
    assertSingleError('---\na: \nb: 2\n---\n', 2, { b: 2 });
  });

  it('duplicate key, first wins', () => {
    assertSingleError('---\na: 1\nb: 2\na: 3\n---\n', 4, { a: 1, b: 2 });
  });

  it('comment line', () => {
    const r = parse('---\n# note\na: 1\n---\n');
    assert.equal(r.diagnostics.length, 1);
    assert.equal(r.diagnostics[0].line, 2);
    assert.equal(r.diagnostics[0].code, FRONTMATTER_SYNTAX);
    assert.match(r.diagnostics[0].message, /comment/i);
    assert.deepEqual(r.data, { a: 1 });
  });

  it('unterminated quoted string', () => {
    assertSingleError('---\na: "abc\nb: 2\n---\n', 2, { b: 2 });
    assertSingleError('---\na: "abc\\"\nb: 2\n---\n', 2, { b: 2 });
  });

  it('invalid escape', () => {
    assertSingleError('---\na: "a\\nb"\nb: 2\n---\n', 2, { b: 2 });
  });

  it('trailing characters after closing quote', () => {
    assertSingleError('---\na: "abc" x\nb: 2\n---\n', 2, { b: 2 });
  });

  it('unquoted value that needs quoting', () => {
    const values = [
      '-x', '?a', ':a', ',a', '[a', ']a', '{a', '}a', '#a', '&a', '*a', '!a', '|a', '>a',
      "'a", '%a', '@a', '`a', ' a', 'a ', 'a: b', 'a #b',
    ];
    for (const v of values) {
      assertSingleError(`---\nk: ${v}\nb: 2\n---\n`, 2, { b: 2 });
    }
  });

  it('integer outside safe range', () => {
    assertSingleError('---\na: 9007199254740993\nb: 2\n---\n', 2, { b: 2 });
  });

  it('reports several errors and keeps valid lines', () => {
    const r = parse('---\na:1\nb: 2\n  c: 3\nd: 4\n---\nx');
    assert.equal(r.diagnostics.length, 2);
    assert.deepEqual(
      r.diagnostics.map((d) => d.line),
      [2, 4],
    );
    assert.deepEqual(r.data, { b: 2, d: 4 });
    assert.equal(r.body, 'x');
  });
});

describe('never throws', () => {
  it('survives 500 garbage strings', () => {
    let s = 12345;
    const rnd = (): number => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 0x100000000;
    };
    const pieces = [
      '---', '\n', '\r\n', '\r', ': ', ':', '"', '\\', ' ', '#', 'a', 'key', 'true', '42',
      '-', '.', '\t', 'é', '\u0000', '0x1', '99999999999999999999', 'constructor',
    ];
    for (let i = 0; i < 500; i++) {
      const n = Math.floor(rnd() * 40);
      let t = rnd() < 0.5 ? '---\n' : '';
      for (let j = 0; j < n; j++) {
        t += pieces[Math.floor(rnd() * pieces.length)];
      }
      assert.doesNotThrow(() => parse(t), JSON.stringify(t));
    }
  });
});

describe('serializeFrontmatter', () => {
  it('writes insertion order', () => {
    assert.equal(
      serializeFrontmatter({ b: 1, a: 'x', 'c.d': true }, 'Body\n'),
      '---\nb: 1\na: x\nc.d: true\n---\nBody\n',
    );
  });

  it('round-trips canonical text', () => {
    const texts = [
      '---\nid: abc\nline: 12\nresolved: false\nanchor.path: src/a.ts\ntext: "a: b"\n---\nHello\n\nWorld\n',
      '---\n---\n',
      '---\na: ""\nb: "42"\n---\nbody without newline',
    ];
    for (const t of texts) {
      const r = parse(t);
      assert.deepEqual(r.diagnostics, []);
      assert.equal(serializeFrontmatter(r.data, r.body), t);
    }
  });

  it('round-trips strings that need quoting', () => {
    const indicators = [...'-?:,[]{}#&*!|>\'"%@`'];
    const strings = [
      '', ' a', 'a ', ' ', 'a: b', 'a #b', '42', '-1', 'true', 'false', 'null', '~', 'yes', 'No',
      'ON', '1.5', '1e3', '0x1F', '0o7', '0b1', '.inf', '-.Inf', '.NaN', '+5', '1_000',
      'say "hi"', 'back\\slash', 'ends with \\', 'tab\there', 'héllo wörld ✓', '日本語',
      'plain', 'a,b,c', 'a:b', 'a#b', 'foo:', '\tx', 'x\t', 'a\t#b',
      ...indicators.map((c) => `${c}rest`),
      ...indicators,
    ];
    for (const str of strings) {
      const data: FrontmatterData = { k: str, after: 1 };
      const out = serializeFrontmatter(data, 'b\n');
      const r = parse(out);
      assert.deepEqual(r.diagnostics, [], JSON.stringify(str));
      assert.deepEqual(r.data, data, JSON.stringify(str));
      assert.equal(r.body, 'b\n');
    }
  });

  it('rejects values YAML parsers would read differently', () => {
    const ls = String.fromCharCode(0x2028);
    const values = ['foo:', 'a\t# c', '\tx', 'x\t', 'a\x01b', '"a\x85b"', `"a${ls}b"`, '"a\x7f"'];
    for (const v of values) {
      const r = parse(`---\nk: ${v}\n---\n`);
      assert.equal(r.diagnostics.length, 1, JSON.stringify(v));
      assert.equal(r.diagnostics[0].code, FRONTMATTER_SYNTAX);
      assert.deepEqual(r.data, {}, JSON.stringify(v));
    }
  });

  it('round-trips numbers and booleans', () => {
    const data: FrontmatterData = { a: 0, b: -7, c: Number.MAX_SAFE_INTEGER, d: true, e: false };
    const r = parse(serializeFrontmatter(data, ''));
    assert.deepEqual(r.diagnostics, []);
    assert.deepEqual(r.data, data);
  });

  it('quotes YAML-special scalars', () => {
    assert.equal(serializeFrontmatter({ a: 'null' }, ''), '---\na: "null"\n---\n');
    assert.equal(serializeFrontmatter({ a: '1.5' }, ''), '---\na: "1.5"\n---\n');
    assert.equal(serializeFrontmatter({ a: '"hi" \\' }, ''), '---\na: "\\"hi\\" \\\\"\n---\n');
    assert.equal(serializeFrontmatter({ a: 'say "hi"' }, ''), '---\na: say "hi"\n---\n');
  });

  it('throws INVALID_INPUT on bad input', () => {
    const bad: FrontmatterData[] = [
      { 'Bad-Key': 1 },
      { '': 1 },
      { a: 1.5 },
      { a: NaN },
      { a: Infinity },
      { a: 2 ** 53 },
      { a: 'x\ny' },
      { a: 'x\ry' },
      { a: 'a\x01b' },
      { a: 'a\x7fb' },
      { a: 'a\x85b' },
      { a: `a${String.fromCharCode(0x2028)}b` },
      { a: `a${String.fromCharCode(0x2029)}b` },
    ];
    for (const d of bad) {
      assert.throws(
        () => serializeFrontmatter(d, ''),
        (e: unknown) => e instanceof LhrError && e.code === 'INVALID_INPUT',
        JSON.stringify(d),
      );
    }
  });
});
