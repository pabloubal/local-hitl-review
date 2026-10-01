import { randomInt } from 'node:crypto';
import { LhrError } from './errors.js';

export type AuthorKind = 'human' | 'agent';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const RANDOM_RE = /^[a-z2-7]{6}$/;
const TS = '(\\d{4})(\\d{2})(\\d{2})T(\\d{2})(\\d{2})(\\d{2})Z';
const ID_RE = new RegExp(`^${TS}-([a-z2-7]{6})$`);
const MESSAGE_ID_RE = new RegExp(`^${TS}-(human|agent)-([a-z2-7]{6})$`);

export interface ParsedId {
  id: string;
  timestamp: Date;
  random: string;
}

export interface ParsedMessageId extends ParsedId {
  kind: AuthorKind;
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

export function formatTimestamp(date: Date): string {
  const ms = date.getTime();
  if (Number.isNaN(ms)) {
    throw new LhrError('INVALID_INPUT', 'Invalid date');
  }
  const year = date.getUTCFullYear();
  if (year < 0 || year > 9999) {
    throw new LhrError('INVALID_INPUT', `Year out of range 0000-9999: ${year}`);
  }
  return (
    pad(year, 4) +
    pad(date.getUTCMonth() + 1, 2) +
    pad(date.getUTCDate(), 2) +
    'T' +
    pad(date.getUTCHours(), 2) +
    pad(date.getUTCMinutes(), 2) +
    pad(date.getUTCSeconds(), 2) +
    'Z'
  );
}

export function defaultRandom(): string {
  let out = '';
  for (let i = 0; i < 6; i++) {
    out += ALPHABET[randomInt(ALPHABET.length)];
  }
  return out;
}

function assertRandom(random: string): void {
  if (!RANDOM_RE.test(random)) {
    throw new LhrError('INVALID_INPUT', `Random part must be 6 chars from [a-z2-7]: ${random}`);
  }
}

function assertKind(kind: string): asserts kind is AuthorKind {
  if (kind !== 'human' && kind !== 'agent') {
    throw new LhrError('INVALID_INPUT', `Author kind must be 'human' or 'agent': ${kind}`);
  }
}

export function createId(now: Date, random: string): string {
  const ts = formatTimestamp(now);
  assertRandom(random);
  return `${ts}-${random}`;
}

export function createMessageId(now: Date, kind: AuthorKind, random: string): string {
  const ts = formatTimestamp(now);
  assertKind(kind);
  assertRandom(random);
  return `${ts}-${kind}-${random}`;
}

export function createMessageFileName(now: Date, kind: AuthorKind, random: string): string {
  return `${createMessageId(now, kind, random)}.md`;
}

/** Builds a Date from regex groups [y, mo, d, h, mi, s]; undefined if impossible. */
function toDate(parts: string[]): Date | undefined {
  const [y, mo, d, h, mi, s] = parts.map(Number);
  if (mo < 1 || mo > 12 || h > 23 || mi > 59 || s > 59 || d < 1) {
    return undefined;
  }
  const date = new Date(0);
  date.setUTCFullYear(y, mo - 1, d);
  date.setUTCHours(h, mi, s, 0);
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) {
    return undefined;
  }
  return date;
}

export function parseId(id: string): ParsedId | undefined {
  const m = ID_RE.exec(id);
  if (!m) return undefined;
  const timestamp = toDate(m.slice(1, 7));
  if (!timestamp) return undefined;
  return { id, timestamp, random: m[7] };
}

export function parseMessageId(id: string): ParsedMessageId | undefined {
  const m = MESSAGE_ID_RE.exec(id);
  if (!m) return undefined;
  const timestamp = toDate(m.slice(1, 7));
  if (!timestamp) return undefined;
  return { id, timestamp, kind: m[7] as AuthorKind, random: m[8] };
}

export function parseMessageFileName(name: string): ParsedMessageId | undefined {
  if (!name.endsWith('.md')) return undefined;
  return parseMessageId(name.slice(0, -3));
}
