import assert from 'node:assert/strict';
import test from 'node:test';
import { answering, drain, harness, JEV_KEY, step, texts } from './harness.mjs';
import { jevResponse } from './helpers.mjs';

const LOW = jevResponse('low', { micro: 0, low: 0.9, medium: 0.1, high: 0, uncertain: 0 });
const HIGH = jevResponse('high', { micro: 0, low: 0, medium: 0.1, high: 0.9, uncertain: 0 });

async function started(file) {
  const h = harness(JEV_KEY);
  if (file) h.files.set('/fixture/team/router.json', JSON.stringify(file));
  answering(h, LOW);
  await h.event('session.start', { cwd: '/fixture' });
  return h;
}

// One routed turn that runs to its end.
async function turn(h, turnId, { answer, complete = {} } = {}) {
  if (answer) answering(h, answer);
  await h.event('turn.start', { turnId, text: 'One edit.' });
  await drain(h.step({ ...step, turnId }));
  await h.event('turn.complete', { turnId, isAborted: false, ...complete });
}

const line = async (h, id, props = {}) =>
  h.component('Placed', { id, plugin: 'router', ...props }, { next: async () => 'next' });

test('a routed turn places one row under its own id and the row draws the route', async () => {
  const h = await started();
  await turn(h, 't1');
  assert.deepEqual(h.places, [{ id: 'rl-t1' }]);
  assert.match(texts(await line(h, 'rl-t1')).join(''), /Haiku 5\.5/);
  assert.equal(h.state.get('lines:rl-t1').value.model, 'claude-haiku-5-5');
});

test('by default a row shows only when the route moved', async () => {
  const h = await started();
  await turn(h, 't1');
  await turn(h, 't2');
  assert.deepEqual(h.places, [{ id: 'rl-t1' }]);
  await turn(h, 't3', { answer: HIGH });
  assert.deepEqual(h.places, [{ id: 'rl-t1' }, { id: 'rl-t3' }]);
  const moved = h.state.get('lines:rl-t3').value;
  assert.notEqual(moved.model, h.state.get('lines:rl-t1').value.model);
});

test('/router line sets the density and keeps it for later sessions', async () => {
  const h = await started();
  const run = (args) => h.event('command.run', { command: 'router', args });
  assert.match((await run('line all')).text, /every turn/);
  assert.equal(h.preferences.get('route:line'), 'all');
  await turn(h, 't1');
  await turn(h, 't2');
  assert.deepEqual(h.places, [{ id: 'rl-t1' }, { id: 'rl-t2' }]);
  await run('line off');
  await turn(h, 't3', { answer: HIGH });
  assert.equal(h.places.length, 2);
  assert.match((await run('line sideways')).text, /Choose line off, moves, all/);
  assert.equal(h.preferences.get('route:line'), 'off');
  await run('line moves');
  assert.equal(h.preferences.get('route:line'), 'moves');
});

test('an interrupted turn, a subagent’s turn and a turn with routing off place nothing', async () => {
  const h = await started();
  await h.event('turn.start', { turnId: 'ta', text: 'One edit.' });
  await drain(h.step({ ...step, turnId: 'ta' }));
  await h.event('turn.complete', { turnId: 'ta', isAborted: true });
  await h.spawn(
    {
      tool_use_id: 'toolu_1',
      prompt: 'Find it.',
      subagentType: 'Explore',
      provider: { plugin: 'engine', tier: 'core' },
      parentModel: 'claude-opus-5-5',
      fork: false,
    },
    { model: 'claude-haiku-5-5', agentId: 'a1' },
  );
  await drain(h.step({ ...step, turnId: 'a1-t', agentId: 'a1' }));
  await h.event('turn.complete', { turnId: 'a1-t', agentId: 'a1', isAborted: false });
  await h.event('command.run', { command: 'router', args: 'off' });
  await turn(h, 'tm');
  assert.deepEqual(h.places, []);
  assert.equal(h.state.has('lines:rl-ta'), false);
});

test('a row another plugin placed, or one with no record, is left to the next hook', async () => {
  const h = await started();
  await turn(h, 't1');
  assert.equal(await line(h, 'rl-t1', { plugin: 'other' }), 'next');
  assert.equal(await line(h, 'rl-missing'), 'next');
});

test('a surface that cannot draw the row now is not an error, and the turn still completes', async () => {
  const h = await started();
  h.placeAnswer({ isPlaced: false, reason: 'no surface' });
  await turn(h, 't1');
  assert.deepEqual(h.places, [{ id: 'rl-t1' }]);
  h.$.ui.place = async () => {
    throw new Error('no surface');
  };
  await turn(h, 't2', { answer: HIGH });
  assert.ok(h.view().tier);
});

test('a turn id the engine would refuse becomes a valid row id', async () => {
  const h = await started();
  await turn(h, 'turn 1/é'.repeat(12));
  const [{ id }] = h.places;
  assert.match(id, /^[A-Za-z0-9_-]{1,64}$/);
});

test('a new session’s first routed turn places a row even when its route is the last session’s', async () => {
  const h = await started();
  await turn(h, 't1');
  await h.event('session.start', { cwd: '/fixture' });
  await turn(h, 't2');
  assert.deepEqual(h.places, [{ id: 'rl-t1' }, { id: 'rl-t2' }]);
});
