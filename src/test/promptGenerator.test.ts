import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { generateAgentPrompt } from '../promptGenerator.js';
import type { FeedbackComment } from '../types.js';

describe('Prompt Generator Test Suite', () => {
  const mockComments: FeedbackComment[] = [
    {
      id: '1',
      severity: 'critical',
      status: 'open',
      reviewer: 'human',
      file: 'src/commentController.ts',
      lines: '10',
      body: 'fix this',
      timestamp: 1,
    },
    {
      id: '2',
      severity: 'high',
      status: 'open',
      reviewer: 'human',
      file: 'src/commentController.ts',
      lines: '20',
      body: 'fix that',
      timestamp: 2,
    },
    {
      id: '3',
      severity: 'critical',
      status: 'open',
      reviewer: 'human',
      file: 'src/feedbackStore.ts',
      lines: '30',
      body: 'and this',
      timestamp: 3,
    },
    {
      id: '4',
      severity: 'critical',
      status: 'open',
      reviewer: 'human',
      file: 'src/feedbackStore.ts',
      lines: '40',
      body: 'and that',
      timestamp: 4,
    },
    {
      id: '5',
      severity: 'high',
      status: 'open',
      reviewer: 'human',
      file: 'src/commentController.ts',
      lines: '50',
      body: 'also this',
      timestamp: 5,
    },
    {
      id: '6',
      severity: 'medium',
      status: 'open',
      reviewer: 'human',
      file: 'src/logger.ts',
      lines: '60',
      body: 'maybe this',
      timestamp: 6,
    },
    {
      id: '7',
      severity: 'low',
      status: 'acknowledged',
      reviewer: 'human',
      file: 'src/logger.ts',
      lines: '70',
      body: 'acknowledged',
      timestamp: 7,
    },
  ];

  it('generateAgentPrompt handles comments correctly', () => {
    const prompt = generateAgentPrompt(
      '/workspace',
      '/workspace/.feedback/AGENTS.md',
      mockComments,
    );
    const expected = `Review feedback: 3 critical, 2 high, 1 medium, 0 low — 6 open findings across 3 files

- src/commentController.ts (1 critical, 2 high)
- src/feedbackStore.ts (2 critical)
- src/logger.ts (1 medium)

@.feedback/AGENTS.md`;
    assert.equal(prompt, expected);
  });

  it('generateAgentPrompt returns simple reference when no open comments', () => {
    const prompt = generateAgentPrompt('/workspace', '/workspace/.feedback/AGENTS.md', []);
    assert.equal(prompt, '@.feedback/AGENTS.md');
  });

  it('generateAgentPrompt grammar handles singular counts correctly', () => {
    const oneComment: FeedbackComment[] = [
      {
        id: '1',
        severity: 'low',
        status: 'open',
        reviewer: 'human',
        file: 'src/app.ts',
        lines: '10',
        body: 'info',
        timestamp: 1,
      },
    ];
    const prompt = generateAgentPrompt('/workspace', '/workspace/.feedback/AGENTS.md', oneComment);
    const expected = `Review feedback: 0 critical, 0 high, 0 medium, 1 low — 1 open finding across 1 file

- src/app.ts (1 low)

@.feedback/AGENTS.md`;
    assert.equal(prompt, expected);
  });
});
