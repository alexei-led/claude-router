import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  advanceDemand,
  assessCandidates,
  decideMove,
  initialAutoState,
  initialIncumbentState,
  proposeAutoRoute,
  selectTarget,
} from '../lib/auto-engine.mjs';
import { loadConfig, TIERS } from '../lib/config.mjs';
import * as costs from '../lib/cost.mjs';
import { advice, T0 } from './helpers.mjs';

const route = (model, effort = null) => ({ model, effort });
function model(capability = 2, input = 1, extra = {}) {
  return {
    id: 'test-model',
    input,
    cacheRead: input / 10,
    output: input * 2,
    contextWindow: 100_000,
    efforts: [],
    billing: 'plan',
    ...(capability === null ? {} : { capability: { default: capability } }),
    ...extra,
  };
}
function config(models = { a: model(1), b: model(2, 2), c: model(3, 3) }, extra = {}) {
  const base = loadConfig({});
  return {
    ...base,
    models: Object.fromEntries(Object.entries(models).map(([alias, spec]) => [alias, { ...spec, id: alias }])),
    cache: { ...base.cache, mode: 'disabled' },
    ...extra,
  };
}
const facts = (extra = {}) => ({
  contextTokens: 1000,
  historyMeasured: true,
  models: {},
  effort: null,
  downAllowed: true,
  dwellAllowed: true,
  lastRequest: { tokens: 1000, outputTokens: 0 },
  ...extra,
});
function run(extra = {}) {
  return proposeAutoRoute({
    config: config(),
    state: initialAutoState({ demand: 1 }),
    incumbent: route('a'),
    facts: facts(),
    advice: null,
    now: T0,
    ...extra,
  });
}
function targetFor(cfg, demand, mode = 'balanced', extra = {}) {
  const candidates = assessCandidates({ config: cfg, incumbent: route('a'), facts: facts(), now: T0, ...extra });
  return { candidates, target: selectTarget({ candidates, demand, mode, ...extra }) };
}
function moveFor({
  cfg = config(),
  raw = 2,
  level = raw,
  routed = 1,
  current = 'a',
  target = 'b',
  a = advice('medium', { medium: 1 }),
  f = facts(),
  changeCause = null,
  stateExtra = {},
  escalated = false,
} = {}) {
  const candidates = assessCandidates({ config: cfg, incumbent: route(current), facts: f, now: T0 });
  const proposed = candidates.find((c) => c.route.model === target);
  const state = { ...initialAutoState({ demand: raw, routedDemand: routed }), turn: 20, ...stateExtra };
  return decideMove({
    config: cfg,
    state,
    demandResult: { raw, level, escalated },
    target: { route: proposed.route, capability: proposed.capability, estimate: proposed.estimate },
    candidates,
    advice: a,
    facts: f,
    now: T0,
    changeCause,
  });
}

test('first routed quality decision fits a known incumbent through the startup explicit-up gate', () => {
  for (const raw of [0, 1]) {
    const cfg = config({ a: model(raw), b: model(2, 2) }, { baselineTier: TIERS[raw] });
    const result = run({
      config: cfg,
      state: undefined,
      startup: true,
      mode: 'quality',
      advice: advice(TIERS[raw], { [TIERS[raw]]: 1 }),
    });
    assert.equal(result.target.requirement, raw + 0.5);
    assert.equal(result.demand.raw, raw);
    assert.equal(result.move.reason, 'startup');
    assert.equal(result.move.move, true);
    assert.equal(result.move.evidence.mass, 1);
    assert.equal(result.state.routeCause, 'startup');
    assert.equal(result.state.routedDemand, raw);
  }
});

test('startup requires explicit history eligibility, known incumbent and a declared qualifying target', () => {
  for (const [models, startup] of [
    [{ a: model(1), b: model(2, 2) }, false],
    [{ a: model(1), b: model(2, 2) }, undefined],
    [{ a: model(null), b: model(2, 2) }, true],
    [{ a: model(1), b: model(1, 2) }, true],
    [{ a: model(1), b: model(null, 2) }, true],
  ]) {
    const result = run({
      config: config(models, { baselineTier: 'low' }),
      state: undefined,
      startup,
      mode: 'quality',
      advice: advice('low', { low: 1 }),
    });
    assert.equal(result.move.move, false);
    assert.notEqual(result.state.routeCause, 'startup');
  }
});

test('startup precedes classifier move mass, while later moves retain the unchanged base gate', () => {
  const cfg = config({ a: model(0), b: model(2, 2) }, { baselineTier: 'low' });
  for (const [startup, probabilities, reason, mass] of [
    [true, { micro: 0.2, low: 0.57, medium: 0.13, high: 0.1 }, 'startup', 1],
    [true, { micro: 0.43, low: 0.57 }, 'startup', 1],
    [false, { micro: 0.2, low: 0.57, medium: 0.13, high: 0.1 }, 'upgrade', 0.8],
    [false, { micro: 0.43, low: 0.57 }, 'upgrade-pending', 0.57],
  ]) {
    const result = run({
      config: cfg,
      state: undefined,
      startup,
      advice: advice('low', probabilities),
    });
    assert.equal(result.move.reason, reason);
    assert.ok(Math.abs(result.move.evidence.mass - mass) < 1e-10);
    assert.ok(result.move.evidence.threshold >= cfg.policy.upgradeBase);
    assert.ok(result.move.evidence.threshold < 0.8);
    assert.equal(cfg.policy.upgradeBase, 0.75);
  }
  const down = run({
    config: config({ a: model(1), b: model(2, 2) }, { baselineTier: 'low' }),
    state: { ...initialAutoState({ demand: 1, routedDemand: 2 }), turn: 5 },
    startup: false,
    mode: 'quality',
    advice: advice('low', { micro: 0.43, low: 0.57 }),
    facts: facts({ dwellAllowed: false }),
  });
  assert.equal(down.move.reason, 'dwell-held');
  assert.equal(down.move.evidence.mass, 1);
  const taxed = config(
    { a: model(1), b: model(2, 2) },
    {
      baselineTier: 'low',
      cache: { ...cfg.cache, mode: 'explicit', effortScope: 'separate' },
      policy: { ...cfg.policy, upgradeBase: 1 },
    },
  );
  const blocked = run({
    config: taxed,
    state: undefined,
    startup: true,
    mode: 'quality',
    advice: advice('low', { low: 1 }),
  });
  assert.equal(blocked.move.move, false);
  assert.equal(blocked.move.reason, 'upgrade-pending');
  assert.equal(blocked.move.evidence.mass, 1);
  assert.ok(blocked.move.evidence.threshold > 1);
});

test('startup uses the existing effective requirement without cancelling the accepted execute discount', () => {
  const result = run({
    config: config({ a: model(1), b: model(2, 2) }, { baselineTier: 'low' }),
    state: undefined,
    startup: true,
    mode: 'quality',
    boundedExecute: true,
    advice: advice('low', { low: 1 }),
  });
  assert.equal(result.demand.raw, 1);
  assert.equal(result.demand.level, 0.5);
  assert.equal(result.target.requirement, 1);
  assert.equal(result.move.reason, 'same-route');
  assert.equal(result.move.move, false);
  assert.equal(result.state.routeCause, 'classifier');
  assert.equal(result.state.routedDemand, 0.5);
});

