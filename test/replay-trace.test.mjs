import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { DEFAULTS, loadConfig } from '../lib/config.mjs';
import { coldWriteUsd } from '../lib/cost.mjs';
import { completedSince, progressEvidence } from '../lib/facts.mjs';
import { applyMode } from '../lib/modes.mjs';
import {
  appendTrace,
  bufferTrace,
  completedFromTrace,
  mergeTraceExport,
  newTrace,
  readTrace,
  settleTrace,
  storedBytes,
  storedTrace,
  TRACE_ACTIVE_MS,
  TRACE_BUDGET_BYTES,
  TRACE_PREFIX,
  TRACE_RETAIN_MS,
  TRACE_SESSION_BYTES,
  TRACE_VERSION,
  traceAdmission,
  traceBytes,
  traceConfig,
  traceEvent,
  traceFacts,
  traceLoop,
  traceOperation,
  traceProblems,
  traceResponse,
  traceVictims,
  usableTrace,
} from '../lib/replay-trace.mjs';
import { chooseRoute, emptyLoop, nativeFacts } from '../lib/route.mjs';
import { packEvents } from '../lib/trace-codec.mjs';

const NOW = Date.UTC(2026, 10, 16, 12);
const configured = loadConfig();
const config = applyMode(configured, { mode: 'balanced', source: 'default' });
const loop = emptyLoop(configured, configured.models.haiku.id);
const initial = () => newTrace(NOW, { configured, config, loop });
const event = (at = NOW) => ({ type: 'end', at });
const key = (id) => TRACE_PREFIX + id;

test('snapshot freezes execution policy/cache/provider/prices without classifier endpoints or text', () => {
  const canary = 'CANARY_PRIVATE_PROMPT_TOOL_PATH_KEY';
  const polluted = {
    ...config,
    prompt: canary,
    nativePath: `/private/${canary}`,
    classifier: canary,
    classifiers: { jev: { endpoint: `https://${canary}`, apiKey: canary } },
    models: { ...config.models, opus: { ...config.models.opus, source: canary, endpoint: canary } },
  };
  const snapshot = traceConfig(polluted);
  assert.equal(JSON.stringify(snapshot).includes(canary), false);
  assert.equal(snapshot.models.opus.input, config.models.opus.input);
  assert.deepEqual(snapshot.policy, config.policy);
  assert.deepEqual(snapshot.cache, config.cache);
  assert.deepEqual(snapshot.routes, config.routes);
  assert.deepEqual(snapshot.configuredActivities, config.configuredActivities ?? config.activities);
  polluted.models.opus.input = 987;
  assert.equal(snapshot.models.opus.input, config.models.opus.input);
});

test('every accepted catalog identifier and custom cache rate survives the frozen projection', () => {
  const alias = 'extra résumé 模型';
  const unusual = loadConfig({
    userFile: {
      models: { [alias]: { ...DEFAULTS.models.opus, id: 'provider/模型 v1', capability: {} } },
      cache: { writeMultiplier: { '2h': 10, 'cache spécial': 3 }, ttlMs: { '2h': 7200000 } },
    },
  });
  const projected = traceConfig(unusual);
  assert.deepEqual(Object.keys(projected.models), Object.keys(unusual.models));
  assert.deepEqual(
    projected.models[alias],
    traceConfig({ ...unusual, models: { [alias]: unusual.models[alias] } }).models[alias],
  );
  assert.equal(projected.models[alias].id, 'provider/模型 v1');
  assert.deepEqual(projected.cache.writeMultiplier, unusual.cache.writeMultiplier);
  assert.deepEqual(projected.cache.ttlMs, unusual.cache.ttlMs);
  assert.equal(coldWriteUsd(projected, 'opus', 1000, NOW), coldWriteUsd(unusual, 'opus', 1000, NOW));
  assert.equal(coldWriteUsd(projected, 'opus', 1000, NOW), 0.04);
});

