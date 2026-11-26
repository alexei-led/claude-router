// RECENT DECISIONS on the Now tab: a line per turn, notes only for what a glance should not miss, and a stop rule.
import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULTS } from '../lib/config.mjs';
import { decisionRow, endRow, failureRow } from '../lib/decisions.mjs';
import { renderPanel } from '../lib/panel.mjs';
import { decisionsOf, MAX_LINES, SHOWN_TURNS } from '../lib/ui/model/decisions.mjs';
import { ELEMENTS, quiet, screen, unboxed } from './harness.mjs';
import { NOW } from './usage-fixtures.mjs';

const MIN = 60_000;
const decision = (tier, model, effort, reason = 'same-tier') => ({ tier, model, effort, reason, activity: 'code' });
const start = (at, d, extra = {}) => decisionRow({ at, kind: 'start', decision: d, ...extra });
const review = (at, d, extra = {}) => decisionRow({ at, kind: 'review', decision: d, ...extra });
const end = (at, requests) => endRow({ at, observed: 'code', requests, priced: requests });
const OPUS_HIGH = decision('medium', 'claude-opus-5-5', 'high');
const OPUS_XHIGH = decision('high', 'claude-opus-5-5', 'xhigh', 'upgrade');
const turn = (at, d = OPUS_HIGH, requests = 3) => [start(at, d), end(at + 2 * MIN, requests)];

test('each turn is one line: when, how long, the tier and route that ran last, the work, its requests and why', () => {
  const rows = [start(NOW, OPUS_HIGH), review(NOW + 5 * MIN, OPUS_XHIGH), end(NOW + 42 * MIN, 172)];
  const [only] = decisionsOf(DEFAULTS, rows).turns;
  assert.deepEqual(
    [only.took, only.tier, only.route, only.work, only.calls, only.why],
    ['42m', 'high', 'Opus 5.5 · xhigh', 'code', '172 req', '↑ needs stronger'],
  );
});

test('a turn still running shows … for how long and its requests', () => {
  const [only] = decisionsOf(DEFAULTS, [start(NOW, OPUS_HIGH)]).turns;
  assert.deepEqual([only.took, only.calls], ['…', '…']);
});

test('a turn notes at most two things, a failure first, then a classifier error, a shadow proposal, a move', () => {
  const shadow = { engine: 'shadow', alt: { route: 'sonnet@max', minUsd: 0.01, maxUsd: 0.38 } };
  const rows = [
    start(NOW, OPUS_HIGH, { error: 'timeout', ...shadow }),
    review(NOW + MIN, OPUS_XHIGH, shadow),
    failureRow({ at: NOW + 2 * MIN, error: 'overloaded', failure: 'availability', scope: 'model', held: 'opus' }),
    end(NOW + 3 * MIN, 4),
  ];
  assert.deepEqual(
    decisionsOf(DEFAULTS, rows).turns[0].notes.map((note) => note.lead),
    ['⚠', '⚠ classifier'],
  );
  const calm = decisionsOf(DEFAULTS, [start(NOW, OPUS_HIGH, shadow), review(NOW + MIN, OPUS_XHIGH, shadow)]);
  assert.deepEqual(
    calm.turns[0].notes.map((note) => [note.lead, note.text]),
    [
      ['◇ shadow', 'Sonnet 5.5 · max · est $0.01–0.38'],
      ['↑ from', `Opus 5.5 · high at ${new Date(NOW + MIN).toTimeString().slice(0, 5)}`],
    ],
  );
});

test(`the newest ${SHOWN_TURNS} turns show, and older ones go first when notes pass ${MAX_LINES} lines`, () => {
  const plain = decisionsOf(DEFAULTS, Array.from({ length: 7 }, (_, i) => turn(NOW + i * 10 * MIN)).flat());
  assert.deepEqual([plain.turns.length, plain.earlier], [SHOWN_TURNS, 2]);
  const moving = Array.from({ length: 5 }, (_, i) => [
    start(NOW + i * 10 * MIN, OPUS_HIGH),
    review(NOW + i * 10 * MIN + MIN, OPUS_XHIGH),
    failureRow({ at: NOW + i * 10 * MIN + 2 * MIN, error: 'overloaded' }),
  ]).flat();
  const busy = decisionsOf(DEFAULTS, moving);
  assert.ok(busy.turns.reduce((n, one) => n + 1 + one.notes.length, 0) <= MAX_LINES);
  assert.equal(busy.turns.at(-1).time, new Date(NOW + 40 * MIN).toTimeString().slice(0, 5));
});

test('the summary counts how often shadow proposed the route that ran, each merged check counted', () => {
  const agree = { engine: 'shadow', alt: { route: 'opus@high' } };
  const differ = { engine: 'shadow', alt: { route: 'sonnet@max' } };
  const rows = [
    start(NOW, OPUS_HIGH, agree),
    { ...review(NOW + MIN, OPUS_HIGH, agree), n: 3 },
    review(NOW + 2 * MIN, OPUS_HIGH, differ),
  ];
  assert.equal(decisionsOf(DEFAULTS, rows).summary, 'shadow agrees 4/5');
  assert.equal(decisionsOf(DEFAULTS, turn(NOW)).summary, null);
  assert.equal(decisionsOf(DEFAULTS, []), null);
});

for (const columns of [88, 60, 44])
  test(`at ${columns} columns every line of the block fits, one line per turn`, () => {
    const rows = [
      start(NOW, OPUS_HIGH, { engine: 'shadow', alt: { route: 'sonnet@max', minUsd: 0.01, maxUsd: 0.38 } }),
      review(NOW + MIN, OPUS_XHIGH),
      end(NOW + 42 * MIN, 172),
      ...turn(NOW + 50 * MIN),
      ...turn(NOW + 55 * MIN, decision('high', 'acme-research-model-with-a-long-name', 'xhigh')),
    ];
    const tree = renderPanel(
      ELEMENTS,
      DEFAULTS,
      { mode: 'auto', phase: 'routed', tab: 'now', decisionRows: rows },
      null,
      quiet,
      { columns, now: NOW + 60 * MIN },
    );
    const all = unboxed(screen(tree));
    const from = all.findIndex((line) => line.startsWith('RECENT DECISIONS'));
    const to = all.findIndex((line, i) => i > from && line.startsWith('every row'));
    const block = all.slice(from, to + 1);
    const inner = columns >= 72 ? columns - 4 : columns;
    assert.ok(block.length >= 4, block.join('\n'));
    for (const line of block) assert.ok([...line].length <= inner, `${[...line].length} > ${inner}: ${line}`);
    assert.equal(block.filter((line) => /^\d\d:\d\d /.test(line)).length, 3);
  });