test('startup never restores a target rejected by hard constraints or cash cap', () => {
  for (const overrides of [
    { availableModels: ['a'] },
    { facts: facts({ hasImages: true }), target: { imageInput: false } },
    { facts: facts({ contextTokens: 95000 }), target: { contextWindow: 100000 } },
    { facts: facts({ historyMeasured: false }), target: { contextWindow: 50000 } },
    { target: { billing: 'credits', input: 100000 }, policy: { cashCapUsd: 0 } },
  ]) {
    const cfg = config(
      { a: model(1, 1, { contextWindow: 200000 }), b: model(2, 2, overrides.target) },
      { baselineTier: 'low' },
    );
    if (overrides.policy) cfg.policy = { ...cfg.policy, ...overrides.policy };
    const result = run({
      config: cfg,
      state: undefined,
      startup: true,
      mode: 'quality',
      advice: advice('low', { low: 1 }),
      facts: overrides.facts ?? facts(),
      availableModels: overrides.availableModels,
    });
    assert.equal(result.move.move, false);
    assert.notEqual(result.move.reason, 'startup');
    assert.equal(result.candidates.find((c) => c.route.model === 'b').eligible, false);
  }
});

test('first proposal seeds accepted demand from the actual supported incumbent capability, not baseline', () => {
  const cfg = config(
    {
      a: model(0, 1, { efforts: ['low', 'high'], capability: { low: 0, high: 2 } }),
    },
    { baselineTier: 'low' },
  );
  const result = run({
    config: cfg,
    state: undefined,
    incumbent: route('a', 'low'),
    advice: advice('low', { micro: 0.2, low: 0.57, medium: 0.13, high: 0.1 }),
  });
  assert.equal(result.demand.raw, 1);
  assert.equal(result.demand.state.routedDemand, 0);
  assert.equal(result.move.reason, 'upgrade');
  assert.deepEqual(result.move.route, route('a', 'high'));
  assert.ok(Math.abs(result.move.evidence.mass - 0.8) < Number.EPSILON);
  assert.equal(result.state.routedDemand, 1);

  const weak = run({
    config: cfg,
    state: undefined,
    incumbent: route('a', 'low'),
    advice: advice('low', { micro: 0.43, low: 0.57 }),
  });
  assert.equal(weak.move.reason, 'upgrade-pending');
  assert.equal(weak.state.routedDemand, 0);
  assert.equal(weak.move.evidence.threshold, cfg.policy.upgradeBase);
});

test('startup uses known half-step capability and never guesses unresolved or unsupported native effort', () => {
  const cfg = config(
    {
      a: model(0, 1, { efforts: ['low', 'high'], capability: { low: 0, high: 2.5 } }),
      b: model(null, 2),
    },
    { baselineTier: 'low' },
  );
  for (const [incumbent, effort, expected] of [
    [route('a', 'high'), null, 2.5],
    [route('a'), 'low', 0],
    [route('a'), null, 1],
    [route('a', 17), 17, 1],
    [route('a', 'max'), null, 1],
    [route('b'), null, 1],
    [route('unlisted'), null, 1],
  ]) {
    const result = run({ config: cfg, state: undefined, incumbent, facts: facts({ effort }), pin: 'low' });
    assert.equal(result.state.demand, 1);
    assert.equal(result.state.routedDemand, expected);
    assert.equal(result.state.turn, 0);
    assert.deepEqual(result.state.votes, []);
    assert.equal(result.state.holdUntilTurn, 0);
  }
});

test('external reentry bypasses evidence and dwell but preserves hold and every eligibility filter', () => {
  for (const availableModels of [undefined, [], ['a'], ['b']]) {
    const state = { ...initialAutoState({ demand: 2, routedDemand: 2 }), holdUntilTurn: 9 };
    const result = run({
      state,
      incumbentOrigin: 'external-fallback',
      availableModels,
      facts: facts({ downAllowed: false, dwellAllowed: false }),
    });
    assert.equal(result.state.holdUntilTurn, 9);
    if (availableModels?.length === 0) {
      assert.equal(result.move.reason, 'no-route');
      assert.equal(result.move.route, null);
    } else if (availableModels?.[0] === 'a') {
      assert.equal(result.move.reason, 'same-route');
      assert.equal(result.move.move, false);
    } else {
      assert.equal(result.move.reason, 'reentry');
      assert.deepEqual(result.move.route, route('b'));
      assert.equal(result.state.routeCause, 'reentry');
      assert.equal(result.state.routedDemand, result.demand.level);
    }
  }
});

test('known token lower bounds reject oversized candidates without a fresh context estimate', () => {
  for (const incumbent of [route('a'), route('unlisted-native')]) {
    const cfg = config({ a: model(1, 1, { contextWindow: 1_000_000 }), b: model(3, 2, { contextWindow: 200_000 }) });
    const result = run({
      config: cfg,
      incumbent,
      contextKnown: false,
      facts: facts({
        contextTokens: null,
        historyMeasured: true,
        lastRequest: { tokens: 900_000, outputTokens: 1000 },
      }),
    });
    assert.equal(result.target.outcome, 'no-route');
    assert.equal(result.move.route, null);
    assert.ok(result.candidates.filter((c) => c.selectable).every((c) => c.reasons.includes('context-full')));
  }
});

test('demand has no price, cache, physical incumbent, mode-policy or dwell dependency', () => {
  const a = advice('medium', { medium: 0.8, low: 0.2 });
  const cfg = config();
  const state = initialAutoState({ demand: 1 });
  const first = advanceDemand({ config: cfg, state, advice: a, facts: facts({ downAllowed: false }) });
  assert.equal(first.raw, 1);
  const expected = advanceDemand({ config: cfg, state: first.state, advice: a, facts: facts() });
  assert.equal(expected.raw, 2);
  const altered = {
    ...cfg,
    models: { a: model(null, 1e9) },
    cache: { ...cfg.cache, mode: 'automatic' },
    modes: { quality: { policy: { upgradeVotes: 999, upgradeBase: 1 } } },
  };
  for (const mode of ['cost', 'balanced', 'quality']) {
    const result = run({ config: altered, state: first.state, advice: a, mode, facts: facts({ downAllowed: false }) });
    assert.deepEqual(result.demand, expected, mode);
  }
  assert.equal(state.turn, 0);
  assert.deepEqual(state.votes, []);
});

test('raw demand votes, zero-tax mass bars, jump and fresh-history exception', () => {
  for (const [name, start, choice, probabilities, historyMeasured, turns, expected] of [
    ['upgrade two votes', 1, 'medium', { medium: 0.75 }, true, 2, 2],
    ['upgrade low mass', 1, 'medium', { medium: 0.749 }, true, 3, 1],
    ['jump', 0, 'high', { high: 0.95 }, true, 1, 3],
    ['fresh', 1, 'medium', { medium: 0.75 }, false, 1, 2],
    ['downgrade', 3, 'low', { low: 0.9 }, true, 2, 1],
    ['split downgrade supported middle', 3, 'micro', { micro: 0.7, low: 0.21 }, true, 2, 1],
    ['weak downgrade', 3, 'low', { low: 0.899 }, true, 3, 3],
    ['uncertain', 1, 'uncertain', { uncertain: 1 }, true, 3, 1],
  ]) {
    let state = initialAutoState({ demand: start });
    for (let i = 0; i < turns; i += 1)
      state = advanceDemand({
        config: config(),
        state,
        advice: advice(choice, probabilities),
        facts: facts({ historyMeasured }),
      }).state;
    assert.equal(state.demand, expected, name);
  }
});

test('only an accepted bounded execute discount affects effective demand, never accumulates', () => {
  for (const raw of [0, 1, 2, 3]) {
    let state = initialAutoState({ demand: raw });
    for (let turn = 0; turn < 3; turn += 1) {
      const d = advanceDemand({ config: config(), state, advice: null, facts: facts(), boundedExecute: true });
      assert.equal(d.raw, raw);
      assert.equal(d.level, Math.max(0, raw - 0.5));
      state = d.state;
    }
    assert.equal(advanceDemand({ config: config(), state, facts: facts() }).level, raw);
  }
  const d = run({
    boundedExecute: false,
    advice: { ...advice('low', { low: 1 }), activity: { choice: 'ops' }, phase: { choice: 'verify' } },
  });
  assert.equal(d.demand.level, 1);
});

