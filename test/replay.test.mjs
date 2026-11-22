import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { readDecisions } from '../lib/decisions.mjs';
import { observedActivity, progressEvidence, routingBucket } from '../lib/facts.mjs';
import { evaluateReplay, replayAuto, replayTable } from '../lib/replay.mjs';
import { observedFromTrace, TRACE_PREFIX } from '../lib/replay-trace.mjs';
import { main as replayCli } from '../scripts/replay-traces.mjs';
import { answering, CONFIG, drain, harness, JEV_KEY, shadowHarness, step } from './harness.mjs';
import { assistant, jevResponse, user } from './helpers.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const FIXTURE = fileURLToPath(new URL('./fixtures/replay-traces.json', import.meta.url));

const exportOf = (record) => ({ version: 1, sessions: { [`${TRACE_PREFIX}private-session`]: record } });

async function capture({ controls = false, continuations = false, keyword = false } = {}) {
  const h = shadowHarness();
  await h.event('session.start', { cwd: '/fixture' });
  for (let i = 0; i < 4; i++) {
    const turnId = `t${i}`;
    if (controls && i === 1) {
      await h.event('command.run', { command: 'router', args: 'mode quality' });
      await h.event('command.run', { command: 'router', args: 'pin high' });
    }
    if (controls && i === 2) await h.event('command.run', { command: 'router', args: 'off' });
    if (controls && i === 3) {
      await h.event('command.run', { command: 'router', args: 'auto' });
      await h.event('session.compact', { trigger: 'auto' });
    }
    const text = keyword && i === 1 ? 'maxthink synthetic task' : 'Synthetic task';
    await h.event('turn.start', { turnId, text });
    const messages = i ? [user('one'), assistant('two'), user('three')] : [user('one')];
    h.messages(async () => messages);
    await drain(h.step({ ...step, turnId, messageCount: messages.length }));
    if (continuations) await drain(h.step({ ...step, turnId, index: 1, messageCount: messages.length }));
    await h.event('turn.complete', { turnId });
  }
  return h.preferences.get(`${TRACE_PREFIX}s1`);
}

test('first low advice routes from actual DeepSeek low capability without a preceding micro turn', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-16T10:00:00Z') });
  const runs = [];
  for (const routingEngine of ['shadow', 'auto']) {
    const h = harness(JEV_KEY);
    h.env.set('CLAUDE_ROUTER_PROVIDER', 'deepseek');
    h.files.set(
      '/fixture/team/deepseek-router.json',
      JSON.stringify({
        routingEngine,
        baselineTier: 'low',
        models: { flash: { capability: { low: 0, high: 2, max: 3 } } },
        policy: { reviewEveryRequests: 0 },
      }),
    );
    h.model('deepseek-flash[1m]');
    answering(h, jevResponse('low', { micro: 0.2, low: 0.57, medium: 0.13, high: 0.1 }, 0, { code: 1 }, 'produce'));
    await h.event('session.start', { cwd: '/fixture' });
    await h.event('turn.start', { turnId: 'first', text: 'Synthetic task' });
    await drain(h.step({ ...step, turnId: 'first', model: 'deepseek-flash[1m]', effort: 'low' }));
    await h.event('turn.complete', { turnId: 'first' });
    runs.push(h);
  }
  assert.deepEqual(
    runs[1].requests.map(({ model, effort }) => ({ model, effort })),
    [{ model: 'deepseek-flash[1m]', effort: 'high' }],
  );
  assert.equal(runs[1].loop().auto.state.demand, 1);
  assert.equal(runs[1].loop().auto.state.routedDemand, 1);
  assert.equal(runs[1].loop().decision.reason, 'startup');
  const record = runs[0].preferences.get(`${TRACE_PREFIX}s1`);
  const table = replayTable(record);
  assert.deepEqual(table.mismatches, []);
  const replayed = replayAuto(record, table.rows);
  assert.deepEqual(
    replayed.map((row) => row.pair),
    [{ model: 'deepseek-flash[1m]', effort: 'high' }],
  );
  assert.equal(replayed[0].reason, 'startup');
});

test('same-route micro adoption lets low votes and mid-turn review upgrade the real DeepSeek request', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-16T10:00:00Z') });
  const runs = [];
  const states = [];
  for (const routingEngine of ['shadow', 'auto']) {
    const h = harness(JEV_KEY);
    h.env.set('CLAUDE_ROUTER_PROVIDER', 'deepseek');
    h.files.set(
      '/fixture/team/deepseek-router.json',
      JSON.stringify({
        routingEngine,
        baselineTier: 'low',
        models: { flash: { capability: { low: 0, high: 2, max: 3 } } },
        policy: { reviewEveryRequests: 1 },
      }),
    );
    h.model('deepseek-flash[1m]');
    h.settings({ availableModels: ['deepseek-flash[1m]'] });
    const calls = answering(
      h,
      jevResponse('micro', { micro: 0.95, low: 0.05 }, 0, { code: 1 }, 'produce'),
      jevResponse('low', { micro: 0.2, low: 0.57, medium: 0.13, high: 0.1 }, 0, { code: 1 }, 'produce'),
    );
    await h.event('session.start', { cwd: '/fixture' });
    const native = { ...step, model: 'deepseek-flash[1m]', effort: 'low' };
    await h.event('turn.start', { turnId: 'micro', text: 'Synthetic task' });
    h.messages(async () => [user('one')]);
    await drain(h.step({ ...native, turnId: 'micro' }));
    const micro = structuredClone(h.loop());
    await h.event('turn.complete', { turnId: 'micro' });
    await h.event('turn.start', { turnId: 'low', text: 'Synthetic task' });
    h.messages(async () => [user('one'), assistant('done'), user('next')]);
    for (const index of [0, 1, 2]) {
      await drain(h.step({ ...native, turnId: 'low', index, messageCount: 3 }));
      await new Promise(setImmediate);
      if (routingEngine === 'auto') states.push(structuredClone(h.loop()));
    }
    await h.event('turn.complete', { turnId: 'low' });
    assert.equal(calls.length, 3);
    runs.push({ h, micro });
  }
  const live = runs[1];
  assert.deepEqual(
    live.h.requests.map(({ model, effort }) => ({ model, effort })),
    ['low', 'low', 'low', 'high'].map((effort) => ({ model: 'deepseek-flash[1m]', effort })),
  );
  assert.equal(live.micro.auto.state.demand, 0);
  assert.equal(live.micro.auto.state.routedDemand, 0);
  assert.equal(live.micro.decision.reason, 'same-route');
  assert.equal(states[0].auto.state.demand, 0);
  assert.deepEqual(states[0].auto.state.votes, [0, 1]);
  assert.equal(states[0].decision.auto.reason, 'upgrade-pending');
  assert.deepEqual(states[0].switchedAt, live.micro.switchedAt);
  assert.equal(states[2].auto.state.demand, 1);
  assert.equal(states[2].auto.state.routedDemand, 1);
  assert.deepEqual(states[2].auto.state.votes, [1, 1]);
  const decisions = readDecisions(live.h.preferences.get('decisions:v1:s1')).rows;
  const review = decisions.find((row) => row.kind === 'review');
  assert.equal(review.reason, 'upgrade');
  assert.equal(review.auto.demand, 1);
  assert.equal(states[2].decision.reason, 'same-route');
  const trace = runs[0].h.preferences.get(`${TRACE_PREFIX}s1`);
  const table = replayTable(trace);
  assert.deepEqual(table.mismatches, []);
  const replayed = replayAuto(trace, table.rows);
  assert.deepEqual(
    replayed.map((row) => row.pair),
    live.h.requests.map(({ model, effort }) => ({ model, effort: effort ?? null })),
  );
  assert.deepEqual(
    replayed.map((row) => row.demand),
    [0, 0, 0, 1],
  );
  assert.equal(replayed.at(-1).reason, 'same-route');
  const report = evaluateReplay([exportOf(trace)]);
  assert.equal(report.sessions[0].modes.balanced.auto.switches.moves, 1);
});

