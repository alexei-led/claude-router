import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../lib/config.mjs';
import { applyMode } from '../lib/modes.mjs';
import { chooseRoute, continueRoute, emptyLoop, nativeFacts, observeResponse } from '../lib/route.mjs';
import { advice, toolResult, user } from './helpers.mjs';

const OPUS = 'claude-opus-5-5';
const HAIKU = 'claude-haiku-5-5';
const T0 = 1_000_000;
const base = loadConfig();
const inMode = (mode, config = base) => applyMode(config, { mode, source: 'session' });
const bash = (id, command) => ({
  role: 'assistant',
  content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }],
});
const ran = (id) => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: false }] });
const UNVERIFIED = [user('Fix it.')];
const VERIFIED = [user('Fix it.'), bash('v', 'npm test'), ran('v')];
const HIGH = advice('high', { high: 0.99, medium: 0.01 }, { continuation: 0.9 });
const NEW_TASK = advice('high', { high: 0.99, medium: 0.01 });

// One reply on the route the loop's decision chose, with `fresh` tokens past the cached prefix, which either route
// writes to the cache. `config` decides the cache keys the reply warms (per effort where effort splits the cache).
function reply(loop, at, fresh = 600, config = base) {
  return observeResponse(config, loop, {
    usage: {
      model: OPUS,
      input_tokens: fresh,
      cache_read_input_tokens: 50_000,
      cache_creation_input_tokens: 0,
      output_tokens: 500,
    },
    requestedModel: loop.decision.model,
    effort: loop.decision.effort,
    stopReason: 'end_turn',
    now: at,
  });
}

function turn(
  config,
  loop,
  { messages = UNVERIFIED, answer = HIGH, at = T0, pin = null, contextTokens = 0, contextKnown = true } = {},
) {
  const facts = nativeFacts(config, loop, {
    messages,
    prompt: 'Fix it.',
    effort: 'high',
    turnId: `t${at}`,
    contextTokens,
  });
  return chooseRoute(config, loop, { facts, advice: answer, pin, nativeModel: OPUS, contextKnown, now: at });
}

// A session that has run a few replies at high on Opus/xhigh in balanced.
function onOpusXhigh(config = base) {
  let loop = { ...emptyLoop(config, OPUS), lastRoute: 'high' };
  loop = turn(config, loop);
  assert.deepEqual([loop.decision.model, loop.decision.effort], [OPUS, 'xhigh']);
  for (let i = 0; i < 2; i += 1) loop = reply(loop, T0 + i, 600, config);
  return loop;
}

const ran_ = (loop) => `${loop.decision.model}@${loop.decision.effort}`;

for (const fresh of [600, 7000])
  test(`a cost switch at high waits out the dwell on the same task, then stays on Opus/high (${fresh} new tokens)`, () => {
    sameTierCostSwitch(fresh);
  });

function sameTierCostSwitch(fresh) {
  const cost = inMode('cost');
  let loop = onOpusXhigh();
  // The mode changed the preferred route; the route in use stays until the dwell (4 requests in cost) has passed
  // and a check passed: a passed check inside the dwell, then a dwell without one.
  for (let i = 0; i < 4; i += 1) {
    loop = turn(cost, loop, { messages: i === 0 ? VERIFIED : UNVERIFIED, at: T0 + 10 + i });
    assert.equal(ran_(loop), `${OPUS}@xhigh`, `request ${i}`);
    assert.equal(loop.decision.reason, 'downgrade-held');
    loop = reply(loop, T0 + 10 + i, fresh);
  }
  loop = turn(cost, loop, { messages: VERIFIED, at: T0 + 20 });
  assert.equal(ran_(loop), `${OPUS}@high`);
  assert.equal(loop.decision.lateral, 'taken');
  assert.deepEqual(loop.route, { model: 'opus', effort: 'high' });
  // Later requests start from the configured route again, never from the one in use: no further step down.
  for (let i = 0; i < 6; i += 1) {
    loop = reply(loop, T0 + 30 + i, fresh);
    loop = turn(cost, loop, { messages: VERIFIED, at: T0 + 30 + i });
    assert.equal(ran_(loop), `${OPUS}@high`, `request ${i}`);
  }
}

test('a cost switch on a new task moves at once, as a tier downgrade would', () => {
  const loop = turn(inMode('cost'), onOpusXhigh(), { answer: NEW_TASK, at: T0 + 10 });
  assert.equal(ran_(loop), `${OPUS}@high`);
});

test('an uncertain turn after a mode change stays on its tier and moves only through the gates', () => {
  const uncertain = advice('uncertain', { uncertain: 0.9, high: 0.1 }, { continuation: 0.9 });
  const loop = onOpusXhigh();
  const held = turn(inMode('cost'), loop, { answer: uncertain, at: T0 + 10 });
  assert.deepEqual([ran_(held), held.decision.reason], [`${OPUS}@xhigh`, 'downgrade-held']);
  const quality = turn(inMode('quality'), loop, { answer: uncertain, at: T0 + 10 });
  assert.equal(ran_(quality), `${OPUS}@max`);
});

