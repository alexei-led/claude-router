// The usage the hook records per reply and per turn, and the records it keeps across sessions.
import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULTS } from '../lib/config.mjs';
import { comparedModel } from '../lib/display.mjs';
import { modelAlias } from '../lib/savings.mjs';
import { readUsage, summarize } from '../lib/usage.mjs';
import { answering, drain, harness, JEV_KEY, press, step } from './harness.mjs';
import { assistant, jevResponse, sessionOf, user } from './helpers.mjs';

// Your model's simulated cache: the one kept for the model /model selects.
const yours = (h) => h.loop().yoursBy[modelAlias(DEFAULTS, h.view().nativeModel)];

const LOW = { micro: 0, low: 0.95, medium: 0.05, high: 0, uncertain: 0 };

// One whole turn on the session's `model`: its prompt, a routed step, then turn.complete over a transcript where the
// assistant called `tools`.
async function turn(h, turnId, model, tools = []) {
  await h.event('turn.start', { turnId, text: 'Next.' });
  h.messages(async () => [user('Next.')]);
  await drain(h.step({ ...step, turnId, model }));
  h.messages(async () => [user('Next.'), assistant('done', tools)]);
  await h.event('turn.complete', { turnId });
}

const _reply = { turns: 1, requests: 1, inputTokens: 1100, outputTokens: 10 };

const _tick = () => new Promise((resolve) => setImmediate(resolve));

const _ran = (id, isError = false) => ({
  role: 'user',
  content: [{ type: 'tool_result', tool_use_id: id, is_error: isError }],
});

const USAGE = 'usage:v1:';

const LEGACY = {
  version: 1,
  since: 500,
  replies: 400,
  routedUsd: 41.18,
  yoursUsd: 52.6,
  cheaperUsd: -14.9,
  strongerUsd: 0,
  switchUsd: 3.48,
};

const ALL = { from: null, to: null };

const totalOf = (value) => summarize(readUsage(value), ALL);

test('a running turn’s replies count once in the session, before and after the turn is recorded, and Delete history clears them', async () => {
  const h = harness(JEV_KEY);
  answering(h, jevResponse('low', LOW));
  h.usage({ startedAt: 0, context: { tokens: 8000 }, rateLimits: [] });
  await h.event('session.start', { cwd: '/fixture' });
  await h.event('turn.start', { turnId: 't1', text: 'Next.' });
  h.messages(async () => [user('Next.')]);
  await drain(h.step({ ...step, turnId: 't1', model: 'claude-haiku-5-5' }));
  await drain(h.step({ ...step, turnId: 't1', index: 1, model: 'claude-haiku-5-5' }));
  assert.deepEqual([h.view().usageLive.length, sessionOf(h).replies], [2, 2]);
  assert.equal(h.preferences.get(`${USAGE}s1`), undefined);
  const live = sessionOf(h);
  await h.event('turn.complete', { turnId: 't1' });
  assert.deepEqual([h.view().usageLive.length, sessionOf(h).replies], [0, 2]);
  assert.ok(Math.abs(sessionOf(h).routedUsd - live.routedUsd) < 1e-9);
  await h.event('turn.start', { turnId: 't2', text: 'Next.' });
  await drain(h.step({ ...step, turnId: 't2', model: 'claude-haiku-5-5' }));
  assert.equal(sessionOf(h).replies, 3);
  await press(h, 'tab-usage');
  await press(h, 'delete-history');
  await press(h, 'delete-confirm');
  assert.deepEqual([h.view().usageLive.length, sessionOf(h).replies], [0, 0]);
});

