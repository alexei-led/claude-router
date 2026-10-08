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

for (const [alias, model] of Object.entries(DEFAULTS.models)) {
  test(`default prices of ${alias} match the checked fixture, so a price edit needs a new source and date`, () => {
    const { input, output, cacheRead } = model;
    assert.deepEqual({ input, output, cacheRead }, fixture.models[model.id]);
  });
}

function twoHighVotesFromSonnetWithOpusWarm(config, mass) {
  const sonnet = served('claude-sonnet-5-5', { tokens: 400_000, output: 0, at: T0 });
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

test('a tenfold Opus cache-read price, the a838f7c failure, holds back an upgrade the right price allows', () => {
  assert.equal(twoHighVotesFromSonnetWithOpusWarm(right, 0.8).reason, 'upgrade');
  const held = twoHighVotesFromSonnetWithOpusWarm(wrong, 0.8);
  assert.equal(held.reason, 'upgrade-pending');
  assert.ok(held.estimate.taxUsd > 0.7);
});

test('a price error moves the bar only within its bounds, and a confident jump ignores it', () => {
  const { upgradeBase, upgradeSlope } = wrong.policy;
  const held = twoHighVotesFromSonnetWithOpusWarm(wrong, 0.8);
  assert.ok(held.estimate.threshold > upgradeBase && held.estimate.threshold < upgradeBase + upgradeSlope);
  assert.equal(twoHighVotesFromSonnetWithOpusWarm(wrong, 0.96).reason, 'jump');
});

const efforts = JSON.parse(readFileSync(new URL('./fixtures/effort-support.json', import.meta.url), 'utf8'));

test('the effort fixture names its method and the date it was checked', () => {
  assert.match(efforts.source, /^Live probe: /);
  assert.match(efforts.checked, /^\d{4}-\d{2}-\d{2}$/);
});

for (const [alias, model] of Object.entries(DEFAULTS.models)) {
  test(`default efforts of ${alias} match the levels the live API accepted, which clampEffort relies on`, () => {
    assert.deepEqual(model.efforts, efforts.models[model.id]);
  });
}