test('repeated failures advance demand to headroom without stale-occurrence re-escalation', () => {
  const cfg = config({ a: model(2.5), b: model(3, 10) });
  let state = initialAutoState({ demand: 0 });
  let incumbent = route('a');
  for (const [index, expected, headroom] of [
    [10, 1, false],
    [11, 2, true],
    [12, 3, true],
    [13, 3, true],
  ]) {
    const f = facts({ failure: { signature: 'same-error', index }, downAllowed: false });
    const result = run({ config: cfg, state, incumbent, facts: f });
    assert.equal(result.demand.raw, expected);
    assert.equal(result.demand.headroom, headroom);
    assert.equal(result.demand.escalated, true);
    state = result.state;
    incumbent = result.move.route;
    const stale = run({ config: cfg, state, incumbent, facts: f });
    assert.equal(stale.demand.escalated, false);
    assert.equal(stale.demand.raw, expected);
  }
  assert.deepEqual(incumbent, route('b'));
  assert.equal(state.routeCause, 'escalation');
  assert.equal(state.routedDemand, 1);
});

test('max demand failure takes strongest declared eligible pair, not cheapest adequate or unknown', () => {
  const cfg = config({
    a: model(2.5),
    b: model(3, 10),
    unknown: model(null, 0.01),
    filtered: model(3, 0.001, { imageInput: false }),
  });
  const result = run({
    config: cfg,
    state: initialAutoState({ demand: 3 }),
    facts: facts({ failure: { signature: 'x', index: 4 }, hasImages: true }),
  });
  assert.equal(result.target.route.model, 'b');
  assert.equal(result.move.reason, 'escalation');
  assert.equal(result.move.move, true);
  assert.equal(result.demand.state.routedDemand, 3);
});

test('failure hold precedes classifier votes; reset permits the same occurrence in a new history', () => {
  const cfg = config();
  const initial = initialAutoState({ demand: 1 });
  const f = facts({ failure: { signature: 'x', index: 10 } });
  let d = advanceDemand({ config: cfg, state: initial, facts: f });
  assert.equal(d.raw, 2);
  for (let turn = 0; turn < cfg.policy.escalationHoldTurns; turn += 1) {
    d = advanceDemand({ config: cfg, state: d.state, facts: f, advice: advice('micro', { micro: 1 }) });
    assert.equal(d.reason, 'hold');
    assert.equal(d.raw, 2);
  }
  const reset = advanceDemand({ config: cfg, state: initialAutoState({ demand: 1 }), facts: f });
  assert.equal(reset.escalated, true);
});

test('balanced builtin targets follow seeded base routes without inferring other efforts', () => {
  const cfg = loadConfig({});
  const candidates = assessCandidates({ config: cfg, incumbent: route('sonnet', 'low'), facts: facts(), now: T0 });
  const candidate = (model, effort) => candidates.find((c) => c.route.model === model && c.route.effort === effort);
  assert.equal(candidate('haiku', 'low').capability, null);
  assert.equal(candidate('opus', 'high').capability, null);
  assert.deepEqual(candidate('haiku', 'medium').estimate, candidate('haiku', 'high').estimate);
  assert.deepEqual(candidate('opus', 'medium').estimate, candidate('opus', 'xhigh').estimate);
  assert.ok(candidate('haiku', 'medium').estimate.maxUsd < candidate('opus', 'medium').estimate.maxUsd);
  for (const [demand, expected] of [
    [0, route('haiku', 'medium')],
    [1, route('haiku', 'high')],
    [2, route('opus', 'medium')],
    [3, route('opus', 'xhigh')],
  ]) {
    const target = selectTarget({ candidates, demand });
    assert.equal(target.outcome, 'meets-demand');
    assert.deepEqual(target.route, expected);
    assert.equal(target.capability, demand);
  }
});

test('target outcome precedence and unknowns, including level zero and empty maps', () => {
  for (const [name, models, demand, expected, outcome, cap] of [
    ['declared below beats cheap unknown', { a: model(null, 0.01), b: model(1) }, 3, 'b', 'declared-below-demand', 1],
    [
      'highest below then cheapest',
      { a: model(1), b: model(2, 3), c: model(2, 2) },
      3,
      'c',
      'declared-below-demand',
      2,
    ],
    ['unknown only', { a: model(null, 3), b: model(null, 1) }, 2, 'b', 'unknown-only', null],
    ['empty map unknown', { a: model(1, 3, { capability: {} }), b: model(null, 1) }, 0, 'b', 'unknown-only', null],
    ['zero is known', { a: model(null, 0.01), b: model(0) }, 0, 'b', 'meets-demand', 0],
    ['adequate cheapest not strongest', { a: model(3, 4), b: model(2, 1) }, 2, 'b', 'meets-demand', 2],
    [
      'lower sufficient capability breaks equal estimate',
      { a: model(1), c: model(3), b: model(2) },
      2,
      'b',
      'meets-demand',
      2,
    ],
    ['config order last tie', { a: model(1), b: model(2), c: model(2) }, 2, 'b', 'meets-demand', 2],
  ]) {
    const { target } = targetFor(config(models), demand);
    assert.deepEqual([target.route.model, target.outcome, target.capability], [expected, outcome, cap], name);
  }
});

test('quality at high selects eligible level 3, not unknown; margins clamp at boundaries', () => {
  for (const mode of ['cost', 'balanced', 'quality']) {
    for (const demand of [0, 0.5, 2.5, 3]) {
      const { target } = targetFor(config({ a: model(null, 0.01), b: model(3) }), demand, mode);
      const margin = { cost: -0.5, balanced: 0, quality: 0.5 }[mode];
      assert.equal(target.requirement, Math.max(0, Math.min(3, demand + margin)));
      assert.equal(target.route.model, 'b');
    }
  }
});

test('equal estimates retain the incumbent in ALL modes, even against higher capability', () => {
  for (const mode of ['cost', 'balanced', 'quality']) {
    for (const incumbent of ['a', 'b']) {
      const { target } = targetFor(config({ a: model(2.5), b: model(3) }), 2, mode, { incumbent: route(incumbent) });
      assert.equal(target.route.model, incumbent, mode);
    }
  }
});

test('equal estimated same-model efforts prefer least sufficient unless the incumbent qualifies', () => {
  const cfg = config({
    a: model(1),
    shared: model(null, 1, { efforts: ['high', 'medium'], capability: { medium: 2, high: 3 } }),
  });
  const f = facts({ lastRequest: { tokens: 1000, outputTokens: 1200 } });
  for (const [incumbent, mode, expected] of [
    [route('a'), 'balanced', 'medium'],
    [route('shared', 'high'), 'balanced', 'high'],
    [route('a'), 'quality', 'high'],
  ]) {
    const candidates = assessCandidates({ config: cfg, incumbent, facts: f, now: T0 });
    const efforts = candidates.filter((candidate) => candidate.route.model === 'shared');
    assert.deepEqual(efforts[0].estimate, efforts[1].estimate);
    assert.equal(selectTarget({ candidates, demand: 2, mode }).route.effort, expected);
  }
  const candidates = assessCandidates({ config: cfg, incumbent: route('a'), facts: f, now: T0 }).filter(
    (candidate) => candidate.route.model === 'shared',
  );
  assert.equal(selectTarget({ candidates, demand: 2 }).route.effort, 'medium');
});