test('a routed reply is priced against your model in the session readout and, at turn end, the usage record', async () => {
  // A plan subscriber's replies report plan rate limits, and Claude Code then caches the main conversation for 1h.
  for (const [rateLimits, writeMultiplier] of [
    [[], 1.25],
    [[{ kind: 'five_hour', percentUsed: 10 }], 2],
  ]) {
    const h = harness(JEV_KEY);
    answering(h, jevResponse('low', LOW));
    h.usage({ startedAt: 0, context: { tokens: 8000 }, rateLimits });
    await h.event('session.start', { cwd: '/fixture' });
    await turn(h, 't1', 'claude-haiku-5-5');
    assert.deepEqual([h.requests[0].model, h.requests[0].effort], ['claude-haiku-5-5', 'high']);
    // Haiku at high against the session's Haiku at medium: one price, and the API read what a single cache would.
    const usd = (0.1 * (100 + 200 * writeMultiplier) + 0.01 * 800 + 0.5 * 10) / 1e6;
    const savings = sessionOf(h);
    assert.equal(savings.replies, 1);
    assert.ok(Math.abs(savings.routedUsd - usd) < 1e-12);
    assert.equal(savings.yoursUsd, savings.routedUsd);
    // Haiku 5.5 keeps one cache across efforts, so the reply ran on your cache.
    assert.deepEqual([yours(h).total, yours(h).onYours], [1100, true]);
    const record = h.preferences.get(`${USAGE}s1`);
    const total = totalOf(record);
    assert.deepEqual(
      [total.replies, total.turns, total.inputTokens, total.cacheReadTokens, total.outputTokens],
      [1, 1, 1100, 800, 10],
    );
    assert.ok(Math.abs(total.routedUsd - usd) < 1e-6);
    assert.deepEqual(Object.keys(total.cells), ['balanced|none|low|claude-haiku-5-5@high']);
    assert.deepEqual(total.yours, { 'claude-haiku-5-5': 1 });
    assert.ok(Number.isFinite(record.since));
    assert.deepEqual([h.view().usageSession, h.view().usageStore], [record, record]);
    assert.equal(h.preferences.get('savings:v1:s1'), undefined);
  }
});

test('after a /model change the session stays against the model each reply ran against, and What if prices every model', async () => {
  const h = harness(JEV_KEY);
  answering(h, jevResponse('low', LOW));
  h.usage({ startedAt: 0, context: { tokens: 8000 }, rateLimits: [] });
  await h.event('session.start', { cwd: '/fixture' });
  await turn(h, 't1', 'claude-haiku-5-5');
  const before = sessionOf(h);
  assert.equal(comparedModel(DEFAULTS, h.view(), before), 'Haiku 5.5 · medium');
  h.model('claude-opus-5-5');
  await h.event('command.run', { command: 'model', origin: { kind: 'user' } });
  const after = sessionOf(h);
  assert.deepEqual([after.replies, after.yoursUsd], [before.replies, before.yoursUsd]);
  assert.equal(comparedModel(DEFAULTS, h.view(), after), 'Haiku 5.5');
  // What the same tokens cost on each model as yours, for What if.
  const [haiku, sonnet, opus] = ['haiku', 'sonnet', 'opus'].map((alias) => after.whatIf[DEFAULTS.models[alias].id]);
  assert.deepEqual([haiku[0], sonnet[0], opus[0]], [1, 1, 1]);
  assert.ok(opus[1] > sonnet[1] && sonnet[1] > haiku[1]);
  assert.ok(Math.abs(haiku[1] - after.yoursUsd) < 1e-6);
});

test('a reply is kept on the local day it arrived, and the turn and its switch on the day it ended', async (t) => {
  const evening = new Date(2026, 9, 12, 23, 59, 59, 900).getTime();
  t.mock.timers.enable({ apis: ['Date'], now: evening });
  const h = harness(JEV_KEY);
  answering(h, jevResponse('low', LOW));
  await h.event('session.start', { cwd: '/fixture' });
  await h.event('turn.start', { turnId: 't1', text: 'Next.' });
  h.messages(async () => [user('Next.')]);
  await drain(h.step({ ...step, model: 'claude-haiku-5-5' }));
  t.mock.timers.tick(200);
  h.messages(async () => [user('Next.'), assistant('done')]);
  await h.event('turn.complete', { turnId: 't1' });
  const { days } = readUsage(h.preferences.get(`${USAGE}s1`));
  assert.deepEqual(Object.keys(days).sort(), ['2026-10-12', '2026-10-13']);
  assert.deepEqual([Object.keys(days['2026-10-12'].cells).length, days['2026-10-12'].turns], [1, 0]);
  assert.deepEqual(days['2026-10-12'].hours, {
    23: days['2026-10-12'].cells['balanced|none|low|claude-haiku-5-5@high'][1],
  });
  assert.deepEqual([Object.keys(days['2026-10-13'].cells).length, days['2026-10-13'].turns], [0, 1]);
});