test('where effort splits the cache, the switch tax holds the effort lever after the dwell', () => {
  const split = { ...base, effortSplitsCache: true };
  let loop = onOpusXhigh(split);
  for (let i = 0; i < 8; i += 1) {
    loop = turn(inMode('cost', split), loop, { messages: VERIFIED, at: T0 + 10 + i });
    loop = reply(loop, T0 + 10 + i, 600, split);
  }
  assert.ok(
    Object.keys(loop.models).some((key) => key.endsWith('@xhigh')),
    'replies warm a per-effort cache key',
  );
  assert.equal(ran_(loop), `${OPUS}@xhigh`);
  assert.equal(loop.decision.reason, 'activity-pending');
  assert.ok(loop.decision.estimate.taxUsd > 0);
});

test('a cost switch to a model with no output price waits out the dwell on the same task', () => {
  // Cost picks the tier below by input price; with no output price the pair does not order by strength.
  const local = loadConfig({
    userFile: {
      models: {
        local: { id: 'local-coder', input: 1, cacheRead: 0.1, contextWindow: 1_000_000, billing: 'plan', efforts: [] },
      },
      routes: { medium: { model: 'local' } },
    },
  });
  const loop = turn(inMode('cost', local), onOpusXhigh(local), { at: T0 + 10 });
  assert.deepEqual([ran_(loop), loop.decision.reason], [`${OPUS}@xhigh`, 'downgrade-held']);
  const moved = turn(inMode('cost', local), onOpusXhigh(local), { answer: NEW_TASK, at: T0 + 10 });
  assert.equal(moved.decision.model, 'local-coder');
});

test('a classifier failure keeps the route in use after a mode change', () => {
  for (const mode of ['cost', 'quality']) {
    const loop = turn(inMode(mode), onOpusXhigh(), { answer: null, at: T0 + 10 });
    assert.deepEqual([ran_(loop), loop.decision.reason], [`${OPUS}@xhigh`, 'no-advice'], mode);
  }
});

test('a classifier failure during an escalation hold keeps the route in use after a mode change', () => {
  const held = onOpusXhigh();
  const loop = turn(inMode('quality'), { ...held, state: { ...held.state, holdUntilTurn: 99 } }, { answer: null });
  assert.deepEqual([ran_(loop), loop.decision.reason], [`${OPUS}@xhigh`, 'hold']);
});

// Opus at 200K runs while the configured high route, Sonnet, has 1M: a route edit held by the dwell.
const heldOnSmallOpus = (models = {}) => {
  const small = { ...models, opus: { contextWindow: 200_000 } };
  const edited = loadConfig({ userFile: { models: small, routes: { high: { model: 'sonnet', effort: 'high' } } } });
  const loop = turn(edited, onOpusXhigh(loadConfig({ userFile: { models: small } })), { at: T0 + 10 });
  assert.deepEqual([ran_(loop), loop.decision.reason], [`${OPUS}@xhigh`, 'downgrade-held']);
  return { edited, loop };
};

// Haiku at 200K too leaves the tier's configured route, Sonnet, as the only one the context fits.
for (const models of [{}, { haiku: { contextWindow: 200_000 } }])
  test(`a tool continuation the route in use cannot hold moves to a route that fits (${JSON.stringify(models)})`, () => {
    const { edited, loop } = heldOnSmallOpus(models);
    const next = continueRoute(edited, loop, {
      nativeModel: OPUS,
      contextTokens: 190_000,
      contextKnown: true,
      effort: 'high',
    });
    assert.deepEqual([next.decision.reason, next.decision.model], ['context-fit', 'claude-sonnet-5-5']);
  });

test('a turn whose route in use fits the context stays on it when the configured route would not', () => {
  // Sonnet at 200K is configured for high; Opus at 1M runs it.
  const edited = loadConfig({
    userFile: { models: { sonnet: { contextWindow: 200_000 } }, routes: { high: { model: 'sonnet', effort: 'high' } } },
  });
  const loop = turn(edited, onOpusXhigh(), { at: T0 + 10, contextTokens: 190_000 });
  assert.deepEqual([loop.decision.tier, ran_(loop)], ['high', `${OPUS}@xhigh`]);
});

test('a first turn with an unmeasured context keeps the session’s model when the mode’s route has a smaller window', () => {
  const config = loadConfig({ userFile: { models: { haiku: { contextWindow: 200_000 } } } });
  const cost = inMode('cost', config);
  const uncertain = advice('uncertain', { uncertain: 0.9, medium: 0.1 });
  const loop = turn(cost, emptyLoop(config, OPUS), { answer: uncertain, contextKnown: false });
  assert.equal(loop.decision.model, OPUS);
});

