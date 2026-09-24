import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../lib/config.mjs';
import { decide, fitTier, initialState, massAbove, massAtOrBelow } from '../lib/policy.mjs';
import { advice, served, T0 } from './helpers.mjs';

const config = loadConfig({});
const NOW = T0 + 10_000;

function facts({
  lastRoute = null,
  tokens = 20_000,
  failure = null,
  servedBy = 'claude-sonnet-5',
  effort = null,
  extraModels = {},
} = {}) {
  const m = served(servedBy, { tokens, output: 0, at: T0, effort });
  return {
    lastRoute,
    lastRequest: m.lastRequest,
    models: { ...m.models, ...extraModels },
    failure,
    continuation: false,
    prompt: 'x',
    turns: [],
  };
}

function runTurns(f, advices, state = initialState(), cfg = config) {
  const out = [];
  for (const a of advices) {
    const d = decide({ config: cfg, facts: f, advice: a, state, baseline: 'low', now: NOW });
    state = d.state;
    out.push(d);
  }
  return out;
}

// No default model bills credits, so the cash gate is inert until a user adds one in router.json.
const metered = loadConfig({ userFile: { models: { opus: { billing: 'credits', input: 10 } } } });

test('mass helpers exclude uncertain', () => {
  const p = { micro: 0.1, low: 0.2, medium: 0.3, high: 0.3, uncertain: 0.1 };
  assert.ok(Math.abs(massAbove(p, 'low') - 0.6) < 1e-9);
  assert.ok(Math.abs(massAtOrBelow(p, 'low') - 0.3) < 1e-9);
});

test('no advice or uncertain keeps the incumbent', () => {
  assert.equal(runTurns(facts(), [null])[0].tier, 'low');
  const d = runTurns(facts({ lastRoute: 'high' }), [advice('uncertain', { uncertain: 1 })])[0];
  assert.equal(d.tier, 'high');
  assert.equal(d.reason, 'uncertain');
});

test('continuation inherits the route and adds no vote', () => {
  const d = runTurns(facts({ lastRoute: 'high' }), [advice('micro', { micro: 0.95 }, { continuation: 0.9 })])[0];
  assert.equal(d.tier, 'high');
  assert.equal(d.reason, 'continuation');
  assert.equal(d.state.votes.length, 0);
});

test('one-tier upgrade needs two consecutive votes above the incumbent', () => {
  const [first, second] = runTurns(facts(), [advice('medium', { medium: 0.9 }), advice('medium', { medium: 0.9 })]);
  assert.equal(first.reason, 'upgrade-pending');
  assert.equal(first.tier, 'low');
  assert.equal(second.reason, 'upgrade');
  assert.equal(second.tier, 'medium');
});

test('a two-tier jump with high mass switches at once', () => {
  const [d] = runTurns(facts(), [advice('high', { high: 0.96 })]);
  assert.equal(d.reason, 'jump');
  assert.equal(d.tier, 'high');
});

test('the upgrade threshold rises with the switching tax', () => {
  const votes = [advice('medium', { medium: 0.8, low: 0.2 }), advice('medium', { medium: 0.8, low: 0.2 })];
  assert.equal(runTurns(facts({ tokens: 10_000 }), votes)[1].reason, 'upgrade');
  const [, pending] = runTurns(facts({ tokens: 400_000 }), votes);
  assert.equal(pending.reason, 'upgrade-pending');
  assert.ok(pending.estimate.threshold > 0.8);
});

test('a cold metered model above the cash cap routes to the strongest plan tier instead', () => {
  const [d] = runTurns(facts({ tokens: 300_000 }), [advice('high', { high: 0.97 })], initialState(), metered);
  assert.equal(d.reason, 'cash-gate');
  assert.equal(d.tier, 'low');
  assert.ok(d.estimate.coldUsd > metered.policy.cashCapUsd);
  assert.equal(d.estimate.cache, 'unknown');
});

test('a warm metered model passes the cash gate even when a cold write would not', () => {
  // 300k at $10/M with the 5m write multiplier: $3.75 cold, above the $2 cap. The warm cache of high's effort passes.
  const warm = served('claude-opus-5-5', { tokens: 300_000, ttl: '5m', at: T0, effort: 'xhigh' }).models;
  const f = facts({ tokens: 300_000, extraModels: warm });
  const [d] = runTurns(f, [advice('high', { high: 0.97 })], initialState(), metered);
  assert.equal(d.reason, 'jump');
  // Warm at another effort is another cache: the guard still applies.
  const otherEffort = served('claude-opus-5-5', { tokens: 300_000, ttl: '5m', at: T0, effort: 'high' }).models;
  const [guarded] = runTurns(
    facts({ tokens: 300_000, extraModels: otherEffort }),
    [advice('high', { high: 0.97 })],
    initialState(),
    metered,
  );
  assert.equal(guarded.reason, 'cash-gate');
});