test('opening the pane while a turn writes its usage counts the turn once', async () => {
  let gate = null;
  const preferences = new (class extends Map {
    set(key, value) {
      super.set(key, value);
      if (!gate || !key.startsWith(USAGE)) return this;
      gate.reached();
      return gate.written;
    }
  })();
  const h = harness(JEV_KEY, preferences);
  answering(h, jevResponse('low', LOW));
  await h.event('session.start', { cwd: '/fixture' });
  await h.event('turn.start', { turnId: 't1', text: 'Next.' });
  await drain(h.step({ ...step, model: 'claude-haiku-5-5' }));
  const reached = Promise.withResolvers();
  const written = Promise.withResolvers();
  gate = { reached: reached.resolve, written: written.promise };
  const completing = h.event('turn.complete', { turnId: 't1' });
  await reached.promise;
  gate = null;
  await h.event('command.run', { command: 'router', args: '' });
  // The pane opened mid-write: the record holds the turn, and the running replies no longer do.
  assert.deepEqual([h.view().usageLive.length, sessionOf(h).replies], [0, 1]);
  written.resolve();
  await completing;
  assert.deepEqual([h.view().usageLive.length, sessionOf(h).replies], [0, 1]);
  assert.equal(totalOf(h.view().usageStore).replies, 1);
  await h.event('command.run', { command: 'router', args: '' });
  assert.equal(totalOf(h.view().usageStore).replies, 1);
});

test('a reply that joins the turn while its usage record is read is recorded with it', async () => {
  let gate = null;
  const preferences = new (class extends Map {
    get(key) {
      // The usage flush's read of the reset marker, told apart from the other ledgers' by its async stack.
      if (!gate || key !== 'savings:reset:v1' || !new Error().stack.includes('flushUsage')) return super.get(key);
      const { reached, released } = gate;
      gate = null;
      reached();
      return released.then(() => super.get(key));
    }
  })();
  const h = harness(JEV_KEY, preferences);
  answering(h, jevResponse('low', LOW));
  await h.event('session.start', { cwd: '/fixture' });
  await h.event('turn.start', { turnId: 't1', text: 'Next.' });
  await drain(h.step({ ...step, model: 'claude-haiku-5-5' }));
  const reached = Promise.withResolvers();
  const released = Promise.withResolvers();
  gate = { reached: reached.resolve, released: released.promise };
  const completing = h.event('turn.complete', { turnId: 't1' });
  await reached.promise;
  await drain(h.step({ ...step, index: 1, model: 'claude-haiku-5-5' }));
  released.resolve();
  await completing;
  assert.deepEqual([h.view().usageLive.length, sessionOf(h).replies], [0, 2]);
  assert.equal(totalOf(h.preferences.get(`${USAGE}s1`)).replies, 2);
});

test('a usage write that fails keeps the turn counted once, and the next turn writes it', async () => {
  let fail = false;
  const preferences = new (class extends Map {
    set(key, value) {
      if (fail && key.startsWith(USAGE)) throw new Error('store full');
      return super.set(key, value);
    }
  })();
  const h = harness(JEV_KEY, preferences);
  answering(h, jevResponse('low', LOW));
  await h.event('session.start', { cwd: '/fixture' });
  fail = true;
  await turn(h, 't1', 'claude-haiku-5-5');
  assert.deepEqual([h.view().usageLive.length, sessionOf(h).replies], [0, 1]);
  assert.equal(h.preferences.get(`${USAGE}s1`), undefined);
  fail = false;
  await h.event('turn.start', { turnId: 't2', text: 'Next.' });
  await drain(h.step({ ...step, turnId: 't2', model: 'claude-haiku-5-5' }));
  assert.equal(sessionOf(h).replies, 2);
  await h.event('turn.complete', { turnId: 't2' });
  assert.equal(totalOf(h.preferences.get(`${USAGE}s1`)).replies, 2);
});

