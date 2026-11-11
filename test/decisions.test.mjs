import assert from 'node:assert/strict';
import test from 'node:test';
import { lateralMove } from '../lib/activity.mjs';
import { loadConfig } from '../lib/config.mjs';
import * as costs from '../lib/cost.mjs';
import {
  addTurnRow,
  appendDecisions,
  DECISIONS_PREFIX,
  decisionLines,
  decisionRow,
  decisionsAfterReset,
  emptyDecisions,
  endRow,
  isGoalOrigin,
  isProgressOrigin,
  MAX_ROWS,
  MAX_TURN_ROWS,
  originKind,
  progressInput,
  prunedDecisions,
  QUEUE_MAX,
  QUEUE_MS,
  queueOrigin,
  RETAIN_MS,
  readDecisions,
  takeOrigin,
} from '../lib/decisions.mjs';
import { decide, initialState } from '../lib/policy.mjs';
import { served, advice as tierAdvice } from './helpers.mjs';

const T = Date.parse('2026-10-27T10:00:00Z');
const decision = {
  tier: 'high',
  activity: 'code',
  reason: 'upgrade',
  model: 'claude-opus-5-5',
  effort: 'medium',
  lateral: null,
  pinned: false,
};
const advice = {
  choice: 'high',
  probabilities: { high: 0.904, medium: 0.096 },
  continuation: 0.951,
  activity: { choice: 'code', probabilities: { code: 0.8 } },
};

test('originKind reads the engine stamp and names anything else unknown', () => {
  for (const [origin, expected] of [
    [{ kind: 'composer' }, 'composer'],
    [{ kind: 'task-notification' }, 'task-notification'],
    [{ kind: 'channel', server: 'slack' }, 'channel'],
    [{ kind: 'a-future-kind' }, 'a-future-kind'],
    [{ kind: 'Not A Kind' }, 'unknown'],
    [{ kind: 'x'.repeat(41) }, 'unknown'],
    [{}, 'unknown'],
    [null, 'unknown'],
    [undefined, 'unknown'],
  ])
    assert.equal(originKind(origin), expected, JSON.stringify(origin));
});

test('progress origins report on the running work; goal origins may start a task; the rest are neither', () => {
  for (const kind of ['task-notification', 'observer', 'observer-activity', 'auto-continuation']) {
    assert.ok(isProgressOrigin(kind), kind);
    assert.ok(!isGoalOrigin(kind), kind);
  }
  for (const kind of [
    'composer',
    'bridge',
    'sdk',
    'peer',
    'peer-send-message',
    'plugin',
    'scheduled-trigger',
    'channel',
  ]) {
    assert.ok(isGoalOrigin(kind), kind);
    assert.ok(!isProgressOrigin(kind), kind);
  }
  for (const kind of ['unclassified', 'unknown', 'a-future-kind']) {
    assert.ok(!isGoalOrigin(kind) && !isProgressOrigin(kind), kind);
  }
});

test('a queued submission names the turn that starts with its text, once, oldest first', () => {
  let queue = [];
  queue = queueOrigin(queue, { kind: 'task-notification', text: 'done', at: T });
  queue = queueOrigin(queue, { kind: 'composer', text: 'next', at: T + 1 });
  queue = queueOrigin(queue, { kind: 'peer', text: 'done', at: T + 2 });
  let taken = takeOrigin(queue, '  done ', T + 3);
  assert.equal(taken.kind, 'task-notification');
  taken = takeOrigin(taken.queue, 'done', T + 4);
  assert.equal(taken.kind, 'peer');
  taken = takeOrigin(taken.queue, 'done', T + 5);
  assert.equal(taken.kind, 'unknown');
  assert.deepEqual(
    taken.queue.map((e) => e.kind),
    ['composer'],
  );
});

