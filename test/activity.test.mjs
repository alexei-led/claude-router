import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acceptActivity, compareRoutes } from '../lib/activity.mjs';
import { loadConfig, resolveRoute } from '../lib/config.mjs';
import { routeCacheKey } from '../lib/cost.mjs';
import { initialState } from '../lib/policy.mjs';
import { chooseRoute, emptyLoop } from '../lib/route.mjs';
import { advice, T0 } from './helpers.mjs';

const ON = loadConfig({ userFile: { activityRouting: 'on' } });
const NOW = T0 + 1_000_000;
const WARM = NOW - 60_000;
const HAIKU = 'claude-haiku-5-5';
const SONNET = 'claude-sonnet-5-5';
const OPUS = 'claude-opus-5-5';

const labelOf = (choice, p = 0.9) => ({ choice, probabilities: { [choice]: p, uncertain: 1 - p } });

test('acceptActivity takes a known label at or above the activity mass, else null', () => {
  const config = loadConfig({});
  for (const [name, input, expected] of [
    ['no advice', null, null],
    ['advice without an activity answer', advice('low', { low: 1 }), null],
    ['a null activity answer', { ...advice('low', { low: 1 }), activity: null }, null],
    ['uncertain', { activity: labelOf('uncertain', 0.9) }, null],
    ['below the mass', { activity: labelOf('code', 0.59) }, null],
    ['at the mass', { activity: labelOf('code', 0.6) }, 'code'],
    ['an unknown label', { activity: labelOf('write', 0.9) }, null],
    ['no probabilities', { activity: { choice: 'ops' } }, null],
  ])
    assert.equal(acceptActivity(config, input), expected, name);
});

test('compareRoutes orders by output price, then effort; a session effort or an unpriced model may not order', () => {
  const unpriced = loadConfig({
    userFile: {
      models: {
        mini: {
          id: 'mini-1',
          input: 1,
          cacheRead: 0.1,
          contextWindow: 200_000,
          billing: 'plan',
          efforts: ['low', 'high'],
        },
      },
    },
  });
  for (const [name, config, a, b, expected, sent] of [
    ['a dearer model', ON, { model: 'sonnet', effort: 'low' }, { model: 'haiku', effort: 'max' }, 1],
    ['a cheaper model', ON, { model: 'haiku', effort: 'high' }, { model: 'sonnet', effort: 'medium' }, -1],
    ['a higher effort', ON, { model: 'opus', effort: 'xhigh' }, { model: 'opus', effort: 'medium' }, 1],
    ['the same route', ON, { model: 'sonnet', effort: 'medium' }, { model: 'sonnet', effort: 'medium' }, 0],
    ['two session efforts', ON, { model: 'sonnet', effort: null }, { model: 'sonnet' }, 0],
    [
      'a session effort against a set one, with no effort sent',
      ON,
      { model: 'sonnet', effort: null },
      { model: 'sonnet', effort: 'low' },
      null,
    ],
    [
      'a session effort is the effort sent',
      ON,
      { model: 'sonnet', effort: null },
      { model: 'sonnet', effort: 'low' },
      1,
      'high',
    ],
    [
      'a session effort equal to the one set',
      ON,
      { model: 'opus', effort: null },
      { model: 'opus', effort: 'medium' },
      0,
      'medium',
    ],
    [
      'a numeric effort sent against a set one',
      ON,
      { model: 'opus', effort: null },
      { model: 'opus', effort: 'medium' },
      null,
      32_000,
    ],
    ['a model without an output price', unpriced, { model: 'mini' }, { model: 'haiku', effort: 'high' }, null],
    [
      'one unpriced model at two efforts',
      unpriced,
      { model: 'mini', effort: 'high' },
      { model: 'mini', effort: 'low' },
      1,
    ],
  ])
    assert.equal(compareRoutes(config, a, b, sent), expected, name);
});

