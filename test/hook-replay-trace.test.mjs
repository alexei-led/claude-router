import assert from 'node:assert/strict';
import test from 'node:test';
import { HOLDS_PREFIX } from '../lib/failover.mjs';
import { evaluateReplay } from '../lib/replay.mjs';
import {
  readTrace,
  storedBytes,
  TRACE_ACTIVE_MS,
  TRACE_PREFIX,
  TRACE_RETAIN_MS,
  TRACE_SESSION_BYTES,
  traceBytes,
  usableTrace,
} from '../lib/replay-trace.mjs';
import { chooseRoute, continueRoute, observeResponse, prepareLoop } from '../lib/route.mjs';
import { answering, CONFIG, drain, harness, press, shadowHarness, step, traceOf } from './harness.mjs';
import { assistant, jevResponse, toolResult, user } from './helpers.mjs';

const record = traceOf;

const answer = jevResponse('low', { low: 1 }, 0, { code: 1 }, 'produce');

const setup = (config, preferences) => shadowHarness(config, preferences, answer);

const ends = (trace) => trace.events.filter((event) => event.type === 'end').length;

async function begin(h) {
  await h.event('session.start', { cwd: '/fixture' });
}

async function turn(h, id = 't1', messages = [user('Synthetic task.')]) {
  await h.event('turn.start', { turnId: id, text: 'Synthetic task.' });
  h.messages(async () => messages);
  await drain(h.step({ ...step, turnId: id, messageCount: messages.length }));
  await h.event('turn.complete', { turnId: id });
}

test('real shadow hooks record a usable sequence, request correlation and narrow frozen snapshot', async () => {
  const h = setup();
  await begin(h);
  await turn(h);
  const trace = record(h);
  assert.ok(trace);
  assert.equal(usableTrace(trace), true);
  assert.deepEqual(
    trace.events.map((e) => e.type),
    ['initial', 'request', 'response', 'end'],
  );
  assert.equal(trace.events[2].requestSeq, trace.events[1].seq);
  assert.equal(trace.events[1].operations[0].kind, 'choose');
  assert.equal(trace.events[2].usage.output_tokens, 10);
  assert.equal(trace.events[0].config.provider, 'anthropic');
  assert.equal(trace.events[0].config.models.opus.input, 4);
  assert.equal(trace.events[0].loop.requests, 0);
  assert.equal(trace.active, true);
});

test('startup with injected messages records and exports a usable first request without classic events', async () => {
  const h = setup();
  await h.event('session.start', { cwd: '/fixture' });
  await turn(
    h,
    'first',
    Array.from({ length: 17 }, (_, i) => user(`injected ${i}`)),
  );
  const trace = record(h);
  assert.equal(trace.events.find((event) => event.type === 'request').messageCount, 17);
  assert.equal(usableTrace(trace), true);
  assert.match((await h.event('command.run', { command: 'router', args: 'trace export' })).text, /Exported 1/);
  const exported = JSON.parse(h.files.get('/fixture/team/router-traces.json'));
  assert.deepEqual(
    JSON.parse(JSON.stringify(readTrace(exported.sessions[`${TRACE_PREFIX}s1`]))),
    JSON.parse(JSON.stringify(trace)),
  );
  assert.equal(evaluateReplay([exported]).fidelity.passed, true);
});

test('resumed assistant history cannot be fresh even without persisted records', async () => {
  const h = setup();
  await begin(h);
  const messages = Array.from({ length: 17 }, () => user('message'));
  messages[8] = assistant('earlier response');
  await turn(h, 'resume', messages);
  assert.equal(usableTrace(record(h)), false);
  assert.ok(record(h).incomplete.includes('mid-session'));
});

test('unreadable or malformed current request history is conservatively incomplete', async () => {
  for (const value of [
    null,
    {},
    [],
    [null],
    [{}],
    [{ role: 'user' }],
    [{ role: 'user', content: [] }],
    [{ role: 'user', content: 'bad shape' }],
    [{ role: 'user', content: [null] }],
    [{ role: 'user', content: [{}] }],
    [{ role: 'unknown', content: [] }],
    'throws',
  ]) {
    const h = setup();
    await begin(h);
    await h.event('turn.start', { turnId: 't1', text: 'Synthetic task.' });
    const read = h.$.session.messages;
    let first = true;
    h.$.session.messages = async (...args) => {
      if (!first) return read(...args);
      first = false;
      if (value === 'throws') throw new Error('unreadable history');
      return value;
    };
    await drain(h.step({ ...step, messageCount: 17 }));
    await h.event('turn.complete', { turnId: 't1' });
    assert.equal(usableTrace(record(h)), false, JSON.stringify(value));
    assert.ok(record(h).incomplete.includes('mid-session'));
  }
});

test('first-request evidence cannot override an existing loop', async () => {
  const original = setup();
  await begin(original);
  await turn(original);
  const h = setup();
  for (const [key, value] of original.state) h.state.set(key, structuredClone(value));
  await begin(h);
  await turn(
    h,
    'next',
    Array.from({ length: 17 }, () => user('message')),
  );
  assert.ok(record(h).incomplete.includes('mid-session'));
});

