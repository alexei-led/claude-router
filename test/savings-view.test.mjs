import assert from 'node:assert/strict';
import test from 'node:test';
import { renderBand } from '../lib/band.mjs';
import { DEFAULTS } from '../lib/config.mjs';
import { savingsLine } from '../lib/display.mjs';
import { ELEMENTS, screen } from './harness.mjs';

const actions = new Proxy({}, { get: () => () => {} });
const SINCE = Date.parse('2026-10-10T12:00:00Z');
const STORE = {
  version: 1,
  since: SINCE,
  replies: 400,
  routedUsd: 41.18,
  yoursUsd: 52.6,
  cheaperUsd: -14.9,
  strongerUsd: 0,
  switchUsd: 3.48,
};
const SAVES = {
  yours: 'claude-opus-5-5',
  replies: 64,
  routedUsd: 6.404,
  yoursUsd: 8.236,
  cheaperUsd: -2.31,
  strongerUsd: 0,
  switchUsd: 0.478,
};
const MORE = {
  yours: 'claude-haiku-5-5',
  replies: 41,
  routedUsd: 3.1,
  yoursUsd: 0.62,
  cheaperUsd: 0,
  strongerUsd: 2.31,
  switchUsd: 0.17,
};
const EARLY = { ...SAVES, replies: 3, routedUsd: 0.21, yoursUsd: 0.26, cheaperUsd: -0.06, switchUsd: 0.01 };
// A session's usage record holding `totals` as one cell, the replies priced against `yours`.
const record = ({ yours, replies, routedUsd, yoursUsd, cheaperUsd, strongerUsd, switchUsd }) => ({
  version: 2,
  since: SINCE,
  days: {
    '2026-10-29': {
      cells: {
        'balanced|code|low|claude-haiku-5-5@high': [
          replies,
          routedUsd,
          yoursUsd,
          cheaperUsd,
          strongerUsd,
          switchUsd,
          0,
          0,
          0,
        ],
      },
      whatIf: {},
      yours: { [yours]: replies },
      hours: {},
      turns: 1,
      switches: { tier: 0, activity: 0 },
    },
  },
});
const OPUS = { nativeModel: 'claude-opus-5-5', nativeEffort: 'xhigh' };
const HAIKU = { nativeModel: 'claude-haiku-5-5', nativeEffort: 'high' };

const view = (props) => ({
  mode: 'auto',
  phase: 'routed',
  tab: 'usage',
  credentials: { jev: null },
  tier: 'low',
  selectedModel: 'claude-haiku-5-5',
  actualModel: 'claude-haiku-5-5',
  effort: 'high',
  tiers: ['low', 'low', 'high'],
  routes: ['claude-haiku-5-5@high', 'claude-haiku-5-5@high', 'claude-opus-5-5@xhigh'],
  savingsStore: STORE,
  ...props,
});

test('the two-row band says the session against your model and the parts that add up to it, the answer kept when narrow', () => {
  const second = (props, columns = 140) =>
    screen(renderBand(ELEMENTS, DEFAULTS, view({ bandDetail: true, ...props }), null, { columns }, actions))[1];
  const SAME = { ...SAVES, replies: 20, routedUsd: 1, yoursUsd: 1, cheaperUsd: 0, switchUsd: 0 };
  for (const [props, columns, expected] of [
    [{ ...OPUS, usageSession: record(SAVES) }, 140, 'session $6.40 billed   −$1.84 (−22%) vs Opus 5.5   64 replies'],
    [{ ...HAIKU, usageSession: record(MORE) }, 140, 'session $3.10 billed   +$2.48 (×5.0) vs Haiku 5.5   41 replies'],
    [{ ...OPUS, usageSession: record(SAME) }, 140, 'session $1.00 billed   $0.00 vs Opus 5.5   20 replies'],
    [
      { ...OPUS, usageSession: record(EARLY) },
      140,
      'session $0.21 billed   −$0.05 (−19%) vs Opus 5.5   3 replies so far',
    ],
    [{ ...OPUS, usageSession: record(EARLY) }, 60, 'session $0.21 billed   −$0.05 (−19%) vs Opus 5.5'],
    [{ ...OPUS, usageSession: record(SAVES) }, 50, 'session $6.40 billed   −$1.84 (−22%) vs Opus 5.5'],
    [{ ...OPUS, usageSession: record(SAVES) }, 30, 'session $6.40'],
    // After a /model change the session stays against the model its replies ran against.
    [{ ...HAIKU, usageSession: record(SAVES) }, 140, 'session $6.40 billed   −$1.84 (−22%) vs Opus 5.5   64 replies'],
    [{ ...OPUS }, 140, 'session · no replies yet'],
  ])
    assert.equal(second(props, columns), expected, `${columns}: ${props.usageSession ? 'record' : 'none'}`);
  const oneRow = screen(
    renderBand(ELEMENTS, DEFAULTS, view({ ...OPUS, usageSession: record(SAVES) }), null, { columns: 140 }, actions),
  );
  assert.ok(!oneRow.join('\n').includes('session'));
});

test('the band counts the running turn’s replies before the turn is recorded', () => {
  const live = {
    at: SINCE,
    cell: 'balanced|code|low|claude-haiku-5-5@high',
    sums: [1, 0.1, 0.5, -0.4, 0, 0, 0, 0, 0],
    whatIf: {},
    yours: 'claude-opus-5-5',
  };
  const second = (props) =>
    screen(
      renderBand(ELEMENTS, DEFAULTS, view({ bandDetail: true, ...OPUS, ...props }), null, { columns: 140 }, actions),
    )[1];
  assert.equal(
    second({ usageLive: Array(10).fill(live) }),
    'session $1.00 billed   −$4.00 (−80%) vs Opus 5.5   10 replies',
  );
  assert.equal(
    second({ usageSession: record(SAVES), usageLive: [live] }),
    'session $6.50 billed   −$2.24 (−26%) vs Opus 5.5   65 replies',
  );
});

test('/router without a surface says the session in the band’s words, in one line', () => {
  const line = (props) => savingsLine(DEFAULTS, view(props), null, Date.parse('2026-10-29T12:00:00Z'));
  for (const [props, expected] of [
    [{ ...OPUS, usageSession: record(SAVES) }, 'Session: $6.40 billed · −$1.84 (−22%) vs Opus 5.5 $8.24 · 64 replies'],
    [{ ...HAIKU, usageSession: record(MORE) }, 'Session: $3.10 billed · +$2.48 (×5.0) vs Haiku 5.5 $0.62 · 41 replies'],
    [
      { ...OPUS, usageSession: record(EARLY) },
      'Session: $0.21 billed · −$0.05 (−19%) vs Opus 5.5 $0.26 · 3 replies so far',
    ],
    [{ nativeModel: 'claude-sonnet-5-5', nativeEffort: 'medium' }, 'Session: no routed replies yet'],
    [{ ...OPUS, savingsStore: 'corrupted' }, 'Session: no routed replies yet'],
  ])
    assert.equal(line(props), expected);
});
