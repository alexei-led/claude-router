import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../lib/config.mjs';
import { isOlderVersion, statusReport, statusSegment, statusSnapshot } from '../lib/status.mjs';

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
  ['gateway off', null, 'router: gateway off, the next prompt starts it'],
  ['no turn yet', statusSnapshot(config, null), 'jev-router: no turn yet'],
  ['last turn', statusSnapshot(config, lastTurn), 'jev-router ▸ opus-5-5 · xhigh'],
  [
    'no observed model, no effort',
    statusSnapshot(config, { lastRoute: 'micro', lastEffort: null, lastRequest: null }),
    'jev-router ▸ haiku-4-5',
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
  assert.match(statusReport(null), /not running\. The next prompt starts it/);
});

test('the report says when Jev is paused and when there is no key', () => {
  const paused = statusReport({ ...statusSnapshot(config, null), jevPausedUntil: '2026-09-23T10:00:00.000Z' });
  assert.match(paused, /Jev routing: paused after repeated failures, next try at 2026-09-23T10:00:00.000Z/);
  assert.match(statusReport(statusSnapshot(loadConfig({}), null)), /Jev routing: inactive, no key/);
});

for (const [running, current, older] of [
  ['0.3.0', '0.3.1', true],
  ['0.3.1', '0.3.1', false],
  ['0.4.0', '0.3.1', false],
  ['1.0.0', '0.9.9', false],
  ['0.9.10', '0.10.0', true],
  [undefined, '0.3.1', true],
  ['garbage', '0.3.1', true],
]) {
  test(`isOlderVersion(${running}, ${current}) is ${older}`, () =>
    assert.equal(isOlderVersion(running, current), older));
}