test('the queue drops expired submissions and keeps at most its bound', () => {
  let queue = queueOrigin([], { kind: 'composer', text: 'old', at: T });
  assert.equal(takeOrigin(queue, 'old', T + QUEUE_MS).kind, 'unknown');
  for (let i = 0; i < QUEUE_MAX + 5; i += 1) queue = queueOrigin(queue, { kind: 'composer', text: `p${i}`, at: T + i });
  assert.equal(queue.length, QUEUE_MAX);
  assert.equal(queue[0].text, 'p5');
});

test('a decision row keeps labels, rounded shares and counts, never text', () => {
  const row = decisionRow({
    at: T,
    kind: 'start',
    origin: 'composer',
    mode: 'cost',
    advice,
    decision,
    facts: { downAllowed: true, contextTokens: 254_321 },
    sameTask: false,
  });
  assert.deepEqual(row, {
    at: T,
    kind: 'start',
    origin: 'composer',
    mode: 'cost',
    cls: 'high',
    p: 0.9,
    cont: 0.95,
    act: 'code',
    actP: 0.8,
    err: null,
    tier: 'high',
    activity: 'code',
    reason: 'upgrade',
    route: 'claude-opus-5-5@medium',
    lateral: null,
    pinned: false,
    same: false,
    down: true,
    ctx: 254,
  });
  const bare = decisionRow({
    at: T,
    kind: 'start',
    error: 'timeout',
    decision: { ...decision, effort: null, activity: null },
  });
  assert.equal(bare.cls, null);
  assert.equal(bare.err, 'timeout');
  assert.equal(bare.route, 'claude-opus-5-5@session');
  assert.equal(bare.same, null);
  assert.equal(bare.ctx, null);
});

test('a row of a weighed move keeps the mass compared and the bar it had to clear', () => {
  const config = loadConfig({});
  const facts = (lastRoute) => ({ lastRoute, ...served('claude-sonnet-5-5', { at: T }) });
  const tierStep = (lastRoute, answer) =>
    decide({
      config,
      facts: facts(lastRoute),
      advice: answer,
      state: initialState(),
      baseline: 'low',
      now: T + 10_000,
    });
  const lateral = lateralMove({
    config,
    from: { model: 'haiku', effort: 'high' },
    to: { model: 'sonnet', effort: 'medium' },
    mass: 0.7,
    hold: false,
    facts: facts('low'),
    now: T + 10_000,
    costs,
  });
  for (const [reason, step, mass] of [
    ['upgrade-pending', tierStep('low', tierAdvice('medium', { medium: 0.62, low: 0.38 })), 0.62],
    ['downgrade-pending', tierStep('high', tierAdvice('low', { low: 0.454, high: 0.546 })), 0.45],
    ['activity-pending', lateral, 0.7],
  ]) {
    assert.equal(step.reason, reason);
    const row = decisionRow({ at: T, kind: 'review', decision: { ...decision, ...step } });
    assert.equal(row.mass, mass, reason);
    assert.equal(row.bar, Math.round(step.estimate.threshold * 100) / 100, reason);
    assert.ok(row.bar > row.mass, reason);
  }
});

