import assert from 'node:assert/strict';
import test from 'node:test';
import { band, harness, start } from './harness.mjs';

const spawnInput = (extra) => ({
  tool_use_id: 'toolu_1',
  prompt: 'Find where the cache key is built.',
  description: 'Locate cache key',
  subagentType: 'Explore',
  provider: { plugin: 'engine', tier: 'core' },
  parentModel: 'claude-opus-5-5',
  permissionMode: 'default',
  background: false,
  fork: false,
  ...extra,
});
const listed = (id, extra) => ({
  id,
  type: 'Explore',
  description: 'Locate cache key',
  status: 'running',
  ...extra,
});

// Spawns an agent the router routes to Haiku and Claude Code lists as running.
async function spawned(h, ...ids) {
  for (const id of ids) await h.spawn(spawnInput(), { model: 'claude-haiku-5-5', agentId: id });
  h.agents(ids.map((id) => listed(id)));
}

const press = async (h, key, props) => {
  const control = (await band(h, props)).controls.find((node) => node.key === key);
  assert.ok(control, `no control ${key}`);
  return control.onPress();
};

test('the band lists the running agents and a press opens one in the main view', async () => {
  const h = harness();
  await start(h);
  await spawned(h, 'a1', 'a2');
  const { line, controls } = await band(h);
  assert.match(line, /agents 2/);
  assert.deepEqual(
    controls.filter((node) => node.key?.startsWith('band-agent-')).map((node) => [node.key, node.label]),
    [
      ['band-agent-a1', '▸ ■ Haiku 5.5 Explore · Locate cache key ●'],
      ['band-agent-a2', '▸ ■ Haiku 5.5 Explore · Locate cache key ●'],
    ],
  );
  await press(h, 'band-agent-a2');
  assert.deepEqual(h.views, [{ agentId: 'a2' }]);
  assert.deepEqual(h.toasts, []);
});

test('the rows follow the agents that run: the view holds their ids and a finished agent leaves', async () => {
  const h = harness();
  await start(h);
  assert.equal((await band(h)).line.includes('agents'), false);
  await spawned(h, 'a1', 'a2');
  assert.deepEqual(h.view().subagentIds, ['a1', 'a2']);
  await h.event('turn.complete', { turnId: 'a1-t', agentId: 'a1' });
  assert.deepEqual([h.view().subagentIds, h.view().subagentsRunning], [['a2'], 1]);
  h.agents([listed('a1', { status: 'completed' }), listed('a2')]);
  const { controls } = await band(h);
  assert.deepEqual(
    controls.filter((node) => node.key?.startsWith('band-agent-')).map((node) => node.key),
    ['band-agent-a2'],
  );
});

test('a teammate, an unlisted agent and an agent without a record get no row', async () => {
  const h = harness();
  await start(h);
  await spawned(h, 'a1', 'a2', 'a3');
  h.agents([
    listed('a1', { teammateId: 'dev@team' }),
    listed('a2'),
    listed('a4'),
    listed('a5', { status: 'completed' }),
  ]);
  const { controls } = await band(h);
  assert.deepEqual(
    controls.filter((node) => node.key?.startsWith('band-agent-')).map((node) => node.key),
    ['band-agent-a2'],
  );
});

test('three rows at most, then how many more', async () => {
  const h = harness();
  await start(h);
  await spawned(h, 'a1', 'a2', 'a3', 'a4', 'a5');
  const { line, controls } = await band(h);
  assert.equal(controls.filter((node) => node.key?.startsWith('band-agent-')).length, 3);
  assert.match(line, /agents 5.*\+2/);
});

test('a refused switch is told in a toast', async () => {
  const h = harness();
  await start(h);
  await spawned(h, 'a1');
  h.viewAnswer({ deny: 'the agent is not in the tasks list' });
  await press(h, 'band-agent-a1');
  assert.deepEqual(h.toasts, ['the agent is not in the tasks list']);
  h.$.ui.view = async () => {
    throw new Error('no surface');
  };
  await press(h, 'band-agent-a1');
  assert.equal(h.toasts.length, 2);
});

test('an agent’s band has a way back to the main view and no rows of its own', async () => {
  const h = harness();
  await start(h);
  await spawned(h, 'a1', 'a2');
  const view = { agentId: 'a1' };
  const { controls } = await band(h, { view });
  assert.deepEqual(
    controls.map((node) => node.key),
    ['band-back'],
  );
  await controls[0].onPress();
  assert.deepEqual(h.views, [{}]);
});