test('the snapshot keeps numeric output scales, so replay prices output as the live engine did', () => {
  const opus = { ...config.models.opus, outputScale: { low: 0.5, max: 4, junk: 1, high: 'text' } };
  const projected = traceConfig({ ...config, models: { ...config.models, opus } });
  assert.deepEqual(projected.models.opus.outputScale, { low: 0.5, max: 4 });
  assert.equal(Object.hasOwn(projected.models.haiku, 'outputScale'), false);
});

test('partial activity overrides stay partial for route inheritance', () => {
  const projected = traceConfig({ ...config, activities: { code: { low: { effort: 'max' } } } });
  assert.deepEqual(projected.activities.code.low, { effort: 'max' });
});

test('missing initial state cannot be falsely usable', () => {
  assert.equal(usableTrace(newTrace(NOW, {})), false);
  const bad = initial();
  delete bad.events[0].configured;
  assert.equal(usableTrace(readTrace(bad)), false);
});

test('projected advice/facts/loop suffice to call the real table decision without transcript text', () => {
  const facts = nativeFacts(config, loop, {
    messages: [{ role: 'user', content: 'CANARY_PROMPT' }],
    effort: 'high',
    turnId: 'turn1',
    contextTokens: 8000,
  });
  const advice = {
    choice: 'high',
    probabilities: { high: 1, micro: 0, low: 0, medium: 0, uncertain: 0 },
    activity: { choice: 'code', probabilities: { code: 1 } },
    phase: { choice: 'produce', probabilities: { produce: 1 } },
    continuation: 0,
  };
  const input = { facts, advice, pin: null, nativeModel: configured.models.haiku.id, contextKnown: true, now: NOW };
  const selected = chooseRoute(config, loop, input);
  const op = traceOperation('choose', NOW, input, selected);
  assert.equal(JSON.stringify(op).includes('CANARY'), false);
  const replay = chooseRoute(
    traceConfig(config),
    { ...traceLoop(loop), turnId: null },
    {
      ...op,
      facts: {
        ...op.facts,
        turnKey: 'turn1',
        lastRoute: loop.lastRoute,
        lastRequest: loop.lastRequest,
        models: loop.models,
        historyMeasured: loop.historyMeasured,
      },
      availableModels: undefined,
      now: op.at,
    },
  );
  assert.equal(replay.decision.model, selected.decision.model);
  assert.equal(replay.decision.effort, selected.decision.effort);
  assert.equal(replay.decision.reason, selected.decision.reason);
  assert.deepEqual(replay.state, selected.state);
});

test('facts keep occurrence signature/index and derived context/task/dwell but reject diagnostic text', () => {
  const facts = traceFacts({
    prompt: 'CANARY',
    turns: [{ text: 'CANARY' }],
    path: 'CANARY',
    failure: { signature: 'ab12', index: 42, text: 'CANARY' },
    downAllowed: true,
    contextTokens: 123,
    hasImages: true,
    progress: true,
  });
  assert.deepEqual(facts.failure, { signature: 'ab12', index: 42 });
  assert.equal(facts.downAllowed, true);
  assert.equal(facts.contextTokens, 123);
  assert.equal(facts.hasImages, true);
  assert.equal(facts.progress, true);
  assert.equal(JSON.stringify(facts).includes('CANARY'), false);
  assert.equal(traceFacts({ failure: { signature: 'CANARY /private/path', index: 1 } }).failure.signature, null);
});

test('response includes served model, effective effort and all four token counters only', () => {
  const response = traceResponse(
    NOW,
    { model: 'claude-haiku-5-5', effort: 123 },
    {
      usage: {
        model: 'claude-sonnet-5-5',
        input_tokens: 1,
        cache_read_input_tokens: 2,
        cache_creation_input_tokens: 3,
        output_tokens: 4,
        secret: 'CANARY',
      },
      stopReason: 'CANARY',
      text: 'CANARY',
      content: 'CANARY',
    },
    '1h',
  );
  assert.equal(response.servedModel, 'claude-sonnet-5-5');
  assert.equal(response.effort, 123);
  assert.deepEqual(response.usage, {
    input_tokens: 1,
    cache_read_input_tokens: 2,
    cache_creation_input_tokens: 3,
    output_tokens: 4,
  });
  assert.equal(response.ttl, '1h');
  assert.equal(response.stopReason, 'other');
  assert.equal(traceResponse(NOW, {}, { stopReason: null }, null).stopReason, null);
  assert.equal(JSON.stringify(response).includes('CANARY'), false);
});

