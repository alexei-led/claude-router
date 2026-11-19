import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULTS, loadConfig } from '../lib/config.mjs';
import { applyMode } from '../lib/modes.mjs';
import {
  cellForModel,
  chooseRoute,
  continueRoute,
  emptyLoop,
  isModelAllowed,
  isNativeFallback,
  nativeFacts,
  observedMove,
  observeResponse,
  prepareLoop,
  resetHistory,
} from '../lib/route.mjs';
import { advice as adviceOf, assistant, toolResult, user } from './helpers.mjs';

const now = 1_000_000;
const model = 'claude-haiku-5-5';
const context = {
  messages: [{ role: 'user', content: 'Do one small edit.' }],
  prompt: 'Do one small edit.',
  effort: 'medium',
  turnId: 't1',
  contextTokens: 10_000,
};
const tiny = {
  id: 'claude-haiku-4-5',
  input: 1,
  output: 5,
  cacheRead: 0.1,
  contextWindow: 200_000,
  billing: 'plan',
  efforts: [],
};
const SMALL_MICRO = loadConfig({ userFile: { models: { tiny }, routes: { micro: { model: 'tiny' } } } });
const advice = adviceOf('micro', { micro: 0.99, medium: 0.01 });
const input = (loop, overrides = {}, config = DEFAULTS) => ({
  facts: nativeFacts(config, loop, context),
  advice,
  pin: null,
  nativeModel: model,
  contextKnown: true,
  now,
  ...overrides,
});
const smallInput = (loop, overrides) => input(loop, overrides, SMALL_MICRO);
const usage = (overrides = {}) => ({
  model,
  input_tokens: 100,
  cache_read_input_tokens: 900,
  cache_creation_input_tokens: 200,
  output_tokens: 50,
  ...overrides,
});

test('switch comparison needs observed usage and preserves savings and added-cost scenarios', () => {
  const sonnet = 'claude-sonnet-5-5';
  const config = loadConfig({
    userFile: { models: { tiny }, routes: { micro: { model: 'tiny' }, low: { model: 'sonnet', effort: null } } },
  });
  const sonnetInput = (loop, overrides) => input(loop, { nativeModel: sonnet, ...overrides }, config);
  const initial = emptyLoop(config, sonnet);
  assert.equal(chooseRoute(config, initial, sonnetInput(initial)).decision.comparison, null);
  const observed = observeResponse(DEFAULTS, initial, {
    usage: usage({
      model: sonnet,
      input_tokens: 2000,
      cache_read_input_tokens: 140_000,
      cache_creation_input_tokens: 8000,
      output_tokens: 1500,
    }),
    requestedModel: sonnet,
    effort: 'medium',
    stopReason: 'end_turn',
    now,
  });
  const selected = chooseRoute(
    config,
    observed,
    sonnetInput(observed, {
      facts: nativeFacts(config, observed, { ...context, contextTokens: 151_500 }),
    }),
  );
  const comparison = selected.decision.comparison;
  assert.equal(comparison.candidate, 'micro');
  assert.equal(comparison.incumbent, 'low');
  assert.ok(comparison.minUsd < 0);
  assert.ok(comparison.maxUsd > 0);
  assert.equal(comparison.outputTokens, 1500);
  assert.equal(comparison.paybackTurns, 37);
});

test('a model without an output price still gets a finite input-only comparison', () => {
  const { output, ...inputOnly } = tiny;
  const config = loadConfig({ userFile: { models: { tiny: inputOnly }, routes: { micro: { model: 'tiny' } } } });
  const initial = emptyLoop(config, model);
  const observed = observeResponse(DEFAULTS, initial, {
    usage: usage({ input_tokens: 2000, cache_read_input_tokens: 140_000, cache_creation_input_tokens: 8000 }),
    requestedModel: model,
    effort: 'medium',
    stopReason: 'end_turn',
    now,
  });
  const facts = nativeFacts(config, observed, { ...context, contextTokens: 151_500 });
  const { comparison } = chooseRoute(config, observed, input(observed, { facts })).decision;
  assert.ok(Number.isFinite(comparison.minUsd) && Number.isFinite(comparison.maxUsd));
  assert.equal(comparison.paybackTurns, null);
});

test('native facts use engine turn ids and bounded prompt rather than tool output', () => {
  const facts = nativeFacts(DEFAULTS, emptyLoop(DEFAULTS, model), {
    ...context,
    prompt: 'x'.repeat(2000),
    messages: [{ role: 'user', content: [{ type: 'tool_result', content: 'PRIVATE_TOOL' }] }],
  });
  assert.equal(facts.turnKey, 't1');
  assert.equal(facts.prompt.length, DEFAULTS.context.maxTextChars);
  assert.equal(facts.pin, null);
  assert.equal(
    facts.turns.some((v) => v.text.includes('PRIVATE_TOOL')),
    false,
  );
});

test('fixing different tests keeps the route; repeating the same failure escalates', () => {
  const header =
    '> @alexeiled/claude-router@1.10.0 test\n' +
    '> node --test --test-timeout=8000 test/*.test.mjs experiments/mod-router/scripts/*.test.mjs\n\n';
  const failure = (name) => `${header}not ok 1 - ${name}\n  error: 'unauthorized'\n`;
  for (const [name, nextTest, tier, reason] of [
    ['progress to another test', 'logout', 'low', 'no-advice'],
    ['test name with a position', 'login at line 40', 'low', 'no-advice'],
    ['test name with different whitespace', 'login  at line 12', 'low', 'no-advice'],
    ['same failing test', 'login at line 12', 'medium', 'escalation'],
  ]) {
    const loop = emptyLoop(DEFAULTS, model);
    const facts = nativeFacts(DEFAULTS, loop, {
      ...context,
      messages: [
        user('fix the tests'),
        assistant('running', ['Bash']),
        toolResult(failure('login at line 12'), { isError: true }),
        assistant('editing', ['Edit']),
        toolResult(failure(nextTest), { isError: true }),
        user('continue'),
      ],
    });
    const { decision } = chooseRoute(DEFAULTS, loop, input(loop, { facts, advice: null }));
    assert.deepEqual([decision.tier, decision.reason], [tier, reason], name);
    assert.equal(decision.escalated, reason === 'escalation', name);
  }
});

