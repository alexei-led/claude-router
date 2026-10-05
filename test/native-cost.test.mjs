import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULTS, loadConfig } from '../lib/config.mjs';
import * as native from '../lib/native-cost.mjs';
import { decide, initialState } from '../lib/policy.mjs';

const now = 1_000_000;
const facts = {
  effort: 'xhigh',
  lastRoute: 'medium',
  lastRequest: { tokens: 150_000, outputTokens: 1500 },
  models: { 'claude-sonnet-5-5@xhigh': { prefixTokens: 148_000, lastAt: now } },
};
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);

test('native cache evidence is only a five-minute fresh estimate, never an inferred hour', () => {
  for (const [age, expected] of [
    [0, 'fresh'],
    [269_999, 'fresh'],
    [270_000, 'unknown'],
    [600_000, 'unknown'],
  ]) {
    assert.equal(native.cacheState({ prefixTokens: 100, lastAt: now - age }, now, DEFAULTS.cache), expected);
  }
  assert.equal(native.cacheState({ prefixTokens: 0, lastAt: now }, now, DEFAULTS.cache), 'unknown');
  assert.equal(native.cacheState({ prefixTokens: 100, lastAt: now + 1 }, now, DEFAULTS.cache), 'unknown');
});

test('cache identity preserves model snapshots and separates effective efforts', () => {
  const config = loadConfig({ userFile: { models: { haiku: { id: 'claude-haiku-4-5-20251001' } } } });
  assert.equal(native.routeCacheKey(config, 'micro', 'xhigh'), 'claude-haiku-4-5-20251001');
  assert.equal(native.routeCacheKey(config, 'medium', 'low'), 'claude-sonnet-5-5@xhigh');
  assert.equal(native.routeCacheKey(config, 'low', 'medium'), 'claude-sonnet-5-5@medium');
  assert.equal(native.routeCacheKey(config, 'low', 2000), 'claude-sonnet-5-5@2000');
});

test('bounds distinguish observed cached prefix from generated and uncached tokens', () => {
  const bounds = native.inputBounds(DEFAULTS, 'medium', 151_500, facts, now);
  near(bounds.min, 0.0366);
  near(bounds.max, 0.0436);
  near(native.coldWriteUsd(DEFAULTS, 'haiku', 151_500), 0.303);
});

test('unknown TTL keeps an optimistic incumbent scenario and a cold candidate upper cost', () => {
  const later = now + 600_000;
  near(native.switchingTaxUsd(DEFAULTS, 'micro', 'medium', facts, later), 0.2664);
  near(native.downgradeTaxUsd(DEFAULTS, 'micro', 'medium', facts, later, 5), 0.1683);
  const estimate = native.shadowEconomics(DEFAULTS, 'micro', 'medium', facts, later);
  near(estimate.nextTurnUsd, 0.2589);
  near(estimate.laterTurnUsd, -0.02265);
  assert.equal(estimate.paybackTurns, 12);
  assert.equal(native.cacheState(facts.models['claude-sonnet-5-5@xhigh'], later, DEFAULTS.cache), 'unknown');
});

test('the default policy accounts for bounded native switching costs', () => {
  const advice = { choice: 'micro', continuation: 0, probabilities: { micro: 0.92, low: 0, medium: 0.08, high: 0 } };
  const state = { ...initialState(), votes: [{ tier: 'micro', turn: 0 }] };
  const args = { config: DEFAULTS, facts, advice, state, baseline: 'medium', now };
  const original = decide(args);
  const bounded = decide({ ...args, costs: native });
  assert.deepEqual(original, bounded);
  assert.equal(bounded.tier, 'medium');
  assert.equal(bounded.reason, 'downgrade-pending');
  near(bounded.estimate.threshold, 0.9 + (0.08 * 0.1683) / 0.6683);
  assert.deepEqual(decide(args), original);
});

test('an all-credits policy with no plan fallback stays rather than returning an undefined tier', () => {
  const config = loadConfig({
    userFile: {
      models: { opus: { billing: 'credits' }, sonnet: { billing: 'credits' }, haiku: { billing: 'credits' } },
      policy: { cashCapUsd: 0 },
    },
  });
  const result = decide({
    config,
    facts,
    advice: { choice: 'high', continuation: 0, probabilities: { high: 1 } },
    state: initialState(),
    baseline: 'medium',
    now,
    costs: native,
  });
  assert.equal(result.tier, 'medium');
  assert.equal(result.reason, 'cash-gate');
});

test('effort clamping keeps supported levels and bounds unsupported levels', () => {
  for (const [wanted, supported, expected] of [
    ['xhigh', ['low', 'medium', 'high', 'max'], 'high'],
    ['max', ['low', 'medium', 'high', 'max'], 'max'],
    ['low', ['medium'], 'medium'],
    [undefined, ['low'], null],
    ['high', [], null],
  ])
    assert.equal(native.clampEffort(wanted, supported), expected);
});

test('context estimate uses both the previous output and the current measurement', () => {
  assert.equal(native.nextContextTokens({ lastRequest: { tokens: 100, outputTokens: 30 }, contextTokens: 120 }), 130);
  assert.equal(native.nextContextTokens({ lastRequest: { tokens: 100, outputTokens: 30 }, contextTokens: 160 }), 160);
  assert.equal(native.nextContextTokens({ contextTokens: 42 }), 42);
  assert.equal(native.nextContextTokens({}), 0);
});