test('live auto and stateful replay agree on bounded multi-turn pin and forced refit', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-16T10:00:00Z') });
  const capabilities = {
    haiku: { capability: { low: 0, medium: 1, high: 1.5, xhigh: 2, max: 2 }, imageInput: false },
    sonnet: { capability: { low: 1, medium: 2, high: 2.5, xhigh: 2.5, max: 2.5 } },
    opus: { capability: { low: 2, medium: 2.5, high: 2.5, xhigh: 3, max: 3 } },
    fable: { capability: { low: 3, medium: 3, high: 3, xhigh: 3, max: 3 } },
  };
  const runs = [];
  for (const engine of ['shadow', 'auto']) {
    const h = harness(JEV_KEY);
    h.files.set(
      CONFIG,
      JSON.stringify({ routingEngine: engine, models: capabilities, policy: { reviewEveryRequests: 0 } }),
    );
    answering(h, jevResponse('high', { high: 1 }, 0, { code: 1 }, 'produce'));
    await h.event('session.start', { cwd: '/fixture' });
    for (const turnId of ['t1', 't2']) {
      if (turnId === 't2') await h.event('command.run', { command: 'router', args: 'pin low' });
      await h.event('turn.start', { turnId, text: 'Synthetic task' });
      h.messages(async () => [user('Synthetic task')]);
      await drain(h.step({ ...step, turnId }));
      if (turnId === 't2') {
        h.settings({ availableModels: ['sonnet'] });
        await drain(h.step({ ...step, turnId, index: 1 }));
      }
      await h.event('turn.complete', { turnId });
    }
    runs.push(h);
  }
  const trace = runs[0].preferences.get(`${TRACE_PREFIX}s1`);
  const table = replayTable(trace);
  assert.deepEqual(table.mismatches, []);
  const replayed = replayAuto(trace, table.rows);
  assert.deepEqual(
    replayed.map((row) => row.pair),
    runs[1].requests.map(({ model, effort }) => ({ model, effort: effort ?? null })),
  );
  assert.deepEqual(
    replayed.map((row) => row.demand),
    [3, 1, 1],
  );
});

test('live auto and stateful replay agree on keyword turns and their tool steps', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-16T10:00:00Z') });
  const capabilities = {
    haiku: { capability: { low: 0, medium: 1, high: 1.5, xhigh: 2, max: 2 } },
    sonnet: { capability: { low: 1, medium: 2, high: 2.5, xhigh: 2.5, max: 2.5 } },
    opus: { capability: { low: 2, medium: 2.5, high: 2.5, xhigh: 3, max: 3 } },
    fable: { capability: { low: 3, medium: 3, high: 3, xhigh: 3, max: 3 } },
  };
  const turns = [
    ['t1', 'Synthetic task'],
    ['t2', 'morethink synthetic task'],
    ['t3', 'highthink synthetic task'],
    ['t4', 'Synthetic task'],
  ];
  const runs = [];
  for (const engine of ['shadow', 'auto']) {
    const h = harness(JEV_KEY);
    h.files.set(
      CONFIG,
      JSON.stringify({ routingEngine: engine, models: capabilities, policy: { reviewEveryRequests: 0 } }),
    );
    answering(h, jevResponse('low', { low: 1 }, 0, { code: 1 }, 'execute'));
    await h.event('session.start', { cwd: '/fixture' });
    for (const [turnId, text] of turns) {
      await h.event('turn.start', { turnId, text });
      h.messages(async () => [user(text)]);
      await drain(h.step({ ...step, turnId }));
      await drain(h.step({ ...step, turnId, index: 1 }));
      await h.event('turn.complete', { turnId });
    }
    runs.push(h);
  }
  const trace = runs[0].preferences.get(`${TRACE_PREFIX}s1`);
  const table = replayTable(trace);
  assert.deepEqual(table.mismatches, []);
  const replayed = replayAuto(trace, table.rows);
  assert.deepEqual(
    replayed.map((row) => row.pair),
    runs[1].requests.map(({ model, effort }) => ({ model, effort: effort ?? null })),
  );
});