// One turn in `on` from the cell (tier, activity) with its route warm. `choice` is the tier advice; `label` the
// activity answer.
function turn({
  config = ON,
  tier = 'low',
  activity = null,
  choice = tier,
  label = null,
  continuation = 0,
  tokens = 20_000,
  output = 1_500,
  warm = true,
  measured = true,
  failure = null,
  state = initialState(),
  pin = null,
  noAdvice = false,
  effort = 'medium',
  loopActivity = activity,
}) {
  const running = resolveRoute(config, tier, activity);
  const models = warm
    ? { [routeCacheKey(config, running, effort)]: { lastAt: WARM, prefixTokens: tokens + output } }
    : {};
  const lastRequest = {
    model: config.models[running.model].id,
    tokens,
    outputTokens: output,
    cacheReadTokens: tokens,
    cacheWriteTokens: 0,
    at: WARM,
  };
  const loop = {
    ...emptyLoop(config, HAIKU),
    lastRoute: tier,
    lastActivity: loopActivity,
    state,
    models,
    lastRequest,
    historyMeasured: measured,
  };
  const facts = {
    lastRoute: tier,
    lastRequest,
    models,
    effort,
    failure,
    contextTokens: tokens,
    continuation: false,
    prompt: 'x',
    turns: [],
    pin: null,
    turnKey: 't',
    historyMeasured: measured,
  };
  const tierAdvice =
    choice === 'uncertain' ? advice('uncertain', { uncertain: 1 }) : advice(choice, { [choice]: 0.97 });
  const input = {
    facts,
    advice: noAdvice ? null : { ...tierAdvice, continuation, activity: label },
    pin,
    nativeModel: HAIKU,
    contextKnown: true,
    now: NOW,
  };
  return chooseRoute(config, loop, input);
}

const priorVote = (tier) => ({ ...initialState(), turn: 1, votes: [{ tier, turn: 1 }] });
const holding = { ...initialState(), turn: 1, holdUntilTurn: 3 };
const metered = loadConfig({
  userFile: { activityRouting: 'on', models: { sonnet: { billing: 'credits' } }, policy: { cashCapUsd: 0.5 } },
});
const docsFlat = loadConfig({
  userFile: {
    activityRouting: 'on',
    activities: { docs: { high: { model: 'sonnet', effort: 'medium' } } },
  },
});
const sessionEffort = loadConfig({
  userFile: { activityRouting: 'on', activities: { code: { low: { model: 'haiku', effort: null } } } },
});
const planSession = loadConfig({
  userFile: { activityRouting: 'on', activities: { plan: { high: { effort: null } } } },
});
const unpricedCode = loadConfig({
  userFile: {
    activityRouting: 'on',
    models: {
      mini: { id: 'mini-1', input: 1, cacheRead: 0.1, contextWindow: 200_000, billing: 'plan', efforts: [] },
    },
    activities: { code: { low: { model: 'mini' } } },
  },
});

