import assert from 'node:assert/strict';
import test from 'node:test';
import { answering, CONFIG, drain, harness, JEV_KEY, press, start, step } from './harness.mjs';
import { jevResponse } from './helpers.mjs';

const PROJECT = '/fixture/project/.claude/router.json';
const HIGH = jevResponse('high', { high: 0.99, medium: 0.01 });
const command = async (h, args) => (await h.event('command.run', { command: 'router', args })).text;
const sent = (h) => h.requests.map((r) => `${r.model}@${r.effort}`);

async function routed(h, turnId = 't1') {
  await h.event('turn.start', { turnId, text: 'Plan the migration.' });
  await drain(h.step({ ...step, turnId, model: 'claude-opus-5-5' }));
}

test('the mode comes from the session, then the project file, then router.json', async () => {
  const h = harness(JEV_KEY);
  h.files.set(CONFIG, JSON.stringify({ mode: 'cost' }));
  await start(h);
  assert.deepEqual(h.view().routingMode, { mode: 'cost', source: 'profile' });
  h.files.set(PROJECT, JSON.stringify({ mode: 'quality' }));
  await start(h);
  assert.deepEqual(h.view().routingMode, { mode: 'quality', source: 'project' });
  assert.equal(await command(h, 'mode cost'), 'Routing mode: cost (session), from the next turn.');
  assert.deepEqual(h.view().routingMode, { mode: 'cost', source: 'session' });
  assert.equal(h.preferences.get('routing-mode:s1'), 'cost');
  assert.equal(await command(h, 'mode default'), 'Routing mode: quality (project), from the next turn.');
  assert.equal(h.preferences.has('routing-mode:s1'), false);
  assert.match(await command(h, 'mode fast'), /^Choose mode cost, balanced, quality, default\.$/);
  h.surfaces([]);
  assert.match(await command(h, ''), /Mode: quality \(project\)/);
});

test('a project file that sets anything but the mode is ignored, with the reason', async () => {
  const h = harness(JEV_KEY);
  h.files.set(PROJECT, JSON.stringify({ mode: 'cost', routes: {} }));
  await start(h);
  assert.deepEqual(h.view().routingMode, { mode: 'balanced', source: 'default' });
  assert.equal(h.view().projectError, 'project .claude/router.json may only set mode, not routes');
  assert.equal(h.view().phase, 'ready');
  h.surfaces([]);
  assert.match(await command(h, ''), /Ignored: project \.claude\/router\.json may only set mode, not routes/);
});

test('the profile router.json is not read as a project file when Claude Code runs in its parent', async () => {
  const h = harness(JEV_KEY);
  h.env.set('CLAUDE_CONFIG_DIR', '/fixture/project/.claude');
  h.files.set(PROJECT, JSON.stringify({ mode: 'cost', policy: { minDwellRequests: 4 } }));
  await start(h);
  assert.deepEqual(h.view().routingMode, { mode: 'cost', source: 'profile' });
  assert.equal(h.view().projectError, null);
});

test('a mode change routes the next turn on its routes, and never aborts the turn running', async () => {
  const h = harness(JEV_KEY);
  answering(h, HIGH);
  await start(h);
  await drain(h.step({ ...step, model: 'claude-opus-5-5' }));
  assert.deepEqual(sent(h), ['claude-opus-5-5@xhigh']);
  await command(h, 'mode quality');
  // The running turn keeps its config; its next step goes out, not aborted.
  await drain(h.step({ ...step, index: 1, model: 'claude-opus-5-5' }));
  assert.deepEqual(sent(h), ['claude-opus-5-5@xhigh', 'claude-opus-5-5@xhigh']);
  await routed(h, 't2');
  assert.equal(sent(h).at(-1), 'claude-opus-5-5@max');
  assert.deepEqual([h.view().routingMode, h.view().mode], [{ mode: 'quality', source: 'session' }, 'auto']);
});

test('a mode change while the classifier answers keeps that turn’s decision', async () => {
  const h = harness(JEV_KEY);
  let release;
  h.http(
    () =>
      new Promise((resolve) => {
        release = () => resolve({ ok: true, status: 200, text: JSON.stringify(HIGH), headers: {} });
      }),
  );
  await start(h);
  const running = drain(h.step({ ...step, model: 'claude-opus-5-5' }));
  await new Promise((resolve) => setImmediate(resolve));
  await command(h, 'mode cost');
  release();
  await running;
  assert.deepEqual([sent(h), h.loop().decision.reason], [['claude-opus-5-5@xhigh'], 'upgrade']);
  // The view names the mode the next turn runs, as the command said.
  assert.deepEqual(h.view().routingMode, { mode: 'cost', source: 'session' });
});

test('a resumed session keeps its mode override; a new session does not', async () => {
  const original = harness(JEV_KEY);
  await start(original);
  await command(original, 'mode cost');
  const resumed = harness(JEV_KEY, original.preferences);
  await start(resumed);
  assert.deepEqual(resumed.view().routingMode, { mode: 'cost', source: 'session' });
  resumed.clear('s2');
  await start(resumed);
  assert.deepEqual(resumed.view().routingMode, { mode: 'balanced', source: 'default' });
});