test('duplicate Mod starts and unexplained session switches cannot establish freshness', async () => {
  for (const boundary of ['switch', 'restart', 'resume-switch']) {
    const h = setup();
    await begin(h);
    if (boundary === 'switch') h.clear('s2');
    if (boundary === 'restart') await h.event('session.start', { cwd: '/fixture' });
    if (boundary === 'resume-switch') {
      await h.event('session.end', { reason: 'resume', sessionId: 's1' });
      h.clear('s2');
    }
    await turn(h);
    assert.equal(usableTrace(record(h, boundary === 'restart' ? 's1' : 's2')), false, boundary);
  }
});

test('first table request consumes freshness before shadow is enabled', async () => {
  const h = setup({ routingEngine: 'table' });
  await begin(h);
  await turn(h);
  h.state.delete('loops:main');
  await h.event('command.run', { command: 'router', args: 'engine shadow' });
  await turn(h, 'after-enable');
  assert.equal(usableTrace(record(h)), false);
  assert.ok(record(h).incomplete.includes('mid-session'));
});

test('compaction before the first recorded request is not fresh history', async () => {
  const h = setup();
  await begin(h);
  await h.event('session.compact', { trigger: 'auto' });
  await turn(h);
  assert.equal(usableTrace(record(h)), false);
});

test('lazy shadow reload without session.start records only an incomplete mid-session trace', async () => {
  const h = setup();
  await turn(
    h,
    'reload',
    Array.from({ length: 17 }, () => user('message')),
  );
  assert.ok(record(h));
  assert.equal(record(h).events[0].configured.routingEngine, 'shadow');
  assert.ok(record(h).incomplete.includes('mid-session'));
  assert.equal(usableTrace(record(h)), false);
});

test('clear starts a fresh session and compaction retains a replay reset', async () => {
  const h = setup();
  await begin(h);
  await turn(h);
  await h.event('session.compact', { trigger: 'auto' });
  await turn(h, 'after-compact');
  assert.equal(usableTrace(record(h)), true);
  assert.ok(record(h).events.some((event) => event.type === 'reset' && event.cause === 'compact'));
  await h.event('session.end', { reason: 'clear', sessionId: 's1' });
  h.clear('s2');
  await turn(
    h,
    'after-clear',
    Array.from({ length: 17 }, () => user('message')),
  );
  assert.equal(usableTrace(record(h, 's2')), true);
});

test('privacy canaries in prompt/tool/path/key/classifier URL and accidental objects never reach store/export', async () => {
  const canary = 'CANARY_PRIVATE_TEXT';
  const h = harness({ typesafe_api_key: canary });
  h.files.set(
    CONFIG,
    JSON.stringify({
      routingEngine: 'shadow',
      classifiers: { jev: { endpoint: `https://example.invalid/${canary}` } },
    }),
  );
  answering(h, answer);
  await begin(h);
  await h.event('turn.start', { turnId: 't1', text: canary });
  h.messages(async () => [user(canary), assistant(canary, ['Edit']), toolResult(`/private/${canary}`)]);
  await drain(h.step({ ...step, messageCount: 3, accidental: canary }));
  await h.event('turn.complete', { turnId: 't1' });
  assert.equal(JSON.stringify(record(h)).includes(canary), false);
  const result = await h.event('command.run', { command: 'router', args: 'trace export' });
  assert.match(result.text, /Exported/);
  assert.equal(h.files.get('/fixture/team/router-traces.json').includes(canary), false);
});

test('table routes have zero trace store/export side effects', async () => {
  const h = setup({ routingEngine: 'table' });
  const calls = [];
  const get = h.$.store.get,
    set = h.$.store.set,
    del = h.$.store.delete;
  h.$.store.get = async (key) => {
    if (key.startsWith(TRACE_PREFIX)) calls.push(['get', key]);
    return get(key);
  };
  h.$.store.set = async (key, value) => {
    if (key.startsWith(TRACE_PREFIX)) calls.push(['set', key]);
    return set(key, value);
  };
  h.$.store.delete = async (key) => {
    if (key.startsWith(TRACE_PREFIX)) calls.push(['delete', key]);
    return del(key);
  };
  await begin(h);
  await turn(h);
  assert.deepEqual(calls, []);
  assert.equal(h.files.has('/fixture/team/router-traces.json'), false);
  const result = await h.event('command.run', { command: 'router', args: 'trace export' });
  assert.match(result.text, /Exported 0/);
  assert.equal(h.files.has('/fixture/team/router-traces.json'), true);
});

test('a failed trace write loses nothing: the next flush writes every held turn', async () => {
  const h = setup();
  await begin(h);
  const set = h.$.store.set;
  let fail = true;
  h.$.store.set = async (key, value) => {
    if (key.startsWith(TRACE_PREFIX) && fail) throw new Error('CANARY_DISK_PATH');
    return set(key, value);
  };
  await turn(h);
  assert.equal(record(h), undefined);
  fail = false;
  await turn(h, 't2', [user('one'), assistant('reply'), user('two')]);
  assert.equal(ends(record(h)), 2);
  assert.equal(usableTrace(record(h)), true);
  assert.equal(JSON.stringify(record(h)).includes('CANARY'), false);
});

