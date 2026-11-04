import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { DEFAULTS, loadConfig } from '../lib/config.mjs';
import { isOffPeak, ratesAt } from '../lib/cost.mjs';
import { decide, initialState } from '../lib/policy.mjs';
import { listPrice, PRICE_SOURCES, PRICES } from '../lib/prices.mjs';
import { advice, served, T0 } from './helpers.mjs';

const PROVIDERS = ['deepseek', 'zai', 'minimax', 'mimo', 'kimi'];

test('every price names an official source with the date it was checked', () => {
  for (const [id, { source }] of Object.entries(PRICES)) {
    assert.ok(Object.hasOwn(PRICE_SOURCES, source), id);
    assert.match(PRICE_SOURCES[source].url, /^https:\/\//, id);
    assert.match(PRICE_SOURCES[source].checked, /^\d{4}-\d{2}-\d{2}$/, id);
  }
});

test('every default model, Claude and provider, prices from the price list', () => {
  const models = [DEFAULTS, ...PROVIDERS.map((provider) => loadConfig({ provider }))].flatMap((c) =>
    Object.values(c.models),
  );
  for (const model of models) {
    const { input, output, cacheRead, longContext, offPeak } = model;
    const rates = Object.fromEntries(
      Object.entries({ input, output, cacheRead, longContext, offPeak }).filter(([, v]) => v !== undefined),
    );
    assert.deepEqual(rates, listPrice(model.id), model.id);
  }
  assert.deepEqual(new Set(models.map((m) => m.id)), new Set(Object.keys(PRICES)));
});

// DeepSeek's peak: 01:00-04:00 and 06:00-10:00 UTC, Monday to Friday. 2026-11-02 is a Monday.
const utc = (day, hour, minute = 0) => Date.UTC(2026, 10, day, hour, minute);
test('DeepSeek bills half outside its peak hours and full inside them', () => {
  const flash = loadConfig({ provider: 'deepseek' }).models.flash;
  for (const [name, at, offPeak] of [
    ['Monday 00:59, before the first window', utc(2, 0, 59), true],
    ['Monday 01:00, the first window opens', utc(2, 1), false],
    ['Monday 03:59', utc(2, 3, 59), false],
    ['Monday 04:00, between the windows', utc(2, 4), true],
    ['Friday 09:59, the second window', utc(6, 9, 59), false],
    ['Friday 10:00, the second window closes', utc(6, 10), true],
    ['Saturday 02:00, a weekend', utc(7, 2), true],
    ['Sunday 07:00, a weekend', utc(8, 7), true],
    ['an unknown time is peak, the higher bound', undefined, false],
  ]) {
    assert.equal(isOffPeak(flash, at), offPeak, name);
    const rates = ratesAt(flash, 1000, at);
    const k = offPeak ? 0.5 : 1;
    assert.deepEqual(rates, { input: 0.3 * k, cacheRead: 0.006 * k, output: 1.2 * k }, name);
  }
});

test('a model without off-peak pricing ignores the time, and long-context and off-peak multipliers combine', () => {
  const haiku = DEFAULTS.models.haiku;
  assert.deepEqual(ratesAt(haiku, 1000, utc(7, 2)), ratesAt(haiku, 1000));
  const both = { ...loadConfig({ provider: 'deepseek' }).models.flash, longContext: { above: 100, multiplier: 2 } };
  assert.equal(ratesAt(both, 1000, utc(7, 2)).input, 0.3);
});

test('router.json off-peak settings are checked', () => {
  const file = (offPeak) => ({ userFile: { models: { opus: { offPeak } } } });
  const ok = { multiplier: 0.5, peakDays: [1], peakHoursUtc: [[9, 17]] };
  assert.deepEqual(loadConfig(file(ok)).models.opus.offPeak, ok);
  assert.equal(loadConfig(file(null)).models.opus.offPeak, null);
  for (const [bad, message] of [
    [{ ...ok, multiplier: 0 }, /offPeak.multiplier must be positive/],
    [{ ...ok, peakDays: [7] }, /peakDays must list UTC weekdays/],
    [{ ...ok, peakHoursUtc: [[17, 9]] }, /peakHoursUtc must list/],
    [{ ...ok, peakHoursUtc: [[9, 25]] }, /peakHoursUtc must list/],
    [{ ...ok, holidays: [] }, /holidays is not a known key/],
  ])
    assert.throws(() => loadConfig(file(bad)), message);
});

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