test('repeated failures with no activity escalate to a stronger route after a mode change', () => {
  const quality = inMode('quality');
  let loop = turn(
    quality,
    { ...emptyLoop(quality, HAIKU), lastRoute: 'low' },
    { answer: advice('low', { low: 0.99 }) },
  );
  assert.equal(ran_(loop), `${HAIKU}@xhigh`);
  loop = reply(loop, T0);
  const failure = (name) => `not ok 1 - ${name}\n  error: 'unauthorized'\n`;
  const failing = [
    user('fix the tests'),
    bash('a', 'npm test'),
    toolResult(failure('login at line 12'), { isError: true }),
    bash('b', 'npm test'),
    toolResult(failure('login at line 12'), { isError: true }),
    user('continue'),
  ];
  // In cost the medium route is Haiku at high, weaker than the route in use; high runs Opus at high.
  const next = turn(inMode('cost'), loop, { messages: failing, answer: null, at: T0 + 10 });
  assert.deepEqual([next.decision.reason, next.decision.tier, next.decision.model], ['escalation', 'high', OPUS]);
});

// Pins bypass the mode in the hook, which routes a pinned turn on the configured routes (hook-modes.test.mjs).
test('a pin runs the configured route of its tier and leaves the route in use alone', () => {
  const loop = turn(base, onOpusXhigh(), { pin: 'medium', at: T0 + 10 });
  assert.equal(ran_(loop), `${OPUS}@medium`);
  assert.deepEqual(loop.route, { model: 'opus', effort: 'xhigh' });
});

test('balanced keeps running the route in use when the configured route changes, until the gates pass', () => {
  const edited = loadConfig({ userFile: { routes: { high: { model: 'opus', effort: 'high' } } } });
  const loop = turn(edited, onOpusXhigh(), { at: T0 + 10 });
  assert.deepEqual([ran_(loop), loop.decision.reason], [`${OPUS}@xhigh`, 'downgrade-held']);
});

const SONNET = 'claude-sonnet-5-5';
const withActivity = (tier, activity, p, continuation = 0) => ({
  ...advice(tier, { [tier]: 0.99, uncertain: 0.01 }, { continuation }),
  activity: { choice: activity, probabilities: { [activity]: p, explore: 1 - p } },
});

// A session that ran a coding turn at low in cost mode: Sonnet at medium.
function codingInCost() {
  const cost = inMode('cost');
  let loop = turn(
    cost,
    { ...emptyLoop(cost, SONNET), lastRoute: 'low' },
    { answer: withActivity('low', 'code', 0.95) },
  );
  assert.equal(ran_(loop), `${SONNET}@medium`);
  loop = reply(loop, T0);
  return loop;
}

test('back to balanced, the incumbent cell takes its configured route without a strong label', () => {
  const loop = turn(base, codingInCost(), { answer: withActivity('low', 'code', 0.7), at: T0 + 10 });
  assert.equal(ran_(loop), `${SONNET}@high`);
  assert.equal(loop.decision.reason, 'activity-up');
});

test('turning activity routing off drops the route the activity ran, at once', () => {
  const on = turn(
    base,
    { ...emptyLoop(base, SONNET), lastRoute: 'low' },
    { answer: withActivity('low', 'code', 0.95) },
  );
  const off = loadConfig({ userFile: { activityRouting: 'off' } });
  const loop = turn(off, reply(on, T0), { answer: advice('low', { low: 0.99 }, { continuation: 0.9 }), at: T0 + 10 });
  assert.equal(ran_(loop), 'claude-haiku-5-5@high');
});

test('a route in use that can no longer run falls back to its cell’s configured route', () => {
  const loop = onOpusXhigh();
  const facts = nativeFacts(base, loop, {
    messages: UNVERIFIED,
    prompt: 'Fix it.',
    effort: 'high',
    turnId: 'tx',
    contextTokens: 0,
  });
  const edited = loadConfig({ userFile: { routes: { high: { model: 'sonnet', effort: 'high' } } } });
  const next = chooseRoute(edited, loop, {
    facts,
    advice: HIGH,
    pin: null,
    nativeModel: OPUS,
    contextKnown: true,
    availableModels: ['sonnet', 'haiku'],
    now: T0 + 10,
  });
  assert.equal(ran_(next), `${SONNET}@high`);
});

test('a fit to another tier inside a turn leaves the route in use of the turn’s tier', () => {
  const loop = onOpusXhigh();
  const small = loadConfig({ userFile: { models: { opus: { contextWindow: 100_000 } } } });
  const next = continueRoute(small, loop, {
    nativeModel: OPUS,
    contextTokens: 900_000,
    contextKnown: true,
    effort: 'high',
  });
  assert.equal(next.decision.reason, 'context-fit');
  assert.deepEqual(next.route, loop.route);
});
