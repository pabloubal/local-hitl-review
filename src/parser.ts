import type { FeedbackComment, Severity, Status, Reviewer } from './types.js';

const FRONTMATTER_REGEX = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;

/**
 * Parse a .review file content into a FeedbackComment.
 * Expects YAML-like frontmatter delimited by --- lines.
 */
export function parseReviewFile(content: string, id: string): FeedbackComment {
  const match = content.match(FRONTMATTER_REGEX);
  if (!match) {
    throw new Error(`Invalid .review file format: no frontmatter found`);
  }

  const frontmatter = match[1];
  const body = match[2].trim();

  const fields = parseFrontmatter(frontmatter);

  const severity = validateSeverity(fields.get('severity') ?? 'medium');
  const status = validateStatus(fields.get('status') ?? 'open');
  const reviewer = (fields.get('reviewer') as Reviewer) || 'human';
  const file = fields.get('file') ?? '';
  const lines = fields.get('lines') ?? '1';

  // Extract timestamp from id (format: <timestamp>-<hash>)
  const timestampStr = id.split('-')[0];
  const timestamp = parseInt(timestampStr, 10) || Date.now() / 1000;

  return { id, severity, status, reviewer, file, lines, body, timestamp };
}

/**
 * Serialize a FeedbackComment into .review file content.
 */
export function serializeReviewFile(comment: FeedbackComment): string {
  const lines = [
    '---',
    `severity: ${comment.severity}`,
    `status: ${comment.status}`,
    `file: ${comment.file}`,
    `lines: ${comment.lines}`,
    '---',
    comment.body,
    '', // trailing newline
  ];
  return lines.join('\n');
}

/**
 * Parse a line range string into start/end line numbers (1-indexed).
 */
export function parseLineRange(lines: string): { start: number; end: number } {
  const parts = lines.split('-').map((s) => parseInt(s.trim(), 10));
  const start = parts[0] || 1;
  const end = parts.length > 1 ? (parts[1] || start) : start;
  return { start, end };
}

/**
 * Format start/end line numbers into a line range string.
 */
export function formatLineRange(start: number, end: number): string {
  if (start === end) {
    return `${start}`;
  }
  return `${start}-${end}`;
}

/**
 * Generate a unique comment ID from a timestamp and random hash.
 */
export function generateCommentId(): string {
  const timestamp = Math.floor(Date.now() / 1000);
  const hash = Math.random().toString(16).slice(2, 6);
  return `${timestamp}-${hash}`;
}

// --- internal helpers ---

function parseFrontmatter(raw: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of raw.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) { continue; }
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (key) {
      fields.set(key, value);
    }
  }
  return fields;
}

function validateSeverity(value: string): Severity {
  const valid: Severity[] = ['critical', 'high', 'medium', 'low'];
  if (valid.includes(value as Severity)) {
    return value as Severity;
  }
  return 'medium';
}

function validateStatus(value: string): Status {
  const valid: Status[] = ['open', 'acknowledged'];
  if (valid.includes(value as Status)) {
    return value as Status;
  }
  return 'open';
}
