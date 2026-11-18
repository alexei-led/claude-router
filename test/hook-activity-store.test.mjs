// The activity counts and latency the hook keeps across sessions: their reads, writes, resets and failures.
import assert from 'node:assert/strict';
import test from 'node:test';
import { STORE_KEY, STORE_PREFIX } from '../lib/activity-stats.mjs';
import { answering, CONFIG, drain, harness, JEV_KEY, press, step, texts } from './harness.mjs';
import { assistant, jevResponse, savedStats, user } from './helpers.mjs';

const LOW = { micro: 0, low: 0.95, medium: 0.05, high: 0, uncertain: 0 };

const isStats = (key) => key.startsWith('activity:stats:');

// One whole turn on the session's `model`: its prompt, a routed step, then turn.complete over a transcript where the
// assistant called `tools`.
async function turn(h, turnId, model, tools = []) {
  await h.event('turn.start', { turnId, text: 'Next.' });
  h.messages(async () => [user('Next.')]);
  await drain(h.step({ ...step, turnId, model }));
  h.messages(async () => [user('Next.'), assistant('done', tools)]);
  await h.event('turn.complete', { turnId });
}

const _tick = () => new Promise((resolve) => setImmediate(resolve));

test('the classifier latency is the wait for its answer, not the routing after it', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  const h = harness(JEV_KEY);
  h.files.set(CONFIG, JSON.stringify({ activityRouting: 'on' }));
  answering(h, jevResponse('low', LOW, 0, { code: 0.9, ops: 0.1 }));
  await h.event('session.start', { cwd: '/fixture' });
  const set = h.$.state.set;
  h.$.state.set = async (...args) => {
    t.mock.timers.tick(120);
    return set(...args);
  };
  await turn(h, 't1', 'claude-sonnet-5-5', ['Edit']);
  assert.deepEqual(h.preferences.get('activity:metrics:v1:s1').latency.jev, [1, ...Array(21).fill(0)]);
});

test('the counts across sessions reach the view and survive a restart', async () => {
  const h = harness(JEV_KEY);
  answering(h, jevResponse('low', LOW, 0, { code: 0.9, ops: 0.1 }));
  await h.event('session.start', { cwd: '/fixture' });
  await turn(h, 't1', 'claude-haiku-5-5', ['Edit']);
  await turn(h, 't2', 'claude-haiku-5-5', ['Edit']);
  assert.deepEqual(h.view().activityStore, savedStats(h.preferences));
  await press(h, 'tab-classifier');
  const lines = texts(await h.render());
  assert.ok(lines.includes('THIS SESSION'));
  assert.ok(lines.includes('Tool compatibility (not accuracy): 2 of 2 turns (100%)'));
  h.surfaces([]);
  const detail = async (r) => (await r.event('command.run', { command: 'router', args: '' })).text;
  assert.match(
    await detail(h),
    /^Tool compatibility across sessions \(not accuracy\): 2 of 2 turns \(100%\) · code\/ops\/explore 2 of 2 \(100%\)$/m,
  );
  await h.event('session.end', { reason: 'clear' });

  const reloaded = harness(JEV_KEY, h.preferences);
  await reloaded.event('session.start', { cwd: '/fixture' });
  assert.equal(reloaded.view().activityStats, null);
  assert.deepEqual(reloaded.view().activityStore, savedStats(h.preferences));
  await press(reloaded, 'tab-classifier');
  assert.ok(texts(await reloaded.render()).includes('Labelled   2 turns'));
});

test('two sessions finishing turns at the same moment both keep their counts', async () => {
  const preferences = new Map();
  const a = harness(JEV_KEY, preferences);
  const b = harness(JEV_KEY, preferences);
  b.clear('s2');
  for (const h of [a, b]) {
    answering(h, jevResponse('low', LOW, 0, { code: 0.9, ops: 0.1 }));
    await h.event('session.start', { cwd: '/fixture' });
  }
  await a.event('turn.start', { turnId: 't1', text: 'Next.' });
  a.messages(async () => [user('Next.')]);
  await drain(a.step({ ...step, turnId: 't1', model: 'claude-haiku-5-5' }));
  a.messages(async () => [user('Next.'), assistant('done', ['Edit'])]);
  // a reads what the store holds, then b's turn finishes before a writes.
  const { promise: bDone, resolve } = Promise.withResolvers();
  const get = a.$.store.get;
  a.$.store.get = async (key) => {
    const value = await get(key);
    await bDone;
    return value;
  };
  const completing = a.event('turn.complete', { turnId: 't1' });
  await turn(b, 't1', 'claude-haiku-5-5', ['Edit']);
  resolve();
  await completing;
  assert.deepEqual(savedStats(preferences).confusion, { code: { code: 2 } });
});