test('contiguous open prefixes are usable, including over 60 events; a seq gap is incomplete', () => {
  let record = initial();
  for (let i = 0; i < 90; i++) record = appendTrace(record, [event(NOW + i)], NOW + i);
  assert.equal(record.events.length, 91);
  assert.equal(usableTrace(record), true);
  assert.deepEqual(
    record.events.map((e) => e.seq),
    Array.from({ length: 91 }, (_, i) => i + 1),
  );
  assert.deepEqual(traceProblems({ ...record, events: record.events.filter((e) => e.seq !== 7) }), ['gap']);
});

test('response references its preceding request sequence and matching turn/index', () => {
  const request = { type: 'request', at: NOW, turn: 1, index: 0, operations: [] };
  const response = {
    ...traceResponse(NOW + 1, { model: 'claude-haiku-5-5' }, { stopReason: 'end_turn' }, '5m'),
    turn: 1,
    index: 0,
  };
  const record = appendTrace(initial(), [request, response], NOW + 1);
  assert.equal(record.events[2].requestSeq, record.events[1].seq);
  assert.equal(usableTrace(record), true);
  assert.equal(usableTrace(appendTrace(initial(), [response], NOW + 1)), false);
  const corrupted = structuredClone(record);
  corrupted.events[2].requestSeq = 1;
  assert.deepEqual(traceProblems(corrupted), ['gap']);
});

test('lost write and mid-session/resume/reload remain incomplete on subsequent success', () => {
  for (const reason of ['mid-session', 'resume', 'reload', 'mode-gap', 'conflict']) {
    const record = appendTrace(newTrace(NOW, { configured, config, loop }, [reason]), [event()], NOW + 1);
    assert.equal(usableTrace(record), false);
    assert.deepEqual(record.incomplete, [reason]);
  }
  const record = appendTrace(initial(), [event()], NOW + 1, { lostWrites: 2 });
  assert.equal(record.lostWrites, 2);
  assert.deepEqual(record.incomplete, ['lost-write']);
  assert.equal(usableTrace(appendTrace(record, [event()], NOW + 2)), false);
});

test('intentional cap retains a usable whole-turn prefix and counts excluded turns/events', () => {
  const record = initial();
  const capped = appendTrace(record, [event(), event()], NOW + 1, { maxBytes: storedBytes(record) + 1 });
  assert.deepEqual(capped.events, record.events);
  assert.equal(capped.capped.turns, 1);
  assert.equal(capped.capped.events, 2);
  assert.equal(capped.lostWrites, 0);
  assert.equal(usableTrace(capped), true);
  const next = appendTrace(capped, [event()], NOW + 2);
  assert.equal(next.capped.turns, 2);
  assert.equal(next.events.length, 1);
});

// A record can be capped by size, or by the reload or resume that restored it; either way it takes no more events.
const cappedRecords = () => {
  const full = appendTrace(initial(), [event()], NOW + 1);
  return {
    size: appendTrace(full, [event()], NOW + 2, { maxBytes: storedBytes(full) + 1 }),
    reload: readTrace(storedTrace({ ...full, capped: { at: NOW + 2, turns: 0, events: 0 } })),
  };
};

test('once capped, what happens to the omitted turns leaves the retained ones usable', () => {
  for (const [cause, record] of Object.entries(cappedRecords()))
    for (const options of [
      { reasons: ['gap'] },
      { reasons: ['mode-gap'] },
      { reasons: ['aborted'] },
      { reasons: ['recorder-error'], lostWrites: 1 },
      { reasons: ['lost-write'] },
      { lostWrites: 1 },
    ])
      for (const events of [[], [event()]]) {
        const next = appendTrace(record, events, NOW + 3, options);
        const name = `${cause} ${JSON.stringify(options)} ${events.length}`;
        assert.deepEqual([next.incomplete, next.lostWrites, usableTrace(next)], [[], 0, true], name);
        assert.equal(next.capped.turns, record.capped.turns + events.length, name);
      }
});

