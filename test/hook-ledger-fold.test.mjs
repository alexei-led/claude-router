// Folding other sessions' settled records into one archive per session, so the counts kept across sessions take a
// few store reads; and the pane and the band show before those reads.
import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyStore, STORE_KEY, STORE_PREFIX } from '../lib/activity-stats.mjs';
import { FOLD_MIN } from '../lib/ledger-fold.mjs';
import { emptySavingsStore, SAVINGS_PREFIX } from '../lib/savings.mjs';
import { readUsage, summarize } from '../lib/usage.mjs';
import { answering, band, CONFIG, drain, harness, JEV_KEY, press, step } from './harness.mjs';
import { assistant, jevResponse, user } from './helpers.mjs';

const USAGE = 'usage:v1:';
const NOW = new Date(2026, 10, 25, 12).getTime();
const LOW = { micro: 0, low: 0.95, medium: 0.05, high: 0, uncertain: 0 };
const ALL = { from: null, to: null };
const repliesOf = (value) => summarize(readUsage(value), ALL).replies;

// One reply, kept on `day`, as a record written before 1.23 reads.
const settled = (day) => ({
  version: 1,
  since: 1,
  days: {
    [day]: {
      cells: { 'none|low|claude-haiku-5-5@high': [1, 0.1, 0.2, -0.1, 0, 0, 10, 5, 1] },
      whatIf: {},
      yours: {},
      hours: {},
      turns: 1,
      switches: { tier: 0, activity: 0 },
    },
  },
});
const others = (n, day = '2026-09-01') => Array.from({ length: n }, (_, i) => [`${USAGE}old${i}`, settled(day)]);
const usageKeys = (preferences) => [...preferences.keys()].filter((key) => key.startsWith(USAGE)).sort();

// A store that counts its reads, and can hold `keys()` until `release()`.
class CountingStore extends Map {
  gets = 0;
  get(key) {
    this.gets += 1;
    return super.get(key);
  }
}

// Holds every `$.store.keys()` until the returned release() runs; `release.reached` resolves at the first call held.
function gated(h) {
  const { promise, resolve } = Promise.withResolvers();
  const reached = Promise.withResolvers();
  const keys = h.$.store.keys;
  h.$.store.keys = async () => {
    reached.resolve(undefined);
    await promise;
    return keys();
  };
  return Object.assign(resolve, { reached: reached.promise });
}

// Waits until `check()` holds, up to `ms` of wall time (never the mocked Date): a slow machine takes more event-loop
// turns than a fast one.
async function until(check, ms = 2000) {
  const end = performance.now() + ms;
  while (!check() && performance.now() < end) await new Promise((resolve) => setTimeout(resolve, 5));
}

// `$.clock.after` callbacks held until the test runs them.
function heldTimers(h) {
  const later = [];
  h.$.clock.after = (_ms, fn) => {
    later.push(fn);
    return { cancel: () => {} };
  };
  return {
    later,
    runAll: async () => {
      while (later.length) await later.shift()();
    },
  };
}

const within = (promise, ms = 2000) =>
  Promise.race([promise.then(() => 'answered'), new Promise((r) => setTimeout(() => r('waiting'), ms))]);

async function turn(h, turnId) {
  await h.event('turn.start', { turnId, text: 'Next.' });
  h.messages(async () => [user('Next.')]);
  await drain(h.step({ ...step, turnId, model: 'claude-haiku-5-5' }));
  h.messages(async () => [user('Next.'), assistant('done')]);
  await h.event('turn.complete', { turnId });
}

test('a session start folds settled records into its archive, the totals stay, and the next start reads a few', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const preferences = new CountingStore(others(60));
  const h = harness(JEV_KEY, preferences);
  await h.event('session.start', { cwd: '/fixture' });
  assert.equal(summarize(h.view().usageStore, ALL).replies, 60);
  assert.deepEqual(usageKeys(preferences), [`${USAGE}archive:s1`]);
  assert.equal(repliesOf(preferences.get(`${USAGE}archive:s1`)), 60);
  const next = harness(JEV_KEY, preferences);
  next.clear('s2');
  preferences.gets = 0;
  await next.event('session.start', { cwd: '/fixture' });
  assert.equal(summarize(next.view().usageStore, ALL).replies, 60);
  assert.ok(preferences.gets < 40, `${preferences.gets} store reads`);
});

