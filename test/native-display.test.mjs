import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULTS, loadConfig } from '../lib/config.mjs';
import {
  bar,
  classifierStatus,
  credentialsNeeded,
  formatTokens,
  missingText,
  sparkline,
  usageMetrics,
} from '../lib/native-display.mjs';

test('unknown metrics stay unknown and zero is a real reading', () => {
  assert.equal(formatTokens(null), 'unknown');
  assert.equal(formatTokens(0), '0');
  assert.equal(bar(null, 100).percent, null);
  assert.equal(bar(0, 100).percent, 0);
  assert.equal(bar(200, 100).percent, 200);
  assert.equal(bar(200, 100).text.length, 16);
});

test('Haiku context is measured against its own window, not the native session model', () => {
  const metrics = usageMetrics(
    DEFAULTS,
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

test('the tiny trend chart handles empty, zero and changing observed data', () => {
  assert.equal(sparkline([]), 'no history yet');
  assert.equal(sparkline([0, 0]), '▄▄');
  assert.equal(sparkline([1, 4, 8]), '▁▄█');
  assert.equal(sparkline([396_000, 400_000, 402_000]), '▁▆█');
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