test('a new or reset history switches on one vote; a measured one waits for the streak', () => {
  const initial = emptyLoop(DEFAULTS, model);
  const observed = observeResponse(DEFAULTS, initial, { usage: usage(), requestedModel: model, effort: 'high', now });
  const up = adviceOf('medium', { medium: 0.95, low: 0.05 });
  for (const [name, config, loop, vote, expected] of [
    ['session start, down', DEFAULTS, initial, advice, ['micro', 'downgrade']],
    ['session start, up', DEFAULTS, initial, up, ['medium', 'upgrade']],
    ['measured, down', DEFAULTS, observed, advice, ['low', 'downgrade-pending']],
    ['measured, up', DEFAULTS, observed, up, ['low', 'upgrade-pending']],
    ['history reset', DEFAULTS, resetHistory(observed), advice, ['micro', 'downgrade']],
    ['rewind', DEFAULTS, prepareLoop({ ...observed, lastMessageCount: 8 }, 4), up, ['medium', 'upgrade']],
    ['into a smaller window', SMALL_MICRO, emptyLoop(SMALL_MICRO, model), advice, ['low', 'context-unknown']],
  ]) {
    const { decision } = chooseRoute(config, loop, input(loop, { advice: vote }, config));
    assert.deepEqual([decision.tier, decision.reason], expected, name);
  }
});

test('native facts say whether this history has a measured reply', () => {
  const initial = emptyLoop(DEFAULTS, model);
  const observed = observeResponse(DEFAULTS, initial, { usage: usage(), requestedModel: model, effort: 'high', now });
  for (const [loop, measured] of [
    [initial, false],
    [observed, true],
    [resetHistory(observed), false],
  ])
    assert.equal(nativeFacts(DEFAULTS, loop, context).historyMeasured, measured);
});

test('pins and tool continuations do not replace the automatic incumbent or add votes', () => {
  const loop = emptyLoop(DEFAULTS, model);
  const pinned = chooseRoute(DEFAULTS, loop, input(loop, { pin: 'high' }));
  assert.equal(pinned.decision.model, 'claude-opus-5-5');
  assert.equal(pinned.lastRoute, loop.lastRoute);
  const continued = continueRoute(DEFAULTS, pinned, {
    nativeModel: model,
    contextTokens: 11_000,
    contextKnown: true,
    effort: 'medium',
  });
  assert.equal(continued.decision.model, 'claude-opus-5-5');
  assert.equal(continued.state.turn, 1);
  const resumed = chooseRoute(DEFAULTS, continued, input(continued, { advice: null }));
  assert.equal(resumed.decision.model, model);
});

test('large and unknown contexts cannot be pinned into a smaller window', () => {
  const loop = emptyLoop(SMALL_MICRO, model);
  const large = chooseRoute(
    SMALL_MICRO,
    loop,
    smallInput(loop, { pin: 'micro', facts: nativeFacts(SMALL_MICRO, loop, { ...context, contextTokens: 589_000 }) }),
  );
  assert.equal(large.decision.model, model);
  assert.equal(large.decision.reason, 'context-fit');
  const unknown = chooseRoute(SMALL_MICRO, loop, smallInput(loop, { pin: 'micro', contextKnown: false }));
  assert.equal(unknown.decision.model, model);
  assert.equal(unknown.decision.reason, 'context-unknown');
});

test('large tool results trigger fit without another turn vote', () => {
  const loop = observeResponse(DEFAULTS, emptyLoop(SMALL_MICRO, model), {
    usage: usage(),
    requestedModel: model,
    effort: 'medium',
    now,
  });
  const small = chooseRoute(SMALL_MICRO, loop, smallInput(loop, { pin: 'micro' }));
  const large = continueRoute(SMALL_MICRO, small, {
    nativeModel: model,
    contextTokens: 300_000,
    contextKnown: true,
    effort: 'medium',
  });
  assert.equal(large.decision.model, model);
  assert.equal(large.decision.reason, 'context-fit');
  assert.equal(large.state.turn, small.state.turn);
});

test('a local estimate alone cannot downgrade a new or reset history into a smaller window', () => {
  const initial = emptyLoop(SMALL_MICRO, model);
  const observed = observeResponse(DEFAULTS, initial, {
    usage: usage(),
    requestedModel: model,
    effort: 'medium',
    now,
  });
  assert.equal(chooseRoute(SMALL_MICRO, observed, smallInput(observed, { pin: 'micro' })).decision.tier, 'micro');
  for (const loop of [initial, resetHistory(observed)]) {
    const selected = chooseRoute(SMALL_MICRO, loop, smallInput(loop, { pin: 'micro' }));
    assert.equal(selected.decision.model, model);
    assert.equal(selected.decision.reason, 'context-unknown');
  }
});

test('allowed models handle exact versions and alias narrowing', () => {
  const sonnet = 'claude-sonnet-5-5';
  for (const [id, allowed, expected] of [
    [sonnet, undefined, true],
    [sonnet, [], false],
    [sonnet, ['sonnet'], true],
    [sonnet, ['sonnet', 'claude-sonnet-4-5'], false],
    ['claude-haiku-4-5-20251001', ['claude-haiku-4-5'], true],
    ['custom.provider/model', ['custom.provider/model'], true],
    [sonnet, ['default'], true],
    ['claude-fable-5-2', ['claude-fable-5-2'], true],
    ['claude-fable-5-2', ['claude-fable-5-1'], false],
    ['claude-fable-5-2', ['fable'], true],
    [sonnet, 'invalid', false],
  ])
    assert.equal(isModelAllowed(id, allowed, sonnet), expected);
});