test('a fold cut off after its archive is written counts each record once, and the next start deletes the rest', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  let failed = false;
  const preferences = new (class extends Map {
    delete(key) {
      if (key === `${USAGE}old0` && !failed) {
        failed = true;
        throw new Error('store busy');
      }
      return super.delete(key);
    }
  })(others(FOLD_MIN));
  const h = harness(JEV_KEY, preferences);
  await h.event('session.start', { cwd: '/fixture' });
  assert.ok(preferences.has(`${USAGE}old0`));
  await h.event('command.run', { command: 'router', args: '' });
  assert.equal(summarize(h.view().usageStore, ALL).replies, FOLD_MIN);
  const next = harness(JEV_KEY, preferences);
  next.clear('s2');
  await next.event('session.start', { cwd: '/fixture' });
  assert.deepEqual(usageKeys(preferences), [`${USAGE}archive:s1`]);
  assert.equal(summarize(next.view().usageStore, ALL).replies, FOLD_MIN);
});

test('a fold keeps the totals of the kinds whose records allow no other field (activity, savings)', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const savings = { ...emptySavingsStore(), since: 1, replies: 2, routedUsd: 1 };
  const activity = { ...emptyStore(), since: 1, lateral: { taken: 1, refused: 0 } };
  const preferences = new Map([
    ...others(FOLD_MIN),
    ...Array.from({ length: FOLD_MIN }, (_, i) => [`${SAVINGS_PREFIX}old${i}`, savings]),
    ...Array.from({ length: FOLD_MIN }, (_, i) => [`${STORE_PREFIX}old${i}`, activity]),
  ]);
  const h = harness(JEV_KEY, preferences);
  await h.event('session.start', { cwd: '/fixture' });
  assert.ok(preferences.has(`${SAVINGS_PREFIX}archive:s1`) && preferences.has(`${STORE_PREFIX}archive:s1`));
  await h.event('command.run', { command: 'router', args: '' });
  assert.deepEqual([h.view().savingsStore.replies, h.view().activityStore.lateral.taken], [2 * FOLD_MIN, FOLD_MIN]);
});

test('a session resumed after a fold that took its record in and was cut off counts its earlier turns once', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  let failed = false;
  const preferences = new (class extends Map {
    delete(key) {
      if (key === `${USAGE}old0` && !failed) {
        failed = true;
        throw new Error('store busy');
      }
      return super.delete(key);
    }
  })(others(FOLD_MIN));
  await harness(JEV_KEY, preferences).event('session.start', { cwd: '/fixture' });
  const resumed = harness(JEV_KEY, preferences);
  resumed.clear('old0');
  answering(resumed, jevResponse('low', LOW));
  const timers = heldTimers(resumed);
  await resumed.event('session.start', { cwd: '/fixture' });
  await turn(resumed, 't1');
  await timers.runAll();
  assert.equal(repliesOf(preferences.get(`${USAGE}old0`)), 1);
  await resumed.event('command.run', { command: 'router', args: '' });
  await timers.runAll();
  assert.equal(summarize(resumed.view().usageStore, ALL).replies, FOLD_MIN + 1);
});

test('a resumed session that ends before the counts kept across sessions are read still saves its turns', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const preferences = new Map([[`${USAGE}s1`, settled('2026-09-01')]]);
  const h = harness(JEV_KEY, preferences);
  answering(h, jevResponse('low', LOW));
  heldTimers(h);
  await h.event('session.start', { cwd: '/fixture' });
  await turn(h, 't1');
  await h.event('session.end', { reason: 'exit' });
  assert.equal(repliesOf(preferences.get(`${USAGE}s1`)), 2);
});

test('a resumed session’s first turn checks its record against the archives alone, before it writes', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const preferences = new CountingStore([[`${USAGE}s1`, settled('2026-09-01')], ...others(60)]);
  const h = harness(JEV_KEY, preferences);
  answering(h, jevResponse('low', LOW));
  heldTimers(h);
  await h.event('session.start', { cwd: '/fixture' });
  preferences.gets = 0;
  await turn(h, 't1');
  assert.equal(repliesOf(preferences.get(`${USAGE}s1`)), 2);
  assert.ok(preferences.gets < 60, `${preferences.gets} store reads`);
});