// Regression: medium and high are one model at two efforts; the switch rewrites the messages cache.
test('an effort-only upgrade pays the switching tax of a new messages cache', () => {
  const f = facts({ lastRoute: 'medium', servedBy: 'claude-opus-5-5', effort: 'high', tokens: 400_000 });
  const votes = [advice('high', { high: 0.8, medium: 0.2 }), advice('high', { high: 0.8, medium: 0.2 })];
  const [, second] = runTurns(f, votes);
  assert.equal(second.reason, 'upgrade-pending');
  assert.ok(second.estimate.taxUsd > 3);
  assert.deepEqual(second.estimate.cache, { candidate: 'unknown', incumbent: 'warm' });
});

test('downgrade needs mass and two consecutive votes', () => {
  const [a, b] = runTurns(facts({ lastRoute: 'high' }), [advice('low', { low: 0.95 }), advice('low', { low: 0.95 })]);
  assert.equal(a.reason, 'downgrade-pending');
  assert.equal(a.tier, 'high');
  assert.equal(b.reason, 'downgrade');
  assert.equal(b.tier, 'low');
});

test('weak downgrade mass never switches', () => {
  const [, b] = runTurns(facts({ lastRoute: 'high' }), [
    advice('low', { low: 0.6, high: 0.4 }),
    advice('low', { low: 0.6, high: 0.4 }),
  ]);
  assert.equal(b.reason, 'downgrade-pending');
});

// Regression: a downgrade is not always cheaper this turn. A candidate colder than the incumbent pays a cache
// write the confidence bar must account for, the same way an upgrade's tax raises its bar.
test('the downgrade bar rises when the candidate is colder than the incumbent', () => {
  const votes = [advice('low', { low: 0.92, high: 0.08 }), advice('low', { low: 0.92, high: 0.08 })];

  const warmCandidate = facts({ lastRoute: 'high' }); // default servedBy: sonnet (low) is warm, opus (high) is not
  const [, warm] = runTurns(warmCandidate, votes);
  assert.equal(warm.reason, 'downgrade');
  assert.equal(warm.estimate.threshold, config.policy.downgradeMass);

  const coldCandidate = facts({ lastRoute: 'high', servedBy: 'claude-opus-5-5', effort: 'xhigh', tokens: 100_000 });
  const [, cold] = runTurns(coldCandidate, votes);
  assert.equal(cold.reason, 'downgrade-pending');
  assert.ok(cold.estimate.threshold > config.policy.downgradeMass);
  assert.ok(cold.estimate.taxUsd > 0);
});

test('repeated failure escalates one tier and holds, once per signature', () => {
  const failing = facts({ failure: { signature: 'error: tests failed', index: 9 } });
  const turns = runTurns(failing, [
    advice('micro', { micro: 1 }),
    advice('micro', { micro: 1 }),
    advice('micro', { micro: 1 }),
    advice('micro', { micro: 1 }),
  ]);
  assert.deepEqual(
    turns.slice(0, 3).map((t) => t.reason),
    ['escalation', 'hold', 'hold'],
  );
  assert.notEqual(turns[3].reason, 'hold');
  assert.equal(turns[3].state.escalatedSignature, 'error: tests failed');
  assert.equal(turns[0].tier, 'medium');
});

test('fitTier climbs past models whose window the context would overflow', () => {
  const cases = [
    { tier: 'micro', tokens: 100_000, want: 'micro' }, // Haiku 200K holds it
    { tier: 'micro', tokens: 170_000, want: 'low' }, // above 80% of Haiku's window
    { tier: 'high', tokens: 900_000, want: 'high' },
  ];
  for (const { tier, tokens, want } of cases) assert.equal(fitTier(config, tier, tokens), want, `${tier} @ ${tokens}`);
});

test('fitTier looks down, then to the largest window, when no higher route fits', () => {
  const cfg = loadConfig({ userFile: { routes: { high: { model: 'haiku' }, medium: { model: 'haiku' } } } });
  assert.equal(fitTier(cfg, 'high', 500_000), 'low');
  assert.equal(fitTier(cfg, 'micro', 5_000_000), 'low');
});
