import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initialView, responseMetrics } from '../lib/native-view.mjs';

const usage = (input, read, write) => ({
  model: 'claude-haiku-4-5',
  input_tokens: input,
  cache_read_input_tokens: read,
  cache_creation_input_tokens: write,
  output_tokens: 7,
});

test('responseMetrics sums the input counters and appends the reading with its tier', () => {
  const view = { ...initialView('claude-sonnet-5-5'), history: [10], tiers: ['low'] };
  assert.deepEqual(responseMetrics(view, { usage: usage(1, 2, 3) }, 'micro'), {
    actualModel: 'claude-haiku-4-5',
    cacheRead: 2,
    cacheWrite: 3,
    inputTokens: 6,
    outputTokens: 7,
    history: [10, 6],
    tiers: ['low', 'micro'],
  });
});

test('responseMetrics keeps the trend when a counter is missing', () => {
  for (const [name, response] of [
    ['no usage', {}],
    ['no cache counters', { usage: { model: 'claude-haiku-4-5', input_tokens: 5 } }],
  ]) {
    const metrics = responseMetrics({ history: [1], tiers: ['low'] }, response, 'low');
    assert.equal(metrics.inputTokens, null, name);
    assert.equal('history' in metrics || 'tiers' in metrics, false, name);
  }
});

test('responseMetrics keeps the last 30 readings, history and tiers in step', () => {
  const view = { history: Array.from({ length: 30 }, (_, i) => i), tiers: Array(30).fill('low') };
  const metrics = responseMetrics(view, { usage: usage(100, 0, 0) }, null);
  assert.equal(metrics.history.length, 30);
  assert.equal(metrics.history[0], 1);
  assert.equal(metrics.history.at(-1), 100);
  assert.equal(metrics.tiers.length, 30);
  assert.equal(metrics.tiers.at(-1), null);
});
