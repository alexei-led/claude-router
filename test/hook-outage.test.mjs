import assert from 'node:assert/strict';
import test from 'node:test';
import { replayAuto, replayTable } from '../lib/replay.mjs';
import { answering, CONFIG, drain, harness, JEV_KEY, step, traceOf } from './harness.mjs';
import { jevResponse } from './helpers.mjs';

const OPUS = 'claude-opus-5-5';
const HAIKU = 'claude-haiku-5-5';
const LOW = jevResponse('low', { micro: 0, low: 0.97, medium: 0.03, high: 0, uncertain: 0 });
const MEDIUM = jevResponse('medium', { micro: 0, low: 0.03, medium: 0.97, high: 0, uncertain: 0 });
const CAPABILITY = { low: 2, medium: 2.5, high: 2.5, xhigh: 3, max: 3 };
const ENGINES = {
  table: {},
  shadow: { routingEngine: 'shadow' },
  auto: { routingEngine: 'auto', models: { opus: { capability: CAPABILITY } } },
};
// A session on Opus at medium effort, so a request sent as Claude Code built it differs from every routed one.
const OWN = `${OPUS}@medium`;

// A session whose first turn routed down; `failing()` makes every later classifier answer unreadable.
async function routedDown(t, config = {}) {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const h = harness(JEV_KEY);
  h.files.set(CONFIG, JSON.stringify({ ...config, policy: { reviewEveryRequests: 0 } }));
  h.model(OPUS);
  answering(h, LOW);
  await h.event('session.start', { cwd: '/fixture' });
  const first = await turn(h, 'down');
  assert.notEqual(first, OWN);
  return { h, cheap: first };
}

const failing = (h) => answering(h, {});

// One turn run to its end, `steps` requests long. Returns what its last request sent.
async function turn(h, turnId, { text = 'One edit.', steps = 1 } = {}) {
  await h.submit({ text, origin: { kind: 'composer' }, wait: false }, () => h.event('turn.start', { turnId, text }));
  for (let index = 0; index < steps; index += 1) await drain(h.step({ ...step, turnId, index, model: OPUS }));
  await h.event('turn.complete', { turnId, isAborted: false });
  const request = h.requests.at(-1);
  return `${request.model}@${request.effort}`;
}

// The three failed turns that keep the route, spaced past the classifier's pause so each one asks.
async function outage(t, h, cheap) {
  failing(h);
  for (const id of ['f1', 'f2', 'f3']) {
    assert.equal(await turn(h, id), cheap, id);
    t.mock.timers.tick(61_000);
  }
}

for (const [engine, config] of Object.entries(ENGINES))
  test(`${engine}: after three turns without advice the next runs the session’s model until advice returns`, async (t) => {
    const { h, cheap } = await routedDown(t, config);
    await outage(t, h, cheap);
    assert.equal(await turn(h, 'own1', { steps: 2 }), OWN);
    assert.deepEqual(
      h.requests.slice(-2).map((r) => `${r.model}@${r.effort}`),
      [OWN, OWN],
    );
    assert.equal(h.loop().decision.reason, 'classifier-unavailable');
    assert.equal(h.view().reason, 'classifier-unavailable');
    t.mock.timers.tick(61_000);
    assert.equal(await turn(h, 'own2'), OWN);
    answering(h, LOW);
    t.mock.timers.tick(61_000);
    // The table's switching gates apply from the session's model, so the move down may take a second vote.
    await turn(h, 'back1');
    assert.equal(await turn(h, 'back2'), cheap);
    // Advice ended the streak: one failure keeps the route again.
    failing(h);
    assert.equal(await turn(h, 'again'), cheap);
  });

test('a paused classifier hands the turn to the session’s model at once', async (t) => {
  const { h, cheap } = await routedDown(t);
  failing(h);
  for (const id of ['f1', 'f2', 'f3']) assert.equal(await turn(h, id), cheap, id);
  // A streak below three, so only the pause can hand the turn over.
  const loop = h.state.get('loops:main');
  h.state.set('loops:main', { ...loop, value: { ...loop.value, noAdvice: 0 } });
  assert.equal(await turn(h, 'paused'), OWN);
  assert.equal(h.view().error, 'paused');
  assert.equal(h.loop().noAdvice, 1);
});