test('escalation ties prefer the least sufficient strictly stronger effort', () => {
  const cfg = config({
    shared: model(null, 1, { efforts: ['low', 'high', 'medium'], capability: { low: 1, medium: 2, high: 3 } }),
  });
  const candidates = assessCandidates({ config: cfg, incumbent: route('shared', 'low'), facts: facts(), now: T0 });
  const target = selectTarget({ candidates, demand: 2, escalation: true });
  assert.deepEqual([target.route.effort, target.capability, target.reason], ['medium', 2, 'escalation']);
});

test('mode capability monotonicity over differing prices, sparse capabilities, unknowns and incumbent ties', () => {
  const caps = [null, 0, 0.5, 1, 1.5, 2, 2.5, 3];
  for (const a of caps)
    for (const b of caps)
      for (const c of caps) {
        for (const prices of [
          [1, 2, 3],
          [3, 1, 2],
          [2, 3, 1],
          [1, 1, 1],
        ]) {
          for (let incumbent = 0; incumbent < 3; incumbent += 1) {
            const candidates = [a, b, c].map((capability, i) => ({
              route: route(String(i)),
              capability,
              eligible: true,
              selectable: true,
              incumbent: i === incumbent,
              estimate: { minUsd: prices[i], maxUsd: prices[i] },
            }));
            for (let demand = 0; demand <= 3; demand += 0.5) {
              const low = selectTarget({ candidates, demand, mode: 'cost' });
              const high = selectTarget({ candidates, demand, mode: 'quality' });
              assert.ok(
                low.capability === null || high.capability >= low.capability,
                JSON.stringify({ a, b, c, prices, incumbent, demand, low, high }),
              );
            }
          }
        }
      }
});

test('all candidate-local constraints precede fallback, including invalid incumbent and no-route', () => {
  for (const [name, mutate, extraFacts, options, reason] of [
    ['context', {}, { contextTokens: 80_001 }, {}, 'context-full'],
    ['images', { imageInput: false }, { hasImages: true }, {}, 'images'],
    ['availability', {}, {}, { availableModels: [] }, 'unavailable'],
    ['known failure', {}, { ineligible: ['a', 'b'] }, {}, 'unavailable'],
    ['cash', { billing: 'credits', input: 3000 }, {}, {}, 'cash-cap'],
  ]) {
    const cfg = config({ a: model(null, 1, mutate), b: model(3, 2, mutate) });
    const result = run({ config: cfg, state: initialAutoState({ demand: 3 }), facts: facts(extraFacts), ...options });
    assert.equal(result.target.outcome, 'no-route', name);
    assert.equal(result.target.route, null, name);
    assert.equal(result.move.route, null, name);
    assert.ok(
      result.candidates.every((c) => !c.eligible && c.reasons.includes(reason)),
      name,
    );
  }
});

test('filtered declared candidates cannot reappear before unknown-only fallback', () => {
  for (const [extra, f, opts] of [
    [{ imageInput: false }, { hasImages: true }, {}],
    [{ contextWindow: 100 }, {}, {}],
    [{}, { ineligible: ['a'] }, {}],
    [{}, {}, { availableModels: ['b'] }],
    [{ billing: 'credits', input: 3000 }, {}, {}],
  ]) {
    const { target, candidates } = targetFor(config({ a: model(3, 1, extra), b: model(null, 2) }), 3, 'quality', {
      facts: facts(f),
      ...opts,
    });
    assert.equal(candidates[0].eligible, false);
    assert.equal(target.outcome, 'unknown-only');
    assert.equal(target.route.model, 'b');
  }
});

test('context margin and unknown smaller-window guard, for each candidate rather than tier winner', () => {
  const cfg = config({ a: model(1), b: model(3, 0.5, { contextWindow: 200_000 }) });
  assert.equal(targetFor(cfg, 3, 'balanced', { facts: facts({ contextTokens: 80_000 }) }).candidates[0].eligible, true);
  assert.equal(
    targetFor(cfg, 3, 'balanced', { facts: facts({ contextTokens: 80_001 }) }).candidates[0].eligible,
    false,
  );
  for (const extra of [{ contextKnown: false }, { facts: facts({ historyMeasured: false }) }]) {
    const { candidates } = targetFor(cfg, 1, 'balanced', { incumbent: route('b'), ...extra });
    assert.equal(candidates[0].eligible, false);
    assert.ok(candidates[0].reasons.includes('context-unknown'));
    assert.equal(candidates[1].eligible, true);
  }
});

test('cold-write cap boundary, warm explicit cache exception, and automatic/disabled semantics', () => {
  const base = config();
  for (const mode of ['explicit', 'automatic', 'disabled']) {
    const cfg = config({ a: model(3, 1, { billing: 'credits' }) }, { cache: { ...base.cache, mode } });
    const cold = costs.coldWriteUsd(cfg, 'a', 1000, T0);
    for (const [cap, expected] of [
      [cold, true],
      [cold - 1e-9, false],
      [cold + 1e-9, true],
    ]) {
      cfg.policy = { ...cfg.policy, cashCapUsd: cap };
      const { candidates } = targetFor(cfg, 3);
      assert.equal(candidates[0].eligible, expected, `${mode} ${cap}`);
    }
    cfg.policy.cashCapUsd = 0;
    const { candidates } = targetFor(cfg, 3, 'balanced', {
      facts: facts({ models: { a: { prefixTokens: 1000, lastAt: T0 } } }),
    });
    assert.equal(candidates[0].eligible, mode === 'explicit', mode);
  }
});

test('all efforts are candidates; no universal curve; native null and numeric efforts remain unknown', () => {
  const cfg = config({
    a: model(null, 1, { efforts: ['low', 'high'], capability: { low: 2.5 } }),
    b: model(0, 2),
  });
  const { candidates, target } = targetFor(cfg, 3);
  assert.deepEqual(
    candidates.slice(0, 3).map((c) => [c.route.effort, c.capability]),
    [
      ['low', 2.5],
      ['high', null],
      [null, 0],
    ],
  );
  assert.equal(target.route.effort, 'low');
  for (const effort of [null, 1024]) {
    const result = run({ config: cfg, incumbent: route('a', effort), facts: facts({ effort }) });
    const current = result.candidates.find((c) => c.incumbent);
    assert.equal(current.eligible, true);
    assert.equal(current.capability, null);
  }
  const resolved = run({ config: cfg, incumbent: route('a'), facts: facts({ effort: 'low' }) });
  assert.equal(resolved.candidates.find((c) => c.incumbent).capability, 2.5);
  const invalid = run({ config: cfg, incumbent: route('a', 'max') });
  assert.equal(invalid.candidates.find((c) => c.incumbent).eligible, false);
  assert.equal(invalid.move.reason, 'forced');
});

test('missing catalog incumbent is invalid and cannot defeat an eligible fallback', () => {
  const result = run({ incumbent: route('removed') });
  assert.equal(result.candidates.find((c) => c.incumbent).eligible, false);
  assert.equal(result.move.reason, 'forced');
  assert.equal(result.state.routeCause, 'forced');
});

