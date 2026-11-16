import assert from 'node:assert/strict';
import test from 'node:test';
import { TRACE_ACTIVE_MS, TRACE_PREFIX, TRACE_RETAIN_MS, traceBytes, usableTrace } from '../lib/replay-trace.mjs';
import { chooseRoute, continueRoute, observeResponse, prepareLoop } from '../lib/route.mjs';
import { answering, CONFIG, drain, harness, JEV_KEY, press, step } from './harness.mjs';
import { assistant, jevResponse, toolResult, user } from './helpers.mjs';

const record = (h, id = 's1') => h.preferences.get(TRACE_PREFIX + id);
const answer = jevResponse('low', { low: 1 }, 0, { code: 1 }, 'produce');
function setup(config = {}, preferences = new Map()) {
  const h = harness(JEV_KEY, preferences);
  h.files.set(CONFIG, JSON.stringify({ routingEngine: 'shadow', policy: { reviewEveryRequests: 0 }, ...config }));
  answering(h, answer);
  return h;
}
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

test('append failure poisons memory and next successful write persists taint instead of falsely completing', async () => {
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
  assert.ok(record(h).lostWrites > 0);
  assert.equal(usableTrace(record(h)), false);
  assert.equal(JSON.stringify(record(h)).includes('CANARY'), false);
});

test('quota reads fail closed, preserve usage, and taint on recovery', async () => {
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
    assert.equal(record(h), undefined);
    fail = false;
    await turn(h, 't2');
    assert.equal(usableTrace(record(h)), false);
    assert.ok(record(h).lostWrites > 0);
    assert.deepEqual(h.preferences.get('other:opaque'), { content: 'not a trace' });
  }
});

test('3MiB guard stops tracing without consuming other ledger headroom', async () => {
  const h = setup();
  await begin(h);
  h.preferences.set('usage:large', 'x'.repeat(3 * 1024 * 1024));
  await turn(h);
  assert.equal(record(h), undefined);
  h.preferences.delete('usage:large');
  await turn(h, 't2');
  assert.ok(record(h).incomplete.includes('store-guard'));
  assert.equal(usableTrace(record(h)), false);
});

test('mid-session/resume/reload cannot become usable even when the saved prefix was clean', async () => {
  const preferences = new Map();
  const first = setup({}, preferences);
  await begin(first);
  await turn(first);
  assert.equal(usableTrace(record(first)), true);
  const resumed = setup({}, preferences);
  await begin(resumed);
  await turn(resumed, 't2', [user('one'), assistant('reply'), user('two')]);
  assert.equal(usableTrace(record(resumed)), false);
  assert.ok(record(resumed).incomplete.includes('resume'));
  const late = setup();
  await late.event('turn.start', { turnId: 't1', text: 'already running' });
  await drain(late.step({ ...step, index: 2, messageCount: 20 }));
  await late.event('turn.complete', { turnId: 't1' });
  assert.equal(usableTrace(record(late)), false);
});

test('over 60 actual decisions remain sequenced; per-session cap preserves only whole-turn usable prefixes', async () => {
  const h = setup();
  await begin(h);
  for (let i = 0; i < 65; i++) await turn(h, `t${i}`);
  const trace = record(h);
  assert.ok(traceBytes(trace) < 128 * 1024);
  const requests = trace.events.filter((e) => e.type === 'request');
  assert.ok(requests.length > 60, `retained ${requests.length} decisions`);
  assert.equal(usableTrace(trace), true);
  for (let i = 65; i < 130; i++) await turn(h, `t${i}`);
  assert.ok(record(h).capped.turns > 0);
  assert.equal(record(h).capped.events % 3, 0);
  assert.equal(usableTrace(record(h)), true);
  assert.equal(record(h).events.at(-1).type, 'end');
});

test('a long single tool turn discards its entire batch and retains capped coverage, not a half-turn', async () => {
  const h = setup();
  await begin(h);
  await turn(h, 'first');
  const before = structuredClone(record(h).events);
  await h.event('turn.start', { turnId: 'long', text: 'Synthetic task.' });
  for (let i = 0; i < 400; i++) await drain(h.step({ ...step, turnId: 'long', index: i, messageCount: 2 }));
  await h.event('turn.complete', { turnId: 'long' });
  assert.deepEqual(record(h).events, before);
  assert.equal(record(h).capped.turns, 1);
  assert.ok(record(h).capped.events >= 801);
  assert.equal(usableTrace(record(h)), true);
  assert.equal(JSON.stringify(record(h)).includes('Synthetic task'), false);
});