test('damage to the retained turns marks a record, capped or not, and so does the append that caps it', () => {
  const capped = Object.values(cappedRecords());
  for (const record of capped)
    for (const reason of ['conflict', 'reset', 'store-guard', 'mid-session'])
      assert.deepEqual(appendTrace(record, [], NOW + 3, { reasons: [reason] }).incomplete, [reason], reason);
  const full = appendTrace(initial(), [event()], NOW + 1);
  for (const reason of ['gap', 'mode-gap', 'aborted', 'recorder-error']) {
    const next = appendTrace(full, [event()], NOW + 2, { reasons: [reason], maxBytes: storedBytes(full) + 1 });
    assert.ok(next.capped, reason);
    assert.deepEqual(next.incomplete, [reason], reason);
    assert.deepEqual(appendTrace(full, [event()], NOW + 2, { reasons: [reason] }).incomplete, [reason], reason);
  }
});

test('a long single turn discards its entire bounded buffer and counts subsequent payload-free events', () => {
  let buffer;
  for (let i = 0; i < 10_000; i++) {
    buffer = bufferTrace(
      buffer,
      buffer?.excludedEvents ? null : { type: 'request', at: NOW, turn: 1, index: i, operations: [] },
      1000,
    );
    assert.ok(traceBytes(packEvents(buffer.events)) <= 1000);
  }
  assert.deepEqual(buffer.events, []);
  assert.equal(buffer.excludedEvents, 10_000);
  assert.ok(traceBytes(buffer) < 100);
  const record = appendTrace(initial(), [], NOW + 1, { excludedEvents: buffer.excludedEvents });
  assert.equal(record.events.length, 1);
  assert.equal(record.capped.turns, 1);
  assert.equal(record.capped.events, 10_000);
  assert.equal(usableTrace(record), true);
});

test('retention is 30 days, not number of rows or sessions; active records are never victims', () => {
  const fresh = Array.from({ length: 100 }, (_, i) => [key(i), initial()]);
  assert.deepEqual(traceVictims(fresh, NOW, key('own'), initial()), []);
  const expired = { ...initial(), active: false, updatedAt: NOW - TRACE_RETAIN_MS - 1 };
  assert.deepEqual(traceVictims([[key('old'), expired], ...fresh], NOW, key('own'), initial()), [key('old')]);
  assert.deepEqual(
    traceVictims([[key('old'), { ...expired, active: true }]], NOW, key('own'), initial(), new Set([key('old')])),
    [key('old')],
  );
});

test('byte budget evicts oldest whole records, not event tails', () => {
  const rows = Array.from({ length: 12 }, (_, i) => [
    key(i),
    { ...initial(), active: false, updatedAt: NOW + i, padding: 'x'.repeat(100_000) },
  ]);
  const victims = traceVictims(rows, NOW + 20, key('own'), initial());
  assert.ok(victims.length > 0);
  assert.deepEqual(
    victims,
    rows.slice(0, victims.length).map(([k]) => k),
  );
  const remaining = rows.filter(([k]) => !victims.includes(k));
  assert.ok(
    traceBytes(initial()) + remaining.reduce((n, [k, v]) => n + traceBytes(k) + traceBytes(v) + 2, 0) <=
      TRACE_BUDGET_BYTES,
  );
});

test('incremental export merges longer/newer sessions and reprojects untrusted existing fields', () => {
  const first = initial();
  const second = appendTrace(first, [event()], NOW + 1);
  const prior = mergeTraceExport(null, [[key('one'), { ...first, prompt: 'CANARY' }]]);
  prior.sessions[key('one')].events[0].config.classifiers = { secret: 'CANARY' };
  const merged = mergeTraceExport(prior, [
    [key('one'), second],
    [key('two'), first],
  ]);
  assert.equal(merged.sessions[key('one')].events.length, 2);
  assert.equal(Object.keys(merged.sessions).length, 2);
  assert.equal(JSON.stringify(merged).includes('CANARY'), false);
  assert.throws(() => mergeTraceExport({ version: 2 }, []), /invalid trace export/);
  assert.throws(() => mergeTraceExport(null, [['not-a-trace', first]]), /invalid trace key/);
  assert.equal(readTrace({ version: 99 }), null);
  assert.equal(
    usableTrace(readTrace({ ...second, events: second.events.map((e) => ({ ...e, seq: e.seq + 1 })) })),
    false,
  );
});