test('a conversation too full for every route keeps the native model and says the context is full', () => {
  const loop = emptyLoop(DEFAULTS, model);
  const full = { ...context, contextTokens: 900_000 };
  const result = chooseRoute(DEFAULTS, loop, input(loop, { facts: nativeFacts(DEFAULTS, loop, full) }));
  assert.deepEqual(
    [result.decision.tier, result.decision.model, result.decision.reason],
    [null, model, 'context-full'],
  );
});

test('a denied pin uses an allowed native model', () => {
  const loop = emptyLoop(DEFAULTS, model);
  const result = chooseRoute(DEFAULTS, loop, input(loop, { pin: 'high', availableModels: ['sonnet'] }));
  assert.equal(result.decision.model, model);
  assert.equal(result.decision.reason, 'model-unavailable');
});

test("a fallback to an unavailable route keeps the turn's activity or passes the session model through", () => {
  const sonnet = 'claude-sonnet-5-5';
  const withActivity = (choice, tier = 'low') => ({
    ...adviceOf(tier, { [tier]: 0.95, medium: 0.05 }),
    activity: { choice, probabilities: { [choice]: 0.95 } },
  });
  for (const [name, loop, overrides, expected] of [
    ['no activity answer', emptyLoop(DEFAULTS, model), {}, [null, null, sonnet, 'medium', 'model-unavailable']],
    ['a pin', emptyLoop(DEFAULTS, model), { pin: 'high' }, [null, null, sonnet, 'medium', 'model-unavailable']],
    [
      'another activity',
      emptyLoop(DEFAULTS, sonnet),
      { advice: withActivity('explore') },
      [null, null, sonnet, 'medium', 'model-unavailable'],
    ],
    [
      'the same activity',
      emptyLoop(DEFAULTS, sonnet),
      { advice: withActivity('code', 'high') },
      ['low', 'code', sonnet, 'high', 'model-unavailable'],
    ],
  ]) {
    const { decision } = chooseRoute(
      DEFAULTS,
      loop,
      input(loop, { nativeModel: sonnet, availableModels: ['sonnet'], ...overrides }),
    );
    assert.deepEqual(
      [decision.tier, decision.activity, decision.model, decision.effort, decision.reason],
      expected,
      name,
    );
  }
});

test('an unknown context also blocks smaller windows in the fallback search', () => {
  const loop = emptyLoop(SMALL_MICRO, model);
  const result = chooseRoute(SMALL_MICRO, loop, smallInput(loop, { contextKnown: false, availableModels: ['tiny'] }));
  assert.equal(result.decision.tier, null);
  assert.equal(result.decision.model, model);
});

test('observations count cached input only and never merge different dated snapshots', () => {
  const observed = observeResponse(DEFAULTS, emptyLoop(DEFAULTS, model), {
    usage: usage(),
    requestedModel: model,
    effort: 'medium',
    now,
  });
  // Haiku 5.5 keeps one cache across efforts; a provider that splits it keys each effort.
  assert.equal(observed.models[model].prefixTokens, 1100);
  assert.equal(observed.lastRequest.tokens, 1200);
  const split = observeResponse({ ...DEFAULTS, effortSplitsCache: true }, emptyLoop(DEFAULTS, model), {
    usage: usage(),
    requestedModel: model,
    effort: 'medium',
    now,
  });
  assert.deepEqual(Object.keys(split.models), [`${model}@medium`]);
  const dated = observeResponse(DEFAULTS, observed, {
    usage: usage({ model: 'claude-haiku-4-5-20251001' }),
    requestedModel: 'claude-haiku-4-5',
    effort: null,
    now,
  });
  assert.equal(dated.resolutions['claude-haiku-4-5'], 'claude-haiku-4-5-20251001');
  const moved = observeResponse(DEFAULTS, dated, {
    usage: usage({ model: 'claude-haiku-4-5-20270101' }),
    requestedModel: 'claude-haiku-4-5',
    effort: null,
    now,
  });
  assert.equal(Object.hasOwn(moved.resolutions, 'claude-haiku-4-5'), false);
  assert.equal(Object.hasOwn(moved.models, 'claude-haiku-4-5-20270101'), false);
});