test('live/replay no-route suspension and next-turn reentry agree, including pinned native fallback', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-16T10:00:00Z') });
  for (const pinned of [false, true]) {
    const runs = [];
    for (const routingEngine of ['shadow', 'auto']) {
      const h = harness(JEV_KEY);
      h.files.set(
        CONFIG,
        JSON.stringify({
          routingEngine,
          policy: { reviewEveryRequests: 0 },
          models: { haiku: { capability: { medium: 1 } }, opus: { capability: { xhigh: 3 } } },
        }),
      );
      answering(h, jevResponse('high', { high: 1 }, 0, { code: 1 }, 'produce'));
      await h.event('session.start', { cwd: '/fixture' });
      for (const turnId of ['normal', 'external', 'reentry']) {
        h.settings({ availableModels: turnId === 'external' ? [] : ['haiku', 'sonnet', 'opus'] });
        if (pinned && turnId === 'external') await h.event('command.run', { command: 'router', args: 'pin low' });
        await h.event('turn.start', { turnId, text: 'Synthetic task' });
        h.messages(async () => [user('Synthetic task')]);
        const native = { ...step, turnId, model: turnId === 'external' ? 'claude-sonnet-5-5' : step.model };
        await drain(h.step(native));
        if (turnId === 'external') {
          h.settings({ availableModels: ['sonnet', 'opus'] });
          await drain(h.step({ ...native, index: 1 }));
        }
        await h.event('turn.complete', { turnId });
      }
      runs.push(h);
    }
    const record = runs[0].preferences.get(`${TRACE_PREFIX}s1`);
    const table = replayTable(record);
    assert.deepEqual(table.mismatches, []);
    const replayed = replayAuto(record, table.rows);
    assert.deepEqual(
      replayed.map((row) => row.pair),
      runs[1].requests.map(({ model, effort }) => ({ model, effort: effort ?? null })),
    );
    assert.equal(replayed.at(-1).reason, 'reentry');
    assert.equal(replayed[1].external, true);
    assert.equal(replayed[2].reason, 'native-fallback');
    const report = evaluateReplay([{ version: 1, sessions: { [`${TRACE_PREFIX}s1`]: record } }]);
    assert.equal(report.sessions[0].modes.balanced.auto.externalRequests, 2);
  }
});

test('live auto and replay both treat an allowlist expansion as catalog evidence', async () => {
  const runs = [];
  for (const routingEngine of ['shadow', 'auto']) {
    const h = harness(JEV_KEY);
    h.files.set(
      CONFIG,
      JSON.stringify({
        routingEngine,
        policy: { reviewEveryRequests: 0 },
        models: { haiku: { capability: { medium: 1, xhigh: 2 } }, opus: { capability: { xhigh: 3 } } },
      }),
    );
    answering(h, jevResponse('high', { high: 1 }, 0, { code: 1 }, 'produce'));
    await h.event('session.start', { cwd: '/fixture' });
    for (const [turnId, availableModels] of [
      ['limited', ['haiku']],
      ['expanded', ['haiku', 'opus']],
    ]) {
      h.settings({ availableModels });
      await h.event('turn.start', { turnId, text: 'Synthetic task' });
      h.messages(async () => [user('Synthetic task')]);
      await drain(h.step({ ...step, turnId }));
      await h.event('turn.complete', { turnId });
    }
    runs.push(h);
  }
  const record = runs[0].preferences.get(`${TRACE_PREFIX}s1`);
  const table = replayTable(record);
  assert.deepEqual(table.mismatches, []);
  const auto = replayAuto(record, table.rows);
  assert.deepEqual(
    auto.map((row) => row.pair),
    runs[1].requests.map(({ model, effort }) => ({ model, effort })),
  );
  assert.deepEqual(
    auto.map((row) => row.reason),
    ['upgrade', 'explicit-up'],
  );
  assert.deepEqual(
    auto.map((row) => row.demand),
    [3, 3],
  );
});

test('fidelity evolves real captured multi-turn, pin, mode, manual, reset and continuation operations', async () => {
  const record = await capture({ controls: true, continuations: true });
  const result = evaluateReplay([exportOf(record)]);
  assert.deepEqual(result.fidelity.mismatches, []);
  assert.equal(result.status, 'ok');
  assert.equal(result.coverage.exportCohort.usableSessions, 1);
  assert.equal(result.coverage.allSessions.usableSessionRatio, null);
  assert.equal(result.coverage.allSessions.gate80Percent, 'unavailable');
  assert.equal(JSON.stringify(result).includes('private-session'), false);
});

test('a shadow keyword turn replays as it ran', async () => {
  const record = await capture({ keyword: true, continuations: true });
  const result = evaluateReplay([exportOf(record)]);
  assert.deepEqual(result.fidelity.mismatches, []);
  assert.equal(result.status, 'ok');
});

test('a held model replays the stand-in in table and never returns through auto', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-22T10:00:00Z') });
  const capabilities = {
    haiku: { capability: { low: 0, medium: 1, high: 1.5, xhigh: 2, max: 2 } },
    sonnet: { capability: { low: 1, medium: 2, high: 2.5, xhigh: 2.5, max: 2.5 } },
    opus: { capability: { low: 2, medium: 2.5, high: 2.5, xhigh: 3, max: 3 } },
  };
  const h = harness(JEV_KEY);
  h.files.set(
    CONFIG,
    JSON.stringify({ routingEngine: 'shadow', models: capabilities, policy: { reviewEveryRequests: 0 } }),
  );
  answering(h, jevResponse('high', { high: 1 }, 0, { code: 1 }, 'produce'));
  await h.event('session.start', { cwd: '/fixture' });
  // The first turn runs Opus and fails; the hold is what the second turn's decision must see.
  await h.event('turn.start', { turnId: 't1', text: 'Synthetic task' });
  h.messages(async () => [user('Synthetic task')]);
  await drain(h.step({ ...step, turnId: 't1' }, { usage: undefined }));
  await h.event('classic.StopFailure', { hook_event_name: 'StopFailure', error: 'overloaded' });
  await h.event('turn.complete', { turnId: 't1' });
  await h.event('turn.start', { turnId: 't2', text: 'Synthetic task' });
  await drain(h.step({ ...step, turnId: 't2' }));
  await h.event('turn.complete', { turnId: 't2' });
  const record = h.preferences.get(`${TRACE_PREFIX}s1`);
  const turn2 = record.events
    .filter((event) => event.type === 'request' && event.turn === 2)
    .flatMap((event) => event.operations);
  assert.deepEqual(turn2[0].held, ['claude-opus-5-5']);
  const table = replayTable(record);
  assert.deepEqual(table.mismatches, []);
  const replayed = replayAuto(record, table.rows);
  assert.ok(replayed.length >= 2);
  assert.notEqual(replayed.at(-1).pair.model, 'claude-opus-5-5');
});