test('export never erases known taint/cap counts and marks divergent prefixes', () => {
  const cleanLong = appendTrace(initial(), [event()], NOW + 1);
  const taintedShort = appendTrace(initial(), [], NOW + 10, { lostWrites: 2 });
  taintedShort.capped = { at: NOW + 2, turns: 3, events: 6 };
  const merged = mergeTraceExport(mergeTraceExport(null, [[key('one'), taintedShort]]), [[key('one'), cleanLong]]);
  assert.equal(usableTrace(merged.sessions[key('one')]), false);
  assert.equal(merged.sessions[key('one')].lostWrites, 2);
  assert.deepEqual(merged.sessions[key('one')].capped, taintedShort.capped);
  const divergent = structuredClone(cleanLong);
  divergent.events[0].loop.requests = 42;
  const conflict = mergeTraceExport(merged, [[key('one'), divergent]]).sessions[key('one')];
  assert.ok(conflict.incomplete.includes('conflict'));
  assert.ok(conflict.incomplete.includes('lost-write'));
});

test('stale active lease cannot hold the global byte budget forever', () => {
  const stale = { ...initial(), updatedAt: NOW - TRACE_ACTIVE_MS - 1, padding: 'x'.repeat(TRACE_BUDGET_BYTES) };
  assert.deepEqual(traceVictims([[key('stale'), stale]], NOW, key('own'), initial()), [key('stale')]);
});

test('3MiB admission stops traces without evicting non-trace usage or active sessions', () => {
  assert.equal(traceAdmission([['usage:v1:large', 'x'.repeat(3 * 1024 * 1024)]], key('own'), initial()), false);
  assert.equal(traceAdmission([['usage:v1:large', 'x'.repeat(3 * 1024 * 1024 - 100)]], key('own'), initial()), false);
  assert.equal(traceAdmission([], key('own'), initial()), true);
  const active = { ...initial(), padding: 'x'.repeat(TRACE_BUDGET_BYTES) };
  assert.deepEqual(traceVictims([[key('active'), active]], NOW, key('own'), initial()), []);
  assert.equal(traceAdmission([[key('active'), active]], key('own'), initial()), false);
});

test('text-free checkpoint indexes reproduce activity completion for any replay switch cursor', () => {
  const call = (id, name, input) => ({ role: 'assistant', content: [{ type: 'tool_use', id, name, input }] });
  const result = (id, error = false, text = 'CANARY result') => ({
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, is_error: error, content: text }],
  });
  const cases = [
    [call('a', 'Bash', { command: 'npm test' }), result('a')],
    [call('a', 'Bash', { command: 'npm test | tail' }), result('a')],
    [call('a', 'Bash', { command: 'npm test' }), result('a', true)],
    [call('a', 'Bash', { command: 'npm test', run_in_background: true }), result('a')],
    [call('a', 'Bash', { command: 'git status' }), result('a')],
    [call('a', 'Bash', { command: 'git commit -m CANARY' }), result('a')],
    [
      call('a', 'Edit', { file_path: '/CANARY/a.mjs' }),
      result('a'),
      call('b', 'Edit', { file_path: '/CANARY/docs/a.md' }),
      result('b'),
    ],
    [call('a', 'Task', { prompt: 'CANARY' }), result('a')],
    [call('a', 'Read', { file_path: '/CANARY' }), result('a', true)],
  ];
  for (const middle of cases) {
    const messages = [{ role: 'user', content: 'CANARY' }, ...middle, { role: 'user', content: 'CANARY next' }];
    const evidence = progressEvidence(messages);
    assert.equal(JSON.stringify(evidence).includes('CANARY'), false);
    for (let from = -1; from <= messages.length + 1; from++)
      for (const activity of [null, 'code', 'debug', 'ops', 'docs', 'explore', 'plan', 'review'])
        assert.equal(
          completedFromTrace(evidence, from, activity),
          completedSince(messages, from, activity),
          JSON.stringify({ evidence, from, activity }),
        );
  }
});