test('quota reads fail closed, preserve usage, and keep the turn for the next flush', async () => {
  for (const boundary of ['keys', 'value']) {
    const h = setup();
    await begin(h);
    h.preferences.set('other:opaque', { content: 'not a trace' });
    const keys = h.$.store.keys,
      get = h.$.store.get;
    let fail = true;
    if (boundary === 'keys')
      h.$.store.keys = async () => {
        if (fail) throw new Error('denied');
        return keys();
      };
    else
      h.$.store.get = async (key) => {
        if (fail && key === 'other:opaque') throw new Error('denied');
        return get(key);
      };
    await turn(h);
    assert.equal(record(h), undefined, boundary);
    fail = false;
    await turn(h, 't2');
    assert.equal(ends(record(h)), 2, boundary);
    assert.equal(usableTrace(record(h)), true, boundary);
    assert.deepEqual(h.preferences.get('other:opaque'), { content: 'not a trace' });
  }
});

test('3MiB guard holds a turn back without consuming other ledger headroom', async () => {
  const h = setup();
  await begin(h);
  h.preferences.set('usage:large', 'x'.repeat(3 * 1024 * 1024));
  await turn(h);
  assert.equal(record(h), undefined);
  h.preferences.delete('usage:large');
  await turn(h, 't2');
  assert.equal(ends(record(h)), 2);
  assert.equal(usableTrace(record(h)), true);
});

for (const [name, keepsLoop] of [
  ['reload', true],
  ['resume', false],
])
  test(`a ${name} stops recording and keeps the stored turns usable`, async () => {
    const first = setup();
    await begin(first);
    await turn(first);
    const before = record(first);
    const next = setup({}, first.preferences);
    if (keepsLoop) for (const [key, value] of first.state) next.state.set(key, structuredClone(value));
    await begin(next);
    await turn(next, 't2', [user('one'), assistant('reply'), user('two')]);
    await turn(next, 't3', [user('one'), assistant('reply'), user('two')]);
    assert.deepEqual(record(next).events, before.events);
    assert.deepEqual(record(next).incomplete, []);
    assert.equal(record(next).capped.turns, 2);
    assert.equal(usableTrace(record(next)), true);
  });

test('a trace first seen after its first request cannot be usable', async () => {
  const late = setup();
  await late.event('turn.start', { turnId: 't1', text: 'already running' });
  await drain(late.step({ ...step, index: 2, messageCount: 20 }));
  await late.event('turn.complete', { turnId: 't1' });
  assert.equal(usableTrace(record(late)), false);
});

test('a session’s record evicted by another session is written again without a conflict', async () => {
  const h = setup();
  await begin(h);
  await turn(h);
  h.preferences.delete(`${TRACE_PREFIX}s1`);
  await turn(h, 't2');
  assert.equal(ends(record(h)), 2);
  assert.equal(usableTrace(record(h)), true);
});

test('a turn left unfinished at session end is dropped, and the recorded turns stay usable', async () => {
  const h = setup();
  await begin(h);
  await turn(h);
  await h.event('turn.start', { turnId: 'open', text: 'Synthetic task.' });
  await drain(h.step({ ...step, turnId: 'open' }));
  await h.event('session.end', { reason: 'exit' });
  assert.equal(ends(record(h)), 1);
  assert.equal(usableTrace(record(h)), true);
});

test('a turn left unfinished after a reload leaves the stored turns usable', async () => {
  const first = setup();
  await begin(first);
  await turn(first);
  await turn(first, 't2', [user('one'), assistant('reply'), user('two')]);
  const next = setup({}, first.preferences);
  await begin(next);
  await next.event('turn.start', { turnId: 'open', text: 'Synthetic task.' });
  await drain(next.step({ ...step, turnId: 'open' }));
  await next.event('session.end', { reason: 'exit' });
  assert.equal(usableTrace(record(next)), true);
});

test('a turn left unfinished behind a recorded one leaves a hole, so the trace is unusable', async () => {
  const h = setup();
  await begin(h);
  await h.event('turn.start', { turnId: 'open', text: 'Synthetic task.' });
  await drain(h.step({ ...step, turnId: 'open' }));
  await turn(h, 't2');
  await h.event('session.end', { reason: 'exit' });
  assert.ok(record(h).incomplete.includes('aborted'));
});

test('retention expires old whole sessions including killed active leases, not decision-row counts', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-16T10:00:00Z') });
  const h = setup();
  await begin(h);
  await turn(h);
  const initial = record(h);
  h.preferences.set(`${TRACE_PREFIX}expired`, {
    ...initial,
    updatedAt: Date.now() - TRACE_RETAIN_MS - 1,
    active: true,
  });
  h.preferences.set(`${TRACE_PREFIX}recent-active`, { ...initial, updatedAt: Date.now(), active: true });
  h.preferences.set(`${TRACE_PREFIX}future-version`, { version: 9, updatedAt: 1 });
  await turn(h, 't2');
  assert.equal(h.preferences.has(`${TRACE_PREFIX}expired`), false);
  assert.equal(h.preferences.has(`${TRACE_PREFIX}recent-active`), true);
  assert.equal(h.preferences.has(`${TRACE_PREFIX}future-version`), true);
});