test('a row keeps a mass and a bar only when its reason compared that mass with that bar', () => {
  const full = { upgradeMass: 0.62, threshold: 0.79 };
  for (const [name, kind, reason, estimate, expected] of [
    ['no estimate', 'start', 'upgrade-pending', undefined, null],
    ['a null estimate', 'start', 'upgrade-pending', null, null],
    ['a cheaper route held by its cache write', 'review', 'activity-pending', { taxUsd: 0.2 }, null],
    ['a cash gate', 'start', 'cash-gate', { coldUsd: 3, cap: 1 }, null],
    ['a mass without a bar', 'start', 'upgrade-pending', { upgradeMass: 0.6 }, null],
    ['a bar without a mass', 'start', 'upgrade-pending', { threshold: 0.8 }, null],
    ['a mass that is no number', 'start', 'upgrade-pending', { upgradeMass: Number.NaN, threshold: 0.8 }, null],
    ['a mass of zero', 'review', 'activity-pending', { upgradeMass: 0, threshold: 0.8 }, [0, 0.8]],
    [
      'a move down that waits for its checkpoint',
      'review',
      'downgrade-held',
      { downgradeMass: 0.97, threshold: 0.9 },
      [0.97, 0.9],
    ],
    ['a taken move', 'start', 'upgrade', full, [0.62, 0.79]],
    ['a jump, weighed against jumpConfidence', 'start', 'jump', full, null],
    ['a context override over a pending move', 'start', 'context-fit', full, null],
    ['an unmeasured context', 'start', 'context-unknown', full, null],
    ['a full context', 'start', 'context-full', full, null],
    ['a model that cannot run', 'start', 'model-unavailable', full, null],
    ['a move on the turn’s tools', 'observed', 'activity-up', { upgradeMass: 1, threshold: 0.79 }, null],
  ]) {
    const row = decisionRow({ at: T, kind, decision: { ...decision, reason, estimate } });
    assert.deepEqual('mass' in row || 'bar' in row ? [row.mass, row.bar] : null, expected, name);
  }
});

test('an end row keeps the turn bucket, request counts and only positive unpriced causes', () => {
  assert.deepEqual(
    endRow({ at: T, observed: 'shell', requests: 9, priced: 7, unpriced: { ttl: 2, model: 0, bad: -1 } }),
    {
      at: T,
      kind: 'end',
      observed: 'shell',
      requests: 9,
      priced: 7,
      unpriced: { ttl: 2 },
    },
  );
  assert.deepEqual(endRow({ at: T }), { at: T, kind: 'end', observed: null, requests: 0, priced: 0, unpriced: {} });
});

test('readDecisions keeps the rows that read and drops the rest', () => {
  const good = decisionRow({ at: T, kind: 'review', advice, decision });
  const weighed = { ...good, reason: 'upgrade-pending', mass: 0.52, bar: 0.79 };
  const end = endRow({ at: T + 1, observed: 'code', requests: 2, priced: 2 });
  const value = {
    version: 1,
    since: T,
    rows: [
      good,
      end,
      { at: 'x', kind: 'start' },
      { at: T, kind: 'bogus' },
      null,
      { ...good, tier: 7, extra: 'kept out' },
      weighed,
      { ...weighed, mass: '0.52', bar: null },
    ],
  };
  const read = readDecisions(value);
  assert.equal(read.rows.length, 5);
  assert.deepEqual(read.rows[0], good, 'a row saved before mass and bar existed');
  assert.deepEqual(read.rows[1], end);
  assert.ok(!('tier' in read.rows[2]) && !('extra' in read.rows[2]));
  assert.deepEqual(read.rows[3], weighed);
  assert.ok(!('mass' in read.rows[4]) && !('bar' in read.rows[4]));
  for (const bad of [
    null,
    [],
    { version: 2, since: T, rows: [] },
    { version: 1, since: 'x', rows: [] },
    { version: 1, since: T },
  ])
    assert.deepEqual(readDecisions(bad), emptyDecisions(), JSON.stringify(bad));
});

test('appending keeps the newest rows up to the bound and sets since once', () => {
  let record = emptyDecisions();
  assert.equal(appendDecisions(record, [], T), record);
  for (let i = 0; i < MAX_ROWS + 7; i += 1) record = appendDecisions(record, [endRow({ at: T + i })], T + i);
  assert.equal(record.rows.length, MAX_ROWS);
  assert.equal(record.rows[0].at, T + 7);
  assert.equal(record.since, T);
  assert.deepEqual(readDecisions(record), record);
  assert.deepEqual(decisionsAfterReset(record, T + 1), emptyDecisions());
  assert.equal(decisionsAfterReset(record, T), record);
});