test('unexplained mismatch retains fidelity denominator and blocks ALL auto totals', async () => {
  const record = await capture();
  record.events.find((e) => e.type === 'request').model = 'wrong-model';
  const result = evaluateReplay([exportOf(record)]);
  assert.equal(result.status, 'blocked');
  assert.equal(result.fidelity.checkedSessions, 1);
  assert.ok(result.fidelity.mismatches.length > 0);
  assert.equal(result.sessions, undefined);
  assert.equal(result.exposureDiagnostic, undefined);
});

test('gap/lost-write exclusions are explained, caps preserve usable prefix and excluded counts', async () => {
  const record = await capture();
  const gap = structuredClone(record);
  gap.events[1].seq = 9;
  const lost = { ...record, lostWrites: 1 };
  const capped = { ...record, capped: { at: record.updatedAt, turns: 7, events: 28 } };
  const result = evaluateReplay([
    {
      version: 1,
      sessions: {
        [`${TRACE_PREFIX}gap`]: gap,
        [`${TRACE_PREFIX}lost`]: lost,
        [`${TRACE_PREFIX}capped`]: capped,
      },
    },
  ]);
  assert.equal(result.status, 'ok');
  assert.equal(result.coverage.exportCohort.sessions, 3);
  assert.equal(result.coverage.exportCohort.usableSessions, 1);
  assert.equal(result.coverage.explainedExclusions.gap, 1);
  assert.equal(result.coverage.explainedExclusions['lost-write'], 1);
  assert.deepEqual(result.coverage.capped, { turns: 7, events: 28 });
});

test('incremental exports merge monotonically and conflicts exclude, never double-count sessions', async () => {
  const record = await capture();
  const short = structuredClone(record);
  short.events = short.events.slice(0, 4);
  const clean = evaluateReplay([exportOf(short), exportOf(record)]);
  assert.equal(clean.coverage.exportCohort.sessions, 1);
  assert.equal(clean.coverage.exportCohort.usableTurns, 4);
  short.events[1].operations[0].advice.choice = 'high';
  const conflict = evaluateReplay([exportOf(short), exportOf(record)]);
  assert.equal(conflict.coverage.explainedExclusions.conflict, 1);
  assert.equal(conflict.fidelity.checkedSessions, 0);
});

test('older continuation evidence blocks auto without changing fidelity denominator', async () => {
  const record = await capture({ continuations: true });
  for (const event of record.events) for (const op of event.operations ?? []) delete op.actualHasImages;
  const result = evaluateReplay([exportOf(record)]);
  assert.equal(result.status, 'blocked');
  assert.equal(result.fidelity.passed, true);
  assert.equal(result.fidelity.checkedSessions, 1);
  assert.ok(result.autoInputIncomplete.length);
  assert.equal(result.sessions, undefined);
});

test('no evidence cannot establish exposure or coverage gates', () => {
  const result = evaluateReplay([]);
  assert.equal(result.coverage.exportCohort.usableSessionRatio, null);
  assert.equal(result.exposureDiagnostic.gate, 'not-established');
  assert.equal(result.exposureDiagnostic.completeSessions, 0);
});

test('input unchanged and auto does not consume recorded per-operation route/cache/dwell state', async () => {
  const record = await capture({ continuations: true });
  const before = structuredClone(record);
  const table = replayTable(record);
  const first = replayAuto(record, table.rows);
  for (const event of record.events)
    for (const op of event.operations ?? []) {
      if (op.facts) op.facts.downAllowed = !op.facts.downAllowed;
      if (op.expected) op.expected.model = 'recorded-route-is-not-a-seed';
    }
  const second = replayAuto(record, table.rows);
  assert.deepEqual(second, first);
  assert.equal(evaluateReplay([exportOf(before)]).status, 'ok');
  const snapshot = structuredClone(before);
  evaluateReplay([exportOf(before)]);
  assert.deepEqual(before, snapshot);
});

const eventsExport = (...events) => ({ version: 1, sessions: { s1: { events } } });
const REQUEST = { type: 'request', at: 1, turn: 't1', mode: 'auto', model: 'claude-haiku-5-5', messageCount: 1 };

for (const [name, value, message] of [
  ['no export', null, /expected version 1 sessions object/],
  ['an export with no version', {}, /expected version 1 sessions object/],
  ['sessions that are null', { version: 1, sessions: null }, /expected version 1 sessions object/],
  ['sessions that are a list', { version: 1, sessions: [] }, /expected version 1 sessions object/],
  ['a session with no events', { version: 1, sessions: { secret: {} } }, /expected events array/],
  ['an event with no timestamp', eventsExport({ type: 'end' }), /event timestamp required/],
  ['an event timestamp that is not finite', eventsExport({ type: 'end', at: Number.NaN }), /event timestamp required/],
  ['a request with no operations', eventsExport(REQUEST), /invalid request/],
  ['a request in an unknown mode', eventsExport({ ...REQUEST, operations: [], mode: 'cost' }), /invalid request/],
  ['a request with no model', eventsExport({ ...REQUEST, operations: [], model: undefined }), /invalid request/],
  [
    'a request with a fractional message count',
    eventsExport({ ...REQUEST, operations: [], messageCount: 1.5 }),
    /invalid request/,
  ],
  [
    'an operation of an unknown kind',
    eventsExport({ ...REQUEST, operations: [{ at: 1, kind: 'guess' }] }),
    /operation timestamp\/kind required/,
  ],
  [
    'an operation with no timestamp',
    eventsExport({ ...REQUEST, operations: [{ kind: 'choose' }] }),
    /operation timestamp\/kind required/,
  ],
  [
    'a negative token counter',
    eventsExport({ type: 'response', at: 1, usage: { input_tokens: -1 } }),
    /invalid token counter/,
  ],
  [
    'a token counter that is not a number',
    eventsExport({ type: 'response', at: 1, usage: { input_tokens: '9' } }),
    /invalid token counter/,
  ],
])
  test(`a replay of ${name} fails with a bounded structural error`, () => {
    assert.throws(
      () => evaluateReplay([value]),
      (error) => message.test(error.message) && /^Invalid replay input/.test(error.message),
    );
  });

