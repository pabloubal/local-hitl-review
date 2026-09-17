import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseReviewFile,
  serializeReviewFile,
  parseLineRange,
  formatLineRange,
  generateCommentId,
} from '../parser.js';

describe('parseReviewFile', () => {
  it('parses a complete .review file', () => {
    const content = `---
severity: high
status: open
file: src/engine/session.go
lines: 42-58
---
The retry logic here doesn't respect context cancellation.

\`\`\`suggestion
if ctx.Err() != nil {
    return ctx.Err()
}
\`\`\``;

    const comment = parseReviewFile(content, '1726588988-a3f2');
    assert.equal(comment.id, '1726588988-a3f2');
    assert.equal(comment.severity, 'high');
    assert.equal(comment.status, 'open');
    assert.equal(comment.file, 'src/engine/session.go');
    assert.equal(comment.lines, '42-58');
    assert.ok(comment.body.includes('retry logic'));
    assert.ok(comment.body.includes('```suggestion'));
    assert.equal(comment.timestamp, 1726588988);
  });

  it('defaults severity to medium if invalid', () => {
    const content = `---
severity: urgent
status: open
file: foo.ts
lines: 1
---
Some comment`;

    const comment = parseReviewFile(content, '123-abcd');
    assert.equal(comment.severity, 'medium');
  });

  it('defaults status to open if invalid', () => {
    const content = `---
severity: low
status: resolved
file: foo.ts
lines: 1
---
Some comment`;

    const comment = parseReviewFile(content, '123-abcd');
    assert.equal(comment.status, 'open');
  });

  it('throws on missing frontmatter', () => {
    assert.throws(
      () => parseReviewFile('No frontmatter here', 'x'),
      /no frontmatter found/
    );
  });
});

describe('serializeReviewFile', () => {
  it('produces valid frontmatter + body', () => {
    const comment = {
      id: '1726588988-a3f2',
      severity: 'critical' as const,
      status: 'acknowledged' as const,
      reviewer: 'human' as const,
      file: 'pkg/handler.go',
      lines: '10',
      body: 'This needs error handling.',
      timestamp: 1726588988,
    };

    const output = serializeReviewFile(comment);
    assert.ok(output.startsWith('---\n'));
    assert.ok(output.includes('severity: critical'));
    assert.ok(output.includes('status: acknowledged'));
    assert.ok(output.includes('file: pkg/handler.go'));
    assert.ok(output.includes('lines: 10'));
    assert.ok(output.includes('This needs error handling.'));
  });

  it('round-trips correctly', () => {
    const original = {
      id: '1726588988-a3f2',
      severity: 'high' as const,
      status: 'open' as const,
      reviewer: 'human' as const,
      file: 'src/main.ts',
      lines: '5-10',
      body: 'Consider using a Map here.',
      timestamp: 1726588988,
    };

    const serialized = serializeReviewFile(original);
    const parsed = parseReviewFile(serialized, original.id);

    assert.equal(parsed.severity, original.severity);
    assert.equal(parsed.status, original.status);
    assert.equal(parsed.file, original.file);
    assert.equal(parsed.lines, original.lines);
    assert.equal(parsed.body, original.body);
  });
});

describe('parseLineRange', () => {
  it('parses a single line', () => {
    const range = parseLineRange('42');
    assert.equal(range.start, 42);
    assert.equal(range.end, 42);
  });

  it('parses a range', () => {
    const range = parseLineRange('10-50');
    assert.equal(range.start, 10);
    assert.equal(range.end, 50);
  });
});

describe('formatLineRange', () => {
  it('formats a single line', () => {
    assert.equal(formatLineRange(42, 42), '42');
  });

  it('formats a range', () => {
    assert.equal(formatLineRange(10, 50), '10-50');
  });
});

describe('generateCommentId', () => {
  it('produces timestamp-hash format', () => {
    const id = generateCommentId();
    assert.match(id, /^\d+-[0-9a-f]{4}$/);
  });

  it('produces unique ids', () => {
    const ids = new Set(Array.from({ length: 20 }, () => generateCommentId()));
    assert.equal(ids.size, 20);
  });
});