test('each §3.3 move case uses only its defined evidence, with no second demand vote', () => {
  for (const [name, input, expected] of [
    ['forced without advice', { f: facts({ ineligible: ['a'], downAllowed: false }), a: null }, ['forced', true]],
    [
      'escalation without advice/dwell',
      { escalated: true, f: facts({ downAllowed: false }), a: null },
      ['escalation', true],
    ],
    [
      'upgrade uses mass above ROUTED demand',
      { a: advice('medium', { low: 0.1, medium: 0.8, high: 0.1 }) },
      ['upgrade', true],
    ],
    ['upgrade insufficient mass', { a: advice('high', { low: 0.9, high: 0.1 }) }, ['upgrade-pending', false]],
    [
      'downgrade uses mass AT OR BELOW demand',
      { raw: 1, routed: 3, current: 'c', target: 'a', a: advice('low', { low: 0.1, high: 0.9 }) },
      ['downgrade-pending', false],
    ],
    [
      'downgrade does not need more votes',
      { raw: 1, routed: 3, current: 'c', target: 'a', a: advice('low', { micro: 0.1, low: 0.9 }) },
      ['downgrade', true],
    ],
    [
      'downgrade same-task checkpoint',
      {
        raw: 1,
        routed: 3,
        current: 'c',
        target: 'a',
        a: advice('low', { low: 1 }, { continuation: 1 }),
        f: facts({ downAllowed: false }),
      },
      ['downgrade-held', false],
    ],
    [
      'mode explicit mass1',
      { raw: 1, routed: 1, changeCause: 'mode', a: null, f: facts({ downAllowed: false }) },
      ['explicit-up', true],
    ],
    ['catalog explicit mass1', { raw: 1, routed: 1, changeCause: 'catalog', a: null }, ['explicit-up', true]],
    [
      'no same-demand stronger implicit move',
      { raw: 1, routed: 1, a: advice('high', { high: 1 }) },
      ['no-evidence', false],
    ],
    ['same-demand cheaper economics', { raw: 2, routed: 2, current: 'b', target: 'a', a: null }, ['cheaper', true]],
    [
      'same-demand cheaper same-task checkpoint',
      {
        raw: 2,
        routed: 2,
        current: 'b',
        target: 'a',
        a: advice('medium', { medium: 1 }, { continuation: 1 }),
        f: facts({ downAllowed: false }),
      },
      ['downgrade-held', false],
    ],
  ]) {
    const result = moveFor(input);
    assert.deepEqual([result.reason, result.move], expected, name);
    if (result.move) assert.equal(result.state.routedDemand, input.level ?? input.raw ?? 2, name);
  }
});

test('route-to-route tax uses existing formulas for upgrade bar and downgrade support bar', () => {
  const base = config();
  const cfg = config(
    { a: model(1, 1, { contextWindow: 1_000_000 }), b: model(2, 10, { contextWindow: 1_000_000 }) },
    { cache: { ...base.cache, mode: 'explicit' } },
  );
  const f = facts({ contextTokens: 100_000, lastRequest: { tokens: 100_000, outputTokens: 0 } });
  const result = moveFor({ cfg, f });
  const tax = Math.max(0, costs.switchingTaxUsd(cfg, route('b'), route('a'), f, T0));
  assert.equal(result.evidence.taxUsd, tax);
  assert.equal(
    result.evidence.threshold,
    cfg.policy.upgradeBase + (cfg.policy.upgradeSlope * tax) / (tax + cfg.policy.upgradePivotUsd),
  );
  const down = moveFor({ cfg, f, raw: 1, routed: 2, current: 'b', target: 'a', a: advice('low', { low: 1 }) });
  const downTax = costs.downgradeTaxUsd(cfg, route('a'), route('b'), f, T0, cfg.policy.downgradeHorizonTurns);
  assert.equal(down.evidence.taxUsd, downTax);
  assert.equal(
    down.evidence.threshold,
    cfg.policy.downgradeMass + (cfg.policy.downgradeSlope * downTax) / (downTax + cfg.policy.downgradePivotUsd),
  );
});

test('equal-demand cheaper move must pay back; no guaranteed automatic cache savings invented', () => {
  const base = config();
  for (const mode of ['explicit', 'automatic']) {
    const cfg = config({ a: model(1), b: model(2, 2) }, { cache: { ...base.cache, mode } });
    const f = facts({ models: { b: { prefixTokens: 500, lastAt: T0 } } });
    const result = moveFor({ cfg, raw: 2, routed: 2, current: 'b', target: 'a', f });
    const tax = costs.downgradeTaxUsd(cfg, route('a'), route('b'), f, T0, cfg.policy.downgradeHorizonTurns);
    assert.equal(result.move, tax <= 0);
    assert.equal(result.evidence.taxUsd, tax);
  }
});

test('pending upgrade survives turns against routed demand, never relabeled by mode/catalog', () => {
  const cfg = config();
  const weak = advice('medium', { medium: 0.74, low: 0.26 });
  let state = initialAutoState({ demand: 2, routedDemand: 1, cause: 'forced' });
  for (const changeCause of [null, 'mode', 'catalog', null]) {
    const result = run({ config: cfg, state, advice: weak, changeCause });
    assert.equal(result.move.reason, 'upgrade-pending');
    assert.equal(result.move.evidence.mass, 0.74);
    assert.equal(result.state.routedDemand, 1);
    assert.equal(result.state.routeCause, 'forced');
    state = result.state;
  }
  const accepted = run({ config: cfg, state, advice: advice('medium', { medium: 1 }) });
  assert.equal(accepted.move.reason, 'upgrade');
  assert.equal(accepted.state.routedDemand, 2);
  assert.equal(accepted.state.routeCause, 'classifier');
  assert.equal(accepted.demand.state.routedDemand, 1);
});

test('pending downgrade retries support and checkpoint until it executes', () => {
  let state = initialAutoState({ demand: 1, routedDemand: 3 });
  for (const downAllowed of [false, false, true]) {
    const result = run({
      state,
      incumbent: route('c'),
      advice: advice('low', { low: 1 }, { continuation: 1 }),
      facts: facts({ downAllowed }),
      changeCause: 'catalog',
    });
    assert.equal(result.move.reason, downAllowed ? 'downgrade' : 'downgrade-held');
    assert.equal(result.state.routedDemand, downAllowed ? 1 : 3);
    state = result.state;
  }
});

test('same-route accepts zero, rising and falling effective demand without changing move history', () => {
  const cfg = config({ a: model(3) });
  const { candidates, target } = targetFor(cfg, 0);
  for (const [routedDemand, level] of [
    [1, 0],
    [0, 1],
    [3, 1],
    [2, 1.5],
  ]) {
    for (const incumbentOrigin of [null, 'external-fallback']) {
      const state = {
        ...initialAutoState({ demand: Math.ceil(level), routedDemand, cause: 'catalog' }),
        turn: 5,
        holdUntilTurn: 8,
        votes: [0, 1],
        escalatedSignature: 'failure',
        escalatedIndex: 3,
      };
      const before = structuredClone(state);
      const result = decideMove({
        config: cfg,
        state,
        demandResult: { level },
        candidates,
        target,
        facts: facts({ downAllowed: false, dwellAllowed: false }),
        now: T0,
        incumbentOrigin,
      });
      assert.equal(result.move, false);
      assert.equal(result.reason, 'same-route');
      assert.deepEqual(result.route, route('a'));
      assert.equal(result.evidence, null);
      assert.deepEqual(result.state, { ...before, routedDemand: level });
      assert.deepEqual(state, before);
    }
  }
});

test('no-route, exhausted escalation and blocked moves never adopt pending demand', () => {
  const cfg = config();
  const state = { ...initialAutoState({ demand: 2, routedDemand: 0 }), holdUntilTurn: 9 };
  const { candidates, target } = targetFor(cfg, 2);
  for (const [proposal, expected] of [
    [{ ...target, route: null }, 'no-route'],
    [{ ...target, route: route('a'), reason: 'escalation-exhausted' }, 'escalation-exhausted'],
    [target, 'upgrade-pending'],
  ]) {
    const result = decideMove({
      config: cfg,
      state,
      demandResult: { level: 2 },
      candidates,
      target: proposal,
      facts: facts(),
      now: T0,
    });
    assert.equal(result.reason, expected);
    assert.equal(result.move, false);
    assert.strictEqual(result.state, state);
  }
});