test('two sessions finishing turns at the same moment both add to the usage kept across sessions', async () => {
  const writes = [];
  let gated = false;
  // Each write lands only once both sessions have sent theirs.
  const preferences = new (class extends Map {
    set(key, value) {
      if (!gated || !key.startsWith(USAGE)) return super.set(key, value);
      const { promise, resolve } = Promise.withResolvers();
      writes.push(() => resolve(super.set(key, value)));
      if (writes.length === 2) for (const write of writes) write();
      return promise;
    }
  })();
  const sessions = [harness(JEV_KEY, preferences), harness(JEV_KEY, preferences)];
  sessions[1].clear('s2');
  for (const h of sessions) {
    answering(h, jevResponse('low', LOW));
    await h.event('session.start', { cwd: '/fixture' });
    await h.event('turn.start', { turnId: 't1', text: 'Next.' });
    await drain(h.step({ ...step, model: 'claude-haiku-5-5' }));
  }
  gated = true;
  await Promise.all(sessions.map((h) => h.event('turn.complete', { turnId: 't1' })));
  gated = false;
  assert.equal(writes.length, 2);
  await sessions[0].event('command.run', { command: 'router', args: '' });
  assert.equal(totalOf(sessions[0].view().usageStore).replies, 2);
  assert.equal(totalOf(sessions[0].view().usageSession).replies, 1);
});

test('a Reset in one session drops what another session still holds from before it', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000 });
  const preferences = new Map();
  const [a, b] = [harness(JEV_KEY, preferences), harness(JEV_KEY, preferences)];
  b.clear('s2');
  answering(b, jevResponse('low', LOW));
  await b.event('session.start', { cwd: '/fixture' });
  await turn(b, 't1', 'claude-haiku-5-5');
  assert.equal(totalOf(preferences.get(`${USAGE}s2`)).replies, 1);
  await a.event('session.start', { cwd: '/fixture' });
  t.mock.timers.tick(1);
  await press(a, 'tab-usage');
  await press(a, 'delete-history');
  await press(a, 'delete-confirm');
  t.mock.timers.tick(1);
  assert.equal(preferences.get(`${USAGE}s2`), undefined);
  await turn(b, 't2', 'claude-haiku-5-5');
  const record = preferences.get(`${USAGE}s2`);
  assert.equal(totalOf(record).replies, 1);
  assert.deepEqual([preferences.get('savings:reset:v1'), record.since], [1_001, 1_002]);
  assert.equal(totalOf(b.view().usageStore).replies, 1);
  await a.event('command.run', { command: 'router', args: '' });
  assert.equal(totalOf(a.view().usageStore).replies, 1);
});

test('a Reset in one session drops the other sessions’ usage another session read before it', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000 });
  const preferences = new Map();
  const [a, b] = [harness(JEV_KEY, preferences), harness(JEV_KEY, preferences)];
  b.clear('s2');
  answering(a, jevResponse('low', LOW));
  answering(b, jevResponse('low', LOW));
  await a.event('session.start', { cwd: '/fixture' });
  await turn(a, 't1', 'claude-haiku-5-5');
  await b.event('session.start', { cwd: '/fixture' });
  assert.equal(totalOf(b.view().usageStore).replies, 1);
  t.mock.timers.tick(1);
  await press(a, 'tab-usage');
  await press(a, 'delete-history');
  await press(a, 'delete-confirm');
  t.mock.timers.tick(1);
  await turn(b, 't1', 'claude-haiku-5-5');
  assert.equal(totalOf(b.view().usageStore).replies, 1);
  assert.equal(b.view().usageStore.since, 1_002);
});

test('the savings totals from before the usage records are read as undated history and never written', async () => {
  const h = harness(JEV_KEY, new Map([['savings:v1:s0', LEGACY]]));
  answering(h, jevResponse('low', LOW));
  await h.event('session.start', { cwd: '/fixture' });
  await turn(h, 't1', 'claude-haiku-5-5');
  assert.deepEqual(h.view().savingsStore, LEGACY);
  assert.deepEqual([h.preferences.get('savings:v1:s1'), h.preferences.get('savings:v1:s0')], [undefined, LEGACY]);
  assert.equal(totalOf(h.view().usageStore).replies, 1);
});