test('retention expires old whole sessions including killed active leases, not decision-row counts', async () => {
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
  assert.equal(second.sessions[`${TRACE_PREFIX}s1`].events.length, 7);
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

test('concurrent active session records are never evicted to admit a new trace', async () => {
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
  assert.equal(record(h).events.length, prefix.events.length);
  assert.ok(h.preferences.has(`${TRACE_PREFIX}active-a`));
  assert.ok(h.preferences.has(`${TRACE_PREFIX}active-b`));
  h.preferences.delete(`${TRACE_PREFIX}active-a`);
  h.preferences.delete(`${TRACE_PREFIX}active-b`);
  await turn(h, 't3');
  assert.equal(usableTrace(record(h)), false);
  assert.ok(record(h).incomplete.includes('store-guard'));
});

test('eviction rereads changed records and keeps a newly active writer', async () => {
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
  const sample = record(h);
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

test('reload and oversized initial snapshots are explicitly unusable', async () => {
  const first = setup();
  await begin(first);
  await turn(first);
  const reloaded = setup({}, first.preferences);
  for (const [key, value] of first.state) reloaded.state.set(key, structuredClone(value));
  await begin(reloaded);
  await turn(reloaded, 't2');
  assert.ok(record(reloaded).incomplete.includes('reload'));
  assert.equal(usableTrace(record(reloaded)), false);
  const models = {};
  for (let i = 0; i < 700; i++)
    models[`m${i}`] = {
      id: `synthetic-model-${i}`,
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
  assert.ok(traceBytes(record(oversized)) < 128 * 1024);
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
    toolResult(diagnostic, { isError: true }),
  ]);
  const failure = record(h).events.find((e) => e.type === 'request').operations[0].facts.failure;
  assert.match(failure.signature, /^[a-f0-9]{1,16}$/);
  assert.equal(failure.index, 4);
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
  h.files.set(CONFIG, JSON.stringify({ routingEngine: 'table' }));
  await h.event('command.run', { command: 'router', args: 'activities off' });
  const set = h.$.store.set;
  const traceWrites = [];
  h.$.store.set = async (key, value) => {
    if (key.startsWith(TRACE_PREFIX)) traceWrites.push(key);
    return set(key, value);
  };
  await h.event('turn.complete', { turnId: 'omitted' });
  assert.deepEqual(traceWrites, []);
  h.files.set(CONFIG, JSON.stringify({ routingEngine: 'shadow', activityRouting: 'off' }));
  await h.event('command.run', { command: 'router', args: 'activities on' });
  await turn(h, 'after');
  assert.equal(usableTrace(record(h)), false);
  assert.ok(record(h).incomplete.includes('mode-gap'));
});

test('aborted manual replies and unfinished streamed requests persist explicit incompleteness', async () => {
  for (const manual of [false, true]) {
    const h = setup();
    await begin(h);
    if (manual) await h.event('command.run', { command: 'router', args: 'off' });
    await h.event('turn.start', { turnId: 't1', text: 'Synthetic task.' });
    const controller = new AbortController();
    const stream = h.step(step, {}, controller.signal);
    await stream.next();
    controller.abort();
    await drain(stream);
    await h.event('turn.complete', { turnId: 't1' });
    assert.equal(usableTrace(record(h)), false);
    assert.ok(record(h).incomplete.includes('aborted'));
  }
  const h = setup();
  await begin(h);
  await h.event('turn.start', { turnId: 't1', text: 'Synthetic task.' });
  const stream = h.step(step);
  await stream.next();
  await stream.return();
  await h.event('turn.complete', { turnId: 't1' });
  assert.equal(usableTrace(record(h)), false);
  assert.ok(record(h).incomplete.includes('gap'));
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

test('pins/mode/off-on/config changes and compaction carry explicit replay boundaries', async () => {
  const h = setup();
  await begin(h);
  await turn(h);
  await h.event('command.run', { command: 'router', args: 'mode quality' });
  await h.event('command.run', { command: 'router', args: 'pin high' });
  await turn(h, 'pinned');
  await h.event('command.run', { command: 'router', args: 'off' });
  await turn(h, 'manual');
  await h.event('command.run', { command: 'router', args: 'auto' });
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
