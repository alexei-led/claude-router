import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig, resolveRoute } from '../lib/config.mjs';
import { switchingTaxUsd } from '../lib/cost.mjs';
import { decide, fitTier, initialState, massAbove, massAtOrBelow } from '../lib/policy.mjs';
import { advice, served, T0 } from './helpers.mjs';

const config = loadConfig({});
const sonnetLow = loadConfig({ userFile: { routes: { low: { model: 'sonnet', effort: null } } } });
const smallMicro = loadConfig({
  userFile: {
    models: {
      tiny: {
        id: 'claude-haiku-4-5',
        input: 1,
        output: 5,
        cacheRead: 0.1,
        contextWindow: 200_000,
        billing: 'plan',
        efforts: [],
      },
    },
    routes: { micro: { model: 'tiny' } },
  },
});
const NOW = T0 + 10_000;

function facts({
  lastRoute = null,
  tokens = 20_000,
  output = 0,
  failure = null,
  servedBy = 'claude-sonnet-5-5',
  effort = null,
  extraModels = {},
} = {}) {
  const m = served(servedBy, { tokens, output, at: T0, effort });
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

function runTurns(f, advices, initial = initialState(), cfg = config) {
  const out = [];
  let state = initial;
  for (const a of advices) {
    const d = decide({ config: cfg, facts: f, advice: a, state, baseline: 'low', now: NOW });
    state = d.state;
    out.push(d);
  }
  return out;
}

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

test('a one-tier switch needs two consecutive votes with enough mass', () => {
  for (const [name, lastRoute, vote, expected] of [
    [
      'upgrade above the incumbent',
      null,
      advice('medium', { medium: 0.9 }),
      [
        ['low', 'upgrade-pending'],
        ['medium', 'upgrade'],
      ],
    ],
    [
      'downgrade with mass',
      'high',
      advice('low', { low: 0.95 }),
      [
        ['high', 'downgrade-pending'],
        ['low', 'downgrade'],
      ],
    ],
    [
      'weak downgrade mass never switches',
      'high',
      advice('low', { low: 0.6, high: 0.4 }),
      [
        ['high', 'downgrade-pending'],
        ['high', 'downgrade-pending'],
      ],
    ],
  ]) {
    const turns = runTurns(facts({ lastRoute }), [vote, vote]);
    assert.deepEqual(
      turns.map((d) => [d.tier, d.reason]),
      expected,
      name,
    );
  }
});

test('before the first measured reply one vote moves up or down; the mass bars and the cash gate still apply', () => {
  const haikuMetered = loadConfig({ userFile: { models: { haiku: { billing: 'credits', input: 10 } } } });
  const history = (historyMeasured, options) => ({ ...facts(options), historyMeasured });
  const up = advice('medium', { medium: 0.9, low: 0.1 });
  const down = advice('low', { low: 0.95, high: 0.05 });
  for (const [name, cfg, f, vote, expected] of [
    ['fresh upgrade', config, history(false, { lastRoute: 'low' }), up, ['medium', 'upgrade']],
    ['fresh downgrade', config, history(false, { lastRoute: 'high' }), down, ['low', 'downgrade']],
    ['measured upgrade', config, history(true, { lastRoute: 'low' }), up, ['low', 'upgrade-pending']],
    ['measured downgrade', config, history(true, { lastRoute: 'high' }), down, ['high', 'downgrade-pending']],
    ['history state not given', config, facts({ lastRoute: 'low' }), up, ['low', 'upgrade-pending']],
    [
      'fresh upgrade below the mass bar',
      config,
      history(false, { lastRoute: 'low' }),
      advice('medium', { medium: 0.6, low: 0.4 }),
      ['low', 'upgrade-pending'],
    ],
    [
      'fresh downgrade below the mass bar',
      config,
      history(false, { lastRoute: 'high' }),
      advice('low', { low: 0.6, high: 0.4 }),
      ['high', 'downgrade-pending'],
    ],
    [
      'fresh upgrade to a cold credits model above the cap',
      metered,
      history(false, { lastRoute: 'low', tokens: 300_000 }),
      up,
      ['low', 'cash-gate'],
    ],
    [
      'fresh downgrade to a cold credits model above the cap',
      haikuMetered,
      history(false, { lastRoute: 'high', tokens: 300_000, servedBy: 'claude-opus-5-5', effort: 'xhigh' }),
      advice('low', { low: 0.99 }),
      ['high', 'cash-gate'],
    ],
  ]) {
    const [d] = runTurns(f, [vote], initialState(), cfg);
    assert.deepEqual([d.tier, d.reason], expected, name);
  }
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

test('a cold metered model above the cash cap is gated, which only a user-billed model can trigger', () => {
  const haikuMetered = loadConfig({ userFile: { models: { haiku: { billing: 'credits', input: 10 } } } });
  const upgrade = advice('high', { high: 0.97 });
  const downgrade = advice('low', { low: 0.99 });
  for (const [name, cfg, f, votes, tier] of [
    [
      'an upgrade from micro routes to the strongest plan tier instead',
      metered,
      facts({ lastRoute: 'micro', tokens: 300_000, servedBy: 'claude-haiku-4-5-20251001' }),
      [upgrade],
      'low',
    ],
    [
      'a downgrade stays on the incumbent',
      haikuMetered,
      facts({ lastRoute: 'high', tokens: 300_000, servedBy: 'claude-opus-5-5', effort: 'xhigh' }),
      [downgrade, downgrade],
      'high',
    ],
    [
      'an escalation stays on the strongest plan tier',
      metered,
      facts({ lastRoute: 'low', tokens: 300_000, failure: { signature: 'sig' } }),
      [null],
      'low',
    ],
  ]) {
    const d = runTurns(f, votes, initialState(), cfg).at(-1);
    assert.deepEqual(
      [d.tier, d.reason, d.estimate],
      [tier, 'cash-gate', { coldUsd: 6, cap: 2, cache: 'unknown' }],
      name,
    );
  }
});

test('a metered model warm at the routed effort passes the cash gate; warm at another effort is still gated', () => {
  const warm = served('claude-opus-5-5', { tokens: 300_000, ttl: '5m', at: T0, effort: 'xhigh' }).models;
  const f = facts({ tokens: 300_000, extraModels: warm });
  const [d] = runTurns(f, [advice('high', { high: 0.97 })], initialState(), metered);
  assert.equal(d.reason, 'jump');
  const otherEffort = served('claude-opus-5-5', { tokens: 300_000, ttl: '5m', at: T0, effort: 'high' }).models;
  const [guarded] = runTurns(
    facts({ tokens: 300_000, extraModels: otherEffort }),
    [advice('high', { high: 0.97 })],
    initialState(),
    metered,
  );
  assert.equal(guarded.reason, 'cash-gate');
});

test('an effort-only upgrade between one model at two efforts pays the tax of rewriting the messages cache', () => {
  const sonnetMedium = loadConfig({
    userFile: { routes: { low: { model: 'sonnet', effort: null }, medium: { model: 'sonnet', effort: 'xhigh' } } },
  });
  const f = facts({ lastRoute: 'low', tokens: 400_000 });
  const votes = [advice('medium', { medium: 0.8, low: 0.2 }), advice('medium', { medium: 0.8, low: 0.2 })];
  const [, second] = runTurns(f, votes, initialState(), sonnetMedium);
  assert.equal(second.reason, 'upgrade-pending');
  assert.ok(second.estimate.taxUsd > 1.5);
  assert.deepEqual(second.estimate.cache, { candidate: 'unknown', incumbent: 'fresh' });
});

test('the default micro to low upgrade is effort-only on Haiku and pays its cache rewrite', () => {
  const f = facts({ lastRoute: 'micro', tokens: 400_000, servedBy: 'claude-haiku-5-5', effort: 'medium' });
  const votes = [advice('low', { low: 0.8, micro: 0.2 }), advice('low', { low: 0.8, micro: 0.2 })];
  const [, second] = runTurns(f, votes);
  assert.deepEqual([second.tier, second.reason], ['low', 'upgrade']);
  assert.deepEqual(second.estimate.cache, { candidate: 'unknown', incumbent: 'fresh' });
  assert.ok(second.estimate.taxUsd > 0);
  assert.ok(second.estimate.threshold > config.policy.upgradeBase);
});

test('a downgrade to a candidate colder than the incumbent raises the bar by its cache write, as an upgrade tax does', () => {
  const votes = [advice('low', { low: 0.92, high: 0.08 }), advice('low', { low: 0.92, high: 0.08 })];

  const sonnetWarmOpusCold = facts({ lastRoute: 'high', servedBy: 'claude-sonnet-5-5' });
  const [, warm] = runTurns(sonnetWarmOpusCold, votes, initialState(), sonnetLow);
  assert.equal(warm.reason, 'downgrade');
  assert.equal(warm.estimate.threshold, config.policy.downgradeMass);

  const coldCandidate = facts({ lastRoute: 'high', servedBy: 'claude-opus-5-5', effort: 'xhigh', tokens: 100_000 });
  const [, cold] = runTurns(coldCandidate, votes, initialState(), sonnetLow);
  assert.equal(cold.reason, 'downgrade-pending');
  assert.ok(cold.estimate.threshold > config.policy.downgradeMass);
  assert.ok(cold.estimate.taxUsd > 0);
});

const opusWarm = { lastRoute: 'high', servedBy: 'claude-opus-5-5', effort: 'xhigh', tokens: 100_000, output: 4_000 };
const sonnetWarm = served('claude-sonnet-5-5', { tokens: 100_000, output: 4_000, at: T0 }).models;
const unpriced = (fields = {}) =>
  loadConfig({
    userFile: {
      models: {
        mini: {
          id: 'mini-1',
          input: 1,
          cacheRead: 0.1,
          contextWindow: 200_000,
          billing: 'plan',
          efforts: [],
          ...fields,
        },
      },
      routes: { micro: { model: 'mini' } },
    },
  });

for (const { name, cfg = config, candidate, f = facts(opusWarm), want } of [
  {
    name: 'a warm candidate keeps the base bar',
    cfg: sonnetLow,
    candidate: 'low',
    f: facts({ ...opusWarm, extraModels: sonnetWarm }),
    want: 'base',
  },
  {
    name: 'equal output prices keep the bar without output savings',
    cfg: loadConfig({
      userFile: { models: { sonnet: { output: 20 } }, routes: { low: { model: 'sonnet', effort: null } } },
    }),
    candidate: 'low',
    want: 'without-output-savings',
  },
  { name: 'cheaper output lowers a cold bar', cfg: sonnetLow, candidate: 'low', want: 'lower' },
  { name: 'much cheaper output lowers a cold bar to the base', candidate: 'micro', want: 'base' },
  {
    name: 'a missing output price keeps the bar without output savings',
    cfg: unpriced(),
    candidate: 'micro',
    want: 'without-output-savings',
  },
  {
    name: 'a zero output price keeps the bar without output savings',
    cfg: unpriced({ output: 0 }),
    candidate: 'micro',
    want: 'without-output-savings',
  },
]) {
  test(`downgrade bar from warm Opus at xhigh: ${name}`, () => {
    const p = cfg.policy;
    const bar = (tax) => p.downgradeMass + p.downgradeSlope * (tax / (tax + p.downgradePivotUsd));
    const withoutOutputSavings = bar(
      Math.max(0, switchingTaxUsd(cfg, resolveRoute(cfg, candidate), resolveRoute(cfg, 'high'), f, NOW)),
    );
    const [d] = runTurns(f, [advice(candidate, { [candidate]: 1 })], initialState(), cfg);
    const { threshold } = d.estimate;
    assert.ok(threshold >= p.downgradeMass);
    if (want === 'base') assert.equal(threshold, p.downgradeMass);
    if (want === 'without-output-savings') assert.equal(threshold, withoutOutputSavings);
    if (want === 'lower') assert.ok(threshold > p.downgradeMass && threshold < withoutOutputSavings);
  });
}

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

test('escalation goes where escalateTo points; with no target the failure is not consumed', () => {
  const failing = facts({ lastRoute: 'low', failure: { signature: 'sig', index: 9 } });
  const vote = advice('low', { low: 1 });
  for (const [name, escalateTo, tier, reason, signature] of [
    ['one tier up by default', undefined, 'medium', 'escalation', 'sig'],
    ['a chosen tier', () => 'high', 'high', 'escalation', 'sig'],
    ['no tier helps', () => null, 'low', 'same-tier', null],
  ]) {
    const d = decide({
      config,
      facts: failing,
      advice: vote,
      state: initialState(),
      baseline: 'low',
      now: NOW,
      escalateTo,
    });
    assert.deepEqual([d.tier, d.reason, d.state.escalatedSignature], [tier, reason, signature], name);
  }
});

test('fitTier climbs past models whose window the context would overflow', () => {
  const cases = [
    { tier: 'micro', tokens: 100_000, want: 'micro' },
    { tier: 'micro', tokens: 170_000, want: 'low' },
    { tier: 'high', tokens: 900_000, want: 'high' },
  ];
  for (const { tier, tokens, want } of cases)
    assert.equal(fitTier(smallMicro, tier, tokens), want, `${tier} @ ${tokens}`);
});

test('fitTier looks down, then to the largest window, when no higher route fits', () => {
  const cfg = loadConfig({
    userFile: {
      models: { tiny: { ...smallMicro.models.tiny } },
      routes: { high: { model: 'tiny' }, medium: { model: 'tiny' }, micro: { model: 'tiny' } },
    },
  });
  assert.equal(fitTier(cfg, 'high', 500_000), 'low');
  assert.equal(fitTier(cfg, 'micro', 5_000_000), 'low');
});
