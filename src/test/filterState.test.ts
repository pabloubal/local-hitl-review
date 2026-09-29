import * as assert from 'node:assert';
import { test, describe } from 'node:test';
import { FilterState } from '../filterState.js';

describe('FilterState', () => {
  test('should default to open status and no severities', () => {
    const filterState = new FilterState();
    assert.strictEqual(filterState.statuses.has('open'), true);
    assert.strictEqual(filterState.statuses.size, 1);
    assert.strictEqual(filterState.severities.size, 0);
  });

  test('update() sets severities and statuses', () => {
    const filterState = new FilterState();
    filterState.update(['critical', 'high'], ['resolved', 'wontfix']);
    
    assert.strictEqual(filterState.severities.has('critical'), true);
    assert.strictEqual(filterState.severities.has('high'), true);
    assert.strictEqual(filterState.statuses.has('resolved'), true);
    assert.strictEqual(filterState.statuses.has('wontfix'), true);
    assert.strictEqual(filterState.statuses.has('open'), false);
  });

  test('matches() returns true when filter is empty for that category', () => {
    const filterState = new FilterState();
    filterState.update([], []);
    
    // With empty severities and empty statuses, everything matches
    assert.strictEqual(filterState.matches('critical', 'open'), true);
    assert.strictEqual(filterState.matches('low', 'resolved'), true);
  });

  test('matches() respects severity filters', () => {
    const filterState = new FilterState();
    filterState.update(['critical'], []);
    
    assert.strictEqual(filterState.matches('critical', 'open'), true);
    assert.strictEqual(filterState.matches('high', 'open'), false);
  });

  test('matches() respects status filters', () => {
    const filterState = new FilterState();
    filterState.update([], ['resolved']);
    
    assert.strictEqual(filterState.matches('critical', 'resolved'), true);
    assert.strictEqual(filterState.matches('critical', 'open'), false);
  });

  test('matches() requires both category conditions to be met if both are set', () => {
    const filterState = new FilterState();
    filterState.update(['high'], ['open']);
    
    // Match both
    assert.strictEqual(filterState.matches('high', 'open'), true);
    // Mismatch status
    assert.strictEqual(filterState.matches('high', 'resolved'), false);
    // Mismatch severity
    assert.strictEqual(filterState.matches('low', 'open'), false);
    // Mismatch both
    assert.strictEqual(filterState.matches('low', 'resolved'), false);
  });
});