test('a Reset in another session empties a shared goal-contract counter at the next turn', async () => {
  const shared = { version: 1, confusion: { ops: { ops: 5 } }, runs: {}, lateral: { taken: 3, refused: 0 } };
  const preferences = new Map([[STORE_KEY, shared]]);
  const a = harness(JEV_KEY, preferences);
  const b = harness(JEV_KEY, preferences);
  b.clear('s2');
  for (const h of [a, b]) {
    answering(h, jevResponse('low', LOW, 0, { code: 0.9, ops: 0.1 }));
    await h.event('session.start', { cwd: '/fixture' });
  }
  assert.equal(a.view().activityStore.lateral.taken, 3);
  await press(b, 'tab-usage');
  await press(b, 'delete-history');
  await press(b, 'delete-confirm');
  await turn(a, 't1', 'claude-haiku-5-5', ['Edit']);
  assert.equal(preferences.has(STORE_KEY), false);
  assert.deepEqual(a.view().activityStore.confusion, { code: { code: 1 } });
  assert.deepEqual(a.view().activityStore, savedStats(preferences));
});

test('a corrupted or unreadable stats store shows an empty readout and never breaks the session', async () => {
  for (const [name, preferences] of [
    ['corrupted', new Map([[`${STORE_PREFIX}s0`, { version: 1, confusion: 'text' }]])],
    [
      'unreadable',
      {
        get: (key) => {
          if (isStats(key)) throw new Error('store down');
        },
        set: () => {},
      },
    ],
  ]) {
    const h = harness(JEV_KEY, preferences);
    await h.event('session.start', { cwd: '/fixture' });
    assert.equal(h.view().phase, 'ready', name);
    await press(h, 'tab-classifier');
    const lines = texts(await h.render());
    assert.ok(!lines.includes('ACROSS SESSIONS · since the last reset'), name);
    h.surfaces([]);
    const { text } = await h.event('command.run', { command: 'router', args: '' });
    assert.match(text, /^Tool compatibility across sessions: no labelled turns yet$/m, name);
  }
});

test('/router activities writes the mode to router.json, off stops the question, and Undo restores it', async () => {
  const h = harness(JEV_KEY);
  const bodies = answering(h, jevResponse('low', LOW, 0, { code: 0.9, ops: 0.1 }));
  await h.event('session.start', { cwd: '/fixture' });
  await turn(h, 't1', 'claude-haiku-5-5');
  assert.ok(bodies[0].questions.activity);
  const command = async (args) => (await h.event('command.run', { command: 'router', args })).text;
  assert.equal(await command('activities later'), 'Choose activities off, on.');
  assert.equal(await command('activities on'), 'Activity routing is already on.');
  assert.equal(await command('activities off'), 'Saved: activity routing on → off. Applies from the next turn.');
  assert.deepEqual(JSON.parse(h.files.get(CONFIG)), { activityRouting: 'off' });
  await turn(h, 't2', 'claude-haiku-5-5');
  assert.equal(bodies.length, 2);
  assert.equal(bodies[1].questions.activity, undefined);
  assert.equal(h.view().activity, null);
  assert.equal(h.view().activityStats.byActivity.code.turns, 1);
  assert.equal(h.view().activityStats.byActivity.none, undefined);
  await press(h, 'undo');
  assert.deepEqual(JSON.parse(h.files.get(CONFIG)), {});
  await turn(h, 't3', 'claude-haiku-5-5');
  assert.ok(bodies[2].questions.activity);
});

test('a failing stats store or transcript never breaks a turn', async () => {
  const saved = new Map();
  const store = {
    get: (key) => {
      if (isStats(key)) throw new Error('store down');
      return saved.get(key);
    },
    set: (key, value) => {
      if (isStats(key)) throw new Error('store down');
      return saved.set(key, value);
    },
  };
  const h = harness(JEV_KEY, store);
  answering(h, jevResponse('low', LOW, 0, { code: 0.9, ops: 0.1 }));
  await h.event('session.start', { cwd: '/fixture' });
  await turn(h, 't1', 'claude-haiku-5-5', ['Edit']);
  assert.equal(h.requests[0].model, 'claude-sonnet-5-5');
  assert.equal(h.view().activityStats.byActivity.code.turns, 1);
  await h.event('turn.start', { turnId: 't2', text: 'Next.' });
  await drain(h.step({ ...step, turnId: 't2' }));
  h.messages(() => Promise.reject(new Error('transcript gone')));
  await h.event('turn.complete', { turnId: 't2' });
  assert.equal(h.requests.length, 2);
  assert.equal(h.view().activityStats.byActivity.code.turns, 1);
  await h.event('session.end', { reason: 'clear' });
});