test('export merges retained sessions and cap metadata, preserves taint and refuses failed writes safely', async () => {
  const h = setup();
  await begin(h);
  await turn(h);
  const exportNow = () => h.event('command.run', { command: 'router', args: 'trace export' });
  assert.match((await exportNow()).text, /Exported/);
  const path = '/fixture/team/router-traces.json';
  const first = JSON.parse(h.files.get(path));
  h.files.set(
    path,
    JSON.stringify({ ...first, sessions: { ...first.sessions, [`${TRACE_PREFIX}archived`]: record(h) } }),
  );
  await turn(h, 't2');
  assert.match((await exportNow()).text, /Exported 2/);
  const second = JSON.parse(h.files.get(path));
  assert.equal(readTrace(second.sessions[`${TRACE_PREFIX}s1`]).events.length, 7);
  const saved = h.files.get(path);
  h.$.fs.write = async () => {
    throw new Error('denied');
  };
  assert.match((await exportNow()).text, /failed/);
  assert.equal(h.files.get(path), saved);
  assert.ok(record(h));
});

test('small recorded chain starts once and evolves table state through requests, a pin and response caches', async () => {
  const h = setup();
  await begin(h);
  await turn(h);
  await h.event('command.run', { command: 'router', args: 'pin high' });
  await h.event('turn.start', { turnId: 'pin', text: 'Synthetic task.' });
  h.messages(async () => [user('first'), assistant('reply'), user('second')]);
  await drain(h.step({ ...step, turnId: 'pin', messageCount: 3 }));
  await drain(h.step({ ...step, turnId: 'pin', index: 1, messageCount: 3 }));
  await h.event('turn.complete', { turnId: 'pin' });
  const trace = record(h);
  const header = trace.events[0];
  let cfg = header.config,
    loop = { ...header.loop, turnId: null };
  let requests = 0;
  for (const event of trace.events.slice(1)) {
    if (event.type === 'config') cfg = event.config;
    if (event.type === 'request') {
      loop = prepareLoop(loop, event.messageCount);
      for (const op of event.operations) {
        const input = { ...op, now: op.at, availableModels: op.availableModels ?? undefined };
        if (op.kind === 'choose') {
          const facts = {
            ...op.facts,
            turnKey: String(event.turn),
            lastRoute: loop.lastRoute,
            lastRequest: loop.lastRequest,
            models: loop.models,
            historyMeasured: loop.historyMeasured,
          };
          loop = chooseRoute(cfg, loop, { ...input, facts });
          loop.engineModel = event.engineModel;
        } else if (op.kind === 'continue') loop = continueRoute(cfg, loop, input);
        else assert.fail('unexpected operation in bounded chain');
      }
      assert.equal(loop.decision.model, event.model);
      assert.equal(loop.decision.effort, event.effort);
      requests++;
    }
    if (event.type === 'response')
      loop = observeResponse(cfg, loop, {
        usage: event.usage && { ...event.usage, model: event.servedModel },
        requestedModel: event.requestedModel,
        effort: event.effort,
        stopReason: event.stopReason,
        now: event.at,
      });
  }
  assert.equal(requests, 3);
  assert.deepEqual(loop.models, h.loop().models);
  assert.deepEqual(loop.lastRequest, h.loop().lastRequest);
  assert.deepEqual(loop.state, h.loop().state);
});

test('explicit Delete history clears stored traces even in table but leaves exports user-owned', async () => {
  const h = setup();
  await begin(h);
  await turn(h);
  await h.event('command.run', { command: 'router', args: 'trace export' });
  const saved = h.files.get('/fixture/team/router-traces.json');
  h.files.set(CONFIG, JSON.stringify({ routingEngine: 'table' }));
  await begin(h);
  await press(h, 'tab-usage');
  await press(h, 'delete-history');
  await press(h, 'delete-confirm');
  assert.equal(record(h), undefined);
  assert.equal(h.files.get('/fixture/team/router-traces.json'), saved);
});

test('concurrent active session records are never evicted to admit a new trace', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-16T10:00:00Z') });
  const h = setup();
  await begin(h);
  await turn(h);
  const prefix = record(h);
  for (const id of ['active-a', 'active-b'])
    h.preferences.set(TRACE_PREFIX + id, {
      ...prefix,
      updatedAt: Date.now(),
      active: true,
      padding: 'x'.repeat(600_000),
    });
  await turn(h, 't2');
  assert.deepEqual(record(h).events, prefix.events);
  assert.ok(h.preferences.has(`${TRACE_PREFIX}active-a`));
  assert.ok(h.preferences.has(`${TRACE_PREFIX}active-b`));
  h.preferences.delete(`${TRACE_PREFIX}active-a`);
  h.preferences.delete(`${TRACE_PREFIX}active-b`);
  await turn(h, 't3');
  assert.equal(ends(record(h)), 3);
  assert.equal(usableTrace(record(h)), true);
});

test('eviction rereads changed records and keeps a newly active writer', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-16T10:00:00Z') });
  const h = setup();
  await begin(h);
  await turn(h);
  const name = `${TRACE_PREFIX}expired`;
  h.preferences.set(name, { ...record(h), updatedAt: Date.now() - TRACE_RETAIN_MS - 1, active: false });
  const get = h.$.store.get;
  let reads = 0;
  h.$.store.get = async (key) => {
    if (key === name && ++reads === 2)
      h.preferences.set(name, { ...h.preferences.get(name), updatedAt: Date.now(), active: true });
    return get(key);
  };
  await turn(h, 't2');
  assert.equal(h.preferences.get(name).active, true);
});