test('a resumed session whose start folds the archive holding its record keeps that record counted once', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  let failed = false;
  const preferences = new (class extends Map {
    delete(key) {
      if (key === `${USAGE}old0` && !failed) {
        failed = true;
        throw new Error('store busy');
      }
      return super.delete(key);
    }
  })(others(FOLD_MIN));
  await harness(JEV_KEY, preferences).event('session.start', { cwd: '/fixture' });
  for (let i = 0; i < FOLD_MIN; i++) preferences.set(`${USAGE}later${i}`, settled('2026-09-01'));
  const resumed = harness(JEV_KEY, preferences);
  resumed.clear('old0');
  await resumed.event('session.start', { cwd: '/fixture' });
  assert.ok(!preferences.has(`${USAGE}archive:s1`), 'the start folded the archive');
  const next = harness(JEV_KEY, preferences);
  next.clear('s9');
  await next.event('command.run', { command: 'router', args: '' });
  assert.equal(summarize(next.view().usageStore, ALL).replies, 2 * FOLD_MIN);
});

test('a session idle past a day checks its record against the archives before it writes again', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 10, 20, 12).getTime() });
  let failed = false;
  const preferences = new (class extends Map {
    delete(key) {
      if (key === `${USAGE}s2` && !failed) {
        failed = true;
        throw new Error('store busy');
      }
      return super.delete(key);
    }
  })();
  const idle = harness(JEV_KEY, preferences);
  idle.clear('s2');
  answering(idle, jevResponse('low', LOW), jevResponse('low', LOW));
  await idle.event('session.start', { cwd: '/fixture' });
  await turn(idle, 't1');
  for (const [key, value] of others(FOLD_MIN)) preferences.set(key, value);
  t.mock.timers.tick(35 * 24 * 60 * 60 * 1000);
  await harness(JEV_KEY, preferences).event('session.start', { cwd: '/fixture' });
  assert.ok(preferences.has(`${USAGE}s2`), 'the fold was cut off before its delete');
  await turn(idle, 't2');
  assert.equal(repliesOf(preferences.get(`${USAGE}s2`)), 1);
  const reader = harness(JEV_KEY, preferences);
  reader.clear('s9');
  await reader.event('command.run', { command: 'router', args: '' });
  assert.equal(summarize(reader.view().usageStore, ALL).replies, FOLD_MIN + 2);
});

test('Delete history’s background delete keeps another session’s record started over after the reset', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const preferences = new Map();
  const [a, b] = [harness(JEV_KEY, preferences), harness(JEV_KEY, preferences)];
  b.clear('s2');
  answering(b, jevResponse('low', LOW), jevResponse('low', LOW));
  await a.event('session.start', { cwd: '/fixture' });
  await b.event('session.start', { cwd: '/fixture' });
  await turn(b, 't1');
  t.mock.timers.tick(1000);
  const timers = heldTimers(a);
  await press(a, 'tab-usage');
  await press(a, 'delete-history');
  await press(a, 'delete-confirm');
  t.mock.timers.tick(1000);
  await turn(b, 't2');
  await timers.runAll();
  assert.equal(repliesOf(preferences.get(`${USAGE}s2`)), 1);
});

test('a session switch while a start reads the counts kept across sessions folds nothing for either session', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const h = harness(JEV_KEY, new Map(others(FOLD_MIN)));
  const timers = heldTimers(h);
  await h.event('session.start', { cwd: '/fixture' });
  const release = gated(h);
  const reading = timers.runAll();
  await release.reached;
  h.clear('s2');
  release();
  await reading;
  assert.deepEqual(
    usageKeys(h.preferences),
    others(FOLD_MIN)
      .map(([key]) => key)
      .sort(),
  );
  assert.equal(h.preferences.get('ledger:fold:v1'), undefined);
});

test('a fold leaves out a record an archive came to hold after the fold read it', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const [first] = others(1);
  const held = {
    ...settled('2026-09-01'),
    folded: [[first[0], readUsage(first[1]).since, JSON.stringify(first[1]).length]],
  };
  const preferences = new (class extends Map {
    set(key, value) {
      // Another start folded old0 into its archive meanwhile, and its delete of old0 failed.
      if (key === 'ledger:fold:v1' && !super.has(`${USAGE}archive:a`)) super.set(`${USAGE}archive:a`, held);
      return super.set(key, value);
    }
  })(others(FOLD_MIN + 1));
  await harness(JEV_KEY, preferences).event('session.start', { cwd: '/fixture' });
  const reader = harness(JEV_KEY, preferences);
  reader.clear('s9');
  await reader.event('command.run', { command: 'router', args: '' });
  assert.equal(summarize(reader.view().usageStore, ALL).replies, FOLD_MIN + 1);
});

