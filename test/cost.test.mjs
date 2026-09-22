import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../lib/config.mjs';
import { coldWriteUsd, inputCostUsd, isWarm, nextContextTokens, switchingTaxUsd } from '../lib/cost.mjs';
import { memory, served, T0 } from './helpers.mjs';

const config = loadConfig({});

test('warmth follows the granted ttl minus the margin', () => {
  const state = { lastAt: T0, ttl: '5m' };
  assert.ok(isWarm(state, T0 + 200_000, config.cache));
  assert.ok(!isWarm(state, T0 + 280_000, config.cache));
  assert.ok(!isWarm(undefined, T0, config.cache));
});

test('a cold candidate pays the full write, a warm one reads its prefix', () => {
  const facts = memory(served('claude-sonnet-4-6', { tokens: 100_000, output: 0, ttl: '1h', at: T0 }));
  const now = T0 + 1_000;
  assert.equal(nextContextTokens(facts), 100_000);
  assert.ok(Math.abs(inputCostUsd(config, 'sonnet', 100_000, facts, now) - 0.03) < 1e-9);
  assert.equal(inputCostUsd(config, 'opus', 100_000, facts, now), 1);
  assert.equal(coldWriteUsd(config, 'fable', 100_000, facts), 1.25);
});

test('switching tax is the difference of input costs and can be negative when the candidate is warm', () => {
  const opus = served('claude-opus-5', { tokens: 100_000, output: 0, ttl: '1h', at: T0 });
  const sonnet = served('claude-sonnet-4-6', { tokens: 100_000, output: 0, ttl: '1h', at: T0 + 1_000 });
  const facts = memory({ ...sonnet, models: { ...opus.models, ...sonnet.models } });
  const now = T0 + 2_000;
  assert.ok(Math.abs(switchingTaxUsd(config, 'opus', 'sonnet', facts, now) - 0.02) < 1e-9);
  const cold = memory(served('claude-sonnet-4-6', { tokens: 100_000, output: 0, ttl: '1h', at: T0 }));
  assert.ok(switchingTaxUsd(config, 'haiku', 'sonnet', cold, now) > 0);
});