test('byte counting includes UTF-8 overhead', () => {
  assert.equal(traceBytes('€'), 5);
  assert.equal(DEFAULTS.models.opus.id, configured.models.opus.id);
});

test('an activity capability map round-trips through a stored trace', () => {
  assert.equal(TRACE_VERSION, 3);
  assert.equal(TRACE_PREFIX, 'trace:v3:');
  const capability = { medium: 2, xhigh: { default: 3, code: 2.5 } };
  const evidence = structuredClone(configured);
  evidence.models.opus.capability = capability;
  const record = newTrace(NOW, { configured: evidence, config: evidence, loop });
  const read = readTrace(JSON.parse(JSON.stringify(storedTrace(record))));
  assert.equal(read.version, TRACE_VERSION);
  assert.deepEqual(read.events[0].config.models.opus.capability, capability);
  assert.deepEqual(read.events[0].configured.models.opus.capability, capability);
});

for (const version of [1, 2])
  test(`a version ${version} trace, its events stored whole, is still read, exported and retired`, () => {
    const whole = { ...appendTrace(initial(), [event()], NOW + 1), version };
    const name = `trace:v${version}:old`;
    assert.deepEqual(readTrace(JSON.parse(JSON.stringify(whole))).events, whole.events);
    const merged = mergeTraceExport(null, [[name, whole]]);
    assert.equal(usableTrace(merged.sessions[name]), true);
    const expired = { ...whole, active: false, updatedAt: NOW - TRACE_RETAIN_MS - 1 };
    assert.deepEqual(traceVictims([[name, expired]], NOW, key('own'), initial()), [name]);
  });

test('a stored trace whose packed events cannot be read is rejected', () => {
  const stored = storedTrace(initial());
  const laterField = [[...stored.packed[0].slice(0, 2), { ...stored.packed[0][2], '~zz': 1 }]];
  for (const packed of [[null], [[99, 0, {}]], [['x']], laterField])
    assert.equal(readTrace({ ...stored, packed }), null);
});

// The fixture is a literal stored record whose aliases run from the first key to the last: moving a key, type or
// operation it uses, or removing any key, reads it differently. Appending keys keeps it passing.
test('a committed version 3 record still reads as the events it was written from', () => {
  const { stored, events } = JSON.parse(
    readFileSync(new URL('./fixtures/trace-packed-v3.json', import.meta.url), 'utf8'),
  );
  assert.deepEqual(JSON.parse(JSON.stringify(readTrace(stored).events)), events);
});

// A turn of `steps` requests as the recorder writes it: one decision, then tool continuations.
function syntheticTurn(turn, steps, state) {
  const events = [];
  for (let index = 0; index < steps; index++) {
    state.at += 3000 + ((turn * 131 + index * 17) % 5000);
    state.messages += 2;
    const context = state.messages * 900 + index;
    const input = {
      taskProgress: {
        check: null,
        edit: { index: state.messages - 4, ok: true },
        run: { index: state.messages - 2, ok: true },
        delegate: -1,
        anyCheck: -1,
        nonDocEdit: state.messages - 4,
        prompt: state.messages - index * 2 - 1,
        lastTool: state.messages - 2,
        result: { index: state.messages - 1, error: false },
      },
      facts: index ? null : { hasImages: false, continuation: turn > 1, contextTokens: context },
      advice: index
        ? null
        : {
            choice: 'medium',
            probabilities: { micro: 0, low: 0.1, medium: (turn % 7) / 10, high: 0.2, uncertain: 0 },
            confidence: 0.7,
            continuation: 0.4,
            activity: { choice: 'code', probabilities: { code: 0.8, debug: (turn % 3) / 10, review: 0.1 } },
          },
      nativeModel: 'claude-sonnet-5-5',
      contextKnown: true,
      contextTokens: context,
      hasImages: false,
      ...(index ? { actualHasImages: false } : {}),
      effort: 'medium',
    };
    const decision = { tier: 'medium', activity: 'code', model: 'claude-sonnet-5-5', effort: 'high', reason: 'same' };
    const place = { turn, index };
    events.push(
      {
        type: 'request',
        at: state.at,
        ...place,
        messageCount: state.messages,
        model: 'claude-sonnet-5-5',
        effort: 'high',
        mode: 'auto',
        engineModel: 'claude-sonnet-5-5',
        engineEffort: 'medium',
        reviewedAt: 0,
        observedFrom: 0,
        operations: [traceOperation(index ? 'continue' : 'choose', state.at - 4, input, { decision })],
      },
      {
        type: 'response',
        at: state.at + 2100,
        ...place,
        requestedModel: 'claude-sonnet-5-5',
        servedModel: 'claude-sonnet-5-5',
        effort: 'high',
        usage: {
          input_tokens: 3 + (index % 5),
          cache_read_input_tokens: context,
          cache_creation_input_tokens: 700 + index,
          output_tokens: 150 + ((turn + index) % 400),
        },
        stopReason: index === steps - 1 ? 'end_turn' : 'tool_use',
        ttl: '5m',
      },
    );
  }
  events.push({ type: 'end', at: state.at + 2200, turn });
  return events;
}