test('Delete history says so when the shared record from before 1.10.3 could not be deleted', async () => {
  const preferences = new (class extends Map {
    delete(key) {
      if (key === STORE_KEY) throw new Error('store busy');
      return super.delete(key);
    }
  })([[STORE_KEY, { version: 1, confusion: { ops: { ops: 2 } }, runs: {}, lateral: { taken: 1, refused: 0 } }]]);
  const h = harness(JEV_KEY, preferences);
  await h.event('session.start', { cwd: '/fixture' });
  await press(h, 'tab-usage');
  await press(h, 'delete-history');
  await press(h, 'delete-confirm');
  assert.match(h.view().notice, /could not be deleted/);
});

test('a fold leaves an undated record whose session wrote usage after the read that planned the fold', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const METRICS = 'activity:metrics:v1:';
  const metrics = { version: 1, since: 5, latency: {}, downMoves: { moves: 1, escalations: 0 } };
  const written = { ...metrics, downMoves: { moves: 2, escalations: 0 } };
  let resumed = false;
  const preferences = new (class extends Map {
    get(key) {
      // old0 resumes while the scan runs: it writes usage today, then its metrics, before the scan reads them.
      if (key === `${METRICS}old0` && !resumed) {
        resumed = true;
        super.set(`${USAGE}old0`, settled('2026-11-25'));
        super.set(key, written);
      }
      return super.get(key);
    }
  })([...others(FOLD_MIN), ...Array.from({ length: FOLD_MIN + 1 }, (_, i) => [`${METRICS}old${i}`, metrics])]);
  await harness(JEV_KEY, preferences).event('session.start', { cwd: '/fixture' });
  assert.deepEqual(preferences.get(`${METRICS}old0`), written);
});

test('a turn ending while the counts kept across sessions are read does not wait for them, and counts once', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const h = harness(JEV_KEY, new Map(others(FOLD_MIN)));
  answering(h, jevResponse('low', LOW));
  const timers = heldTimers(h);
  await h.event('session.start', { cwd: '/fixture' });
  const release = gated(h);
  const reading = timers.runAll();
  await h.event('turn.start', { turnId: 't1', text: 'Next.' });
  h.messages(async () => [user('Next.')]);
  await drain(h.step({ ...step, turnId: 't1', model: 'claude-haiku-5-5' }));
  h.messages(async () => [user('Next.'), assistant('done')]);
  assert.equal(await within(h.event('turn.complete', { turnId: 't1' })), 'answered');
  release();
  await reading;
  await timers.runAll();
  assert.equal(summarize(h.view().usageStore, ALL).replies, FOLD_MIN + 1);
});

test('a record its session wrote again while it was folded stays out of the archive and in the store', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const fresh = settled('2026-11-25');
  let reads = 0;
  const preferences = new (class extends Map {
    get(key) {
      // The session writes its record between the read for the view and the read again before the fold.
      if (key === `${USAGE}old0` && ++reads === 2) super.set(key, fresh);
      return super.get(key);
    }
  })(others(FOLD_MIN + 1));
  const h = harness(JEV_KEY, preferences);
  await h.event('session.start', { cwd: '/fixture' });
  assert.deepEqual(preferences.get(`${USAGE}old0`), fresh);
  assert.equal(repliesOf(preferences.get(`${USAGE}archive:s1`)), FOLD_MIN);
});

test('a session whose record another session folded starts its record over, so no reply counts twice', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 10, 20, 12).getTime() });
  const preferences = new Map();
  const [a, b] = [harness(JEV_KEY, preferences), harness(JEV_KEY, preferences)];
  b.clear('s2');
  answering(b, jevResponse('low', LOW));
  await b.event('session.start', { cwd: '/fixture' });
  await turn(b, 't1');
  for (const [key, value] of others(FOLD_MIN)) preferences.set(key, value);
  t.mock.timers.tick(35 * 24 * 60 * 60 * 1000);
  await a.event('session.start', { cwd: '/fixture' });
  assert.equal(preferences.has(`${USAGE}s2`), false);
  await turn(b, 't2');
  assert.equal(repliesOf(preferences.get(`${USAGE}s2`)), 1);
  await a.event('command.run', { command: 'router', args: '' });
  assert.equal(summarize(a.view().usageStore, ALL).replies, FOLD_MIN + 2);
});

