import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../lib/config.mjs';
import { statusReport, statusSegment, statusSnapshot } from '../lib/status.mjs';

const config = loadConfig({ env: { TYPESAFE_API_KEY: 'secret-key' } });
const lastTurn = {
  lastRoute: 'high',
  lastReason: 'upgrade',
  lastEffort: 'xhigh',
  lastRequest: { model: 'claude-opus-5-5', tokens: 120_000, cacheReadTokens: 118_000, at: 1 },
};

test('the snapshot lists the routes and never carries the key', () => {
  const status = statusSnapshot(config, null);
  assert.equal(status.keySet, true);
  assert.equal(status.session, null);
  assert.doesNotMatch(JSON.stringify(status), /secret-key/);
  assert.deepEqual(status.routes, [
    { tier: 'micro', model: 'claude-haiku-4-5', effort: 'none' },
    { tier: 'low', model: 'claude-sonnet-5', effort: 'as sent' },
    { tier: 'medium', model: 'claude-opus-5-5', effort: 'high' },
    { tier: 'high', model: 'claude-opus-5-5', effort: 'xhigh' },
  ]);
});

for (const [name, status, expected] of [
  ['gateway down', null, 'router: gateway down'],
  ['no turn yet', statusSnapshot(config, null), 'router: no turn yet'],
  ['last turn', statusSnapshot(config, lastTurn), 'router ▸ opus-5-5 · xhigh'],
  [
    'no observed model, no effort',
    statusSnapshot(config, { lastRoute: 'micro', lastEffort: null, lastRequest: null }),
    'router ▸ haiku-4-5',
  ],
]) {
  test(`segment: ${name}`, () => assert.equal(statusSegment(status), expected));
}

test('the report shows the routes and the last turn', () => {
  const report = statusReport(statusSnapshot(config, lastTurn));
  assert.match(report, /\| medium \| claude-opus-5-5 \| high \|/);
  assert.match(report, /Jev routing: active/);
  assert.match(report, /Last turn: high → claude-opus-5-5 at xhigh, reason upgrade, context 120000 tokens/);
  assert.match(statusReport(statusSnapshot(config, null)), /No routed turn/);
  assert.match(statusReport(null), /does not answer/);
});