test('the activity decision: (route now, tier advice, activity advice, cache, context) → route and reason', () => {
  for (const [name, setup, expected] of [
    [
      'a label change on the same route does not switch',
      { activity: 'code', label: labelOf('debug') },
      ['low', 'debug', 'same-tier', SONNET, 'medium'],
    ],
    [
      'a stronger label clears the upgrade bar',
      { label: labelOf('code') },
      ['low', 'code', 'activity-up', SONNET, 'medium'],
    ],
    [
      'a stronger label below the upgrade bar waits',
      { label: labelOf('code', 0.7) },
      ['low', null, 'activity-pending', HAIKU, 'high'],
    ],
    [
      'a label below the activity mass is the base route',
      { activity: 'code', label: labelOf('ops', 0.5) },
      ['low', null, 'activity-down', HAIKU, 'high'],
    ],
    [
      'continuation moves up',
      { activity: 'explore', continuation: 0.9, label: labelOf('code') },
      ['low', 'code', 'activity-up', SONNET, 'medium'],
    ],
    [
      'continuation never moves down',
      { activity: 'code', continuation: 0.9, label: labelOf('ops', 0.99) },
      ['low', 'code', 'continuation', SONNET, 'medium'],
    ],
    [
      'continuation with an uncertain label keeps the activity',
      { activity: 'code', continuation: 0.9, label: labelOf('uncertain') },
      ['low', 'code', 'continuation', SONNET, 'medium'],
    ],
    [
      'uncertain returns down to the base route',
      { activity: 'code', label: labelOf('uncertain') },
      ['low', null, 'activity-down', HAIKU, 'high'],
    ],
    [
      'uncertain returns up to the base route',
      { tier: 'medium', activity: 'ops', label: labelOf('uncertain') },
      ['medium', null, 'activity-up', OPUS, 'medium'],
    ],
    [
      'a tier answer without an activity answer keeps the running route',
      { tier: 'medium', activity: 'ops' },
      ['medium', 'ops', 'same-tier', SONNET, 'medium'],
    ],
    [
      'a missing activity answer does not move a coding session down',
      { activity: 'code' },
      ['low', 'code', 'same-tier', SONNET, 'medium'],
    ],
    [
      'tier and activity change together',
      { choice: 'medium', label: labelOf('ops'), state: priorVote('medium') },
      ['medium', 'ops', 'upgrade', SONNET, 'medium'],
    ],
    [
      'escalation keeps the activity and skips a tier whose route is not stronger',
      { activity: 'docs', choice: 'micro', label: labelOf('docs'), failure: { signature: 'boom' } },
      ['high', 'docs', 'escalation', OPUS, 'xhigh'],
    ],
    [
      'escalation without an activity is one tier up',
      { choice: 'micro', label: labelOf('uncertain'), failure: { signature: 'boom' } },
      ['medium', null, 'escalation', OPUS, 'medium'],
    ],
    [
      'a session started on an override cell keeps it when the classifier fails',
      { activity: 'code', noAdvice: true },
      ['low', 'code', 'no-advice', SONNET, 'medium'],
    ],
    [
      'a lateral move to a cold credits model above the cash cap is blocked',
      { config: metered, label: labelOf('code', 0.95), tokens: 300_000 },
      ['low', null, 'cash-gate', HAIKU, 'high'],
    ],
    [
      'a hold refuses a cheaper lateral move',
      { tier: 'medium', label: labelOf('ops'), tokens: 5_000, state: holding },
      ['medium', null, 'hold', OPUS, 'medium'],
    ],
    [
      'a hold allows a stronger lateral move',
      { label: labelOf('code'), state: holding },
      ['low', 'code', 'activity-up', SONNET, 'medium'],
    ],
    [
      'a pin ignores the activity',
      { activity: 'code', pin: 'low', label: labelOf('docs') },
      ['low', null, 'pinned', HAIKU, 'high'],
    ],
    [
      'a fresh history moves tier and activity on one vote',
      { choice: 'medium', label: labelOf('ops'), warm: false, measured: false },
      ['medium', 'ops', 'upgrade', SONNET, 'medium'],
    ],
    [
      'a measured history waits for the vote streak, labelled with a cell on the same route',
      { choice: 'medium', label: labelOf('ops') },
      ['low', 'ops', 'upgrade-pending', HAIKU, 'high'],
    ],
    [
      'a cheaper move pays back at a small context',
      { tier: 'medium', label: labelOf('ops'), tokens: 10_000 },
      ['medium', 'ops', 'activity-down', SONNET, 'medium'],
    ],
    [
      'a cheaper move does not pay back at a large context',
      { tier: 'medium', label: labelOf('ops'), tokens: 150_000 },
      ['medium', null, 'activity-pending', OPUS, 'medium'],
    ],
    [
      'a session-effort override orders by the effort sent',
      { config: sessionEffort, label: labelOf('code') },
      ['low', null, 'activity-pending', HAIKU, 'high'],
    ],
    [
      'a session-effort override running the request already sent stays',
      { config: sessionEffort, label: labelOf('code'), effort: 'high' },
      ['low', 'code', 'same-tier', HAIKU, 'high'],
    ],
    [
      'uncertain leaves a session-effort override for the base route',
      { config: planSession, tier: 'high', activity: 'plan', label: labelOf('uncertain') },
      ['high', null, 'activity-up', OPUS, 'xhigh'],
    ],
    [
      'uncertain leaves an override the router cannot order',
      { config: unpricedCode, activity: 'code', label: labelOf('uncertain') },
      ['low', null, 'activity-up', HAIKU, 'high'],
    ],
    [
      'a label for an override the router cannot order needs the upgrade bar',
      { config: unpricedCode, label: labelOf('code', 0.7) },
      ['low', null, 'activity-pending', HAIKU, 'high'],
    ],
    [
      'escalation counts the effort sent for a session-effort override',
      {
        config: planSession,
        tier: 'medium',
        activity: 'plan',
        label: labelOf('plan'),
        failure: { signature: 'boom' },
        effort: 'xhigh',
      },
      ['high', 'plan', 'escalation', OPUS, 'xhigh'],
    ],
  ]) {
    const { decision } = turn(setup);
    assert.deepEqual(
      [decision.tier, decision.activity, decision.reason, decision.model, decision.effort],
      expected,
      name,
    );
  }
});