test('a session whose lease another start claimed while it read the records leaves them to that start', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const preferences = new (class extends Map {
    get(key) {
      if (key === `${USAGE}old0`) super.set('ledger:fold:v1', { sessionId: 's9', at: NOW });
      return super.get(key);
    }
  })(others(FOLD_MIN));
  const h = harness(JEV_KEY, preferences);
  await h.event('session.start', { cwd: '/fixture' });
  assert.equal(usageKeys(preferences).length, FOLD_MIN);
  assert.deepEqual(preferences.get('ledger:fold:v1'), { sessionId: 's9', at: NOW });
});

test('a session that finds another one folding leaves the records to it', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const preferences = new Map([...others(FOLD_MIN), ['ledger:fold:v1', { sessionId: 's9', at: NOW - 1000 }]]);
  const h = harness(JEV_KEY, preferences);
  await h.event('session.start', { cwd: '/fixture' });
  assert.equal(usageKeys(preferences).length, FOLD_MIN);
  assert.equal(summarize(h.view().usageStore, ALL).replies, FOLD_MIN);
});

test('the band’s Router opens the pane and answers the press before the counts kept across sessions are read', async () => {
  const h = harness(JEV_KEY, new Map(others(FOLD_MIN)));
  await h.event('session.start', { cwd: '/fixture' });
  const opened = [];
  const open = h.$.ui.open;
  h.$.ui.open = async (args) => {
    opened.push(args.id);
    return open(args);
  };
  const release = gated(h);
  const router = (await band(h)).controls.find((node) => node.key === 'details');
  const pressed = router.onPress();
  const answer = await Promise.race([
    pressed.then(() => 'answered'),
    new Promise((r) => setTimeout(() => r('waiting'), 2000)),
  ]);
  assert.deepEqual([opened, answer], [['jev-router'], 'answered']);
  release();
  await h.event('turn.start', { turnId: 'later', text: 'Next.' });
  assert.equal(summarize(h.view().usageStore, ALL).replies, FOLD_MIN);
});

test('a session start shows the routing mode before the counts kept across sessions are read', async () => {
  const h = harness(JEV_KEY, new Map(others(FOLD_MIN)));
  const release = gated(h);
  const started = h.event('session.start', { cwd: '/fixture' });
  await until(() => h.view()?.routingMode);
  assert.deepEqual([h.view().routingMode?.mode, h.view().usageStore], ['balanced', null]);
  release();
  await started;
  assert.equal(summarize(h.view().usageStore, ALL).replies, FOLD_MIN);
});

test('session.start answers before any record kept across sessions is read; a timer reads them', async () => {
  const h = harness(JEV_KEY, new Map(others(FOLD_MIN)));
  const later = [];
  h.$.clock.after = (_ms, fn) => {
    later.push(fn);
    return { cancel: () => {} };
  };
  await h.event('session.start', { cwd: '/fixture' });
  assert.deepEqual([h.view().routingMode?.mode, h.view().usageStore], ['balanced', null]);
  await Promise.all(later.splice(0).map((fn) => fn()));
  assert.equal(summarize(h.view().usageStore, ALL).replies, FOLD_MIN);
});

test('the pane draws while the store is busy: drawing reads no store record', async () => {
  const h = harness(JEV_KEY, new Map(others(FOLD_MIN)));
  h.files.set(CONFIG, JSON.stringify({ routingEngine: 'shadow' }));
  await h.event('session.start', { cwd: '/fixture' });
  assert.equal(h.view().configPath, CONFIG);
  h.$.store.get = () => new Promise(() => {});
  h.$.store.keys = () => new Promise(() => {});
  const drawn = await Promise.race([h.render(), new Promise((resolve) => setTimeout(() => resolve('blocked'), 500))]);
  assert.notEqual(drawn, 'blocked');
});

test('a fold goes a few records at a time, with a pause between, so other store calls run in between', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const ops = [];
  const preferences = new (class extends Map {
    delete(key) {
      ops.push('delete');
      return super.delete(key);
    }
  })(others(25));
  const h = harness(JEV_KEY, preferences);
  const after = h.$.clock.after;
  h.$.clock.after = (ms, fn) => {
    if (ms > 0) ops.push(`pause ${ms}`);
    return after(ms, fn);
  };
  await h.event('session.start', { cwd: '/fixture' });
  const runs = ops
    .join(' ')
    .split(/pause \d+/)
    .map((run) => run.trim().split(' ').filter(Boolean).length);
  assert.deepEqual(runs, [0, 10, 10, 6]);
  assert.equal(usageKeys(preferences).length, 1);
});