test('a generation fence discards stale classification without recording a routed request', async () => {
  const h = setup();
  await begin(h);
  await h.event('turn.start', { turnId: 't1', text: 'Synthetic task.' });
  let resolveWire, resolveStarted;
  const started = new Promise((resolve) => {
    resolveStarted = resolve;
  });
  h.http(async () => {
    resolveStarted();
    return new Promise((resolve) => {
      resolveWire = resolve;
    });
  });
  const pending = drain(h.step(step));
  await started;
  await h.event('session.compact', { trigger: 'auto' });
  resolveWire({ ok: true, status: 200, text: JSON.stringify(answer), headers: {} });
  await pending;
  await h.event('turn.complete', { turnId: 't1' });
  assert.ok(
    record(h)
      .events.filter((e) => e.type === 'request')
      .every((e) => e.mode === 'manual' && e.operations.length === 0),
  );
});

test('export rolls over near 3MiB without rewriting or dropping the earlier archive', async () => {
  const h = setup();
  await begin(h);
  await turn(h);
  const sessions = {};
  const sample = h.preferences.get(`${TRACE_PREFIX}s1`);
  const count = Math.floor((3 * 1024 * 1024 - 100) / (traceBytes(sample) + 30));
  for (let i = 0; i < count; i++) sessions[`${TRACE_PREFIX}archive-${i}`] = sample;
  let previous = { version: 1, sessions };
  while (traceBytes(previous) + traceBytes(sample) < 3 * 1024 * 1024) {
    sessions[`${TRACE_PREFIX}extra-${Object.keys(sessions).length}`] = sample;
    previous = { version: 1, sessions };
  }
  const path = '/fixture/team/router-traces.json';
  h.files.set(path, JSON.stringify(previous));
  const saved = h.files.get(path);
  const result = await h.event('command.run', { command: 'router', args: 'trace export' });
  assert.match(result.text, /router-traces-.*\.json/);
  assert.equal(h.files.get(path), saved);
  assert.equal([...h.files.keys()].filter((name) => name.includes('router-traces-')).length, 1);
});

test('an oversized initial snapshot is explicitly unusable', async () => {
  const models = {};
  for (let i = 0; i < 800; i++)
    models[`m${i}`] = {
      id: `synthetic-model-${i}-${'x'.repeat(800)}`,
      strength: 1,
      contextWindow: 200000,
      input: 1,
      output: 1,
      cacheRead: 0.1,
      efforts: ['low'],
      billing: 'plan',
      capability: {},
    };
  const oversized = setup({ models });
  await begin(oversized);
  await turn(oversized);
  assert.equal(usableTrace(record(oversized)), false);
  assert.ok(storedBytes(record(oversized)) < TRACE_SESSION_BYTES);
  assert.ok(record(oversized).incomplete.includes('store-guard'));
});

test('real repeated-failure evidence stores only its hash and occurrence index', async () => {
  const h = setup();
  await begin(h);
  const diagnostic = 'CANARY_FAILURE /private/CANARY_FILE';
  await turn(h, 't1', [
    user('CANARY_PROMPT'),
    assistant('run', ['Bash']),
    toolResult(diagnostic, { isError: true }),
    assistant('edit', ['Edit']),
    toolResult('ok'),
    assistant('running again', ['Bash']),
    toolResult(diagnostic, { isError: true }),
  ]);
  const failure = record(h).events.find((e) => e.type === 'request').operations[0].facts.failure;
  assert.match(failure.signature, /^[a-f0-9]{1,16}$/);
  assert.equal(failure.index, 6);
  assert.equal(JSON.stringify(record(h)).includes('CANARY'), false);
});

test('observed moves and continuation availability/context inputs are recorded, not reconstructed from text', async () => {
  const h = setup();
  answering(h, jevResponse('low', { low: 1 }, 0, { ops: 1 }, 'execute'));
  await begin(h);
  await h.event('turn.start', { turnId: 't1', text: 'Synthetic task.' });
  await drain(h.step(step));
  h.messages(async () => [
    user('CANARY'),
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'e', name: 'Edit', input: { file_path: '/private/CANARY.mjs' } }],
    },
    toolResult('CANARY'),
  ]);
  h.settings({ availableModels: ['haiku', 'sonnet', 'opus'] });
  await drain(h.step({ ...step, index: 1, messageCount: 3 }));
  await h.event('turn.complete', { turnId: 't1' });
  const requests = record(h).events.filter((e) => e.type === 'request');
  const ops = requests[1].operations;
  assert.ok(ops.some((op) => op.kind === 'observed' && op.observed === 'code'));
  const continuation = ops.find((op) => op.kind === 'continue');
  assert.deepEqual(continuation.availableModels, ['haiku', 'sonnet', 'opus']);
  assert.equal(continuation.contextKnown, true);
  assert.ok(continuation.contextTokens >= 8000);
  assert.equal(JSON.stringify(record(h)).includes('CANARY'), false);
});