test('a session on a routed model starts on its configured tier in every mode', async () => {
  const UNCERTAIN = jevResponse('uncertain', { uncertain: 0.99, medium: 0.01 });
  const first = {};
  for (const mode of ['cost', 'balanced', 'quality']) {
    const h = harness(JEV_KEY);
    h.files.set(CONFIG, JSON.stringify({ mode }));
    answering(h, UNCERTAIN);
    await start(h);
    await drain(h.step({ ...step, model: 'claude-opus-5-5' }));
    first[mode] = [h.loop().decision.tier, sent(h)[0]];
  }
  // Opus runs medium in the configured routes; cost's table runs Opus only at high.
  assert.deepEqual(first, {
    cost: ['medium', 'claude-haiku-5-5@high'],
    balanced: ['medium', 'claude-opus-5-5@medium'],
    quality: ['medium', 'claude-opus-5-5@high'],
  });
});

test('a pin runs its tier’s configured route in cost mode', async () => {
  const h = harness(JEV_KEY);
  h.files.set(CONFIG, JSON.stringify({ mode: 'cost' }));
  await start(h);
  await command(h, 'pin high');
  await drain(h.step(step));
  assert.deepEqual(sent(h), ['claude-opus-5-5@xhigh']);
});

test('each decision records the mode, its source, the classified tier and the route', async () => {
  const h = harness(JEV_KEY);
  answering(h, HIGH);
  const logs = [];
  h.$.ui.log = (text, options) => logs.push([text, options]);
  h.files.set(CONFIG, JSON.stringify({ mode: 'cost' }));
  await start(h);
  await drain(h.step({ ...step, model: 'claude-opus-5-5' }));
  const [text, options] = logs.find(([line]) => line.startsWith('router decision '));
  assert.deepEqual(options, { to: 'debug' });
  assert.deepEqual(JSON.parse(text.slice('router decision '.length)), {
    mode: 'cost',
    modeSource: 'profile',
    classified: 'high',
    tier: 'high',
    reason: 'upgrade',
    route: 'claude-opus-5-5@high',
    pinned: false,
  });
  assert.deepEqual(h.view().routingMode, { mode: 'cost', source: 'profile' });
});

test('the pane saves the profile mode at once, Undo restores it, and a session mode still wins', async () => {
  const h = harness(JEV_KEY);
  await start(h);
  await h.event('command.run', { command: 'router', args: '' });
  await press(h, 'tab-policy');
  await press(h, 'routing-mode', 'cost');
  assert.deepEqual(JSON.parse(h.files.get(CONFIG)), { mode: 'cost' });
  assert.deepEqual(h.view().routingMode, { mode: 'cost', source: 'profile' });
  assert.equal(h.view().notice, 'Saved: routing mode balanced → cost. Applies from the next turn.');
  await press(h, 'undo');
  assert.deepEqual(JSON.parse(h.files.get(CONFIG)), {});
  assert.deepEqual(h.view().routingMode, { mode: 'balanced', source: 'default' });
  await command(h, 'mode quality');
  await press(h, 'routing-mode', 'cost');
  assert.deepEqual(h.view().routingMode, { mode: 'quality', source: 'session' });
});

test('the footer names a mode other than balanced', async () => {
  const h = harness(JEV_KEY);
  await start(h);
  const footer = async () => (await h.component('SessionMode', { modes: [] })).props.modes;
  assert.deepEqual(await footer(), []);
  await command(h, 'mode cost');
  assert.deepEqual(await footer(), ['cost mode (session)']);
});

test('the usage record keeps each reply under the mode it ran in', async () => {
  const h = harness(JEV_KEY);
  answering(h, HIGH);
  h.files.set(CONFIG, JSON.stringify({ mode: 'cost' }));
  await start(h);
  await drain(h.step({ ...step, model: 'claude-opus-5-5' }));
  await h.event('turn.complete', { turnId: 't1' });
  const record = h.preferences.get('usage:v1:s1');
  assert.equal(record.version, 2);
  assert.deepEqual(Object.keys(Object.values(record.days)[0].cells), ['cost|none|high|claude-opus-5-5@high']);
});

test('a pinned turn’s replies count under balanced, the routes it ran', async () => {
  const h = harness(JEV_KEY);
  h.files.set(CONFIG, JSON.stringify({ mode: 'cost' }));
  await start(h);
  await command(h, 'pin high');
  await drain(h.step(step));
  await h.event('turn.complete', { turnId: 't1' });
  const record = h.preferences.get('usage:v1:s1');
  assert.deepEqual(Object.keys(Object.values(record.days)[0].cells), ['balanced|none|high|claude-opus-5-5@xhigh']);
});

test('a store that cannot be written keeps the mode for this process and says what a resume does', async () => {
  const h = harness(JEV_KEY);
  await start(h);
  h.$.store.set = async () => {
    throw new Error('store down');
  };
  h.$.store.delete = h.$.store.set;
  assert.equal(
    await command(h, 'mode cost'),
    'Routing mode: cost (session), from the next turn. A resume of this session will not keep it: the store could not be written.',
  );
  assert.equal(
    await command(h, 'mode default'),
    'Routing mode: balanced (default), from the next turn. A resume of this session may bring the cleared mode back: the store could not be written.',
  );
});

test('a symlinked project file is refused, and the home directory has no project file', async () => {
  const h = harness(JEV_KEY);
  h.files.set(PROJECT, JSON.stringify({ mode: 'cost' }));
  h.links.add(PROJECT);
  await start(h);
  assert.deepEqual(h.view().routingMode, { mode: 'balanced', source: 'default' });
  assert.equal(h.view().projectError, 'project .claude/router.json is a symlink');
  const home = harness(JEV_KEY);
  home.env.set('HOME', '/fixture/project');
  home.files.set(PROJECT, JSON.stringify({ routes: {} }));
  await start(home);
  assert.equal(home.view().projectError, null);
});
