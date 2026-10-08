import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULTS, loadConfig } from '../lib/config.mjs';
import {
  bar,
  classifierStatus,
  credentialsNeeded,
  formatTokens,
  missingText,
  routeLabel,
  sparkline,
  switchCount,
  usageMetrics,
} from '../lib/display.mjs';

test('unknown metrics stay unknown and zero is a real reading', () => {
  assert.equal(formatTokens(null), 'unknown');
  assert.equal(formatTokens(0), '0');
  assert.equal(bar(null, 100).percent, null);
  assert.equal(bar(0, 100).percent, 0);
  assert.equal(bar(200, 100).percent, 200);
  assert.equal(bar(200, 100).text.length, 16);
});

test('a small-window model is measured against its own window, not the native session model', () => {
  const config = loadConfig({
    userFile: {
      models: {
        haiku: { id: 'claude-haiku-4-5', input: 1, output: 5, cacheRead: 0.1, contextWindow: 200_000, efforts: [] },
      },
    },
  });
  const metrics = usageMetrics(
    config,
    {
      actualModel: 'claude-haiku-4-5-20251001',
      contextTokens: 150_000,
      inputTokens: 150_000,
      outputTokens: 500,
      cacheRead: 120_000,
    },
    { context: { window: 1_000_000, tokens: 150_000 }, cost: { usd: 0.03 } },
  );
  assert.equal(metrics.window, 200_000);
  assert.equal(metrics.contextBar.percent, 75);
  assert.equal(metrics.cacheBar.percent, 80);
  assert.equal(metrics.cacheBar.color, 'green');
  assert.equal(metrics.cost, 0.03);
  assert.equal(metrics.cacheBenefit, 0.108);
});

test('unreported ledgers and model pricing produce no fake savings', () => {
  const metrics = usageMetrics(DEFAULTS, { nativeModel: 'unknown-model' }, { context: { window: 1_000_000 } });
  assert.equal(metrics.cost, null);
  assert.equal(metrics.window, null);
  assert.equal(metrics.cacheBenefit, null);
  assert.equal(metrics.reuse, null);
});

test('the trend chart scales from the lowest to the highest reading and refuses unknown readings', () => {
  for (const [values, expected] of [
    [[], 'no history yet'],
    [[5], '▄'],
    [[0, 0], '▄▄'],
    [[0, 7], '▁█'],
    [[0, 1, 2, 3, 4, 5, 6, 7], '▁▂▃▄▅▆▇█'],
    [[1, 4, 8], '▁▄█'],
    [[396_000, 400_000, 402_000], '▁▆█'],
    [[1, Number.NaN], 'no history yet'],
    [[1, Number.POSITIVE_INFINITY], 'no history yet'],
  ])
    assert.equal(sparkline(values), expected, JSON.stringify(values));
});

test('token counts switch unit at a thousand and a million', () => {
  for (const [value, expected] of [
    [0, '0'],
    [999, '999'],
    [999.4, '999'],
    [1000, '1.0K'],
    [12_345, '12.3K'],
    [1_000_000, '1.00M'],
    [1_234_567, '1.23M'],
    [Number.NaN, 'unknown'],
    [Number.POSITIVE_INFINITY, 'unknown'],
    [undefined, 'unknown'],
  ])
    assert.equal(formatTokens(value), expected, String(value));
});

test('a bar turns yellow above 60% and red above 80%, clamps its fill and knows no reading', () => {
  for (const [value, maximum, width, expected] of [
    [0, 1, 4, { text: '░░░░', percent: 0, color: 'green' }],
    [0.6, 1, 10, { text: '██████░░░░', percent: 60, color: 'green' }],
    [0.61, 1, 10, { text: '██████░░░░', percent: 61, color: 'yellow' }],
    [0.8, 1, 10, { text: '████████░░', percent: 80, color: 'yellow' }],
    [0.81, 1, 10, { text: '████████░░', percent: 81, color: 'red' }],
    [3, 2, 4, { text: '████', percent: 150, color: 'red' }],
    [-1, 1, 4, { text: '░░░░', percent: 0, color: 'green' }],
    [1, 0, 4, { text: 'unknown', percent: null, color: 'gray' }],
    [Number.NaN, 1, 4, { text: 'unknown', percent: null, color: 'gray' }],
    [null, 1, 4, { text: 'unknown', percent: null, color: 'gray' }],
  ])
    assert.deepEqual(bar(value, maximum, width), expected, `${value} of ${maximum}`);
});

test('a route label adds the effort only when there is one', () => {
  for (const [model, effort, expected] of [
    ['claude-opus-5-5', 'high', 'Opus 5.5 · high'],
    ['claude-haiku-4-5-20251001', null, 'Haiku 4.5'],
    ['claude-sonnet-5-5', undefined, 'Sonnet 5.5'],
    ['claude-sonnet-5-5', 0, 'Sonnet 5.5 · 0'],
  ])
    assert.equal(routeLabel(model, effort), expected);
});

test('a switch is a tier change between consecutive routed replies', () => {
  for (const [tiers, expected] of [
    [[], 0],
    [['low'], 0],
    [['low', 'low'], 0],
    [['low', 'high', 'high'], 1],
    [['low', 'high', 'low'], 2],
    [['low', null, 'high'], 0],
  ])
    assert.equal(switchCount(tiers), expected, tiers.join(','));
});

test('a classifier status names the classifier and the setting it lacks', () => {
  const clef = loadConfig({ userFile: { classifier: 'clef' } });
  for (const [config, error, expected] of [
    [DEFAULTS, 'missing-key', 'Jev: no API key'],
    [clef, 'missing-key', 'Clef: no API token'],
    [clef, 'missing-account', 'Clef: no account ID'],
    [clef, 'timeout', 'Clef timed out'],
    [clef, 'auth', 'Clef rejected the key'],
    [clef, 'something-new', 'Clef something-new'],
  ])
    assert.equal(classifierStatus(config, error), expected);
  assert.equal(missingText(clef, 'jev', 'missing-key'), 'no API key');
});

test('the credentials list groups classifiers that need the same settings', () => {
  const proxy = {
    label: 'Proxy',
    endpoint: 'https://jev-proxy.example.internal/v1/systemone',
    model: 'jev-1.13.0',
    keyOption: 'typesafe_api_key',
    timeoutMs: 1500,
  };
  assert.equal(credentialsNeeded(DEFAULTS), 'Jev: API key · Clef, Clef Flash: API token, account ID');
  assert.equal(
    credentialsNeeded(loadConfig({ userFile: { classifiers: { proxy } } })),
    'Jev, Proxy: API key · Clef, Clef Flash: API token, account ID',
  );
});