test('pruning lets go of expired records and the oldest past the bound, never one that does not read', () => {
  const at = (last) => ({ version: 1, since: last - 10, rows: [endRow({ at: last })] });
  const now = T + RETAIN_MS + 100;
  const entries = [
    [`${DECISIONS_PREFIX}old`, at(T)],
    [`${DECISIONS_PREFIX}a`, at(now - 3)],
    [`${DECISIONS_PREFIX}b`, at(now - 2)],
    [`${DECISIONS_PREFIX}c`, at(now - 1)],
    [`${DECISIONS_PREFIX}future`, { version: 2, rows: [] }],
    [`${DECISIONS_PREFIX}junk`, 'text'],
  ];
  assert.deepEqual([...prunedDecisions(entries, now, 2)].sort(), [`${DECISIONS_PREFIX}a`, `${DECISIONS_PREFIX}old`]);
  assert.deepEqual([...prunedDecisions(entries, now)], [`${DECISIONS_PREFIX}old`]);
});

test('a turn keeps its start row and its newest others', () => {
  let rows = [];
  for (let i = 0; i < MAX_TURN_ROWS + 5; i += 1) rows = addTurnRow(rows, endRow({ at: T + i }));
  assert.equal(rows.length, MAX_TURN_ROWS);
  assert.equal(rows[0].at, T);
  assert.equal(rows[1].at, T + 6);
  assert.equal(rows.at(-1).at, T + MAX_TURN_ROWS + 4);
});

test('a progress turn asks about the active goal, with the report as the newest dialogue line', () => {
  const turns = [
    { role: 'user', text: 'a' },
    { role: 'assistant', text: 'b' },
  ];
  assert.deepEqual(progressInput({ prompt: 'note', turns }, { goal: 'fix the build', note: 'note' }, 6), {
    prompt: 'fix the build',
    turns: [...turns, { role: 'user', text: 'note' }],
  });
  assert.deepEqual(progressInput({ prompt: 'note', turns }, { goal: 'fix the build', note: 'note' }, 2).turns, [
    { role: 'assistant', text: 'b' },
    { role: 'user', text: 'note' },
  ]);
  assert.deepEqual(progressInput({ prompt: 'note', turns }, { goal: null, note: 'note' }, 6), {
    prompt: 'note',
    turns,
  });
  assert.deepEqual(progressInput({ prompt: 'p', turns }, { goal: 'g', note: null }, 6), { prompt: 'p', turns });
});

test('decision lines read as one routing step each, oldest first', () => {
  const rows = [
    decisionRow({ at: T, kind: 'start', origin: 'task-notification', advice, decision, sameTask: true }),
    decisionRow({ at: T + 1000, kind: 'review', error: 'timeout', decision: { ...decision, reason: 'no-advice' } }),
    endRow({ at: T + 2000, observed: 'code', requests: 1, priced: 0, unpriced: { ttl: 1 } }),
    { ...decisionRow({ at: T + 3000, kind: 'review', decision }), reason: 'upgrade-pending', mass: 0.52, bar: 0.79 },
    { ...decisionRow({ at: T + 4000, kind: 'review', decision }), mass: 0.52 },
  ];
  const lines = decisionLines(rows);
  assert.equal(lines.length, 5);
  assert.match(lines[3], / {2}\(upgrade-pending 52% vs bar 79%\)$/);
  assert.match(lines[4], / {2}\(upgrade\)$/);
  assert.match(
    lines[0],
    /start {5}task-notification {2}asked high 90% code 80% {2}same task {2}-> high code claude-opus-5-5@medium {2}\(upgrade\)$/,
  );
  assert.match(lines[1], /review {4}unknown {2}asked timeout {2}-> high code claude-opus-5-5@medium {2}\(no-advice\)$/);
  assert.match(lines[2], /end {7}tools code {2}1 request {2}0 priced {2}unpriced ttl 1$/);
  assert.equal(decisionLines(rows, 1).length, 1);
  assert.deepEqual(decisionLines([]), ['No routing decisions recorded in this session yet.']);
});