test('incomplete usage cannot erase the last context measurement', () => {
  const loop = { ...emptyLoop(DEFAULTS, model), lastRequest: { tokens: 700_000, outputTokens: 10 } };
  for (const u of [
    usage({ input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
    usage({ input_tokens: -1 }),
  ]) {
    assert.equal(
      observeResponse(DEFAULTS, loop, { usage: u, requestedModel: model, effort: null, now }).lastRequest.tokens,
      700_000,
    );
  }
});

test('rewind clears votes and warmth but retains the context floor', () => {
  const loop = {
    ...emptyLoop(DEFAULTS, model),
    models: { seen: {} },
    lastMessageCount: 20,
    lastRequest: { tokens: 700_000, outputTokens: 50 },
    state: { turn: 10, votes: [{ tier: 'high' }], holdUntilTurn: 12 },
  };
  for (const result of [prepareLoop(loop, 10), resetHistory(loop)]) {
    assert.equal(result.turnId, loop.turnId);
    assert.deepEqual(result.models, {});
    assert.deepEqual(result.state.votes, []);
    assert.equal(result.lastRequest.tokens, 700_000);
    assert.equal(result.generation, 1);
  }
});

test('window-exceeded responses latch the model without a retry', () => {
  const loop = observeResponse(DEFAULTS, emptyLoop(SMALL_MICRO, model), {
    usage: usage(),
    requestedModel: model,
    effort: 'medium',
    now,
  });
  const failed = observeResponse(DEFAULTS, loop, {
    usage: null,
    requestedModel: 'claude-haiku-4-5',
    effort: null,
    stopReason: 'model_context_window_exceeded',
    now,
  });
  const result = chooseRoute(SMALL_MICRO, failed, smallInput(failed, { pin: 'micro' }));
  assert.equal(result.decision.model, model);
  assert.equal(result.decision.reason, 'model-unavailable');
});

test('isNativeFallback: a model the router neither saw nor chose is an engine fallback', () => {
  const routed = { engineModel: 'claude-sonnet-5-5', decision: { model: 'claude-haiku-4-5' } };
  for (const [name, loop, served, fallback] of [
    ['the engine model again', routed, 'claude-sonnet-5-5', false],
    ['the routed model echoed', routed, 'claude-haiku-4-5', false],
    ['a dated snapshot of the routed model', routed, 'claude-haiku-4-5-20251001', false],
    ['a third model', routed, 'claude-opus-5-5', true],
    ['a suspended loop', { ...routed, suspended: true }, 'claude-sonnet-5-5', true],
    ['nothing known yet', {}, 'claude-opus-5-5', false],
  ])
    assert.equal(isNativeFallback(loop, served), fallback, name);
});

test('cellForModel searches base routes first, and activity overrides only in on mode', () => {
  const custom = { userFile: { activities: { review: { high: { model: 'sonnet', effort: 'max' } } } } };
  for (const [mode, id, file, expected] of [
    ['off', 'claude-sonnet-5-5', {}, null],
    ['on', 'claude-sonnet-5-5', {}, { tier: 'low', activity: 'code' }],
    ['on', model, {}, { tier: 'low', activity: null }],
    ['on', 'claude-opus-5-5', {}, { tier: 'medium', activity: null }],
    ['on', 'gpt-x', {}, null],
    ['on', 'claude-sonnet-5-5', { baselineTier: 'high', ...custom.userFile }, { tier: 'high', activity: 'review' }],
  ]) {
    const config = loadConfig({ userFile: { ...file, activityRouting: mode } });
    assert.deepEqual(cellForModel(config, id), expected, `${mode} ${id}`);
    const loop = emptyLoop(config, id);
    assert.deepEqual(
      [loop.lastRoute, loop.lastActivity],
      [expected?.tier ?? config.baselineTier, expected?.activity ?? null],
      `${mode} ${id} loop`,
    );
  }
});

test('a tool continuation keeps the activity and fits the context through its route', () => {
  const config = loadConfig({
    userFile: { activityRouting: 'on', models: { tiny }, activities: { code: { low: { model: 'tiny' } } } },
  });
  const decision = { tier: 'low', activity: 'code', reason: 'activity-up', model: tiny.id, effort: null };
  const loop = { ...emptyLoop(config, model), decision };
  const go = (contextTokens) =>
    continueRoute(config, loop, { nativeModel: model, contextTokens, contextKnown: true, effort: 'medium' }).decision;
  assert.deepEqual(go(20_000), decision);
  const grown = go(300_000);
  assert.deepEqual(
    [grown.tier, grown.activity, grown.model, grown.effort, grown.reason],
    ['medium', 'code', 'claude-opus-5-5', 'medium', 'context-fit'],
  );
  const unavailable = continueRoute(config, loop, {
    nativeModel: model,
    contextTokens: 20_000,
    contextKnown: true,
    availableModels: ['sonnet'],
    effort: 'medium',
  }).decision;
  assert.deepEqual([unavailable.tier, unavailable.activity, unavailable.model], [null, null, model]);
});

test("a route the context outgrows moves up the activity's routes; an unknown context returns to the running cell", () => {
  const config = loadConfig({
    userFile: { activityRouting: 'on', models: { tiny }, activities: { code: { low: { model: 'tiny' } } } },
  });
  const label = { choice: 'code', probabilities: { code: 0.95, uncertain: 0.05 } };
  const loop = observeResponse(DEFAULTS, emptyLoop(config, model), {
    usage: usage(),
    requestedModel: model,
    effort: 'medium',
    now,
  });
  const large = { facts: nativeFacts(config, loop, { ...context, contextTokens: 300_000 }) };
  for (const [name, overrides, expected] of [
    ['fits', {}, ['low', 'code', 'activity-up', 'claude-haiku-4-5']],
    ['too large for the override', large, ['medium', 'code', 'context-fit', 'claude-opus-5-5']],
    ['unknown context', { contextKnown: false }, ['low', null, 'context-unknown', model]],
  ]) {
    const vote = adviceOf('low', { low: 0.99 });
    const { decision } = chooseRoute(
      config,
      loop,
      input(loop, { advice: { ...vote, activity: label }, ...overrides }, config),
    );
    assert.deepEqual([decision.tier, decision.activity, decision.reason, decision.model], expected, name);
  }
});

test('a turn moves up to the route its own tool calls show, never down, and not when pinned or off', () => {
  const on = loadConfig({ userFile: {} });
  const off = loadConfig({ userFile: { activityRouting: 'off' } });
  const routed = (config, activity, pinned = false) => ({
    ...emptyLoop(config, model),
    lastRoute: 'medium',
    lastActivity: activity,
    decision: { tier: 'medium', activity, model, effort: 'high', reason: 'activity-down', pinned },
  });
  for (const [name, config, loop, observed, expected] of [
    ['ops edits code', on, routed(on, 'ops'), 'code', ['code', 'claude-opus-5-5', 'medium', 'activity-up']],
    ['ops only runs commands', on, routed(on, 'ops'), 'ops', ['ops', model, 'high', 'activity-down']],
    ['ops only reads', on, routed(on, 'ops'), 'read', ['ops', model, 'high', 'activity-down']],
    ['pinned turn', on, routed(on, 'ops', true), 'code', ['ops', model, 'high', 'activity-down']],
    ['activity routing off', off, routed(off, 'ops'), 'code', ['ops', model, 'high', 'activity-down']],
  ]) {
    const facts = nativeFacts(config, loop, context);
    const { decision } = observedMove(config, loop, { observed, facts, contextKnown: true, now });
    assert.deepEqual([decision.activity, decision.model, decision.effort, decision.reason], expected, name);
  }
});

test('an observed move to a smaller window waits for a measured context, as a routed turn does', () => {
  const config = loadConfig({
    userFile: { models: { tiny: { ...tiny, strength: 2 } }, activities: { code: { medium: { model: 'tiny' } } } },
  });
  const loop = {
    ...emptyLoop(config, model),
    lastRoute: 'medium',
    lastActivity: 'ops',
    decision: { tier: 'medium', activity: 'ops', model, effort: 'high', reason: 'activity-down', pinned: false },
  };
  const facts = nativeFacts(config, loop, context);
  for (const [name, contextKnown, measured, expected] of [
    ['measured', true, true, 'claude-haiku-4-5'],
    ['context unknown', false, true, model],
    ['history not measured', true, false, model],
  ]) {
    const { decision } = observedMove(
      config,
      { ...loop, historyMeasured: measured },
      { observed: 'code', facts, contextKnown, now },
    );
    assert.equal(decision.model, expected, name);
  }
});

test('the first response a loop serves starts the dwell and the verification window', () => {
  const initial = { ...emptyLoop(DEFAULTS, model), lastMessageCount: 40 };
  const first = observeResponse(DEFAULTS, initial, { usage: usage(), requestedModel: model, effort: 'high', now });
  assert.deepEqual(first.switchedAt, { requests: 1, messageCount: 40 });
  const same = observeResponse(
    DEFAULTS,
    { ...first, lastMessageCount: 42 },
    { usage: usage(), requestedModel: model, effort: 'high', now },
  );
  assert.deepEqual(same.switchedAt, { requests: 1, messageCount: 40 });
});

test('a shortened history moves the checkpoint and edit cursors to its end and keeps the dwell', () => {
  const loop = {
    ...emptyLoop(DEFAULTS, model),
    lastMessageCount: 200,
    requests: 30,
    switchedAt: { requests: 25, messageCount: 180 },
    observedFrom: 190,
  };
  for (const [name, count, expected] of [
    ['compaction', 20, [{ requests: 25, messageCount: 20 }, 20]],
    ['growth', 210, [{ requests: 25, messageCount: 180 }, 190]],
  ]) {
    const next = prepareLoop(loop, count);
    assert.deepEqual([next.switchedAt, next.observedFrom], expected, name);
  }
  assert.equal(prepareLoop({ ...loop, switchedAt: null }, 20).switchedAt, null);
});

test('routing turned on for a model no tier routes to keeps it running: failures never escalate to a weaker route', () => {
  const fable = 'claude-fable-5-2';
  const cost = applyMode(DEFAULTS, { mode: 'cost', source: 'session' });
  const failure = "not ok 1 - login\n  error: 'unauthorized'\n";
  const messages = [
    user('fix the tests'),
    assistant('running', ['Bash']),
    toolResult(failure, { isError: true }),
    assistant('editing', ['Edit']),
    toolResult(failure, { isError: true }),
    user('continue'),
  ];
  // Routing was off while Fable served the session; the loop saw its replies.
  const loop = observeResponse(DEFAULTS, emptyLoop(DEFAULTS, fable), {
    usage: usage({ model: fable, cache_read_input_tokens: 350_000 }),
    requestedModel: fable,
    effort: 'xhigh',
    stopReason: 'tool_use',
    now,
  });
  const facts = nativeFacts(cost, loop, { ...context, messages, effort: 'xhigh', contextTokens: 353_000 });
  assert.ok(facts.failure);
  const sameTask = { continuation: 0.86 };
  for (const [name, answer, reason] of [
    ['no classifier answer', null, 'no-advice'],
    ['an uncertain answer on the running task', adviceOf('uncertain', { uncertain: 0.3 }, sameTask), 'downgrade-held'],
  ]) {
    const { decision } = chooseRoute(cost, loop, input(loop, { facts, advice: answer, nativeModel: fable }, cost));
    assert.deepEqual([decision.model, decision.effort, decision.reason], [fable, 'xhigh', reason], name);
    assert.equal(decision.escalated, false, name);
  }
});

const OPUS = 'claude-opus-5-5';
const heldOpus = (until = now + 300_000) => ({
  ...emptyLoop(DEFAULTS, OPUS),
  held: { [OPUS]: { error: 'overloaded', until } },
});
const opusInput = (loop, overrides = {}) =>
  input(loop, { nativeModel: OPUS, advice: adviceOf('medium', { medium: 0.97, high: 0.03 }), ...overrides });

test('a held-out model routes the turn to the nearest tier on another model and keeps the held route for later', () => {
  const loop = heldOpus();
  const result = chooseRoute(DEFAULTS, loop, opusInput(loop));
  assert.deepEqual(
    [result.decision.tier, result.decision.model, result.decision.effort, result.decision.reason],
    ['low', 'claude-haiku-5-5', 'high', 'model-held'],
  );
  assert.equal(result.lastRoute, loop.lastRoute);
  assert.equal(result.route, loop.route);
});

test('a held-out model at the turn’s activity falls to that activity’s nearest route', () => {
  const loop = heldOpus();
  const code = {
    ...adviceOf('medium', { medium: 0.97, high: 0.03 }),
    activity: { choice: 'code', probabilities: { code: 0.95 } },
  };
  const { decision } = chooseRoute(DEFAULTS, loop, opusInput(loop, { advice: code }));
  assert.deepEqual(
    [decision.tier, decision.model, decision.effort, decision.reason],
    ['low', 'claude-sonnet-5-5', 'high', 'model-held'],
  );
});

test('a pinned turn on a held-out model runs the fallback and names the hold', () => {
  const loop = heldOpus();
  const { decision } = chooseRoute(DEFAULTS, loop, opusInput(loop, { pin: 'high' }));
  assert.deepEqual([decision.pinned, decision.model, decision.reason], [true, 'claude-haiku-5-5', 'model-held']);
});

test('once the hold ends the next turn runs the held model again', () => {
  const loop = heldOpus(now);
  const { decision } = chooseRoute(DEFAULTS, loop, opusInput(loop));
  assert.deepEqual([decision.tier, decision.model], ['medium', OPUS]);
  assert.notEqual(decision.reason, 'model-held');
});

test('a compaction keeps the holds', () => {
  assert.deepEqual(resetHistory(heldOpus()).held, heldOpus().held);
});

const holdOpusUntil = (loop, until) => ({ ...loop, held: { [OPUS]: { error: 'overloaded', until } } });

for (const [name, until, expected] of [
  ['while Opus is held out the turn stays on its route', now + 300_000, ['ops', model]],
  ['once the hold ends the turn moves up to Opus', now, ['code', OPUS]],
])
  test(`a turn whose tool calls edit code: ${name}`, () => {
    const routed = holdOpusUntil(
      {
        ...emptyLoop(DEFAULTS, model),
        lastRoute: 'medium',
        lastActivity: 'ops',
        decision: { tier: 'medium', activity: 'ops', model, effort: 'high', reason: 'activity-down', pinned: false },
      },
      until,
    );
    const facts = nativeFacts(DEFAULTS, routed, context);
    const { decision } = observedMove(DEFAULTS, routed, { observed: 'code', facts, contextKnown: true, now });
    assert.deepEqual([decision.activity, decision.model], expected);
  });

for (const [name, until, expected] of [
  ['a held-out route is not taken', now + 300_000, [null, model]],
  ['an ended hold lets the route run', now, ['medium', OPUS]],
])
  test(`a tool continuation the context outgrows into Opus: ${name}`, () => {
    const config = loadConfig({ userFile: { models: { tiny }, routes: { low: { model: 'tiny' } } } });
    const decision = { tier: 'low', activity: null, route: { model: 'tiny' }, model: tiny.id, effort: null };
    const loop = holdOpusUntil({ ...emptyLoop(config, model), decision }, until);
    const continued = continueRoute(config, loop, {
      nativeModel: model,
      contextTokens: 300_000,
      contextKnown: true,
      effort: 'medium',
      now,
    }).decision;
    assert.deepEqual([continued.tier, continued.model], expected);
  });

for (const [name, until, expected] of [
  ['skips the held-out tiers', now + 300_000, ['micro', model]],
  ['takes the strongest once the hold ends', now, ['high', OPUS]],
])
  test(`a tool continuation with images on a route that takes none ${name}`, () => {
    const config = loadConfig({
      userFile: { models: { tiny: { ...tiny, imageInput: false } }, routes: { low: { model: 'tiny' } } },
    });
    const decision = { tier: 'low', activity: null, route: { model: 'tiny' }, model: tiny.id, effort: null };
    const loop = holdOpusUntil({ ...emptyLoop(config, model), decision }, until);
    const continued = continueRoute(config, loop, {
      nativeModel: model,
      contextTokens: 20_000,
      contextKnown: true,
      effort: 'medium',
      hasImages: true,
      now,
    }).decision;
    assert.deepEqual([continued.tier, continued.model], expected);
  });

test('an escalation a hold turned away still escalates on the same failure once the hold ends', () => {
  const failure = "not ok 1 - login\n  error: 'unauthorized'\n";
  const messages = [
    user('fix the tests'),
    assistant('running', ['Bash']),
    toolResult(failure, { isError: true }),
    assistant('editing', ['Edit']),
    toolResult(failure, { isError: true }),
    user('continue'),
  ];
  const failing = (loop, at) =>
    input(loop, { facts: nativeFacts(DEFAULTS, loop, { ...context, messages }), advice: null, now: at });
  const loop = holdOpusUntil(emptyLoop(DEFAULTS, model), now + 300_000);
  const during = chooseRoute(DEFAULTS, loop, failing(loop, now));
  assert.deepEqual([during.decision.tier, during.decision.model, during.decision.reason], ['low', model, 'model-held']);
  const after = chooseRoute(DEFAULTS, during, failing(during, now + 300_000));
  assert.deepEqual([after.decision.tier, after.decision.model, after.decision.reason], ['medium', OPUS, 'escalation']);
});

// Sonnet ran medium before a mode change made the configured medium route Opus; no classifier answer moves it.
for (const [name, held, expected] of [
  ['unheld, it keeps running', undefined, 'claude-sonnet-5-5'],
  ['held, Opus replaces it, and stays after the hold', { error: 'overloaded', until: now + 300_000 }, OPUS],
])
  test(`a route kept apart from its tier’s configured route, ${name}`, () => {
    const loop = {
      ...emptyLoop(DEFAULTS, OPUS),
      route: { model: 'sonnet', effort: 'high' },
      held: held && { 'claude-sonnet-5-5': held },
    };
    const during = chooseRoute(DEFAULTS, loop, opusInput(loop, { advice: null }));
    const after = chooseRoute(DEFAULTS, during, opusInput(during, { advice: null, now: now + 300_000 }));
    assert.deepEqual(
      [during.decision.model, during.decision.reason, after.decision.model],
      [expected, 'no-advice', expected],
    );
  });

test('a real reply from a held model drops its hold and streak; an empty or substituted reply keeps them', () => {
  const hold = { kind: 'availability', error: 'overloaded', since: now - 600_000, until: now - 300_000, streak: 2 };
  const loop = { ...emptyLoop(DEFAULTS, model), held: { [model]: hold } };
  const reply = (extra = {}, usageOver = {}) =>
    observeResponse(DEFAULTS, loop, {
      usage: usage({ model, ...usageOver }),
      requestedModel: model,
      effort: 'medium',
      stopReason: 'end_turn',
      now,
      ...extra,
    });
  assert.deepEqual(reply().held, {});
  assert.deepEqual(reply({ usage: null }).held, { [model]: hold });
  assert.deepEqual(reply({}, { model: 'claude-sonnet-5-5' }).held, { [model]: hold });
  assert.equal(
    observeResponse(DEFAULTS, emptyLoop(DEFAULTS, model), {
      usage: usage({ model }),
      requestedModel: model,
      effort: 'medium',
      stopReason: 'end_turn',
      now,
    }).held,
    undefined,
  );
});

const GLM = {
  id: 'glm-5.3[1m]',
  input: 1,
  output: 2,
  cacheRead: 0.1,
  contextWindow: 1_000_000,
  billing: 'credits',
  efforts: ['high', 'max'],
};
const KIMI = { ...GLM, id: 'kimi-k3.1-pro[1m]', requiresOwnHistory: true };
const chained = (userFile) => loadConfig({ userFile: { models: { glm: GLM }, ...userFile } });
const FALLBACKS = chained({ fallbacks: { opus: ['glm@max', 'sonnet'] } });
const planHold = (until = now + 300_000) => ({ kind: 'window', error: 'rate_limit', since: now, until, streak: 1 });
const standInDecision = (config, loop, overrides) => {
  const facts = nativeFacts(config, loop, context);
  return chooseRoute(config, loop, {
    ...opusInput(loop, { facts, ...overrides }),
  });
};

test('a fallback target in no tier stands in for the held-out model and its continuation, then routing returns', () => {
  const loop = heldOpus();
  const result = standInDecision(FALLBACKS, loop);
  const { decision } = result;
  assert.deepEqual(
    [decision.tier, decision.model, decision.effort, decision.reason, decision.fallback],
    ['medium', GLM.id, 'max', 'model-held', { from: 'opus', step: 1, of: 2 }],
  );
  assert.deepEqual(decision.route, { model: 'glm', effort: 'max' });
  assert.equal(result.route, loop.route);
  assert.equal(result.lastRoute, loop.lastRoute);
  const continued = continueRoute(FALLBACKS, result, {
    nativeModel: OPUS,
    contextTokens: 20_000,
    contextKnown: true,
    effort: 'medium',
    now: now + 1000,
  });
  assert.deepEqual(
    [continued.decision.model, continued.decision.effort, continued.decision.reason],
    [GLM.id, 'max', 'model-held'],
  );
  const after = standInDecision(FALLBACKS, result, { now: now + 300_000 }).decision;
  assert.deepEqual([after.tier, after.model, after.fallback], ['medium', OPUS, undefined]);
});

test('a bare chain entry runs at the source’s effort, clamped to what the target supports', () => {
  const loop = heldOpus();
  for (const [target, model, effort] of [
    ['sonnet', 'claude-sonnet-5-5', 'medium'],
    ['glm', GLM.id, 'high'],
  ]) {
    const { decision } = standInDecision(chained({ fallbacks: { opus: [target] } }), loop);
    assert.deepEqual(
      [decision.model, decision.effort, decision.route],
      [model, effort, { model: target, effort: null }],
    );
  }
});

test('a pinned turn keeps its tier and the stand-in runs it', () => {
  const loop = heldOpus();
  const { decision } = standInDecision(FALLBACKS, loop, { pin: 'high' });
  assert.deepEqual(
    [decision.pinned, decision.tier, decision.model, decision.reason],
    [true, 'high', GLM.id, 'model-held'],
  );
});

test('an account hold skips every model of the account in a chain', () => {
  const config = chained({ fallbacks: { opus: ['sonnet', 'haiku', 'glm@high'] } });
  const loop = emptyLoop(config, OPUS);
  const { decision } = standInDecision(config, loop, { accountHolds: { plan: planHold() } });
  assert.deepEqual(
    [decision.model, decision.reason, decision.fallback],
    [GLM.id, 'model-held', { from: 'opus', step: 3, of: 3 }],
  );
});

test('an account hold that ended holds nothing', () => {
  const config = chained({ fallbacks: { opus: ['glm@high'] } });
  const loop = emptyLoop(config, OPUS);
  const { decision } = standInDecision(config, loop, { accountHolds: { plan: planHold(now) } });
  assert.deepEqual([decision.model, decision.fallback], [OPUS, undefined]);
});

for (const [name, change] of [
  ['one the session is not allowed to use', { availableModels: ['opus', 'sonnet'] }],
  ['one this turn sent too much context to', { loopOver: { ineligible: [GLM.id] } }],
  ['one that is itself held out', { loopOver: { held: { [GLM.id]: { error: 'overloaded', until: now + 60_000 } } } }],
])
  test(`a chain skips ${name}, to the next target`, () => {
    const loop = { ...heldOpus(), ...change.loopOver, held: { ...heldOpus().held, ...change.loopOver?.held } };
    const config = chained({ fallbacks: { opus: ['glm@max', 'sonnet'] } });
    const { decision } = standInDecision(config, loop, { availableModels: change.availableModels });
    assert.deepEqual([decision.model, decision.fallback], ['claude-sonnet-5-5', { from: 'opus', step: 2, of: 2 }]);
  });

test('a chain skips a target that takes no images, or whose window the context fills', () => {
  const noImages = chained({ models: { glm: { ...GLM, imageInput: false } }, fallbacks: { opus: ['glm', 'sonnet'] } });
  const loop = heldOpus();
  const facts = { ...nativeFacts(noImages, loop, context), hasImages: true };
  assert.equal(standInDecision(noImages, loop, { facts }).decision.model, 'claude-sonnet-5-5');
  const small = chained({
    models: { glm: { ...GLM, contextWindow: 100_000 } },
    fallbacks: { opus: ['glm', 'sonnet'] },
  });
  const full = { ...nativeFacts(small, loop, context), contextTokens: 95_000 };
  assert.equal(standInDecision(small, loop, { facts: full }).decision.model, 'claude-sonnet-5-5');
});

test('a chain skips a smaller window while the context is unmeasured', () => {
  const small = chained({
    models: { glm: { ...GLM, contextWindow: 200_000 } },
    fallbacks: { opus: ['glm', 'sonnet'] },
  });
  const loop = { ...heldOpus(), historyMeasured: true };
  assert.equal(standInDecision(small, loop, { contextKnown: false }).decision.model, 'claude-sonnet-5-5');
  assert.equal(standInDecision(small, { ...loop, historyMeasured: false }).decision.model, 'claude-sonnet-5-5');
  assert.equal(standInDecision(small, loop).decision.model, small.models.glm.id);
});

test('a chain with every target skipped falls back to the nearest tier', () => {
  const config = chained({ fallbacks: { opus: ['glm@max'] } });
  const loop = { ...heldOpus(), ineligible: [GLM.id] };
  const { decision } = standInDecision(config, loop);
  assert.deepEqual(
    [decision.tier, decision.model, decision.reason, decision.fallback],
    ['low', 'claude-haiku-5-5', 'model-held', undefined],
  );
});

test('a model without a chain still falls to the nearest tier', () => {
  const loop = heldOpus();
  const { decision } = standInDecision(chained({ fallbacks: { sonnet: ['glm'] } }), loop);
  assert.deepEqual([decision.tier, decision.model, decision.fallback], ['low', 'claude-haiku-5-5', undefined]);
});

test('the nearest tier never switches into a model that reads only its own history', () => {
  const config = loadConfig({
    userFile: { models: { kimi: KIMI }, routes: { low: { model: 'kimi', effort: 'high' } } },
  });
  const loop = heldOpus();
  const { decision } = standInDecision(config, loop);
  assert.deepEqual([decision.tier, decision.model, decision.reason], ['micro', 'claude-haiku-5-5', 'model-held']);
});

test('a held model that reads only its own history gets no stand-in from another model', () => {
  const config = loadConfig({
    userFile: { models: { kimi: KIMI }, routes: { low: { model: 'kimi', effort: 'high' } } },
  });
  const loop = { ...emptyLoop(config, KIMI.id), held: { [KIMI.id]: { error: 'overloaded', until: now + 300_000 } } };
  const { decision } = chooseRoute(
    config,
    loop,
    input(loop, { nativeModel: KIMI.id, advice: adviceOf('low', { low: 0.97, medium: 0.03 }) }, config),
  );
  assert.deepEqual([decision.tier, decision.model, decision.reason], [null, KIMI.id, 'model-held']);
});

test('routing returns to the source model when its hold ends, whether or not a model reads only its own history', () => {
  const config = loadConfig({
    userFile: { models: { kimi: KIMI }, routes: { low: { model: 'kimi', effort: 'high' } } },
  });
  const opus = heldOpus();
  const stoodIn = standInDecision(config, opus).decision;
  assert.equal(stoodIn.model, 'claude-haiku-5-5');
  assert.equal(standInDecision(config, opus, { now: now + 300_000 }).decision.model, OPUS);

  const held = { ...emptyLoop(config, KIMI.id), held: { [KIMI.id]: { error: 'overloaded', until: now + 300_000 } } };
  const decideKimi = (at) =>
    chooseRoute(
      config,
      held,
      input(held, { nativeModel: KIMI.id, advice: adviceOf('low', { low: 0.97, medium: 0.03 }), now: at }, config),
    ).decision;
  assert.deepEqual([decideKimi(now).tier, decideKimi(now).reason], [null, 'model-held']);
  assert.deepEqual([decideKimi(now + 300_000).tier, decideKimi(now + 300_000).model], ['low', KIMI.id]);
});

test('an account hold covers a chain’s own source model and the stand-in ends up on another account', () => {
  const config = chained({ fallbacks: { sonnet: ['glm@high'] }, routes: { medium: { model: 'sonnet' } } });
  const loop = emptyLoop(config, 'claude-sonnet-5-5');
  const { decision } = standInDecision(config, loop, { accountHolds: { plan: planHold() } });
  assert.deepEqual([decision.tier, decision.model], ['medium', GLM.id]);
});

test('an account hold keeps a turn’s own tool calls and a growing context off the models it covers', () => {
  const routed = {
    ...emptyLoop(DEFAULTS, model),
    lastRoute: 'medium',
    lastActivity: 'ops',
    decision: { tier: 'medium', activity: 'ops', model, effort: 'high', reason: 'activity-down', pinned: false },
  };
  const facts = nativeFacts(DEFAULTS, routed, context);
  const accountHolds = { plan: planHold() };
  const moved = observedMove(DEFAULTS, routed, { observed: 'code', facts, contextKnown: true, accountHolds, now });
  assert.equal(moved, routed);
  const config = loadConfig({ userFile: { models: { tiny }, routes: { low: { model: 'tiny' } } } });
  const tiny200 = { tier: 'low', activity: null, route: { model: 'tiny' }, model: tiny.id, effort: null };
  const continued = continueRoute(
    config,
    { ...emptyLoop(config, model), decision: tiny200 },
    {
      nativeModel: model,
      contextTokens: 300_000,
      contextKnown: true,
      effort: 'medium',
      accountHolds,
      now,
    },
  ).decision;
  assert.deepEqual([continued.tier, continued.model], [null, model]);
});