test('another session’s usage with no day left in the kept window is deleted when read; one that does not read stays', async (t) => {
  const now = new Date(2026, 9, 13, 12).getTime();
  t.mock.timers.enable({ apis: ['Date'], now });
  const day = {
    cells: { 'none|low|claude-haiku-5-5@high': [1, 0.1, 0.2, -0.1, 0, 0, 10, 5, 1] },
    whatIf: {},
    yours: {},
    hours: {},
    turns: 1,
    switches: { tier: 0, activity: 0 },
  };
  const old = { version: 1, since: 1, days: { '2025-01-02': day } };
  const later = { version: 3, days: 'kept as written' };
  const widerDay = {
    version: 1,
    since: 1,
    days: { '2025-01-02': { ...day, switches: { tier: 0, activity: 0, x: 0 } } },
  };
  const h = harness(
    JEV_KEY,
    new Map([
      [`${USAGE}s0`, old],
      [`${USAGE}s8`, widerDay],
      [`${USAGE}s9`, later],
    ]),
  );
  await h.event('session.start', { cwd: '/fixture' });
  assert.deepEqual(
    [h.preferences.has(`${USAGE}s0`), h.preferences.get(`${USAGE}s8`), h.preferences.get(`${USAGE}s9`)],
    [false, widerDay, later],
  );
});

test('a record another session wrote again after it was read for pruning stays', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 9, 13, 12).getTime() });
  const day = (key) => ({
    [key]: {
      cells: { 'none|low|claude-haiku-5-5@high': [1, 0.1, 0.2, -0.1, 0, 0, 10, 5, 1] },
      whatIf: {},
      yours: {},
      hours: {},
      turns: 1,
      switches: { tier: 0, activity: 0 },
    },
  });
  const old = { version: 1, since: 1, days: day('2025-01-02') };
  const fresh = { version: 1, since: 1, days: { ...day('2025-01-02'), ...day('2026-10-13') } };
  let reads = 0;
  const preferences = new (class extends Map {
    get(key) {
      // The other session writes its record between the read for pruning and the delete.
      if (key === `${USAGE}s0` && ++reads === 2) super.set(key, fresh);
      return super.get(key);
    }
  })([[`${USAGE}s0`, old]]);
  const h = harness(JEV_KEY, preferences);
  await h.event('session.start', { cwd: '/fixture' });
  assert.deepEqual(preferences.get(`${USAGE}s0`), fresh);
  assert.equal(totalOf(h.view().usageStore).replies, 2);
});

test('Delete history asks again after a tab change, and when the store refuses, this session alone starts over', async () => {
  const h = harness(JEV_KEY);
  answering(h, jevResponse('low', LOW));
  await h.event('session.start', { cwd: '/fixture' });
  await turn(h, 't1', 'claude-haiku-5-5');
  await press(h, 'tab-usage');
  await press(h, 'delete-history');
  assert.equal(h.view().confirmDelete, true);
  await press(h, 'tab-now');
  assert.equal(h.view().confirmDelete, false);
  await press(h, 'tab-usage');
  const kept = h.preferences.get(`${USAGE}s1`);
  h.$.store.keys = async () => {
    throw new Error('store down');
  };
  await press(h, 'delete-history');
  await press(h, 'delete-confirm');
  assert.equal(h.view().notice, 'This session’s counts cleared. The saved history could not be deleted.');
  assert.equal(totalOf(h.view().usageSession).replies, 0);
  assert.equal(h.preferences.get(`${USAGE}s1`), kept);
  await turn(h, 't2', 'claude-haiku-5-5');
  assert.equal(totalOf(h.preferences.get(`${USAGE}s1`)).replies, 1);
});

test('the Usage period is kept across sessions, and a period the store cannot name opens Session', async () => {
  const h = harness(JEV_KEY);
  await h.event('session.start', { cwd: '/fixture' });
  assert.equal(h.view().usagePeriod, 'session');
  await press(h, 'tab-usage');
  await press(h, 'period-7d');
  assert.deepEqual([h.view().usagePeriod, h.preferences.get('usage:period')], ['7d', '7d']);
  await h.event('session.end', { reason: 'clear' });
  h.clear('s2');
  await h.event('session.start', { cwd: '/fixture' });
  assert.equal(h.view().usagePeriod, '7d');
  h.preferences.set('usage:period', 'fortnight');
  h.clear('s3');
  await h.event('session.start', { cwd: '/fixture' });
  assert.equal(h.view().usagePeriod, 'session');
});