test('shadow-table-shadow between steps cannot lose an unflushed turn silently', async () => {
  const h = setup();
  await begin(h);
  await turn(h, 'complete');
  await h.event('turn.start', { turnId: 'omitted', text: 'Synthetic task.' });
  await drain(h.step({ ...step, turnId: 'omitted' }));
  await h.event('command.run', { command: 'router', args: 'engine table' });
  const set = h.$.store.set;
  const traceWrites = [];
  h.$.store.set = async (key, value) => {
    if (key.startsWith(TRACE_PREFIX)) traceWrites.push(key);
    return set(key, value);
  };
  await h.event('turn.complete', { turnId: 'omitted' });
  assert.deepEqual(traceWrites, []);
  await h.event('command.run', { command: 'router', args: 'engine shadow' });
  await turn(h, 'after');
  assert.equal(usableTrace(record(h)), false);
  assert.ok(record(h).incomplete.includes('mode-gap'));
});

for (const [name, manual, stop] of [
  ['an interrupted routed request', false, 'abort'],
  ['an interrupted manual request', true, 'abort'],
  ['a stream closed before its reply', false, 'return'],
])
  test(`${name} is recorded as unanswered and the trace still replays`, async () => {
    const h = setup();
    await begin(h);
    if (manual) await h.event('command.run', { command: 'router', args: 'off' });
    await h.event('turn.start', { turnId: 't1', text: 'Synthetic task.' });
    const controller = new AbortController();
    const stream = h.step(step, {}, controller.signal);
    await stream.next();
    if (stop === 'abort') {
      controller.abort();
      await drain(stream);
    } else await stream.return();
    await h.event('turn.complete', { turnId: 't1' });
    await turn(h, 't2', [user('one'), assistant('reply'), user('two')]);
    const replies = record(h).events.filter((event) => event.type === 'response');
    assert.deepEqual(
      replies.map((reply) => reply.unanswered ?? false),
      [true, false],
    );
    assert.equal(usableTrace(record(h)), true);
    assert.equal(
      evaluateReplay([{ version: 1, sessions: { [`${TRACE_PREFIX}s1`]: record(h) } }]).fidelity.passed,
      true,
    );
  });

test('real hook snapshots retain unused odd catalog aliases and custom cache economics', async () => {
  const alias = 'unused modèle 模型';
  const h = setup({
    models: {
      [alias]: {
        id: 'provider/模型 v1',
        input: 1,
        output: 2,
        cacheRead: 0.1,
        contextWindow: 200000,
        billing: 'credits',
        efforts: [],
        capability: {},
      },
    },
    cache: { writeMultiplier: { '2h': 10 }, ttlMs: { '2h': 7200000 } },
  });
  await begin(h);
  await turn(h);
  const config = record(h).events[0].config;
  assert.equal(config.models[alias].id, 'provider/模型 v1');
  assert.deepEqual(config.models[alias].capability, {});
  assert.equal(config.cache.writeMultiplier['2h'], 10);
  assert.equal(config.cache.ttlMs['2h'], 7200000);
  assert.equal(usableTrace(record(h)), true);
});

test('pre-request recorder failure cannot change the shadow request or response', async (t) => {
  const baseline = setup({ routingEngine: 'table' });
  await begin(baseline);
  await baseline.event('turn.start', { turnId: 't1', text: 'Synthetic task.' });
  const expected = await drain(baseline.step(step));
  const h = setup();
  await begin(h);
  await h.event('turn.start', { turnId: 't1', text: 'Synthetic task.' });
  const encode = TextEncoder.prototype.encode;
  let fail = true;
  t.mock.method(TextEncoder.prototype, 'encode', function (value) {
    if (fail) throw new Error('CANARY_RECORDER_FAILURE');
    return encode.call(this, value);
  });
  const actual = await drain(h.step(step));
  assert.deepEqual(h.requests, baseline.requests);
  assert.deepEqual(actual, expected);
  fail = false;
  await h.event('turn.complete', { turnId: 't1' });
  await turn(h, 'recovered');
  assert.equal(usableTrace(record(h)), false);
  assert.ok(record(h).lostWrites > 0);
  assert.equal(JSON.stringify(record(h)).includes('CANARY'), false);
});

test('post-response recorder failure cannot discard the native response or priced usage', async (t) => {
  const baseline = setup({ routingEngine: 'table' });
  await begin(baseline);
  await baseline.event('turn.start', { turnId: 't1', text: 'Synthetic task.' });
  const expected = await drain(baseline.step(step));
  const h = setup();
  await begin(h);
  await h.event('turn.start', { turnId: 't1', text: 'Synthetic task.' });
  const encode = TextEncoder.prototype.encode;
  let fail = false;
  t.mock.method(TextEncoder.prototype, 'encode', function (value) {
    if (fail) throw new Error('CANARY_RECORDER_FAILURE');
    return encode.call(this, value);
  });
  const set = h.$.state.set;
  h.$.state.set = async (ref, value, options) => {
    const result = await set(ref, value, options);
    if (ref.key === 'loops' && value.requests > 0) fail = true;
    return result;
  };
  const actual = await drain(h.step(step));
  assert.deepEqual(h.requests, baseline.requests);
  assert.deepEqual(actual, expected);
  assert.equal(h.view().inputTokens, baseline.view().inputTokens);
  fail = false;
  h.$.state.set = set;
  await h.event('turn.complete', { turnId: 't1' });
  await turn(h, 'recovered');
  assert.equal(usableTrace(record(h)), false);
  assert.ok(record(h).lostWrites > 0);
});