test('escalation keeps the failure for later when no tier above runs a stronger route', () => {
  const failure = { signature: 'boom' };
  const flat = turn({ config: docsFlat, activity: 'docs', label: labelOf('docs'), failure });
  assert.deepEqual([flat.decision.tier, flat.decision.reason], ['low', 'same-tier']);
  assert.equal(flat.state.escalatedSignature, null);
  const base = turn({ config: docsFlat, activity: 'docs', label: labelOf('uncertain'), failure });
  assert.deepEqual([base.decision.tier, base.decision.reason], ['medium', 'escalation']);
  assert.equal(base.state.escalatedSignature, 'boom');
});

test('the loop keeps the applied activity; a pin keeps the automatic one', () => {
  for (const [name, setup, lastRoute, lastActivity] of [
    ['a lateral move', { label: labelOf('code') }, 'low', 'code'],
    ['a refused move', { label: labelOf('code', 0.7) }, 'low', null],
    ['a pin', { activity: 'code', pin: 'high', label: labelOf('docs') }, 'low', 'code'],
  ]) {
    const loop = turn(setup);
    assert.deepEqual([loop.lastRoute, loop.lastActivity], [lastRoute, lastActivity], name);
  }
});

test('off routes without the activity, shadow applies the same and reports what on would do, on applies it', () => {
  const routeOf = (d) => [d.tier, d.activity, d.reason, d.model, d.effort];
  for (const [mode, applied, wouldRoute] of [
    ['off', ['low', null, 'same-tier', HAIKU, 'high'], null],
    [
      'shadow',
      ['low', null, 'same-tier', HAIKU, 'high'],
      { activity: 'code', tier: 'low', model: SONNET, effort: 'medium', reason: 'activity-up' },
    ],
    ['on', ['low', 'code', 'activity-up', SONNET, 'medium'], null],
  ]) {
    const config = loadConfig({ userFile: { activityRouting: mode } });
    const loop = turn({ config, label: labelOf('code') });
    assert.deepEqual(routeOf(loop.decision), applied, mode);
    assert.deepEqual(loop.decision.wouldRoute, wouldRoute, mode);
    assert.equal(loop.lastActivity, applied[1], mode);
  }
});

test('off and the applied shadow decision ignore an activity left in the loop by on', () => {
  const routeOf = ({ decision: d, lastRoute, lastActivity }) => [
    d.tier,
    d.activity,
    d.reason,
    d.model,
    d.effort,
    lastRoute,
    lastActivity,
  ];
  for (const mode of ['off', 'shadow'])
    for (const [name, setup] of [
      ['during a hold', { state: holding }],
      ['on a same-tier answer', {}],
      ['on a coding answer', { label: labelOf('code', 0.95) }],
      ['on a credits model above the cash cap', { tokens: 300_000 }],
    ]) {
      const config = loadConfig({
        userFile: {
          activityRouting: mode,
          ...(setup.tokens ? { models: { haiku: { billing: 'credits' } }, policy: { cashCapUsd: 0.05 } } : {}),
        },
      });
      const left = turn({ config, activity: 'code', loopActivity: 'code', ...setup });
      const clean = turn({ config, activity: 'code', loopActivity: null, ...setup });
      assert.deepEqual(routeOf(left), routeOf(clean), `${mode} ${name}`);
      assert.deepEqual(routeOf(left).slice(0, 5), ['low', null, routeOf(clean)[2], HAIKU, 'high'], `${mode} ${name}`);
    }
});