test('a replay with a zero reversal window is refused', () => {
  assert.throws(() => evaluateReplay([], { reversalWindow: 0 }), /positive integer/);
});

const runCli = async (args) => {
  const out = [];
  const err = [];
  const status = await replayCli(args, { log: (text) => out.push(text), error: (text) => err.push(text) });
  return { status, stdout: out.join('\n'), stderr: err.join('\n') };
};

for (const [name, args, message] of [
  ['a missing input file', ['/private/CANARY.json'], /input 1/],
  ['a malformed input file', [fileURLToPath(import.meta.url)], /input 1/],
  ['no input files', [], /Provide all incremental trace export files/],
  ['an unknown option', ['--nope', FIXTURE], /Unknown option/],
])
  test(`CLI with ${name} fails without leaking paths`, async () => {
    const result = await runCli(args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, message);
    assert.equal(result.stderr.includes('CANARY'), false);
    assert.equal(result.stderr.includes(REPO), false);
    assert.equal(result.stdout, '');
  });

test('the CLI process exits 1 on a failing input and writes no stdout', () => {
  const cli = spawnSync(process.execPath, ['scripts/replay-traces.mjs', '/private/CANARY.json'], {
    cwd: REPO,
    encoding: 'utf8',
  });
  assert.equal(cli.status, 1);
  assert.equal(cli.stdout, '');
});

test('CLI --help prints usage and succeeds', async () => {
  const result = await runCli(['--help']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^Usage: /);
});

async function oneTurn(config = {}, response = null, continuationModel = null, messagesAfter = null, answer) {
  const h = shadowHarness(config, undefined, answer);
  await h.event('session.start', { cwd: '/fixture' });
  await h.event('turn.start', { turnId: 't1', text: 'Synthetic task' });
  h.messages(async () => [user('one')]);
  await drain(h.step(step, response));
  if (continuationModel || messagesAfter) {
    h.messages(async () => messagesAfter ?? [user('one')]);
    await drain(
      h.step({ ...step, index: 1, model: continuationModel ?? step.model, messageCount: messagesAfter?.length ?? 1 }),
    );
  }
  await h.event('turn.complete', { turnId: 't1' });
  return { h, record: h.preferences.get(`${TRACE_PREFIX}s1`) };
}

test('synthetic exported fixture and CLI retain recorded mode history', async () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/replay-traces.json', import.meta.url), 'utf8'));
  const result = evaluateReplay([fixture]);
  assert.equal(result.status, 'ok');
  assert.deepEqual(Object.keys(result.sessions[0].modes), ['balanced', 'quality']);
  assert.equal(result.sessions[0].modes.quality.table.switches.moves, 0);
  const inProcess = await runCli(['--reversal-window', '2', FIXTURE]);
  assert.equal(inProcess.status, 0, inProcess.stderr);
  assert.equal(JSON.parse(inProcess.stdout).reversalWindow, 2);
  const cli = spawnSync(process.execPath, ['scripts/replay-traces.mjs', '--reversal-window', '2', FIXTURE], {
    cwd: REPO,
    encoding: 'utf8',
  });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(cli.stdout, `${inProcess.stdout}\n`);
});

test('routed null-stop suspends faithfully, and genuine third-model fallback is frozen for auto', async () => {
  for (const [response, continuationModel] of [
    [{ stopReason: null }, step.model],
    [null, 'external-native-model'],
  ]) {
    const { record } = await oneTurn({}, response, continuationModel);
    const table = replayTable(record);
    assert.deepEqual(table.mismatches, []);
    assert.equal(table.rows[1].fallback, true);
    const auto = replayAuto(record, table.rows);
    assert.equal(auto[1].reason, 'native-fallback');
    assert.equal(auto[1].pair.model, continuationModel);
  }
});

test('table-model echoes do not suspend an independent auto incumbent', async () => {
  const { record } = await oneTurn({}, null, 'claude-sonnet-5-5');
  const table = replayTable(record);
  assert.deepEqual(table.mismatches, []);
  assert.equal(table.rows[1].fallback, false);
  const auto = replayAuto(record, table.rows);
  assert.notEqual(auto[0].pair.model, table.rows[0].pair.model);
  assert.equal(auto[1].pair.model, auto[0].pair.model);
  assert.notEqual(auto[1].reason, 'native-fallback');
});

test('missing usage and substituted models report unknown total rather than free requests', async () => {
  for (const response of [
    { usage: null },
    {
      usage: {
        model: 'unpriced-substitute',
        input_tokens: 100,
        cache_read_input_tokens: 800,
        cache_creation_input_tokens: 200,
        output_tokens: 10,
      },
    },
  ]) {
    const { record } = await oneTurn({}, response);
    const result = evaluateReplay([exportOf(record)]);
    assert.equal(result.status, 'ok');
    for (const engine of ['table', 'auto']) {
      const cost = result.sessions[0].modes.balanced[engine].conditionalCost;
      assert.equal(cost.minUsd, null);
      assert.equal(cost.maxUsd, null);
      assert.equal(cost.unpricedRequests, 1);
    }
  }
});

