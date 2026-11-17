import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  advanceDemand,
  assessCandidates,
  decideMove,
  initialAutoState,
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

test('no physical move cannot change routed demand or route provenance', () => {
  const state = initialAutoState({ demand: 0, routedDemand: 3, cause: 'catalog' });
  const result = run({ state, config: config({ a: model(3) }), boundedExecute: true });
  assert.equal(result.move.reason, 'same-route');
  assert.equal(result.state.routedDemand, 3);
  assert.equal(result.state.routeCause, 'catalog');
  assert.equal(result.demand.level, 0);
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
  assert.equal(result.state.routedDemand, 1);
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
