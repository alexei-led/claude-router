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
  failureRow,
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

test('table rows omit engine, while shadow and legacy table rows remain readable', () => {
  const table = decisionRow({ at: T, kind: 'start', decision, engine: 'table' });
  const shadow = decisionRow({ at: T, kind: 'start', decision, engine: 'shadow' });
  assert.equal(Object.hasOwn(table, 'engine'), false);
  assert.equal(shadow.engine, 'shadow');
  const rows = readDecisions({ version: 1, since: T, rows: [table, { ...table, engine: 'table' }, shadow] }).rows;
  assert.equal(Object.hasOwn(rows[0], 'engine'), false);
  assert.equal(rows[1].engine, 'table');
  assert.equal(rows[2].engine, 'shadow');
});

test('shadow proposals roundtrip only numeric facts and bounded identifiers, in live and stored lines', () => {
  const alt = {
    demand: 2.5,
    reason: 'classifier',
    headroom: false,
    requirement: 3,
    outcome: 'unknown-only',
    route: 'sonnet@high',
    capability: null,
    minUsd: 0.04321,
    maxUsd: 0.12345,
    prompt: 'secret prompt',
    tools: 'secret tools',
    path: '/private/project',
  };
  const row = decisionRow({ at: T, kind: 'start', decision, engine: 'shadow', alt });
  assert.equal(row.engine, 'shadow');
  assert.deepEqual(row.alt, {
    demand: 2.5,
    reason: 'classifier',
    headroom: false,
    targetReason: null,
    requirement: 3,
    outcome: 'unknown-only',
    route: 'sonnet@high',
    capability: null,
    minUsd: 0.04321,
    maxUsd: 0.12345,
  });
  const stored = readDecisions({ version: 1, since: T, rows: [{ ...row, alt }] }).rows[0];
  assert.deepEqual(stored, row);
  for (const candidate of [row, stored]) {
    const line = decisionLines([candidate])[0];
    assert.match(line, /shadow demand 2.5.*target sonnet@high.*unknown.*next-turn estimate/);
    assert.doesNotMatch(JSON.stringify(candidate), /secret|private/);
  }
});

test('a cash-capped outcome survives storage and is listed for shadow and auto rows', () => {
  const proposal = { demand: 3, outcome: 'cash-capped', route: 'sonnet@max', capability: 2 };
  for (const row of [
    decisionRow({ at: T, kind: 'start', decision, engine: 'shadow', alt: proposal }),
    decisionRow({ at: T, kind: 'start', decision: { ...decision, auto: proposal }, engine: 'auto' }),
  ]) {
    const [stored] = readDecisions({ version: 1, since: T, rows: [row] }).rows;
    assert.deepEqual(stored, row);
    assert.match(decisionLines([stored])[0] ?? '', /; cash-capped/);
  }
});