test('no-effort auto candidate stays null and unconditional continuation images force its refit', async () => {
  const image = {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 't',
        content: [{ type: 'image', source: { type: 'base64', data: 'synthetic' } }],
      },
    ],
  };
  const { record } = await oneTurn(
    {
      models: {
        tiny: {
          id: 'tiny-text-only',
          input: 0.01,
          cacheRead: 0.001,
          output: 0.01,
          billing: 'plan',
          strength: 0,
          contextWindow: 1000000,
          efforts: [],
          imageInput: false,
          capability: { default: 3 },
        },
      },
    },
    null,
    step.model,
    [user('one'), assistant('read', ['Read']), image],
    jevResponse('high', { high: 1 }, 0, { code: 1 }, 'produce'),
  );
  const table = replayTable(record);
  assert.deepEqual(table.mismatches, []);
  const op = record.events.find((e) => e.type === 'request' && e.index === 1).operations.at(-1);
  assert.equal(op.hasImages, false);
  assert.equal(op.actualHasImages, true);
  const auto = replayAuto(record, table.rows);
  assert.deepEqual(auto[0].pair, { model: 'tiny-text-only', effort: null });
  assert.notEqual(auto[1].pair.model, 'tiny-text-only');
  assert.equal(auto[1].reason, 'forced');
});

test('malformed shadow-only image projection never breaks a pinned table continuation', async () => {
  const h = harness(JEV_KEY);
  h.files.set(CONFIG, JSON.stringify({ routingEngine: 'shadow' }));
  await h.event('session.start', { cwd: '/fixture' });
  await h.event('command.run', { command: 'router', args: 'pin high' });
  await h.event('turn.start', { turnId: 't1', text: 'Synthetic task' });
  h.messages(async () => [user('one')]);
  await drain(h.step(step));
  h.messages(async () => [null]);
  await drain(h.step({ ...step, index: 1 }));
  await h.event('turn.complete', { turnId: 't1' });
  assert.equal(h.requests.length, 2);
  const record = h.preferences.get(`${TRACE_PREFIX}s1`);
  const result = evaluateReplay([exportOf(record)]);
  assert.equal(result.fidelity.passed, true);
  assert.ok(result.autoInputIncomplete.length);
});

test('compact activity evidence equals transcript bucket at every cursor', () => {
  const call = (name, input) => ({ role: 'assistant', content: [{ type: 'tool_use', id: 't', name, input }] });
  const fixtures = [
    [],
    [call('Read', {})],
    [call('Edit', { file_path: 'main.mjs' })],
    [call('Write', { file_path: 'docs/guide.md' })],
    [call('Bash', { command: 'echo text > out' })],
    [call('Bash', { command: 'npm test' })],
    [call('Bash', { command: 'mkdir build' })],
    [
      call('Read', {}),
      call('Edit', { file_path: 'docs/a.md' }),
      call('Bash', { command: 'npm test' }),
      call('Edit', { file_path: 'main.mjs' }),
      call('Read', {}),
    ],
  ];
  for (const messages of fixtures)
    for (let cursor = -1; cursor <= messages.length; cursor++) {
      const evidence = progressEvidence(messages);
      assert.equal(
        observedFromTrace(evidence, cursor),
        routingBucket(observedActivity(messages, cursor)),
        JSON.stringify({ cursor, evidence }),
      );
    }
});

test('rewind and mid-turn classifier reviews preserve sequential table fidelity', async () => {
  const h = harness(JEV_KEY);
  h.files.set(CONFIG, JSON.stringify({ routingEngine: 'shadow', policy: { reviewEveryRequests: 1 } }));
  answering(
    h,
    jevResponse('low', { low: 1 }, 0, { explore: 1 }, 'reason'),
    jevResponse('high', { high: 1 }, 1, { code: 1 }, 'produce'),
  );
  await h.event('session.start', { cwd: '/fixture' });
  await h.event('turn.start', { turnId: 't1', text: 'Synthetic task' });
  let messages = [user('one')];
  h.messages(async () => messages);
  await drain(h.step(step));
  messages = [user('one'), assistant('read', ['Read']), user('two')];
  await drain(h.step({ ...step, index: 1, messageCount: 3 }));
  await new Promise(setImmediate);
  await drain(h.step({ ...step, index: 2, messageCount: 3 }));
  await h.event('turn.complete', { turnId: 't1' });
  await h.event('turn.start', { turnId: 'rewound', text: 'Synthetic task' });
  messages = [user('one')];
  await drain(h.step({ ...step, turnId: 'rewound', messageCount: 1 }));
  await h.event('turn.complete', { turnId: 'rewound' });
  const record = h.preferences.get(`${TRACE_PREFIX}s1`);
  assert.ok(record.events.some((e) => e.type === 'reset' && e.cause === 'history'));
  assert.ok(
    record.events.some((e) => e.type === 'request' && e.index > 0 && e.operations.some((op) => op.kind === 'choose')),
  );
  const result = evaluateReplay([exportOf(record)]);
  assert.deepEqual(result.fidelity.mismatches, []);
  assert.equal(result.status, 'ok');
});

test('a pinned continuation enforces context and resumes the pre-pin route next turn', async () => {
  const h = harness(JEV_KEY);
  h.files.set(
    CONFIG,
    JSON.stringify({
      routingEngine: 'shadow',
      models: { haiku: { contextWindow: 200000, capability: { medium: 1 } } },
    }),
  );
  answering(h, jevResponse('low', { low: 1 }));
  await h.event('session.start', { cwd: '/fixture' });
  await h.event('command.run', { command: 'router', args: 'pin low' });
  await h.event('turn.start', { turnId: 't1', text: 'Synthetic task' });
  h.messages(async () => [user('one')]);
  await drain(h.step(step));
  h.usage({ startedAt: 0, context: { tokens: 250000, breakdown: { totalTokens: 250000 } }, rateLimits: [] });
  await drain(h.step({ ...step, index: 1 }));
  await h.event('turn.complete', { turnId: 't1' });
  const record = h.preferences.get(`${TRACE_PREFIX}s1`);
  const table = replayTable(record);
  assert.deepEqual(table.mismatches, []);
  const auto = replayAuto(record, table.rows);
  assert.notEqual(auto[1].pair.model, 'claude-haiku-5-5');
  assert.equal(auto[0].demand, 1);
  assert.equal(auto[1].demand, 1);
  h.usage({ startedAt: 0, context: { tokens: 8000, breakdown: { totalTokens: 8000 } }, rateLimits: [] });
  await h.event('turn.start', { turnId: 't2', text: 'Next task' });
  h.messages(async () => [user('one'), assistant('reply'), user('two')]);
  await drain(h.step({ ...step, turnId: 't2', messageCount: 3 }));
  await h.event('turn.complete', { turnId: 't2' });
  const full = h.preferences.get(`${TRACE_PREFIX}s1`);
  const resumed = replayAuto(full, replayTable(full).rows);
  assert.deepEqual(resumed[2].pair, { model: step.model, effort: step.effort });
});