test('same-route pin leaves the entire original state unchanged', () => {
  const state = {
    ...initialAutoState({ demand: 2, routedDemand: 3, cause: 'catalog' }),
    votes: [1, 2],
    holdUntilTurn: 8,
  };
  const before = structuredClone(state);
  const result = run({ state, config: config({ a: model(3) }), pin: 'micro' });
  assert.equal(result.move.reason, 'pinned');
  assert.equal(result.move.move, false);
  assert.strictEqual(result.state, state);
  assert.deepEqual(result.state, before);
});

test('estimates use input/cache state plus last output, long-context and offpeak math', () => {
  const base = config();
  for (const mode of ['explicit', 'automatic', 'disabled']) {
    const cfg = config(
      {
        a: model(2, 2, {
          longContext: { above: 1000, multiplier: 2 },
          offPeak: { multiplier: 0.5, peakDays: [1], peakHoursUtc: [[0, 1]] },
        }),
      },
      { cache: { ...base.cache, mode } },
    );
    const f = facts({
      contextTokens: 2000,
      lastRequest: { tokens: 1000, outputTokens: 500 },
      models: { a: { prefixTokens: 1000, lastAt: T0 } },
    });
    const { candidates } = targetFor(cfg, 2, 'balanced', { facts: f });
    const input = costs.inputBounds(cfg, route('a'), 2000, f, T0);
    const output = (costs.ratesAt(cfg.models.a, 2000, T0).output * 500) / 1e6;
    assert.deepEqual(candidates[0].estimate, { minUsd: input.min + output, maxUsd: input.max + output });
  }
});

test('native numeric incumbent uses its real effort cache, not a clamped capability or cache', () => {
  const base = config();
  const cfg = config(
    { a: model(null, 1, { efforts: ['low', 'high'] }) },
    { cache: { ...base.cache, mode: 'explicit' } },
  );
  const f = facts({ effort: 1024, models: { 'a@1024': { prefixTokens: 1000, lastAt: T0 } } });
  const { candidates } = targetFor(cfg, 2, 'balanced', { incumbent: route('a', 1024), facts: f });
  const current = candidates.find((c) => c.incumbent);
  assert.equal(current.eligible, true);
  assert.equal(current.capability, null);
  assert.equal(current.cache, 'fresh');
  assert.equal(candidates[0].cache, 'unknown');
});

test('range boundaries reject invalid demand and treat malformed declarations as unknown', () => {
  for (const demand of [-1, 3.5, NaN, Infinity, '2', 0.25]) {
    assert.throws(() => selectTarget({ candidates: [], demand }), RangeError);
    assert.throws(() => initialAutoState({ demand }), RangeError);
  }
  for (const capability of [-0.5, 3.5, NaN, Infinity, '2', 0.25]) {
    const { target } = targetFor(config({ a: model(capability) }), 2);
    assert.equal(target.capability, null);
    assert.equal(target.outcome, 'unknown-only');
  }
  assert.throws(() => selectTarget({ candidates: [], demand: 1, mode: 'invalid' }), RangeError);
  assert.equal(run({ config: config(undefined, { baselineTier: 'micro' }), state: undefined }).demand.raw, 0);
});

test('demand pins are tier labels or integer raw demand and do not accumulate ops discounts', () => {
  for (const [i, tier] of TIERS.entries()) {
    for (const pin of [i, tier]) {
      const d = run({ pin, boundedExecute: true, facts: facts({ failure: { signature: 'x', index: 1 } }) }).demand;
      assert.equal(d.raw, i);
      assert.equal(d.level, i);
      assert.equal(d.reason, 'pinned');
      assert.equal(d.escalated, false);
    }
  }
  for (const pin of [-1, 4, 1.5, 'unknown']) assert.throws(() => run({ pin }), RangeError);
});

test('escalation searches stronger requests NOW, never a cheaper weaker adequate candidate', () => {
  for (const [incumbentCap, raw, models, expected, outcome, reason] of [
    [
      2.5,
      0,
      { weaker: model(2, 0.1), stronger: model(3, 10), unknown: model(null, 0.01) },
      'stronger',
      'meets-demand',
      'escalation',
    ],
    [2, 3, { stronger: model(2.5, 10), unknown: model(null, 0.01) }, 'stronger', 'declared-below-demand', 'escalation'],
    [1, 1, { adequate: model(2, 1), highest: model(3, 10) }, 'adequate', 'meets-demand', 'escalation'],
    [
      1,
      2,
      { first: model(2.5, 5), highest: model(2.5, 2), unknown: model(null, 0.01) },
      'highest',
      'declared-below-demand',
      'escalation',
    ],
    [2.5, 0, { weaker: model(2, 0.01), unknown: model(null, 10) }, 'unknown', 'unknown-only', 'escalation-unknown'],
    [
      null,
      1,
      { below: model(1.5, 0.01), adequate: model(2, 10), unknown: model(null, 0.001) },
      'adequate',
      'meets-demand',
      'escalation',
    ],
    [null, 1, { below: model(1.5, 0.01), unknown: model(null, 10) }, 'unknown', 'unknown-only', 'escalation-unknown'],
  ]) {
    const result = run({
      config: config({ a: model(incumbentCap), ...models }),
      state: initialAutoState({ demand: raw }),
      facts: facts({ failure: { signature: 'failed', index: 10 }, downAllowed: false }),
    });
    assert.deepEqual(
      [result.target.route.model, result.target.outcome, result.move.reason],
      [expected, outcome, reason],
    );
    assert.equal(result.move.move, true);
    assert.equal(result.state.routeCause, 'escalation');
    assert.equal(result.state.routedDemand, Math.min(raw + 1, 3));
  }
});

test('exhausted escalation retains eligible incumbent and pending headroom, never a known weaker route', () => {
  for (const [incumbentCap, raw] of [
    [2.5, 0],
    [3, 3],
    [null, 1],
  ]) {
    const result = run({
      config: config({ a: model(incumbentCap), below: model(1.5, 0.01) }),
      state: initialAutoState({ demand: raw, routedDemand: raw, cause: 'catalog' }),
      facts: facts({ failure: { signature: 'failed', index: 10 } }),
    });
    assert.equal(result.move.reason, 'escalation-exhausted');
    assert.equal(result.move.move, false);
    assert.deepEqual(result.move.route, route('a'));
    assert.equal(result.target.headroom, true);
    assert.equal(result.demand.headroom, true);
    assert.equal(result.state.headroom, true);
    assert.equal(result.state.routedDemand, raw);
    assert.equal(result.state.routeCause, 'catalog');
  }
});

test('exhausted headroom can take a newly eligible stronger request without new failure or confidence', () => {
  const failed = run({
    config: config({ a: model(2.5), b: model(3) }),
    state: initialAutoState({ demand: 3 }),
    facts: facts({ failure: { signature: 'failed', index: 10 }, ineligible: ['b'] }),
  });
  assert.equal(failed.move.reason, 'escalation-exhausted');
  const retried = run({
    config: config({ a: model(2.5), b: model(3) }),
    state: failed.state,
    facts: facts({ failure: { signature: 'failed', index: 10 }, downAllowed: false }),
  });
  assert.equal(retried.demand.escalated, false);
  assert.equal(retried.move.reason, 'escalation');
  assert.deepEqual(retried.move.route, route('b'));
  assert.equal(retried.state.headroom, false);
});

test('escalation cannot nominate same physical request via another alias or restore filtered stronger models', () => {
  const cfg = config({
    a: model(null),
    alias: model(3, 0.01),
    b: model(3, 10, { imageInput: false }),
    c: model(3, 10, { billing: 'credits', input: 3000 }),
  });
  cfg.models.alias.id = cfg.models.a.id;
  const result = run({
    config: cfg,
    state: initialAutoState({ demand: 1 }),
    facts: facts({ failure: { signature: 'x', index: 1 }, hasImages: true }),
  });
  assert.equal(result.move.reason, 'escalation-exhausted');
  assert.deepEqual(result.move.route, route('a'));
  assert.equal(result.candidates.find((c) => c.route.model === 'b').eligible, false);
  assert.equal(result.candidates.find((c) => c.route.model === 'c').eligible, false);
});