test('malformed shadow fields cannot retain arbitrary text on read or write', () => {
  const alt = {
    demand: 4,
    requirement: NaN,
    reason: 'secret prompt',
    outcome: 'secret tools',
    route: '/private/project@high',
    capability: -1,
    headroom: 'yes',
    minUsd: -1,
    maxUsd: Infinity,
  };
  const row = decisionRow({ at: T, kind: 'review', decision, engine: 'shadow', alt });
  assert.deepEqual(row.alt, {
    demand: null,
    reason: null,
    headroom: false,
    targetReason: null,
    requirement: null,
    outcome: null,
    route: null,
    capability: null,
    minUsd: null,
    maxUsd: null,
  });
  assert.deepEqual(readDecisions({ version: 1, since: T, rows: [{ ...row, alt }] }).rows[0], row);
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

test('a same-task move to a model cheaper per turn waits for the checkpoint even at a higher input price', () => {
  const model = (id, input, cacheRead, strength) => ({
    id,
    input,
    cacheRead,
    strength,
    contextWindow: 1_000_000,
    billing: 'credits',
    efforts: ['low', 'high'],
  });
  const config = loadConfig({
    userFile: {
      models: {
        dear: model('dear-cache', 0.12, 0.0232, 2),
        cheap: model('cheap-cache', 0.255, 0.0051, 3),
        cheapInput: model('cheap-input', 0.1, 0.05, 4),
      },
    },
  });
  const move = (from, to) =>
    lateralMove({
      config,
      from: { model: from, effort: 'high' },
      to: { model: to, effort: 'high' },
      mass: 1,
      hold: false,
      sameTask: true,
      facts: { ...served('dear-cache', { at: T }), lastRoute: 'low', downAllowed: false },
      now: T + 10_000,
      costs,
    });
  assert.equal(move('dear', 'cheap').reason, 'downgrade-held');
  assert.notEqual(move('dear', 'cheapInput').reason, 'downgrade-held');
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

const review = (at, overrides = {}, decisionOverrides = {}) =>
  decisionRow({
    at,
    kind: 'review',
    advice: { ...advice, choice: 'medium', probabilities: { medium: overrides.p ?? 0.6 } },
    decision: {
      ...decision,
      reason: 'downgrade-pending',
      estimate: { downgradeMass: overrides.mass ?? 0.6, threshold: 0.95 },
      ...decisionOverrides,
    },
  });

test('a review that changes nothing joins the one before it: its count, its last time and its best support', () => {
  let rows = [decisionRow({ at: T, kind: 'start', advice, decision })];
  for (const [i, mass] of [0.63, 0.75, 0.7].entries()) rows = addTurnRow(rows, review(T + 1000 * (i + 1), { mass }));
  assert.equal(rows.length, 2);
  assert.deepEqual([rows[1].at, rows[1].last, rows[1].n, rows[1].mass], [T + 1000, T + 3000, 3, 0.75]);
  assert.deepEqual(readDecisions({ version: 1, since: T, rows }).rows[1], rows[1]);
  assert.match(decisionLines(rows)[1], /3 checks until \d\d:\d\d:\d\d/);
});

test('a long turn drops the reviews that changed nothing before the one that moved the route', () => {
  let rows = [decisionRow({ at: T, kind: 'start', advice, decision: { ...decision, effort: 'high' } })];
  rows = addTurnRow(rows, review(T + 1, {}, { reason: 'upgrade', effort: 'xhigh' }));
  for (let i = 0; i < MAX_TURN_ROWS + 5; i += 1)
    rows = addTurnRow(
      rows,
      review(T + 10 + i, { mass: 0.6 }, { reason: i % 2 ? 'downgrade-pending' : 'hold', effort: 'xhigh' }),
    );
  assert.equal(rows.length, MAX_TURN_ROWS);
  assert.deepEqual(
    rows.slice(0, 2).map((row) => [row.at, row.reason, row.route]),
    [
      [T, 'upgrade', 'claude-opus-5-5@high'],
      [T + 1, 'upgrade', 'claude-opus-5-5@xhigh'],
    ],
  );
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

const BARE = { at: T, kind: 'start', tier: 'low', route: 'claude-haiku-5-5@high', reason: 'hold' };
const lineOf = (row) => decisionLines([row])[0].replace(/^\d\d:\d\d:\d\d {2}/, '');

for (const [name, row, expected] of [
  [
    'a row with no answer and no error',
    BARE,
    /^start {5}unknown {2}asked no answer {2}-> low claude-haiku-5-5@high {2}\(hold\)$/,
  ],
  ['a new task', { ...BARE, same: false }, / {2}new task {2}-> low /],
  ['a pinned turn', { ...BARE, pinned: true }, /\(hold\) {2}pinned$/],
  [
    'a goal phase with its share',
    { ...BARE, cls: 'low', p: 0.9, act: 'code', actP: 0.5, phase: 'produce', phaseP: 0.7 },
    /asked low 90% goal code 50% {2}phase produce 70% /,
  ],
  ['a row with no tier', { ...BARE, tier: undefined, route: undefined, reason: undefined }, /-> - {2}\(\?\)$/],
  [
    'an automatic move with no cost bound',
    {
      ...BARE,
      engine: 'auto',
      auto: {
        demand: 'high',
        route: 'claude-opus-5-5@high',
        capability: 7,
        outcome: 'moved',
        move: 'up',
        minUsd: null,
        maxUsd: null,
      },
    },
    /demand high → target claude-opus-5-5@high cap 7; moved; move up; next-turn estimate unknown$/,
  ],
  [
    'an automatic move with a cost range',
    { ...BARE, engine: 'auto', auto: { demand: 'low', outcome: 'held', move: 'none', minUsd: 0.5, maxUsd: 1.25 } },
    /demand low → target none cap unknown; held; move none; next-turn estimate \$0\.5000–\$1\.2500$/,
  ],
  [
    'an end row of several requests',
    { at: T, kind: 'end', requests: 3, priced: 2 },
    /^end {7}tools \? {2}3 requests {2}2 priced$/,
  ],
  [
    'an end row with an unpriced comparison',
    { at: T, kind: 'end', observed: 'ops', requests: 1, priced: 1, unpriced: { comparison: 2, ttl: 1 } },
    /unpriced ttl 1 {2}comparison unavailable 2$/,
  ],
])
  test(`a decision line for ${name}`, () => {
    assert.match(lineOf(row), expected);
  });

for (const [name, cost] of [
  ['a negative lower bound', { minUsd: -1, maxUsd: 1.25 }],
  ['a missing lower bound', { maxUsd: 1.25 }],
  ['a missing upper bound', { minUsd: 0.5 }],
])
  test(`a stored automatic row with ${name} reads its estimate as unknown`, () => {
    const stored = { ...BARE, engine: 'auto', auto: { demand: 'low', outcome: 'held', move: 'none', ...cost } };
    const [row] = readDecisions({ version: 1, since: T, rows: [stored] }).rows;
    assert.match(lineOf(row), /move none; next-turn estimate unknown$/);
  });

test('a failure row keeps the error, 300 characters of its text, the readings and what was held', () => {
  const row = failureRow({
    at: T,
    error: 'rate_limit',
    details: 'x'.repeat(500),
    limits: [{ kind: 'five_hour', label: '5h', percent: 100.04, resetsAt: T + 1 }],
    failure: 'window',
    scope: 'account',
    held: 'plan',
  });
  assert.equal(row.details?.length, 300);
  assert.deepEqual(row.limits, [{ kind: 'five_hour', pct: 100, resets: T + 1 }]);
  assert.deepEqual(readDecisions({ version: 1, since: T, rows: [row] }).rows, [row]);
});

test('a failure row with nothing given holds nulls and no readings', () => {
  assert.deepEqual(failureRow({ at: T, error: 'unknown' }), {
    at: T,
    kind: 'failure',
    err: 'unknown',
    details: null,
    limits: [],
    fail: null,
    scope: null,
    held: null,
  });
});

test('a stored failure row with text over 300 characters or a reading that is not one loses that field', () => {
  const stored = failureRow({ at: T, error: 'rate_limit', details: 'ok' });
  const [row] = readDecisions({
    version: 1,
    since: T,
    rows: [{ ...stored, details: 'x'.repeat(301), limits: [{ kind: 'five_hour', pct: 'all' }] }],
  }).rows;
  assert.equal(row?.details, undefined);
  assert.equal(row?.limits, undefined);
  assert.equal(row?.err, 'rate_limit');
});

test('a failure row is listed with what it held and never its text', () => {
  const [held, nothing] = decisionLines([
    failureRow({ at: T, error: 'rate_limit', details: 'secret', failure: 'window', scope: 'account', held: 'plan' }),
    failureRow({ at: T, error: 'authentication_failed', details: 'secret' }),
  ]);
  assert.match(held ?? '', /failure +rate_limit {2}window held account plan$/);
  assert.match(nothing ?? '', /failure +authentication_failed {2}held nothing$/);
  assert.doesNotMatch(`${held}${nothing}`, /secret/);
});

test('a shadow row keeps its counterfactual move, blocked candidates and profile on write and read', () => {
  const extra = {
    serve: 'sonnet@high',
    move: 'downgrade-pending',
    incumbentCap: 2,
    blocked: [{ route: 'fable@max', reasons: ['context-full', 'cash-cap'] }],
    profile: 'anthropic.0a1b2c3d',
  };
  const row = decisionRow({
    at: T,
    kind: 'start',
    decision,
    engine: 'shadow',
    alt: { reason: 'classifier', ...extra },
  });
  const stored = readDecisions({ version: 1, since: T, rows: [row] }).rows[0];
  for (const [field, value] of Object.entries(extra)) assert.deepEqual(stored.alt[field], value, field);
  assert.match(decisionLines([stored])[0], /auto would serve sonnet@high \(downgrade-pending\)/);
});

for (const [name, field, value] of [
  ['a would-serve path', 'serve', '/private/project@high'],
  ['an unknown move reason', 'move', 'secret prompt'],
  ['an incumbent capability out of range', 'incumbentCap', 9],
  ['a profile path', 'profile', '/Users/someone/router.json'],
  ['blocked text', 'blocked', 'secret'],
  ['a blocked path', 'blocked', [{ route: '/private/project@high', reasons: ['cash-cap'] }]],
  ['blocked unknown reasons only', 'blocked', [{ route: 'fable@max', reasons: ['secret'] }]],
  ['an empty blocked list', 'blocked', []],
]) {
  test(`a shadow row drops ${name}`, () => {
    const row = decisionRow({ at: T, kind: 'start', decision, engine: 'shadow', alt: { [field]: value } });
    assert.equal(Object.hasOwn(row.alt, field), false);
  });
}

test('a shadow row keeps at most 3 blocked candidates and only their known reasons', () => {
  const blocked = Array.from({ length: 5 }, (_, i) => ({
    route: `model${i}@max`,
    reasons: ['cash-cap', 'cash-cap', 'secret'],
    estimate: 1,
  }));
  const row = decisionRow({ at: T, kind: 'start', decision, engine: 'shadow', alt: { blocked } });
  assert.deepEqual(
    row.alt.blocked,
    [0, 1, 2].map((i) => ({ route: `model${i}@max`, reasons: ['cash-cap'] })),
  );
});

test('the largest shadow proposal a row can hold stays under 1.2 KB', () => {
  const route = `${'m'.repeat(64)}@session`;
  const reasons = [
    'model-missing',
    'effort-unsupported',
    'unavailable',
    'held-out',
    'context-full',
    'context-unknown',
    'images',
    'cash-cap',
  ];
  const alt = {
    demand: 2.5,
    reason: 'downgrade-pending',
    headroom: false,
    targetReason: 'escalation-exhausted',
    requirement: 2.5,
    outcome: 'declared-below-demand',
    route,
    capability: 2.5,
    minUsd: 1234.123456,
    maxUsd: 1234.123456,
    serve: route,
    move: 'escalation-exhausted',
    incumbentCap: 2.5,
    blocked: Array.from({ length: 9 }, () => ({ route, reasons })),
    profile: `${'p'.repeat(24)}.ffffffff`,
  };
  const row = decisionRow({ at: T, kind: 'start', decision, engine: 'shadow', alt });
  assert.equal(row.alt.blocked.length, 3);
  assert.equal(row.alt.profile, alt.profile);
  assert.ok(JSON.stringify(row.alt).length <= 1200, String(JSON.stringify(row.alt).length));
});

test('reviews whose would-serve route changed stay separate rows', () => {
  const review = (serve) =>
    decisionRow({ at: T, kind: 'review', decision, engine: 'shadow', alt: { route: 'sonnet@high', serve } });
  assert.equal(addTurnRow([review('opus@high')], review('opus@high')).length, 1);
  assert.equal(addTurnRow([review('opus@high')], review('sonnet@high')).length, 2);
});

test('reviews held for different move reasons stay separate rows', () => {
  const review = (move) =>
    decisionRow({
      at: T,
      kind: 'review',
      decision,
      engine: 'shadow',
      alt: { route: 'sonnet@high', serve: 'opus@high', move },
    });
  assert.equal(addTurnRow([review('dwell-held')], review('dwell-held')).length, 1);
  const rows = addTurnRow([review('downgrade-pending')], review('dwell-held'));
  assert.deepEqual(
    rows.map((row) => row.alt.move),
    ['downgrade-pending', 'dwell-held'],
  );
});
