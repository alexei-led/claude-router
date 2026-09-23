import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../lib/config.mjs';
import {
  cacheState,
  coldWriteUsd,
  inputCostUsd,
  isWarm,
  nextContextTokens,
  routeCacheKey,
  shadowEconomics,
  switchingTaxUsd,
} from '../lib/cost.mjs';
import { memory, served, T0 } from './helpers.mjs';

const config = loadConfig({});
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test('warmth follows the granted ttl minus the margin', () => {
  const state = { lastAt: T0, ttl: '5m' };
  assert.ok(isWarm(state, T0 + 200_000, config.cache));
  assert.ok(!isWarm(state, T0 + 280_000, config.cache));
  assert.ok(!isWarm(undefined, T0, config.cache));
});

test('cache state tells a cache never seen from one that expired', () => {
  const state = { lastAt: T0, ttl: '5m' };
  assert.equal(cacheState(state, T0 + 1_000, config.cache), 'warm');
  assert.equal(cacheState(state, T0 + 280_000, config.cache), 'expired');
  assert.equal(cacheState(undefined, T0, config.cache), 'unknown');
});

test('the cache key is the model and the effort the route sends', () => {
  assert.equal(routeCacheKey(config, 'high', null), 'claude-opus-5-5@xhigh');
  assert.equal(routeCacheKey(config, 'medium', 'low'), 'claude-opus-5-5@high');
  assert.equal(routeCacheKey(config, 'low', 'max'), 'claude-sonnet-5@max');
  assert.equal(routeCacheKey(config, 'low', null), 'claude-sonnet-5');
  assert.equal(routeCacheKey(config, 'micro', 'high'), 'claude-haiku-4-5');
});

test('a cold candidate pays the full write, a warm one reads its prefix', () => {
  const facts = memory(served('claude-sonnet-5', { tokens: 100_000, output: 0, ttl: '1h', at: T0 }));
  const now = T0 + 1_000;
  assert.equal(nextContextTokens(facts), 100_000);
  near(inputCostUsd(config, 'low', 100_000, facts, now), 0.02);
  near(inputCostUsd(config, 'high', 100_000, facts, now), 0.8);
  near(coldWriteUsd(config, 'haiku', 100_000, facts), 0.2);
});

test('switching tax is the difference of input costs and can be negative when the candidate is warm', () => {
  const opus = served('claude-opus-5-5', { tokens: 100_000, output: 0, ttl: '1h', at: T0, effort: 'xhigh' });
  const sonnet = served('claude-sonnet-5', { tokens: 100_000, output: 0, ttl: '1h', at: T0 + 1_000 });
  const facts = memory({ ...sonnet, models: { ...opus.models, ...sonnet.models } });
  const now = T0 + 2_000;
  // Warm Opus 5.5 reads at 0.20/M, warm Sonnet 5 also at 0.20/M: no switching tax.
  near(switchingTaxUsd(config, 'high', 'low', facts, now), 0);
  const cold = memory(served('claude-sonnet-5', { tokens: 100_000, output: 0, ttl: '1h', at: T0 }));
  assert.ok(switchingTaxUsd(config, 'micro', 'low', cold, now) > 0);
});

// Regression: before 0.6.1 the cache was keyed by the model alone, so medium <-> high looked free.
test('an effort change on the same model pays for a new messages cache', () => {
  const facts = memory(served('claude-opus-5-5', { tokens: 100_000, output: 0, ttl: '1h', at: T0, effort: 'xhigh' }));
  near(switchingTaxUsd(config, 'medium', 'high', facts, T0 + 1_000), 0.8 - 0.02);
});

// Context 100k plus 4k of output; Opus at xhigh served the last turn.
const warm = (...entries) =>
  memory({
    lastRequest: entries[0].lastRequest,
    models: Object.assign({}, ...entries.map((e) => e.models)),
  });
const opusTurn = served('claude-opus-5-5', { tokens: 100_000, output: 4_000, ttl: '1h', at: T0, effort: 'xhigh' });
const sonnetTurn = served('claude-sonnet-5', { tokens: 100_000, output: 4_000, ttl: '1h', at: T0 });

for (const { name, candidate, incumbent, facts, next, later, payback } of [
  {
    name: 'a downgrade to a cold model repays its cache write in later turns',
    candidate: 'low',
    incumbent: 'high',
    facts: warm(opusTurn),
    next: 0.416 - 0.0208 - 0.04,
    later: -0.04,
    payback: 9,
  },
  {
    name: 'a downgrade to a warm model is cheaper at once',
    candidate: 'low',
    incumbent: 'high',
    facts: warm(opusTurn, sonnetTurn),
    next: -0.04,
    later: -0.04,
    payback: 0,
  },
  {
    name: 'an upgrade never repays in dollars',
    candidate: 'high',
    incumbent: 'low',
    facts: warm(sonnetTurn),
    next: 0.832 - 0.0208 + 0.04,
    later: 0.04,
    payback: null,
  },
]) {
  test(`shadow economics: ${name}`, () => {
    const s = shadowEconomics(config, candidate, incumbent, facts, T0 + 1_000);
    near(s.nextTurnUsd, next);
    near(s.laterTurnUsd, later);
    assert.equal(s.paybackTurns, payback);
    assert.equal(s.outputTokens, 4_000);
  });
}

test('shadow economics is null when a model has no output price', () => {
  const custom = loadConfig({
    userFile: {
      models: {
        mini: { id: 'mini-1', input: 1, cacheRead: 0.1, contextWindow: 100_000, billing: 'plan', efforts: [] },
      },
      routes: { micro: { model: 'mini' } },
    },
  });
  assert.equal(shadowEconomics(custom, 'micro', 'low', warm(sonnetTurn), T0), null);
});