test('failure with invalid incumbent uses forced normal refit, not stronger-only exhaustion', () => {
  const result = run({
    config: config({ a: model(3, 1, { imageInput: false }), b: model(1, 2) }),
    state: initialAutoState({ demand: 2 }),
    facts: facts({ failure: { signature: 'x', index: 1 }, hasImages: true }),
  });
  assert.equal(result.move.reason, 'forced');
  assert.deepEqual(result.move.route, route('b'));
  assert.equal(result.target.outcome, 'declared-below-demand');
});

test('one-turn tier pin ignores modes and ALL move gates without changing any session state', () => {
  const cfg = config({ a: model(1), b: model(2), c: model(2.5, 2) });
  const state = {
    ...initialAutoState({ demand: 3, routedDemand: 3, cause: 'escalation' }),
    turn: 10,
    holdUntilTurn: 100,
    votes: [0, 1],
    escalatedSignature: 'old',
    escalatedIndex: 1,
    headroom: true,
  };
  for (const mode of ['cost', 'balanced', 'quality']) {
    const result = run({
      config: cfg,
      state,
      mode,
      pin: 'medium',
      boundedExecute: true,
      facts: facts({ downAllowed: false, failure: { signature: 'new', index: 2 }, midTurn: true }),
    });
    assert.deepEqual(result.target.route, route('b'));
    assert.equal(result.target.requirement, 2);
    assert.equal(result.move.reason, 'pinned');
    assert.equal(result.move.move, false);
    assert.deepEqual(result.move.route, route('b'));
    assert.strictEqual(result.state, state);
    assert.strictEqual(result.demand.state, state);
    assert.strictEqual(result.move.state, state);
    assert.equal(result.demand.raw, 2);
    assert.equal(result.demand.level, 2);
    const following = run({ config: cfg, state: result.state, incumbent: route('a') });
    assert.equal(following.demand.raw, 3);
    assert.equal(following.demand.reason, 'hold');
  }
});

test('pins never restore filtered candidates, bypass cash cap or hide explicit no-route', () => {
  for (const [f, opts, patch] of [
    [{ hasImages: true }, {}, { imageInput: false }],
    [{ contextTokens: 80_001 }, {}, {}],
    [{}, { availableModels: [] }, {}],
    [{}, {}, { billing: 'credits', input: 3000 }],
  ]) {
    const cfg = config({ a: model(3, 1, patch) });
    const state = initialAutoState({ demand: 1 });
    const result = run({ config: cfg, state, pin: 'high', facts: facts(f), ...opts });
    assert.equal(result.target.outcome, 'no-route');
    assert.equal(result.move.route, null);
    assert.equal(result.move.move, false);
    assert.strictEqual(result.state, state);
  }
  const cfg = config({ a: model(3, 1, { imageInput: false }), b: model(1), unknown: model(null, 0.01) });
  const result = run({ config: cfg, pin: 'high', facts: facts({ hasImages: true }) });
  assert.deepEqual(result.move.route, route('b'));
  assert.equal(result.target.outcome, 'declared-below-demand');
});

test('every incumbent hard-constraint violation forces refit without classifier or dwell evidence', () => {
  for (const [patch, extraFacts, opts] of [
    [{ contextWindow: 100 }, {}, {}],
    [{ imageInput: false }, { hasImages: true }, {}],
    [{}, {}, { availableModels: ['b'] }],
    [{}, { ineligible: ['a'] }, {}],
    [{ billing: 'credits', input: 3000 }, {}, {}],
  ]) {
    const cfg = config({ a: model(3, 1, patch), b: model(1, 2) });
    const result = run({
      config: cfg,
      state: initialAutoState({ demand: 3 }),
      facts: facts({ downAllowed: false, ...extraFacts }),
      ...opts,
    });
    assert.equal(result.move.reason, 'forced');
    assert.deepEqual(result.move.route, route('b'));
    assert.equal(result.state.routeCause, 'forced');
  }
});

test('same canonical request under a different alias never counts as a physical move', () => {
  const cfg = config({ a: model(1, 2), b: model(2, 1) });
  cfg.models.b.id = cfg.models.a.id;
  const result = run({
    config: cfg,
    state: initialAutoState({ demand: 2, routedDemand: 1 }),
    advice: advice('medium', { medium: 1 }),
  });
  assert.deepEqual(result.target.route, route('b'));
  assert.equal(result.move.reason, 'same-route');
  assert.equal(result.state.routedDemand, 2);
  assert.equal(result.move.move, false);
  assert.equal(result.state.routeCause, 'classifier');
});

test('pin ignores preexisting headroom and normal escalation-only selection', () => {
  const state = { ...initialAutoState({ demand: 3, routedDemand: 3 }), headroom: true, demandCause: 'escalation' };
  const cfg = config({ a: model(2.5, 2), b: model(2, 1), c: model(3, 3) });
  const result = run({ config: cfg, state, pin: 'medium' });
  assert.deepEqual(result.target.route, route('b'));
  assert.equal(result.target.reason, null);
  assert.strictEqual(result.state, state);
  assert.equal(result.state.headroom, true);
});

test('headroom exhaustion does not repeatedly move to unknown candidate after it was selected', () => {
  const cfg = config({ a: model(3, 1), unknown: model(null, 2) });
  const prior = { ...initialAutoState({ demand: 3 }), headroom: true, demandCause: 'escalation', holdUntilTurn: 10 };
  const first = run({ config: cfg, state: prior });
  assert.equal(first.move.reason, 'escalation-unknown');
  assert.equal(first.state.headroom, false);
  const second = run({ config: cfg, state: first.state, incumbent: first.move.route });
  assert.notEqual(second.move.reason, 'escalation-unknown');
  assert.notEqual(second.move.reason, 'escalation');
  assert.equal(second.move.move, false);
});

test('native numeric effort remains valid and unknown for models without configured efforts', () => {
  const cfg = config({ a: model(3), b: model(1, 3) });
  const result = run({ config: cfg, incumbent: route('a', 1024), facts: facts({ effort: 1024 }) });
  const incumbent = result.candidates.find((candidate) => candidate.incumbent);
  assert.equal(incumbent.eligible, true);
  assert.equal(incumbent.capability, null);
  const generated = result.candidates.find((candidate) => candidate.selectable);
  assert.equal(incumbent.requestKey, generated.requestKey);
  assert.equal(result.move.reason, 'same-route');
  assert.equal(result.move.move, false);
});

test('unresolved native incumbent wins unknown-only equal estimates in every mode', () => {
  for (const effort of [null, 1024]) {
    const cfg = config({ a: model(null, 1, { efforts: ['low', 'high'] }) });
    for (const mode of ['cost', 'balanced', 'quality']) {
      const result = run({ config: cfg, mode, incumbent: route('a', effort), facts: facts({ effort }) });
      assert.deepEqual(result.target.route, route('a', effort), `${mode} ${effort}`);
      assert.equal(result.target.outcome, 'unknown-only');
      assert.equal(result.move.move, false);
      const declared = config({ a: cfg.models.a, b: model(0, 100) });
      const below = run({ config: declared, mode, incumbent: route('a', effort), facts: facts({ effort }) });
      assert.deepEqual(below.target.route, route('b'));
      assert.equal(below.target.outcome, 'declared-below-demand');
    }
  }
});