test('recorder failures during controls, compaction and turn completion do not escape lifecycle hooks', async (t) => {
  const h = setup();
  await begin(h);
  await turn(h, 'first');
  await h.event('turn.start', { turnId: 'second', text: 'Synthetic task.' });
  await drain(h.step({ ...step, turnId: 'second' }));
  const encode = TextEncoder.prototype.encode;
  let fail = true;
  t.mock.method(TextEncoder.prototype, 'encode', function (value) {
    if (fail) throw new Error('CANARY_LIFECYCLE_FAILURE');
    return encode.call(this, value);
  });
  assert.match((await h.event('command.run', { command: 'router', args: 'off' })).text, /Routing off/);
  const generation = h.loop().generation;
  await h.event('session.compact', { trigger: 'auto' });
  assert.equal(h.loop().generation, generation + 1);
  await h.event('turn.complete', { turnId: 'second' });
  fail = false;
  await h.event('command.run', { command: 'router', args: 'on' });
  await turn(h, 'recovered');
  assert.equal(usableTrace(record(h)), false);
  assert.ok(record(h).lostWrites > 0);
  assert.ok(record(h).incomplete.includes('recorder-error'));
  assert.equal(JSON.stringify(record(h)).includes('CANARY'), false);
});

test('a recorder failure while a turn is appended leaves the missing turn marked, never a usable hole', async (t) => {
  const h = setup();
  await begin(h);
  await turn(h, 't1');
  await h.event('turn.start', { turnId: 't2', text: 'Synthetic task.' });
  await drain(h.step({ ...step, turnId: 't2' }));
  const encode = TextEncoder.prototype.encode;
  let failed = false;
  // The first whole record measured from here on is the one taking the turn.
  t.mock.method(TextEncoder.prototype, 'encode', function (value) {
    if (!failed && value.startsWith('{"version":')) {
      failed = true;
      throw new Error('CANARY_APPEND_FAILURE');
    }
    return encode.call(this, value);
  });
  await h.event('turn.complete', { turnId: 't2' });
  assert.equal(failed, true);
  assert.equal(usableTrace(record(h)), false);
  await turn(h, 't3');
  const trace = record(h);
  assert.equal(ends(trace), 2);
  assert.equal(trace.lostWrites, 1);
  assert.ok(trace.incomplete.includes('lost-write'));
  assert.ok(trace.incomplete.includes('recorder-error'));
  assert.equal(usableTrace(trace), false);
});

test('failed session-end tracing does not prevent the session lifecycle and the stored turns stay usable', async (t) => {
  const h = setup();
  await begin(h);
  await turn(h);
  const encode = TextEncoder.prototype.encode;
  let fail = true;
  t.mock.method(TextEncoder.prototype, 'encode', function (value) {
    if (fail) throw new Error('recorder failed');
    return encode.call(this, value);
  });
  await h.event('session.end', { reason: 'exit' });
  fail = false;
  const resumed = setup({}, h.preferences);
  await begin(resumed);
  await turn(resumed);
  assert.equal(ends(record(resumed)), 1);
  assert.equal(usableTrace(record(resumed)), true);
});

test('a reply the loop took is recorded as answered even when reading the holds afterwards fails', async () => {
  const h = setup();
  await begin(h);
  await turn(h, 't1');
  const agent = { ...step, agentId: 'a1', model: 'claude-haiku-5-5' };
  await drain(h.step({ ...agent, turnId: 'a1-t' }, { usage: undefined }));
  await h.event('classic.StopFailure', { hook_event_name: 'StopFailure', error: 'overloaded', agent_id: 'a1' });
  assert.deepEqual(Object.keys(h.loop().held), [agent.model]);
  // The agent's successful reply lands while the main step is deciding, so its clear waits for the main write.
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let entered = () => {};
  const reached = new Promise((resolve) => {
    entered = resolve;
  });
  let gated = false;
  h.messages(async () => {
    if (!gated) {
      gated = true;
      entered();
      await gate;
    }
    return [user('Synthetic task.')];
  });
  await h.event('turn.start', { turnId: 't2', text: 'Synthetic task.' });
  const main = drain(h.step({ ...step, turnId: 't2' }));
  await reached;
  await drain(h.step({ ...agent, turnId: 'a1-t2' }));
  let fail = false;
  let threw = false;
  const { set } = h.$.state;
  h.$.state.set = async (ref, value, options) => {
    const result = await set(ref, value, options);
    // The write that carries the cleared hold is the main reply's.
    if (ref.key === 'loops' && !Object.keys(value.held ?? {}).length) fail = true;
    return result;
  };
  const { get } = h.$.store;
  h.$.store.get = (key) => {
    if (fail && key.startsWith(HOLDS_PREFIX)) {
      threw = true;
      throw new Error('holds read failed');
    }
    return get(key);
  };
  release();
  await main.catch(() => {});
  fail = false;
  await h.event('turn.complete', { turnId: 't2' });
  assert.equal(threw, true);
  const replies = record(h).events.filter((event) => event.type === 'response');
  assert.deepEqual(
    replies.map((reply) => reply.unanswered ?? false),
    [false, false],
  );
});