test('with routing off a reply is not counted, and your model’s cache still follows it', async () => {
  const h = harness(JEV_KEY);
  await h.event('session.start', { cwd: '/fixture' });
  await h.event('command.run', { command: 'router', args: 'off' });
  await turn(h, 't1', 'claude-haiku-5-5');
  assert.equal(h.requests[0].effort, 'medium');
  assert.equal(sessionOf(h).replies, 0);
  assert.deepEqual([yours(h).total, yours(h).onYours], [1100, true]);
  assert.equal(h.preferences.get(`${USAGE}s1`), undefined);
  h.surfaces([]);
  const { text } = await h.event('command.run', { command: 'router', args: '' });
  assert.match(text, /^Session: no routed replies yet$/m);
});

test('a session usage without rate limits prices cache writes at five minutes', async () => {
  const h = harness(JEV_KEY);
  answering(h, jevResponse('low', LOW));
  h.usage({ startedAt: 0, context: { tokens: 8000 } });
  await h.event('session.start', { cwd: '/fixture' });
  await turn(h, 't1', 'claude-haiku-5-5');
  const usd = (0.1 * (100 + 200 * 1.25) + 0.01 * 800 + 0.5 * 10) / 1e6;
  assert.equal(sessionOf(h).replies, 1);
  assert.ok(Math.abs(sessionOf(h).routedUsd - usd) < 1e-12);
});

test('turns on an unchanged session model and effort keep your model’s cache warm', async () => {
  const h = harness(JEV_KEY);
  // Each effort its own cache, so the replies at high are off your Haiku at medium and its cache is simulated.
  h.env.set('CLAUDE_CODE_USE_BEDROCK', '1');
  answering(h, jevResponse('low', LOW));
  h.usage({ startedAt: 0, context: { tokens: 8000 } });
  await h.event('session.start', { cwd: '/fixture' });
  await turn(h, 't1', 'claude-haiku-5-5');
  await turn(h, 't2', 'claude-haiku-5-5');
  assert.deepEqual(
    h.requests.map((request) => request.effort),
    ['high', 'high'],
  );
  assert.deepEqual([yours(h).model, yours(h).effort], ['claude-haiku-5-5', 'medium']);
  const first = (0.1 * (100 + 200 * 1.25) + 0.01 * 800 + 0.5 * 10) / 1e6;
  // The second reply reads the whole previous prompt on your model's cache and writes nothing.
  const warm = (0.1 * 100 + 0.01 * 1_000 + 0.5 * 10) / 1e6;
  assert.ok(Math.abs(sessionOf(h).yoursUsd - (first + warm)) < 1e-12);
});

test('a reply whose cache lifetime cannot be read is not counted, and your model’s cache still follows it', async () => {
  const h = harness(JEV_KEY);
  h.env.set('CLAUDE_CODE_USE_BEDROCK', '1');
  answering(h, jevResponse('low', LOW));
  await h.event('session.start', { cwd: '/fixture' });
  await h.event('command.run', { command: 'router', args: 'off' });
  await turn(h, 't1', 'claude-haiku-5-5');
  assert.equal(yours(h).onYours, true);
  await h.event('command.run', { command: 'router', args: 'on' });
  const usage = h.$.session.usage;
  h.$.session.usage = async () => {
    throw new Error('usage unavailable');
  };
  await turn(h, 't2', 'claude-haiku-5-5');
  assert.equal(h.requests.at(-1).effort, 'high');
  assert.equal(sessionOf(h).replies, 0);
  assert.equal(yours(h).onYours, false);
  h.$.session.usage = usage;
  await turn(h, 't3', 'claude-haiku-5-5');
  assert.equal(sessionOf(h).replies, 1);
});

test('a corrupted saved record never breaks a turn', async () => {
  const h = harness(
    JEV_KEY,
    new Map([
      [`${USAGE}s1`, { version: 9, days: 'many' }],
      ['savings:v1:s0', { version: 9, replies: 'many' }],
    ]),
  );
  answering(h, jevResponse('low', LOW));
  await h.event('session.start', { cwd: '/fixture' });
  assert.deepEqual([totalOf(h.view().usageStore).replies, h.view().savingsStore.replies], [0, 0]);
  await turn(h, 't1', 'claude-haiku-5-5');
  assert.equal(h.requests.length, 1);
  assert.equal(sessionOf(h).replies, 1);
  assert.equal(totalOf(h.preferences.get(`${USAGE}s1`)).replies, 1);
});