test('numeric native effort prices its own warm effort-specific cache', async () => {
  const { record } = await oneTurn({ cache: { effortScope: 'separate' } }, null, step.model);
  const first = record.events.find((e) => e.type === 'request');
  for (const event of record.events) {
    if (event.type === 'request') {
      event.engineEffort = 1024;
      event.effort = 1024;
    }
    if (event.type === 'response') event.effort = 1024;
    for (const op of event.operations ?? []) {
      if (op.facts) op.facts.effort = 1024;
      op.effort = 1024;
    }
  }
  // Auto alone consumes external numeric effort; recorded expected table decisions are not replay seeds.
  const table = replayTable(record);
  const rows = replayAuto(record, table.rows);
  assert.equal(rows[0].pair.effort, 1024);
  assert.equal(rows[1].pair.effort, 1024);
  assert.ok(rows[1].cost.maxUsd < rows[0].cost.maxUsd);
  assert.equal(first.engineEffort, 1024);
});

test('bounded execute removal uses own activity evidence and reports effective demand without extra votes', async () => {
  const h = harness(JEV_KEY);
  h.files.set(CONFIG, JSON.stringify({ routingEngine: 'shadow', policy: { reviewEveryRequests: 0 } }));
  answering(h, jevResponse('medium', { medium: 1 }, 0, { code: 1 }, 'execute'));
  await h.event('session.start', { cwd: '/fixture' });
  await h.event('turn.start', { turnId: 't1', text: 'Synthetic task' });
  h.messages(async () => [user('one')]);
  await drain(h.step(step));
  h.messages(async () => [
    user('one'),
    { role: 'assistant', content: [{ type: 'tool_use', id: 'e', name: 'Edit', input: { file_path: 'main.mjs' } }] },
    user('two'),
  ]);
  await drain(h.step({ ...step, index: 1, messageCount: 3 }));
  await h.event('turn.complete', { turnId: 't1' });
  const record = h.preferences.get(`${TRACE_PREFIX}s1`);
  const table = replayTable(record);
  assert.deepEqual(table.mismatches, []);
  const rows = replayAuto(record, table.rows);
  assert.equal(rows[0].demand, 1.5);
  assert.equal(rows[1].demand, 2);
  assert.equal(rows[1].activity, 'code');
});