for (const engine of ['table', 'shadow'])
  test(`${engine}: in cost mode an outage starts from the session model’s configured tier, as a new session does`, async (t) => {
    const { h, cheap } = await routedDown(t, { ...ENGINES[engine], mode: 'cost' });
    await outage(t, h, cheap);
    assert.equal(await turn(h, 'own'), OWN);
    // Cost mode runs Opus at `high`; the configured routes name it at `medium`.
    assert.equal(h.loop().lastRoute, 'medium');
    if (engine !== 'shadow') return;
    // `medium` keeps the configured tier, and would be a move down from the mode's: the replay must start there too.
    answering(h, MEDIUM);
    t.mock.timers.tick(61_000);
    await turn(h, 'back');
    assert.equal(h.loop().decision.reason, 'same-tier');
    assert.deepEqual(replayTable(traceOf(h)).mismatches, []);
  });

test('a pinned turn asks nothing, so it neither counts toward the outage nor ends it', async (t) => {
  const { h, cheap } = await routedDown(t);
  failing(h);
  assert.equal(await turn(h, 'f1'), cheap);
  assert.equal(await turn(h, 'f2'), cheap);
  await h.event('command.run', { command: 'router', args: 'pin medium' });
  await turn(h, 'pin');
  assert.equal(h.loop().noAdvice, 2);
  t.mock.timers.tick(61_000);
  await turn(h, 'f3');
  assert.equal(h.loop().decision.reason, 'no-advice');
  t.mock.timers.tick(61_000);
  assert.equal(await turn(h, 'own'), OWN);
});

test('a keyword still moves the route during an outage', async (t) => {
  const { h, cheap } = await routedDown(t);
  await outage(t, h, cheap);
  assert.equal(await turn(h, 'kw', { text: 'maxthink find the race' }), `${OPUS}@xhigh`);
  assert.equal(h.loop().decision.reason, 'maxthink');
});

test('a held-out session model is not what an outage falls back to', async (t) => {
  const { h, cheap } = await routedDown(t);
  await outage(t, h, cheap);
  const loop = h.state.get('loops:main');
  const hold = { kind: 'availability', error: 'overloaded', since: Date.now(), until: Date.now() + 600_000, streak: 1 };
  h.state.set('loops:main', { ...loop, value: { ...loop.value, held: { [OPUS]: hold } } });
  assert.equal(await turn(h, 'held'), cheap);
  assert.equal(h.loop().decision.reason, 'no-advice');
});

test('without a classifier key no turn counts toward an outage', async () => {
  const h = harness();
  h.model(HAIKU);
  await h.event('session.start', { cwd: '/fixture' });
  for (const id of ['t1', 't2', 't3', 't4']) {
    await h.event('turn.start', { turnId: id, text: 'One edit.' });
    await drain(h.step({ ...step, turnId: id }));
    await h.event('turn.complete', { turnId: id, isAborted: false });
    assert.equal(h.loop().decision.reason, 'no-advice', id);
  }
});

test('a shadow trace through an outage replays without a mismatch', async (t) => {
  const { h, cheap } = await routedDown(t, { routingEngine: 'shadow' });
  await outage(t, h, cheap);
  await turn(h, 'own', { steps: 2 });
  answering(h, LOW);
  t.mock.timers.tick(61_000);
  await turn(h, 'back');
  const record = traceOf(h);
  const table = replayTable(record);
  assert.deepEqual(table.mismatches, []);
  const auto = replayAuto(record, table.rows);
  assert.deepEqual(
    auto.filter((row) => row.reason === 'classifier-unavailable').map((row) => [row.pair.model, row.external]),
    [
      [OPUS, true],
      [OPUS, true],
    ],
  );
});