test('200 turns of eight requests fit one session, and read back as they were recorded', () => {
  let record = initial();
  const state = { at: NOW, messages: 0 };
  // Ten turns an append: each append measures the whole record.
  for (let turn = 1; turn <= 200; turn += 10) {
    const events = Array.from({ length: 10 }, (_, i) => syntheticTurn(turn + i, 8, state)).flat();
    record = appendTrace(record, events, state.at + 2300);
  }
  assert.equal(record.capped, null);
  assert.equal(usableTrace(record), true);
  assert.ok(storedBytes(record) <= TRACE_SESSION_BYTES);
  assert.ok(storedBytes(record) * 5 < traceBytes(record), 'packed events are under a fifth of their whole size');
  assert.deepEqual(readTrace(JSON.parse(JSON.stringify(storedTrace(record)))), record);
});

test('packed events read back exactly through config changes, resets, reordered catalogs and unusual aliases', () => {
  const state = { at: NOW, messages: 0 };
  const reordered = structuredClone(configured);
  reordered.models = { '~extra': { ...reordered.models.opus }, ...reordered.models };
  const record = appendTrace(
    initial(),
    [
      ...syntheticTurn(1, 3, state),
      { type: 'config', at: state.at, turn: 2, index: 0, configured: reordered, config: reordered },
      { type: 'reset', at: state.at, cause: 'compact', loop, generation: 1 },
      { type: 'control', at: state.at, pin: 'high', enabled: true },
      ...syntheticTurn(2, 3, state),
      { type: 'config', at: state.at, turn: 3, index: 0, configured, config },
    ],
    state.at,
  );
  const read = readTrace(JSON.parse(JSON.stringify(storedTrace(record))));
  assert.deepEqual(read, record);
  assert.equal(JSON.stringify(read.events), JSON.stringify(record.events.map(traceEvent)), 'catalog order is kept');
});

test('a completed turn’s unanswered request is settled, an answered one is left alone', () => {
  const [request, response] = syntheticTurn(1, 1, { at: NOW, messages: 0 });
  assert.deepEqual(settleTrace([request, response]), [request, response]);
  const settled = settleTrace([request]);
  assert.deepEqual(
    settled.map((e) => [e.type, e.turn, e.index, e.unanswered ?? false]),
    [
      ['request', 1, 0, false],
      ['response', 1, 0, true],
    ],
  );
  assert.equal(usableTrace(appendTrace(initial(), settled, NOW + 1)), true);
});

test('trace projection keeps only valid capability cells', () => {
  const projected = traceConfig({
    models: {
      m: {
        id: 'm',
        efforts: ['high'],
        capability: { high: { default: 2, code: 2.5, debug: 4, bogus: 1 } },
      },
    },
  });
  assert.deepEqual(projected.models.m.capability, { high: { default: 2, code: 2.5 } });
});