test('a step that passes through on a routing failure leaves the trace incomplete', async () => {
  const h = setup();
  await begin(h);
  await h.event('turn.start', { turnId: 't1', text: 'Synthetic task.' });
  const read = h.$.settings.read;
  h.$.settings.read = async () => {
    throw new Error('routing settings failure');
  };
  await drain(h.step(step));
  assert.deepEqual(h.requests, [step]);
  await h.event('turn.complete', { turnId: 't1' });
  h.$.settings.read = read;
  await turn(h, 't2');
  assert.equal(usableTrace(record(h)), false);
  assert.ok(record(h).incomplete.includes('gap'));
});

test('pins/mode/off-on/config changes and compaction carry explicit replay boundaries', async () => {
  const h = setup();
  await begin(h);
  await turn(h);
  await h.event('command.run', { command: 'router', args: 'mode quality' });
  await h.event('command.run', { command: 'router', args: 'pin high' });
  await turn(h, 'pinned');
  await h.event('command.run', { command: 'router', args: 'off' });
  await turn(h, 'manual');
  await h.event('command.run', { command: 'router', args: 'on' });
  await h.event('session.compact', { trigger: 'auto' });
  await turn(h, 'after-compact');
  const events = record(h).events;
  assert.ok(events.some((e) => e.type === 'control' && e.pin === 'high'));
  assert.ok(events.some((e) => e.type === 'control' && !e.enabled));
  assert.ok(events.some((e) => e.type === 'request' && e.mode === 'manual'));
  assert.ok(events.some((e) => e.type === 'config' && e.config.routingMode.mode === 'quality'));
  assert.ok(events.some((e) => e.type === 'reset' && e.cause === 'compact'));
  assert.equal(usableTrace(record(h)), true);
  assert.ok(TRACE_ACTIVE_MS > 0);
});

test('a trace export after Delete history leaves out the traces it deleted, before its background delete runs too', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 10, 25, 12).getTime() });
  const h = setup();
  await begin(h);
  await turn(h);
  h.preferences.set(`${TRACE_PREFIX}other`, structuredClone(record(h)));
  t.mock.timers.tick(1000);
  h.$.clock.after = () => ({ cancel: () => {} });
  await press(h, 'tab-usage');
  await press(h, 'delete-history');
  await press(h, 'delete-confirm');
  assert.equal(record(h), undefined);
  assert.ok(record(h, 'other'), 'another session’s trace deleted inside the press');
  assert.match((await h.event('command.run', { command: 'router', args: 'trace export' })).text, /Exported 0 /);
});

test('turns whose queued trace flushes run after a reset in another session keep none of their earlier events', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 10, 25, 12).getTime() });
  const h = setup();
  await begin(h);
  await turn(h);
  const later = [];
  h.$.clock.after = (_ms, fn) => {
    later.push(fn);
    return { cancel: () => {} };
  };
  await turn(h, 't2');
  await turn(h, 't3');
  t.mock.timers.tick(1000);
  h.preferences.set('savings:reset:v1', Date.now());
  t.mock.timers.tick(1000);
  while (later.length) await later.shift()();
  const trace = record(h);
  assert.ok(trace.startedAt >= h.preferences.get('savings:reset:v1'));
  assert.deepEqual(trace.events, []);
});

test('a turn whose trace flush waits keeps its events when the engine is switched away from shadow first', async () => {
  const h = setup();
  await begin(h);
  const later = [];
  h.$.clock.after = (_ms, fn) => {
    later.push(fn);
    return { cancel: () => {} };
  };
  await turn(h);
  await h.event('command.run', { command: 'router', args: 'engine table' });
  while (later.length) await later.shift()();
  assert.equal(record(h)?.events.filter((event) => event.type === 'end').length, 1);
});

test('a trace export right after a turn includes that turn’s queued trace', async () => {
  const h = setup();
  await begin(h);
  h.$.clock.after = () => ({ cancel: () => {} });
  await turn(h);
  assert.match((await h.event('command.run', { command: 'router', args: 'trace export' })).text, /Exported 1 /);
  const exported = JSON.parse(h.files.get('/fixture/team/router-traces.json'));
  assert.equal(ends(readTrace(exported.sessions[`${TRACE_PREFIX}s1`])), 1);
});

test('a shadow turn’s trace is written after turn.complete returns, and session.end writes one still waiting', async () => {
  const h = setup();
  await begin(h);
  const later = [];
  h.$.clock.after = (_ms, fn) => {
    later.push(fn);
    return { cancel: () => {} };
  };
  await turn(h);
  assert.equal(record(h)?.events.some((event) => event.type === 'end') ?? false, false);
  await h.event('session.end', { reason: 'exit' });
  assert.equal(record(h).events.filter((event) => event.type === 'end').length, 1);
  assert.equal(record(h).incomplete.includes('aborted'), false);
});

test('a shadow turn’s end reads the trace records, not the whole store, once the store is measured', async () => {
  const preferences = new Map(Array.from({ length: 300 }, (_, i) => [`mode:old-${i}`, 'auto']));
  const h = setup({}, preferences);
  await begin(h);
  await turn(h);
  const reads = [];
  const get = h.$.store.get;
  h.$.store.get = async (key) => {
    reads.push(key);
    return get(key);
  };
  await turn(h, 't2');
  assert.equal(reads.filter((key) => key.startsWith('mode:old-')).length, 0);
  assert.equal(record(h).events.filter((event) => event.type === 'end').length, 2);
});
