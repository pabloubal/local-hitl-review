import { Diagnostic, LhrError } from './errors.js';

export type FrontmatterValue = string | number | boolean;
export type FrontmatterData = Record<string, FrontmatterValue>;

export interface ParsedFrontmatter {
  data: FrontmatterData;
  body: string;
  diagnostics: Diagnostic[];
}

export const FRONTMATTER_SYNTAX = 'FRONTMATTER_SYNTAX';

const KEY_RE = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)*$/;
const FORBIDDEN_CHARS_RE = /[\x00-\x08\x0b-\x1f\x7f\u0085\u2028\u2029]/;
const INT_RE = /^-?[0-9]+$/;
const INDICATORS = '-?:,[]{}#&*!|>\'"%@`';

const YAML_SPECIAL_RE =
  /^(null|Null|NULL|~|true|True|TRUE|false|False|FALSE|yes|Yes|YES|no|No|NO|on|On|ON|off|Off|OFF|y|Y|n|N)$/;
const YAML_NUMERIC_RE = /^[-+]?(\d[\d_]*)?(\.\d*)?([eE][-+]?\d+)?$/;
const YAML_RADIX_RE = /^[-+]?0[xXoObB]/;
const YAML_FLOAT_SPECIAL_RE = /^[-+]?\.(inf|Inf|INF|nan|NaN|NAN)$/;

/** Parse a double-quoted value. Returns the string or an error message. */
function parseQuoted(raw: string): { value: string } | { error: string } {
  let out = '';
  let i = 1;
  while (i < raw.length) {
    const c = raw[i];
    if (c === '\\') {
      const n = raw[i + 1];
      if (n === '"' || n === '\\') {
        out += n;
        i += 2;
        continue;
      }
      return {
        error: 'invalid escape in quoted string (only \\" and \\\\ are allowed)',
      };
    }
    if (c === '"') {
      if (i !== raw.length - 1) {
        return { error: 'unexpected characters after the closing quote' };
      }
      return { value: out };
    }
    out += c;
    i++;
  }
  return { error: 'unterminated quoted string' };
}

/** Parse the text after `key: `. Returns the typed value or an error message. */
function parseValue(raw: string): { value: FrontmatterValue } | { error: string } {
  if (raw.trim() === '') {
    return { error: 'empty value (use "" for an empty string)' };
  }
  if (FORBIDDEN_CHARS_RE.test(raw)) {
    return { error: 'control characters and line separators are not allowed' };
  }
  if (raw.startsWith('"')) {
    return parseQuoted(raw);
  }
  if (raw === 'true') {
    return { value: true };
  }
  if (raw === 'false') {
    return { value: false };
  }
  if (INT_RE.test(raw)) {
    const n = Number(raw);
    if (!Number.isSafeInteger(n)) {
      return { error: 'integer is outside the safe integer range' };
    }
    return { value: n };
  }
  if (INDICATORS.includes(raw[0])) {
    return { error: `value starting with "${raw[0]}" must be double-quoted` };
  }
  if (/^[ \t]|[ \t]$/.test(raw)) {
    return { error: 'value starting or ending with a space or tab must be double-quoted' };
  }
  if (raw.endsWith(':')) {
    return { error: 'value ending with ":" must be double-quoted' };
  }
  if (raw.includes(': ') || raw.includes(':\t') || raw.includes(' #') || raw.includes('\t#')) {
    return {
      error:
        'value containing ": ", a colon followed by a tab, " #" or a tab followed by "#" must be double-quoted',
    };
  }
  return { value: raw };
}

