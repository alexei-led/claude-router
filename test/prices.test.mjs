import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { DEFAULTS, loadConfig } from '../lib/config.mjs';
import { decide, initialState } from '../lib/policy.mjs';
import { advice, served, T0 } from './helpers.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/list-prices.json', import.meta.url), 'utf8'));

test('the price fixture names its source and the date it was checked', () => {
  assert.match(fixture.source, /^Anthropic list prices: https:\/\//);
  assert.match(fixture.checked, /^\d{4}-\d{2}-\d{2}$/);
});

// A price edit in lib/config.mjs must come with a fixture edit: a new source, a new date.
for (const [alias, model] of Object.entries(DEFAULTS.models)) {
  test(`default prices of ${alias} match the checked fixture`, () => {
    const { input, output, cacheRead } = model;
    assert.deepEqual({ input, output, cacheRead }, fixture.models[model.id]);
  });
}

// The failure of a838f7c: Opus cache reads entered at ten times the list price. Sonnet served the last turn and
// Opus at xhigh is still warm from an earlier one, 400k of context; Jev votes twice for high at 0.8.
function upgradeFromSonnet(config, mass) {
  const sonnet = served('claude-sonnet-5', { tokens: 400_000, output: 0, at: T0 });
  const opus = served('claude-opus-5-5', { tokens: 400_000, output: 0, at: T0, effort: 'xhigh' });
  const facts = { lastRoute: 'low', lastRequest: sonnet.lastRequest, models: { ...sonnet.models, ...opus.models } };
  let state = initialState();
  let d;
  for (let i = 0; i < 2; i += 1) {
    d = decide({
      config,
      facts,
      advice: advice('high', { high: mass, low: 1 - mass }),
      state,
      baseline: 'low',
      now: T0 + 1_000,
    });
    state = d.state;
  }
  return d;
}

const right = loadConfig({});
const wrong = loadConfig({ userFile: { models: { opus: { cacheRead: 2 } } } });

test('a tenfold cache-read error holds back an upgrade the right price allows', () => {
  assert.equal(upgradeFromSonnet(right, 0.8).reason, 'upgrade');
  const held = upgradeFromSonnet(wrong, 0.8);
  assert.equal(held.reason, 'upgrade-pending');
  assert.ok(held.estimate.taxUsd > 0.7);
});

test('a price error moves the bar only within its bounds, and a confident jump ignores it', () => {
  const { upgradeBase, upgradeSlope } = wrong.policy;
  const held = upgradeFromSonnet(wrong, 0.8);
  assert.ok(held.estimate.threshold > upgradeBase && held.estimate.threshold < upgradeBase + upgradeSlope);
  assert.equal(upgradeFromSonnet(wrong, 0.96).reason, 'jump');
});