test('a turn finishing while the session changes records nothing into the new session', async () => {
  const h = harness(JEV_KEY);
  answering(h, jevResponse('low', LOW, 0, { code: 0.9, ops: 0.1 }));
  await h.event('session.start', { cwd: '/fixture' });
  await turn(h, 't1', 'claude-haiku-5-5', ['Edit']);
  await h.event('turn.start', { turnId: 't2', text: 'Next.' });
  await drain(h.step({ ...step, turnId: 't2' }));
  let release;
  h.messages(() => new Promise((resolve) => (release = () => resolve([user('Next.'), assistant('done', ['Edit'])]))));
  const completing = h.event('turn.complete', { turnId: 't2' });
  for (let i = 0; i < 100 && !release; i += 1) await Promise.resolve();
  await h.event('session.end', { reason: 'clear' });
  h.clear('s2');
  await h.event('session.start', { cwd: '/fixture' });
  release();
  await completing;
  assert.equal(h.view().activityStats, null);
  assert.deepEqual(savedStats(h.preferences).confusion, { code: { code: 1 } });
  assert.deepEqual(savedStats(h.preferences).runs, { code: [1, 0, 0, 0, 0] });
});

test('a session ending while a turn writes its stats leaves no run in the new session', async () => {
  const h = harness(JEV_KEY);
  answering(h, jevResponse('low', LOW, 0, { code: 0.9, ops: 0.1 }));
  await h.event('session.start', { cwd: '/fixture' });
  await turn(h, 't1', 'claude-haiku-5-5', ['Edit']);
  await h.event('turn.start', { turnId: 't2', text: 'Next.' });
  await drain(h.step({ ...step, turnId: 't2' }));
  h.messages(async () => [user('Next.'), assistant('done', ['Edit'])]);
  const set = h.$.state.set;
  let release;
  h.$.state.set = async (ref, value, options) => {
    if (ref.key === 'view' && value.activityStats && !release) await new Promise((resolve) => (release = resolve));
    return set(ref, value, options);
  };
  const completing = h.event('turn.complete', { turnId: 't2' });
  for (let i = 0; i < 100 && !release; i += 1) await Promise.resolve();
  h.$.state.set = set;
  await h.event('session.end', { reason: 'clear' });
  h.clear('s2');
  await h.event('session.start', { cwd: '/fixture' });
  release();
  await completing;
  await h.event('session.end', { reason: 'clear' });
  assert.deepEqual(savedStats(h.preferences).runs, { code: [0, 1, 0, 0, 0] });
});

test('two sessions finishing turns at the same moment both add to the metrics kept across sessions', async () => {
  const writes = [];
  let gated = false;
  // Each write lands only once both sessions have sent theirs.
  const preferences = new (class extends Map {
    set(key, value) {
      if (!gated || !key.startsWith('activity:metrics:')) return super.set(key, value);
      const { promise, resolve } = Promise.withResolvers();
      writes.push(() => resolve(super.set(key, value)));
      if (writes.length === 2) for (const write of writes) write();
      return promise;
    }
  })();
  const sessions = [harness(JEV_KEY, preferences), harness(JEV_KEY, preferences)];
  sessions[1].clear('s2');
  for (const h of sessions) {
    answering(h, jevResponse('low', LOW, 0, { code: 0.9, ops: 0.1 }));
    await h.event('session.start', { cwd: '/fixture' });
    await h.event('turn.start', { turnId: 't1', text: 'Next.' });
    await drain(h.step({ ...step, model: 'claude-haiku-5-5' }));
  }
  gated = true;
  await Promise.all(sessions.map((h) => h.event('turn.complete', { turnId: 't1' })));
  gated = false;
  assert.equal(writes.length, 2);
  await sessions[0].event('command.run', { command: 'router', args: '' });
  assert.deepEqual(sessions[0].view().activityMetrics.latency.jev, [2, ...Array(21).fill(0)]);
});

test('a Reset in one session drops the metrics another session still holds from before it', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000 });
  const preferences = new Map();
  const [a, b] = [harness(JEV_KEY, preferences), harness(JEV_KEY, preferences)];
  b.clear('s2');
  answering(b, jevResponse('low', LOW, 0, { code: 0.9, ops: 0.1 }));
  await b.event('session.start', { cwd: '/fixture' });
  await turn(b, 't1', 'claude-haiku-5-5', ['Edit']);
  assert.deepEqual(preferences.get('activity:metrics:v1:s2').latency.jev, [1, ...Array(21).fill(0)]);
  await a.event('session.start', { cwd: '/fixture' });
  t.mock.timers.tick(1);
  await press(a, 'tab-usage');
  await press(a, 'delete-history');
  await press(a, 'delete-confirm');
  assert.equal(preferences.get('activity:metrics:v1:s2'), undefined);
  t.mock.timers.tick(1);
  await turn(b, 't2', 'claude-haiku-5-5', ['Edit']);
  const record = preferences.get('activity:metrics:v1:s2');
  assert.deepEqual([record.since, record.latency.jev], [1_002, [1, ...Array(21).fill(0)]]);
  await a.event('command.run', { command: 'router', args: '' });
  assert.deepEqual(a.view().activityMetrics.latency.jev, [1, ...Array(21).fill(0)]);
});