test('checkpoint after an auto-only switch releases own pending downgrade on a continuation', async () => {
  const h = harness(JEV_KEY);
  h.files.set(
    CONFIG,
    JSON.stringify({
      routingEngine: 'shadow',
      cache: { effortScope: 'separate' },
      policy: { reviewEveryRequests: 1, minDwellRequests: 1, downgradeVotes: 1 },
      models: {
        tiny: {
          id: 'synthetic-tiny',
          input: 0.01,
          cacheRead: 0.001,
          output: 0.01,
          billing: 'plan',
          contextWindow: 1000000,
          efforts: ['high'],
          capability: { high: 2 },
        },
        cheap: {
          id: 'synthetic-cheap',
          input: 0.001,
          cacheRead: 0.0001,
          output: 0.001,
          billing: 'plan',
          contextWindow: 1000000,
          efforts: ['medium'],
          capability: { medium: 1 },
        },
      },
    }),
  );
  answering(
    h,
    jevResponse('medium', { medium: 1 }, 0, { code: 1 }, 'produce'),
    jevResponse('low', { low: 1 }, 1, { code: 1 }, 'produce'),
  );
  await h.event('session.start', { cwd: '/fixture' });
  await h.event('turn.start', { turnId: 't1', text: 'Synthetic task' });
  let messages = [user('one')];
  h.messages(async () => messages);
  await drain(h.step(step));
  await drain(h.step({ ...step, index: 1 }));
  await new Promise(setImmediate);
  await drain(h.step({ ...step, index: 2 }));
  messages = [
    user('one'),
    { role: 'assistant', content: [{ type: 'tool_use', id: 'check', name: 'Bash', input: { command: 'npm test' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'check', content: 'passed', is_error: false }] },
  ];
  await drain(h.step({ ...step, index: 3, messageCount: 3 }));
  await h.event('turn.complete', { turnId: 't1' });
  const record = h.preferences.get(`${TRACE_PREFIX}s1`);
  const table = replayTable(record);
  assert.deepEqual(table.mismatches, []);
  const rows = replayAuto(record, table.rows);
  assert.deepEqual(rows[0].pair, { model: 'synthetic-tiny', effort: 'high' });
  assert.equal(rows[2].reason, 'downgrade-held');
  assert.deepEqual(rows[3].pair, { model: 'synthetic-cheap', effort: 'medium' });
  assert.equal(rows[3].reason, 'downgrade');
  assert.equal(evaluateReplay([exportOf(record)]).status, 'ok');
});

test('cross-mode reversals are recognized before partitioning and attributed to destination mode', async () => {
  const h = harness(JEV_KEY);
  h.files.set(
    CONFIG,
    JSON.stringify({
      routingEngine: 'shadow',
      mode: 'cost',
      policy: { reviewEveryRequests: 0 },
      modes: { cost: { policy: { minDwellRequests: 1 } }, quality: { policy: { minDwellRequests: 1 } } },
    }),
  );
  answering(h, jevResponse('low', { low: 1 }, 0, { code: 1 }, 'produce'));
  await h.event('session.start', { cwd: '/fixture' });
  for (let i = 0; i < 3; i++) {
    if (i) await h.event('command.run', { command: 'router', args: i === 1 ? 'mode quality' : 'mode cost' });
    const turnId = `t${i}`;
    await h.event('turn.start', { turnId, text: 'Synthetic task' });
    h.messages(async () =>
      Array.from({ length: i * 2 }, (_, j) => (j % 2 ? assistant('reply') : user('task'))).concat(user('next')),
    );
    await drain(h.step({ ...step, turnId, messageCount: i * 2 + 1 }));
    await h.event('turn.complete', { turnId });
  }
  const record = h.preferences.get(`${TRACE_PREFIX}s1`);
  const within = evaluateReplay([exportOf(record)], { reversalWindow: 1 });
  const modes = within.sessions[0].modes;
  assert.equal(modes.cost.table.switches.reversals, 1);
  assert.equal(modes.quality.table.switches.reversals, 0);
  assert.equal(modes.cost.table.switches.oneWay, 0);
  assert.equal(modes.quality.table.switches.oneWay, 0);
  assert.equal(modes.cost.table.switches.per100Turns, 50);
});

test('missing choose checkpoint and raw booleans block auto only after successful fidelity', async () => {
  for (const corrupt of [
    (op) => {
      op.taskProgress = null;
    },
    (op) => {
      delete op.facts.hasImages;
    },
    (op) => {
      delete op.contextKnown;
    },
  ]) {
    const { record } = await oneTurn();
    corrupt(record.events.find((event) => event.type === 'request').operations[0]);
    const result = evaluateReplay([exportOf(record)]);
    assert.equal(result.fidelity.passed, true);
    assert.equal(result.fidelity.checkedSessions, 1);
    assert.equal(result.status, 'blocked');
    assert.equal(result.sessions, undefined);
    assert.equal(result.autoInputIncomplete[0].reason, 'auto-input-incomplete');
  }
});

test('manual-only captured traffic is not engine exposure', async () => {
  const h = harness(JEV_KEY);
  h.files.set(CONFIG, JSON.stringify({ routingEngine: 'shadow' }));
  await h.event('session.start', { cwd: '/fixture' });
  await h.event('command.run', { command: 'router', args: 'off' });
  await h.event('turn.start', { turnId: 't1', text: 'Synthetic task' });
  await drain(h.step(step));
  await h.event('turn.complete', { turnId: 't1' });
  const result = evaluateReplay([exportOf(h.preferences.get(`${TRACE_PREFIX}s1`))]);
  assert.equal(result.status, 'ok');
  assert.equal(result.exposureDiagnostic.capturedMainTurns, 1);
  assert.equal(result.exposureDiagnostic.eligibleRoutedTurns, 0);
  assert.equal(result.exposureDiagnostic.completeSessions, 0);
  assert.equal(result.exposureDiagnostic.gate, 'not-established');
});

test('repeated failure captured at its occurrence raises independent demand once', async () => {
  const h = harness(JEV_KEY);
  h.files.set(CONFIG, JSON.stringify({ routingEngine: 'shadow', policy: { reviewEveryRequests: 0 } }));
  answering(h, jevResponse('low', { low: 1 }, 1, { code: 1 }, 'produce'));
  await h.event('session.start', { cwd: '/fixture' });
  await h.event('turn.start', { turnId: 't1', text: 'Synthetic task' });
  let messages = [user('one')];
  h.messages(async () => messages);
  await drain(h.step(step));
  await h.event('turn.complete', { turnId: 't1' });
  const call = (name) => ({ role: 'assistant', content: [{ type: 'tool_use', id: 't', name, input: {} }] });
  const error = {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 't', is_error: true, content: 'Synthetic test failure' }],
  };
  const ok = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', is_error: false, content: 'ok' }] };
  messages = [user('one'), call('Bash'), error, call('Edit'), ok, call('Bash'), error, user('fix')];
  await h.event('turn.start', { turnId: 't2', text: 'Synthetic fix' });
  await drain(h.step({ ...step, turnId: 't2', messageCount: messages.length }));
  await drain(h.step({ ...step, turnId: 't2', index: 1, messageCount: messages.length }));
  await h.event('turn.complete', { turnId: 't2' });
  const record = h.preferences.get(`${TRACE_PREFIX}s1`);
  const table = replayTable(record);
  assert.deepEqual(table.mismatches, []);
  const rows = replayAuto(record, table.rows);
  assert.equal(rows[0].demand, 1);
  assert.equal(rows[1].demand, 2);
  assert.equal(rows[2].demand, 2);
  assert.equal(evaluateReplay([exportOf(record)]).status, 'ok');
});

test('manual interval breaks reversal pairing without losing either policy move', async () => {
  const h = harness(JEV_KEY);
  h.files.set(
    CONFIG,
    JSON.stringify({
      routingEngine: 'shadow',
      mode: 'cost',
      policy: { reviewEveryRequests: 0 },
      modes: { cost: { policy: { minDwellRequests: 1 } }, quality: { policy: { minDwellRequests: 1 } } },
    }),
  );
  answering(h, jevResponse('low', { low: 1 }, 0, { code: 1 }, 'produce'));
  await h.event('session.start', { cwd: '/fixture' });
  for (let i = 0; i < 5; i++) {
    if (i === 1) await h.event('command.run', { command: 'router', args: 'mode quality' });
    if (i === 2) await h.event('command.run', { command: 'router', args: 'off' });
    if (i === 3) await h.event('command.run', { command: 'router', args: 'auto' });
    if (i === 4) await h.event('command.run', { command: 'router', args: 'mode cost' });
    const turnId = `t${i}`;
    await h.event('turn.start', { turnId, text: 'Synthetic task' });
    h.messages(async () =>
      Array.from({ length: i * 2 }, (_, j) => (j % 2 ? assistant('reply') : user('task'))).concat(user('next')),
    );
    await drain(h.step({ ...step, turnId, messageCount: i * 2 + 1 }));
    await h.event('turn.complete', { turnId });
  }
  const result = evaluateReplay([exportOf(h.preferences.get(`${TRACE_PREFIX}s1`))], { reversalWindow: 10 });
  const modes = result.sessions[0].modes;
  assert.equal(modes.cost.table.switches.reversals + modes.quality.table.switches.reversals, 0);
  assert.equal(modes.cost.table.switches.moves + modes.quality.table.switches.moves, 2);
  assert.equal(modes.cost.table.switches.oneWay + modes.quality.table.switches.oneWay, 2);
});
