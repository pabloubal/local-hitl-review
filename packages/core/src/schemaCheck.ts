import messageSchema from '../schema/message.schema.json';
import pushSchema from '../schema/push.schema.json';
import roundSchema from '../schema/round.schema.json';
import threadSchema from '../schema/thread.schema.json';
import type { FrontmatterData } from './frontmatter.js';

/** Keywords allowed at the schema root. Anything else throws at load time. */
const ROOT_KEYWORDS = new Set([
  '$schema',
  '$id',
  'title',
  'description',
  'required',
  'properties',
  'additionalProperties',
]);
const PROPERTY_KEYWORDS = new Set(['title', 'description', 'type', 'enum', 'pattern']);
const TYPES = ['string', 'integer', 'boolean'] as const;
type SchemaType = (typeof TYPES)[number];

export interface PropertySchema {
  type?: SchemaType;
  enum?: readonly string[];
  pattern?: RegExp;
  description?: string;
}

export interface Schema {
  id: string;
  required: readonly string[];
  properties: Readonly<Record<string, PropertySchema>>;
  additionalProperties: boolean;
}

export type SchemaIssueKind = 'missing' | 'type' | 'enum' | 'pattern' | 'unknown';

export interface SchemaIssue {
  key: string;
  kind: SchemaIssueKind;
  message: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function compileProperty(key: string, raw: unknown): PropertySchema {
  if (!isRecord(raw)) throw new Error(`schema property "${key}" must be an object`);
  for (const kw of Object.keys(raw)) {
    if (!PROPERTY_KEYWORDS.has(kw)) {
      throw new Error(`unsupported schema keyword "${kw}" on property "${key}"`);
    }
  }
  const out: PropertySchema = {};
  if (raw.type !== undefined) {
    const t = TYPES.find((x) => x === raw.type);
    if (t === undefined) {
      throw new Error(`unsupported type ${JSON.stringify(raw.type)} on property "${key}"`);
    }
    out.type = t;
  }
  if (raw.enum !== undefined) {
    if (!Array.isArray(raw.enum) || !raw.enum.every((e): e is string => typeof e === 'string')) {
      throw new Error(`enum on property "${key}" must be an array of strings`);
    }
    out.enum = raw.enum;
  }
  if (raw.pattern !== undefined) {
    if (typeof raw.pattern !== 'string') throw new Error(`pattern on "${key}" must be a string`);
    out.pattern = new RegExp(raw.pattern);
  }
  if (typeof raw.description === 'string') out.description = raw.description;
  return out;
}

/** Compiles a parsed JSON Schema document. Throws on any keyword outside the supported subset. */
export function compileSchema(raw: unknown): Schema {
  if (!isRecord(raw)) throw new Error('schema must be an object');
  for (const kw of Object.keys(raw)) {
    if (!ROOT_KEYWORDS.has(kw)) throw new Error(`unsupported schema keyword "${kw}"`);
  }
  const required = raw.required ?? [];
  if (!Array.isArray(required) || !required.every((r): r is string => typeof r === 'string')) {
    throw new Error('required must be an array of strings');
  }
  const rawProps = raw.properties ?? {};
  if (!isRecord(rawProps)) throw new Error('properties must be an object');
  const properties: Record<string, PropertySchema> = {};
  for (const [key, value] of Object.entries(rawProps))
    properties[key] = compileProperty(key, value);
  const additional = raw.additionalProperties ?? true;
  if (typeof additional !== 'boolean') throw new Error('additionalProperties must be a boolean');
  return {
    id: typeof raw.$id === 'string' ? raw.$id : '',
    required,
    properties,
    additionalProperties: additional,
  };
}

/** Validates parsed frontmatter against a compiled schema. */
export function validate(schema: Schema, data: FrontmatterData): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  for (const key of schema.required) {
    if (data[key] === undefined) {
      issues.push({
        key,
        kind: 'missing',
        message: `missing required key "${key}"`,
      });
    }
  }
  for (const [key, value] of Object.entries(data)) {
    const prop = schema.properties[key];
    if (prop === undefined) {
      if (!schema.additionalProperties) {
        issues.push({ key, kind: 'unknown', message: `unknown key "${key}"` });
      }
      continue;
    }
    if (prop.type !== undefined && !matchesType(prop.type, value)) {
      issues.push({
        key,
        kind: 'type',
        message: `key "${key}" must be ${article(prop.type)}`,
      });
      continue;
    }
    if (prop.enum !== undefined && !prop.enum.includes(String(value))) {
      issues.push({
        key,
        kind: 'enum',
        message: `key "${key}" must be one of: ${prop.enum.join(', ')}`,
      });
      continue;
    }
    if (prop.pattern !== undefined && !(typeof value === 'string' && prop.pattern.test(value))) {
      issues.push({
        key,
        kind: 'pattern',
        message: `key "${key}" does not match ${prop.pattern.source}`,
      });
    }
  }
  return issues;
}

/** Keys of `data` that the schema does not declare. */
export function unknownKeys(schema: Schema, data: FrontmatterData): string[] {
  return Object.keys(data).filter((k) => schema.properties[k] === undefined);
}

function matchesType(type: SchemaType, value: unknown): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
  }
}

function article(type: SchemaType): string {
  return type === 'integer' ? 'an integer' : `a ${type}`;
}

export type SchemaKind = 'thread' | 'message' | 'round' | 'push';

let cache: Record<SchemaKind, Schema> | undefined;

/**
 * Compiles the shipped schemas (imported as JSON modules, so bundlers inline
 * them); cached after the first call.
 */
export function loadSchemas(): Record<SchemaKind, Schema> {
  cache ??= {
    thread: compileSchema(threadSchema),
    message: compileSchema(messageSchema),
    round: compileSchema(roundSchema),
    push: compileSchema(pushSchema),
  };
  return cache;
}