test('demand downgrades and cheaper lateral moves need dwell even off the same task', () => {
  for (const path of [
    { raw: 1, routed: 3, current: 'c', target: 'a', a: advice('low', { low: 1 }) },
    { raw: 2, routed: 2, current: 'b', target: 'a', a: null },
  ]) {
    for (const dwellAllowed of [false, undefined, true]) {
      const result = moveFor({ ...path, f: facts({ dwellAllowed, downAllowed: false }) });
      assert.equal(result.move, dwellAllowed === true);
      assert.equal(result.reason, dwellAllowed === true ? (path.routed === 3 ? 'downgrade' : 'cheaper') : 'dwell-held');
    }
    const fresh = moveFor({ ...path, f: facts({ historyMeasured: false, dwellAllowed: true, downAllowed: false }) });
    assert.equal(fresh.move, true);
  }
  for (const input of [
    {},
    { raw: 1, routed: 1, changeCause: 'mode', a: null },
    { escalated: true, a: null },
    { f: facts({ ineligible: ['a'], dwellAllowed: false }), a: null },
  ]) {
    const result = moveFor({ f: facts({ dwellAllowed: false, downAllowed: false }), ...input });
    assert.equal(result.move, true);
  }
});

// A held model is a candidate-local hard constraint (docs/plans/2026-11-22-auto-holds-design.md): never a
// target, in any mode, and a held incumbent forces the move like any other invalid incumbent.
test('a held model is ineligible with reason held-out, the incumbent included', () => {
  const { candidates } = targetFor(config(), 2, 'balanced', { held: ['b'] });
  const held = candidates.find((c) => c.route.model === 'b');
  assert.equal(held?.eligible, false);
  assert.ok(held?.reasons.includes('held-out'));
  assert.ok(candidates.filter((c) => c.route.model !== 'b').every((c) => !c.reasons.includes('held-out')));
});

test('a held incumbent forces the move to the best eligible candidate', () => {
  for (const [held, expected] of [
    [['a'], 'b'],
    [['a', 'b'], 'c'],
  ]) {
    const result = run({ held });
    assert.equal(result.move.move, true);
    assert.equal(result.move.reason, 'forced');
    assert.equal(result.move.route?.model, expected);
  }
});

test('a pin falls to the next eligible candidate when the best is held', () => {
  const result = run({ pin: 'high', held: ['c'] });
  assert.equal(result.move.move, false);
  assert.equal(result.move.reason, 'pinned');
  assert.equal(result.move.route.model, 'b');
});

test('every candidate held gives no route, and the native request takes the turn', () => {
  const result = run({ held: ['a', 'b', 'c'] });
  assert.equal(result.target.outcome, 'no-route');
  assert.equal(result.move.route, null);
  assert.equal(result.move.reason, 'no-route');
});
test('one activity chooses the capability column for the whole decision', () => {
  const cfg = config({
    a: model(1, 1),
    b: model(null, 2, { efforts: ['high'], capability: { high: { code: 2.5, docs: 0.5 } } }),
  });
  const choose = (activity) => {
    const candidates = assessCandidates({ config: cfg, incumbent: route('a'), facts: facts(), now: T0, activity });
    return { candidates, target: selectTarget({ candidates, demand: 2 }) };
  };
  const capability = (result) => result.candidates.find((candidate) => candidate.route.model === 'b').capability;

  const code = choose('code');
  assert.equal(capability(code), 2.5);
  assert.equal(code.target.route.model, 'b');
  assert.equal(code.target.outcome, 'meets-demand');

  const docs = choose('docs');
  assert.equal(capability(docs), 0.5);
  assert.equal(docs.target.route.model, 'a');
  assert.equal(docs.target.outcome, 'declared-below-demand');

  const none = choose(null);
  assert.equal(capability(none), null);
  assert.equal(none.target.route.model, 'a');
  assert.equal(none.target.outcome, 'declared-below-demand');
});

test('the initial state reads the decision activity column', () => {
  const cfg = config({ a: model(null, 1, { efforts: ['high'], capability: { high: { default: 0.5, code: 3 } } }) });
  const state = initialIncumbentState({ config: cfg, incumbent: route('a', 'high'), facts: facts(), activity: 'code' });
  assert.equal(state.routedDemand, 3);
});

test('a numeric capability is one value for every activity', () => {
  const cfg = config({ a: model(1, 1), b: model(2, 2) });
  for (const activity of ['code', 'docs', null]) {
    const candidates = assessCandidates({
      config: cfg,
      incumbent: route('a'),
      facts: facts(),
      now: T0,
      activity,
    });
    assert.equal(candidates.find((candidate) => candidate.route.model === 'b').capability, 2);
  }
});

const scaled = (input, outputScale, extra = {}) =>
  model(null, input, {
    efforts: ['low', 'max'],
    capability: { low: 2, max: 2 },
    contextWindow: 1_000_000,
    ...(outputScale ? { outputScale } : {}),
    ...extra,
  });
const replied = facts({ lastRequest: { tokens: 1000, outputTokens: 100_000 } });
const upperBounds = (cfg, incumbent) =>
  Object.fromEntries(
    assessCandidates({ config: cfg, incumbent, facts: replied, now: T0 })
      .filter((c) => c.selectable)
      .map((c) => [`${c.route.model}@${c.route.effort}`, Number(c.estimate.maxUsd.toFixed(6))]),
  );

test('output scales move the winner from a cheap model at max effort to a pricier model at low effort', () => {
  const pick = (a, b) => {
    const cfg = config({ a: scaled(1, a, { capability: { low: 1, max: 2 } }), b: scaled(2, b) });
    const candidates = assessCandidates({ config: cfg, incumbent: route('a', 'max'), facts: replied, now: T0 });
    return selectTarget({ candidates, demand: 2 }).route;
  };
  assert.deepEqual(pick(null, null), route('a', 'max'));
  assert.deepEqual(pick({ low: 4, max: 20 }, { low: 1, max: 8 }), route('b', 'low'));
});

test('the output estimate scales by the candidate volume over the incumbent volume, input unchanged', () => {
  // The next context is 101k tokens: $0.101 on a, $0.303 on b. The last reply's output is $0.2 on a, $0.6 on b.
  const cfg = config({ a: scaled(1, { low: 1, max: 4 }), b: scaled(3, { low: 0.5 }) });
  assert.deepEqual(upperBounds(cfg, route('a', 'max')), {
    'a@low': 0.151,
    'a@max': 0.301,
    'b@low': 0.378,
    'b@max': 0.903,
  });
});

test('an output estimate stays unscaled unless both the candidate and the incumbent volume are known', () => {
  const plain = config({ a: scaled(1), b: scaled(3) });
  const scales = config({ a: scaled(1, { low: 1, max: 4 }), b: scaled(3, { low: 0.5 }) });
  const noIncumbentScale = config({ a: scaled(1, { low: 1 }), b: scaled(3, { low: 0.5, max: 2 }) });
  for (const [name, cfg, incumbent] of [
    ['incumbent effort without a scale', noIncumbentScale, route('a', 'max')],
    ['unresolved native effort', scales, route('a', null)],
    ['numeric native effort', scales, route('a', 4000)],
    ['incumbent outside the catalog', scales, route('gone', 'max')],
  ]) {
    const expected = upperBounds(plain, incumbent);
    assert.deepEqual(upperBounds(cfg, incumbent), expected, name);
  }
  assert.equal(upperBounds(scales, route('a', 'max'))['b@max'], upperBounds(plain, route('a', 'max'))['b@max']);
});

test('a native session effort selects the incumbent output volume', () => {
  const cfg = config({ a: scaled(1, { low: 1, max: 4 }) });
  const candidates = assessCandidates({
    config: cfg,
    incumbent: route('a', null),
    facts: { ...replied, effort: 'max' },
    now: T0,
  });
  assert.equal(Number(candidates.find((c) => c.route.effort === 'low').estimate.maxUsd.toFixed(6)), 0.151);
});
