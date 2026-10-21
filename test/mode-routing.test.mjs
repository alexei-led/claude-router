import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../lib/config.mjs';
import { applyMode } from '../lib/modes.mjs';
import { chooseRoute, emptyLoop, nativeFacts, observeResponse } from '../lib/route.mjs';
import { advice, user } from './helpers.mjs';

const OPUS = 'claude-opus-5-5';
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

// One reply on the route the loop's decision chose. No new tokens since the cached prefix: the switch tax is zero.
function reply(loop, at) {
  return observeResponse(base, loop, {
    usage: {
      model: OPUS,
      input_tokens: 0,
      cache_read_input_tokens: 50_000,
      cache_creation_input_tokens: 0,
      output_tokens: 0,
    },
    requestedModel: loop.decision.model,
    effort: loop.decision.effort,
    stopReason: 'end_turn',
    now: at,
  });
}

function turn(config, loop, { messages = UNVERIFIED, answer = HIGH, at = T0, pin = null } = {}) {
  const facts = nativeFacts(config, loop, {
    messages,
    prompt: 'Fix it.',
    effort: 'high',
    turnId: `t${at}`,
    contextTokens: 0,
  });
  return chooseRoute(config, loop, { facts, advice: answer, pin, nativeModel: OPUS, contextKnown: true, now: at });
}

// A session that has run a few replies at high on Opus/xhigh in balanced.
function onOpusXhigh(config = base) {
  let loop = { ...emptyLoop(config, OPUS), lastRoute: 'high' };
  loop = turn(config, loop);
  assert.deepEqual([loop.decision.model, loop.decision.effort], [OPUS, 'xhigh']);
  for (let i = 0; i < 2; i += 1) loop = reply(loop, T0 + i);
  return loop;
}

const ran_ = (loop) => `${loop.decision.model}@${loop.decision.effort}`;

test('a cost switch at high waits out the dwell on the same task, then stays on Opus/high', () => {
  const cost = inMode('cost');
  let loop = onOpusXhigh();
  // The mode changed the preferred route; the route in use stays until the dwell (4 requests in cost) has passed
  // and a check passed: a passed check inside the dwell, then a dwell without one.
  for (let i = 0; i < 4; i += 1) {
    loop = turn(cost, loop, { messages: i === 0 ? VERIFIED : UNVERIFIED, at: T0 + 10 + i });
    assert.equal(ran_(loop), `${OPUS}@xhigh`, `request ${i}`);
    assert.equal(loop.decision.reason, 'downgrade-held');
    loop = reply(loop, T0 + 10 + i);
  }
  loop = turn(cost, loop, { messages: VERIFIED, at: T0 + 20 });
  assert.equal(ran_(loop), `${OPUS}@high`);
  assert.equal(loop.decision.lateral, 'taken');
  assert.deepEqual(loop.route, { model: 'opus', effort: 'high' });
  // Later requests start from the configured route again, never from the one in use: no further step down.
  for (let i = 0; i < 6; i += 1) {
    loop = reply(loop, T0 + 30 + i);
    loop = turn(cost, loop, { messages: VERIFIED, at: T0 + 30 + i });
    assert.equal(ran_(loop), `${OPUS}@high`, `request ${i}`);
  }
});

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
    loop = reply(loop, T0 + 10 + i);
  }
  assert.equal(ran_(loop), `${OPUS}@xhigh`);
  assert.equal(loop.decision.reason, 'activity-pending');
  assert.ok(loop.decision.estimate.taxUsd > 0);
});

test('a pin runs the configured route of its tier, not the mode route', () => {
  const loop = turn(base, onOpusXhigh(), { pin: 'medium', at: T0 + 10 });
  assert.equal(ran_(loop), `${OPUS}@medium`);
  assert.deepEqual(loop.route, { model: 'opus', effort: 'xhigh' });
});

test('balanced keeps running the route in use when the configured route changes, until the gates pass', () => {
  const edited = loadConfig({ userFile: { routes: { high: { model: 'opus', effort: 'high' } } } });
  const loop = turn(edited, onOpusXhigh(), { at: T0 + 10 });
  assert.deepEqual([ran_(loop), loop.decision.reason], [`${OPUS}@xhigh`, 'downgrade-held']);
});