export function parseFrontmatter(text: string, path: string): ParsedFrontmatter {
  const diagnostics: Diagnostic[] = [];
  const fail = (line: number, message: string): void => {
    diagnostics.push({
      severity: 'error',
      code: FRONTMATTER_SYNTAX,
      path,
      line,
      message,
    });
  };

  const readLine = (pos: number): { line: string; next: number } => {
    const nl = text.indexOf('\n', pos);
    const end = nl === -1 ? text.length : nl;
    let line = text.slice(pos, end);
    if (line.endsWith('\r')) {
      line = line.slice(0, -1);
    }
    return { line, next: nl === -1 ? text.length : nl + 1 };
  };

  const first = readLine(0);
  if (first.line !== '---') {
    fail(1, 'file must start with a "---" frontmatter delimiter line');
    return { data: {}, body: text, diagnostics };
  }

  const data: FrontmatterData = {};
  let pos = first.next;
  let lineNo = 2;
  while (pos < text.length) {
    const { line, next } = readLine(pos);
    pos = next;
    if (line === '---') {
      return { data, body: text.slice(pos), diagnostics };
    }
    parseLine(line, lineNo, data, fail);
    lineNo++;
  }

  return {
    data: {},
    body: '',
    diagnostics: [
      {
        severity: 'error',
        code: FRONTMATTER_SYNTAX,
        path,
        line: 1,
        message: 'frontmatter is not closed: missing closing "---" line',
      },
    ],
  };
}

function parseLine(
  line: string,
  lineNo: number,
  data: FrontmatterData,
  fail: (line: number, message: string) => void,
): void {
  if (line.trim() === '') {
    return;
  }
  if (/^\s/.test(line)) {
    fail(lineNo, 'indentation is not allowed in frontmatter');
    return;
  }
  if (line.startsWith('#')) {
    fail(lineNo, 'comments are not allowed in frontmatter');
    return;
  }
  const colon = line.indexOf(':');
  if (colon === -1) {
    fail(lineNo, 'expected "key: value" but found no ":"');
    return;
  }
  const key = line.slice(0, colon);
  if (!KEY_RE.test(key)) {
    fail(lineNo, `invalid key "${key}"`);
    return;
  }
  const rest = line.slice(colon + 1);
  if (rest === '') {
    fail(lineNo, `empty value for key "${key}" (use "" for an empty string)`);
    return;
  }
  if (rest[0] !== ' ') {
    fail(lineNo, `missing space after ":" for key "${key}"`);
    return;
  }
  const parsed = parseValue(rest.slice(1));
  if ('error' in parsed) {
    fail(lineNo, `key "${key}": ${parsed.error}`);
    return;
  }
  if (Object.prototype.hasOwnProperty.call(data, key)) {
    fail(lineNo, `duplicate key "${key}" (first value wins)`);
    return;
  }
  data[key] = parsed.value;
}

function needsQuoting(s: string): boolean {
  if (s === '' || s.startsWith(' ') || s.endsWith(' ') || s.endsWith(':')) {
    return true;
  }
  if (s.includes(': ') || s.includes(' #') || s.includes('\t')) {
    return true;
  }
  if (INDICATORS.includes(s[0])) {
    return true;
  }
  if (s === 'true' || s === 'false' || INT_RE.test(s)) {
    return true;
  }
  if (YAML_SPECIAL_RE.test(s) || YAML_RADIX_RE.test(s) || YAML_FLOAT_SPECIAL_RE.test(s)) {
    return true;
  }
  return /\d/.test(s) && YAML_NUMERIC_RE.test(s);
}

function serializeValue(key: string, value: FrontmatterValue): string {
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new LhrError('INVALID_INPUT', `value for "${key}" is not a safe integer: ${value}`);
    }
    return String(value);
  }
  if (typeof value !== 'string') {
    throw new LhrError('INVALID_INPUT', `value for "${key}" must be a string, number or boolean`);
  }
  if (value.includes('\n') || value.includes('\r')) {
    throw new LhrError('INVALID_INPUT', `value for "${key}" must not contain a line break`);
  }
  if (FORBIDDEN_CHARS_RE.test(value)) {
    throw new LhrError(
      'INVALID_INPUT',
      `value for "${key}" must not contain control characters or line separators`,
    );
  }
  if (!needsQuoting(value)) {
    return value;
  }
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function serializeFrontmatter(data: FrontmatterData, body: string): string {
  let out = '---\n';
  for (const [key, value] of Object.entries(data)) {
    if (!KEY_RE.test(key)) {
      throw new LhrError('INVALID_INPUT', `invalid frontmatter key "${key}"`);
    }
    out += `${key}: ${serializeValue(key, value)}\n`;
  }
  return `${out}---\n${body}`;
}
