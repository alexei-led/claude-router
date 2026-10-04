import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULTS } from '../lib/config.mjs';
import {
  chooseRoute,
  continueRoute,
  emptyLoop,
  isModelAllowed,
  nativeFacts,
  observeResponse,
  prepareLoop,
  resetHistory,
} from '../lib/native-router.mjs';

const now = 1_000_000;
const model = 'claude-sonnet-5-5';
const context = {
  messages: [{ role: 'user', content: 'Do one small edit.' }],
  prompt: 'Do one small edit.',
  effort: 'medium',
  turnId: 't1',
  contextTokens: 10_000,
};
const advice = { choice: 'micro', continuation: 0, probabilities: { micro: 0.99, low: 0, medium: 0.01, high: 0 } };
const input = (loop, overrides = {}) => ({
  facts: nativeFacts(DEFAULTS, loop, context),
  advice,
  pin: null,
  nativeModel: model,
  contextKnown: true,
  now,
  ...overrides,
});
const usage = (overrides = {}) => ({
  model,
  input_tokens: 100,
  cache_read_input_tokens: 900,
  cache_creation_input_tokens: 200,
  output_tokens: 50,
  ...overrides,
});

test('switch comparison needs observed usage and preserves savings and added-cost scenarios', () => {
  const initial = emptyLoop(DEFAULTS, model);
  assert.equal(chooseRoute(DEFAULTS, initial, input(initial)).decision.comparison, null);
  const observed = observeResponse(DEFAULTS, initial, {
    usage: usage({
      input_tokens: 2000,
      cache_read_input_tokens: 140_000,
      cache_creation_input_tokens: 8000,
      output_tokens: 1500,
    }),
    requestedModel: model,
    effort: 'medium',
    stopReason: 'end_turn',
    now,
  });
  const selected = chooseRoute(
    DEFAULTS,
    observed,
    input(observed, {
      facts: nativeFacts(DEFAULTS, observed, { ...context, contextTokens: 151_500 }),
    }),
  );
  const comparison = selected.decision.comparison;
  assert.equal(comparison.candidate, 'micro');
  assert.ok(comparison.minUsd < 0);
  assert.ok(comparison.maxUsd > 0);
  assert.equal(comparison.outputTokens, 1500);
  assert.equal(comparison.paybackTurns, 12);
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
  const loop = emptyLoop(DEFAULTS, model);
  const large = chooseRoute(
    DEFAULTS,
    loop,
    input(loop, { pin: 'micro', facts: nativeFacts(DEFAULTS, loop, { ...context, contextTokens: 589_000 }) }),
  );
  assert.equal(large.decision.model, model);
  assert.equal(large.decision.reason, 'context-fit');
  const unknown = chooseRoute(DEFAULTS, loop, input(loop, { pin: 'micro', contextKnown: false }));
  assert.equal(unknown.decision.model, model);
  assert.equal(unknown.decision.reason, 'context-unknown');
});

test('large tool results trigger fit without another turn vote', () => {
  const loop = observeResponse(DEFAULTS, emptyLoop(DEFAULTS, model), {
    usage: usage(),
    requestedModel: model,
    effort: 'medium',
    now,
  });
  const small = chooseRoute(DEFAULTS, loop, input(loop, { pin: 'micro' }));
  const large = continueRoute(DEFAULTS, small, {
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
  const initial = emptyLoop(DEFAULTS, model);
  const observed = observeResponse(DEFAULTS, initial, { usage: usage(), requestedModel: model, effort: 'medium', now });
  assert.equal(chooseRoute(DEFAULTS, observed, input(observed, { pin: 'micro' })).decision.tier, 'micro');
  for (const loop of [initial, resetHistory(observed)]) {
    const selected = chooseRoute(DEFAULTS, loop, input(loop, { pin: 'micro' }));
    assert.equal(selected.decision.model, model);
    assert.equal(selected.decision.reason, 'context-unknown');
  }
});

test('allowed models handle exact versions and alias narrowing', () => {
  for (const [id, allowed, expected] of [
    [model, undefined, true],
    [model, [], false],
    [model, ['sonnet'], true],
    [model, ['sonnet', 'claude-sonnet-4-5'], false],
    ['claude-haiku-4-5-20251001', ['claude-haiku-4-5'], true],
    ['custom.provider/model', ['custom.provider/model'], true],
    [model, ['default'], true],
    [model, 'invalid', false],
  ])
    assert.equal(isModelAllowed(id, allowed, model), expected);
});

test('a denied pin uses an allowed native model', () => {
  const loop = emptyLoop(DEFAULTS, model);
  const result = chooseRoute(DEFAULTS, loop, input(loop, { pin: 'high', availableModels: ['sonnet'] }));
  assert.equal(result.decision.model, model);
  assert.equal(result.decision.reason, 'model-unavailable');
});

test('an unknown context also blocks smaller windows in the fallback search', () => {
  const loop = emptyLoop(DEFAULTS, model);
  const result = chooseRoute(DEFAULTS, loop, input(loop, { contextKnown: false, availableModels: ['haiku'] }));
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
  assert.equal(observed.models[`${model}@medium`].prefixTokens, 1100);
  assert.equal(observed.lastRequest.tokens, 1200);
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
    assert.deepEqual(result.models, {});
    assert.deepEqual(result.state.votes, []);
    assert.equal(result.lastRequest.tokens, 700_000);
    assert.equal(result.generation, 1);
  }
});

test('window-exceeded responses latch the model without a retry', () => {
  const loop = observeResponse(DEFAULTS, emptyLoop(DEFAULTS, model), {
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
  const result = chooseRoute(DEFAULTS, failed, input(failed, { pin: 'micro' }));
  assert.equal(result.decision.model, model);
  assert.equal(result.decision.reason, 'model-unavailable');
});
