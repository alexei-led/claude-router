import assert from 'node:assert/strict';
import test from 'node:test';
import { answering, CONFIG, drain, harness, JEV_KEY, step } from './harness.mjs';
import { jevResponse, user } from './helpers.mjs';

const MICRO = jevResponse('micro', { micro: 1 });
const MEDIUM = jevResponse('medium', { medium: 1 });
const HIGH = jevResponse('high', { high: 1 });
const sent = (h) => h.requests.map((r) => `${r.model}@${r.effort}`);
const command = async (h, args) => (await h.event('command.run', { command: 'router', args })).text;

function setup(config = {}, answer = MICRO) {
  const h = harness(JEV_KEY);
  h.files.set(CONFIG, JSON.stringify({ policy: { reviewEveryRequests: 0 }, ...config }));
  answering(h, answer);
  return h;
}

// One turn from a prompt with `origin`, through its first step; `steps` more steps continue it.
async function run(h, id, text, { origin = 'composer', model = 'claude-haiku-5-5', steps = 0 } = {}) {
  await h.submit({ text, origin: { kind: origin }, wait: false }, () => h.event('turn.start', { turnId: id, text }));
  h.messages(async () => [user(text)]);
  for (let index = 0; index <= steps; index += 1) await drain(h.step({ ...step, turnId: id, index, model }));
  await h.event('turn.complete', { turnId: id });
}

async function routeOf(text, { config = {}, answer = MICRO } = {}) {
  const h = setup(config, answer);
  await h.event('session.start', { cwd: '/fixture' });
  await run(h, 't1', text);
  return h;
}

test('maxthink runs the top tier’s route although the classifier answered micro', async () => {
  const h = await routeOf('maxthink fix the flaky test');
  assert.deepEqual(sent(h), ['claude-opus-5-5@xhigh']);
  assert.equal(h.loop().decision.keyword, 'maxthink');
  assert.equal(h.view().reason, 'maxthink');
});

for (const [mode, expected] of [
  ['cost', 'claude-opus-5-5@high'],
  ['quality', 'claude-opus-5-5@max'],
])
  test(`maxthink in ${mode} mode runs the top tier’s ${mode} route, unlike a pin`, async () => {
    const h = await routeOf('maxthink fix the flaky test', { config: { mode } });
    assert.deepEqual(sent(h), [expected]);
  });

test('a keyword turn keeps the activity the classifier gave', async () => {
  const code = jevResponse('low', { low: 1 }, 0, { code: 1 });
  const h = await routeOf('highthink add the endpoint', { config: { mode: 'cost' }, answer: code });
  assert.deepEqual(sent(h), ['claude-sonnet-5-5@high']);
  assert.equal(h.loop().decision.activity, 'code');
});

test('nothink runs the bottom tier although the classifier answered high', async () => {
  const h = await routeOf('nothink rename the variable', { answer: HIGH });
  assert.deepEqual(sent(h), ['claude-haiku-5-5@medium']);
});

for (const [keyword, tier, route] of [
  ['highthink', 'high', 'claude-opus-5-5@xhigh'],
  ['lowthink', 'low', 'claude-haiku-5-5@high'],
])
  test(`${keyword} moves one tier from the router’s own pick`, async () => {
    const plain = await routeOf('Fix the flaky test', { answer: MEDIUM });
    const moved = await routeOf(`${keyword} fix the flaky test`, { answer: MEDIUM });
    assert.equal(plain.loop().decision.tier, 'medium');
    assert.deepEqual([moved.loop().decision.tier, ...sent(moved)], [tier, route]);
  });

for (const [keyword, expected] of [
  ['morethink', 'high'],
  ['lessthink', 'low'],
])
  test(`${keyword} keeps the router’s model and moves its effort one level`, async () => {
    const plain = await routeOf('Fix the flaky test', { answer: MEDIUM });
    const moved = await routeOf(`${keyword} fix the flaky test`, { answer: MEDIUM });
    assert.deepEqual(sent(plain), ['claude-opus-5-5@medium']);
    assert.deepEqual(sent(moved), [`claude-opus-5-5@${expected}`]);
  });

test('a keyword serves its turn’s tool steps, and the next turn routes as before it', async () => {
  const h = setup();
  await h.event('session.start', { cwd: '/fixture' });
  await run(h, 't1', 'Fix the flaky test');
  const before = h.loop().lastRoute;
  await run(h, 't2', 'maxthink find the root cause', { steps: 2 });
  assert.equal(h.loop().lastRoute, before);
  await run(h, 't3', 'Now rename the helper');
  assert.deepEqual(sent(h), [
    'claude-haiku-5-5@medium',
    'claude-opus-5-5@xhigh',
    'claude-opus-5-5@xhigh',
    'claude-opus-5-5@xhigh',
    'claude-haiku-5-5@medium',
  ]);
});

test('a keyword in a task notification is not read', async () => {
  const h = await routeOf('Fix the flaky test');
  await run(h, 't2', 'maxthink background work finished', { origin: 'task-notification' });
  assert.equal(h.loop().decision.keyword, undefined);
  assert.notEqual(sent(h).at(-1), 'claude-opus-5-5@xhigh');
});

test('a pin outranks a keyword', async () => {
  const h = setup();
  await h.event('session.start', { cwd: '/fixture' });
  await command(h, 'pin micro');
  await run(h, 't1', 'maxthink fix the flaky test');
  assert.deepEqual(sent(h), ['claude-haiku-5-5@medium']);
  assert.equal(h.loop().decision.keyword, undefined);
});

const AUTO = {
  routingEngine: 'auto',
  models: {
    haiku: { capability: { low: 0, medium: 1, high: 1.5, xhigh: 2, max: 2 } },
    sonnet: { capability: { low: 1, medium: 2, high: 2.5, xhigh: 2.5, max: 2.5 } },
    opus: { capability: { low: 2, medium: 2.5, high: 2.5, xhigh: 3, max: 3 } },
    fable: { capability: { low: 3, medium: 3, high: 3, xhigh: 3, max: 3 } },
  },
};

for (const [mode, requirement] of [
  ['balanced', 3],
  ['cost', 2.5],
])
  test(`with Auto, maxthink sets top demand and ${mode} mode sets the requirement`, async () => {
    const h = await routeOf('maxthink fix the flaky test', { config: { ...AUTO, mode } });
    const { decision } = h.loop();
    assert.deepEqual([decision.auto.demand, decision.auto.requirement], [3, requirement]);
    assert.equal(decision.reason, 'maxthink');
    assert.equal(decision.pinned, false);
  });

test('with Auto, a keyword serves its turn’s tool steps and leaves demand as it was', async () => {
  const h = setup(AUTO);
  await h.event('session.start', { cwd: '/fixture' });
  await run(h, 't1', 'Fix the flaky test');
  const demand = h.loop().auto.state.demand;
  await run(h, 't2', 'maxthink find the root cause', { steps: 1 });
  const [keyed, step2] = sent(h).slice(1);
  assert.equal(step2, keyed);
  assert.equal(h.loop().decision.keyword, 'maxthink');
  await run(h, 't3', 'Now rename the helper');
  assert.equal(h.loop().auto.state.demand, demand);
  assert.equal(h.loop().decision.keyword, undefined);
});