test('a session start leaves the metrics of a session at work, and folds an idle one’s', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const METRICS = 'activity:metrics:v1:';
  const metrics = { version: 1, since: 5, latency: {}, downMoves: { moves: 1, escalations: 0 } };
  const preferences = new Map([
    ...others(FOLD_MIN),
    [`${USAGE}busy`, settled('2026-11-25')],
    ...Array.from({ length: FOLD_MIN }, (_, i) => [`${METRICS}old${i}`, metrics]),
    [`${METRICS}busy`, metrics],
  ]);
  const h = harness(JEV_KEY, preferences);
  await h.event('session.start', { cwd: '/fixture' });
  assert.deepEqual([...preferences.keys()].filter((key) => key.startsWith(METRICS)).sort(), [
    `${METRICS}archive:s1`,
    `${METRICS}busy`,
  ]);
});

test('a session start deletes all but the newest session modes in the background', async () => {
  const preferences = new Map(Array.from({ length: 105 }, (_, i) => [`mode:old${i}`, 'auto']));
  const h = harness(JEV_KEY, preferences);
  await h.event('session.start', { cwd: '/fixture' });
  const modes = [...preferences.keys()].filter((key) => key.startsWith('mode:'));
  assert.equal(modes.length, 100);
  assert.ok(!preferences.has('mode:old0') && preferences.has('mode:old104'));
});

test('Delete history answers the press before the records are deleted, and stops a fold', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const preferences = new Map(others(FOLD_MIN + 12));
  const h = harness(JEV_KEY, preferences);
  const later = [];
  h.$.clock.after = (_ms, fn) => {
    later.push(fn);
    return { cancel: () => {} };
  };
  await h.event('session.start', { cwd: '/fixture' });
  while (later.length && !preferences.has('ledger:fold:v1')) await later.shift()();
  await press(h, 'tab-usage');
  await press(h, 'delete-history');
  await press(h, 'delete-confirm');
  assert.ok(usageKeys(preferences).length > 0, 'deleted inside the press');
  assert.equal(summarize(h.view().usageStore, ALL).replies, 0);
  while (later.length) await later.shift()();
  assert.deepEqual(usageKeys(preferences), []);
});

test('Delete history deletes this session’s records in the press and the others’ from a timer, which leaves this session’s alone', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const h = harness(JEV_KEY, new Map(others(2)));
  answering(h, jevResponse('low', LOW), jevResponse('low', LOW));
  await h.event('session.start', { cwd: '/fixture' });
  await turn(h, 't1');
  t.mock.timers.tick(1000);
  const timers = heldTimers(h);
  await press(h, 'tab-usage');
  await press(h, 'delete-history');
  await press(h, 'delete-confirm');
  assert.deepEqual(usageKeys(h.preferences), [`${USAGE}old0`, `${USAGE}old1`]);
  assert.equal(summarize(h.view().usageStore, ALL).replies, 0);
  t.mock.timers.tick(1000);
  await turn(h, 't2');
  await timers.runAll();
  assert.deepEqual(usageKeys(h.preferences), [`${USAGE}s1`]);
  assert.equal(repliesOf(h.preferences.get(`${USAGE}s1`)), 1);
});

test('a turn between Delete history and its background delete keeps the counts it wrote after the reset', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const h = harness(JEV_KEY, new Map());
  answering(h, jevResponse('low', LOW), jevResponse('low', LOW), jevResponse('low', LOW));
  await h.event('session.start', { cwd: '/fixture' });
  await turn(h, 't1');
  t.mock.timers.tick(1000);
  const timers = heldTimers(h);
  await press(h, 'tab-usage');
  await press(h, 'delete-history');
  await press(h, 'delete-confirm');
  t.mock.timers.tick(1000);
  await turn(h, 't2');
  await timers.runAll();
  assert.equal(repliesOf(h.preferences.get(`${USAGE}s1`)), 1);
  await turn(h, 't3');
  await timers.runAll();
  assert.equal(repliesOf(h.preferences.get(`${USAGE}s1`)), 2);
});
