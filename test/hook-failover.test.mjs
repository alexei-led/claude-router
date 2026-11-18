import assert from 'node:assert/strict';
import test from 'node:test';
import { answering, CONFIG, drain, harness, JEV_KEY, step } from './harness.mjs';
import { assistant, jevResponse, toolResult, user } from './helpers.mjs';

const OPUS = 'claude-opus-5-5';
const HAIKU = 'claude-haiku-5-5';
const MEDIUM = jevResponse('medium', { micro: 0, low: 0, medium: 0.97, high: 0.03, uncertain: 0 });

// `router` is the router.json the session loads, if any.
async function started(t, router = null) {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const h = harness(JEV_KEY);
  if (router) h.files.set(CONFIG, JSON.stringify(router));
  h.model(OPUS);
  answering(h, MEDIUM);
  await h.event('session.start', { cwd: '/fixture' });
  return h;
}

// One routed turn that runs to its end; `failure` is the API error it ends on, if any. Returns the request it sent.
async function turn(h, turnId, failure = null) {
  await h.event('turn.start', { turnId, text: 'One edit.' });
  await drain(h.step({ ...step, turnId, model: OPUS }));
  if (failure) await h.event('classic.StopFailure', { hook_event_name: 'StopFailure', ...failure });
  await h.event('turn.complete', { turnId, isAborted: false });
  return h.requests.at(-1);
}

test('an overloaded model is held out: the next turn runs the nearest tier on another model, and says so', async (t) => {
  const h = await started(t);
  assert.equal((await turn(h, 't1', { error: 'overloaded' })).model, OPUS);
  assert.deepEqual(h.loop().held, { [OPUS]: { error: 'overloaded', until: 1_000_000 + 5 * 60_000 } });
  assert.deepEqual(h.toasts, ['Opus 5.5 held out of routing: overloaded, 5 min']);
  const next = await turn(h, 't2');
  assert.deepEqual([next.model, next.effort], [HAIKU, 'high']);
  assert.equal(h.toasts.at(-1), 'Model changed: Opus 5.5 · medium → Haiku 5.5 · high · ! held out');
  assert.equal(h.state.get('lines:rl-t2').value.reason, 'model-held');
});

test('once the hold ends the next turn runs the held model again', async (t) => {
  const h = await started(t);
  await turn(h, 't1', { error: 'server_error' });
  t.mock.timers.tick(2 * 60_000 - 1);
  assert.equal((await turn(h, 't2')).model, HAIKU);
  t.mock.timers.tick(1);
  assert.equal((await turn(h, 't3')).model, OPUS);
});

test('a pinned turn on a held-out model runs the fallback and its route line names the hold', async (t) => {
  const h = await started(t);
  await turn(h, 't1', { error: 'rate_limit' });
  await h.event('command.run', { command: 'router', args: 'pin medium' });
  assert.equal((await turn(h, 't2')).model, HAIKU);
  assert.equal(h.loop().decision.pinned, true);
  assert.equal(h.state.get('lines:rl-t2').value.reason, 'model-held');
});

test('a turn whose own tool calls edit code does not move up onto the held-out model', async (t) => {
  const h = await started(t);
  await turn(h, 't1', { error: 'overloaded' });
  answering(h, jevResponse('medium', { medium: 0.97, high: 0.03 }, 0, { ops: 0.9, code: 0.1 }, 'execute'));
  await h.event('turn.start', { turnId: 't2', text: 'Run the worker brief.' });
  h.messages(async () => [user('Run the worker brief.')]);
  await drain(h.step({ ...step, turnId: 't2', model: OPUS }));
  h.messages(async () => [
    user('Run the worker brief.'),
    assistant('running', ['Bash']),
    toolResult('ok'),
    assistant('fixing', ['Edit']),
    toolResult('ok'),
  ]);
  await drain(h.step({ ...step, turnId: 't2', model: OPUS, index: 1, messageCount: 5 }));
  assert.deepEqual(
    h.requests.slice(1).map((r) => `${r.model}@${r.effort}`),
    ['claude-haiku-5-5@high', 'claude-haiku-5-5@high'],
  );
  assert.equal(h.loop().decision.activity, 'ops');
});

test('the shadow engine routes as the table does, so it holds the model and says so', async (t) => {
  const h = await started(t, { routingEngine: 'shadow' });
  await turn(h, 't1', { error: 'overloaded' });
  assert.deepEqual(Object.keys(h.loop().held), [OPUS]);
  assert.deepEqual(h.toasts, ['Opus 5.5 held out of routing: overloaded, 5 min']);
});

test('the auto engine does not route around holds, so it holds nothing and says nothing', async (t) => {
  const capability = { low: 2, medium: 2.5, high: 2.5, xhigh: 3, max: 3 };
  const h = await started(t, { routingEngine: 'auto', models: { opus: { capability } } });
  await turn(h, 't1', { error: 'overloaded' });
  assert.ok(h.loop());
  assert.equal(h.loop().held, undefined);
  assert.deepEqual(
    h.toasts.filter((text) => text.includes('held out')),
    [],
  );
});

for (const [name, failure] of [
  ['a billing error', { error: 'billing_error' }],
  ['a rejected key', { error: 'authentication_failed' }],
  ['an invalid request', { error: 'invalid_request' }],
  ['an unknown error', { error: 'unknown' }],
  ['a subagent’s overloaded model', { error: 'overloaded', agent_id: 'a1' }],
])
  test(`${name} holds no model out`, async (t) => {
    const h = await started(t);
    await turn(h, 't1', failure);
    assert.equal(h.loop().held, undefined);
    assert.deepEqual(h.toasts, []);
    assert.equal((await turn(h, 't2')).model, OPUS);
  });
