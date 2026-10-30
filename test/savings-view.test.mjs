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
// One dated day kept by the usage records after the undated totals: −$2.00 more saved, on 10 replies.
const DATED = {
  version: 1,
  since: Date.parse('2026-10-12T12:00:00Z'),
  days: {
    '2026-10-12': {
      cells: { 'code|low|haiku@high': [10, 1, 3, -2, 0, 0, 10_000, 9_000, 100] },
      whatIf: {},
      yours: { opus: 10 },
      hours: { 12: 1 },
      turns: 4,
      switches: { tier: 1, activity: 0 },
    },
  },
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
const FOOTER = [
  '',
  '  API list prices · same tokens and output length · not a bill;',
  '  on a Claude plan it stands for quota · answer quality not measured',
];
const _SAVED_FOOTER = ['', '  since Oct 10: each session compared with its own model', ...FOOTER.slice(1)];

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
    [
      { ...OPUS, usageSession: record(SAVES) },
      140,
      'session  routing −$1.84 (−22%) vs Opus 5.5 · xhigh  =  −$2.31 cheaper models  +$0.47 cache rebuilds  ·  64 replies',
    ],
    [
      { ...HAIKU, usageSession: record(MORE) },
      140,
      'session  routing +$2.48 (×5.0) vs Haiku 5.5 · high  =  +$2.31 stronger models  +$0.17 cache rebuilds  ·  41 replies',
    ],
    [{ ...OPUS, usageSession: record(SAME) }, 140, 'session  routing $0.00 vs Opus 5.5 · xhigh  ·  20 replies'],
    [
      { ...OPUS, usageSession: record(EARLY) },
      140,
      'session  routing −$0.05 (−19%) vs Opus 5.5 · xhigh  ·  3 replies · early sample',
    ],
    [{ ...OPUS, usageSession: record(EARLY) }, 60, 'session  routing −$0.05 (−19%) vs Opus 5.5 · xhigh'],
    [
      { ...OPUS, usageSession: record(SAVES) },
      90,
      'session  routing −$1.84 (−22%) vs Opus 5.5 · xhigh  =  −$2.31 + $0.47  ·  64 replies',
    ],
    [
      { ...OPUS, usageSession: record(SAVES) },
      75,
      'session  routing −$1.84 (−22%) vs Opus 5.5 · xhigh  =  −$2.31 + $0.47',
    ],
    [{ ...OPUS, usageSession: record(SAVES) }, 50, 'session  routing −$1.84 (−22%) vs Opus 5.5 · xhigh'],
    // After a /model change the session stays against the model its replies ran against.
    [
      { ...HAIKU, usageSession: record(SAVES) },
      140,
      'session  routing −$1.84 (−22%) vs Opus 5.5  =  −$2.31 cheaper models  +$0.47 cache rebuilds  ·  64 replies',
    ],
    [{ ...OPUS }, 140, 'no replies yet'],
    [{ nativeModel: 'claude-fable-5-1', nativeEffort: null }, 140, 'session  Fable 5.1 has no list price'],
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
    'session  routing −$4.00 (−80%) vs Opus 5.5 · xhigh  =  −$4.00 cheaper models  ·  10 replies',
  );
  assert.equal(
    second({ usageSession: record(SAVES), usageLive: [live] }),
    'session  routing −$2.24 (−26%) vs Opus 5.5 · xhigh  =  −$2.71 cheaper models  +$0.47 cache rebuilds  ·  65 replies',
  );
});

test('/router without a surface says the session in the band’s words, in one line', () => {
  const line = (props) => savingsLine(DEFAULTS, view(props), Date.parse('2026-10-29T12:00:00Z'));
  for (const [props, expected] of [
    [
      { ...OPUS, usageSession: record(SAVES) },
      'Session: routing −$1.84 (−22%) vs Opus 5.5 · xhigh = −$2.31 cheaper models +$0.47 cache rebuilds, 64 replies, est. at list prices',
    ],
    [
      { ...HAIKU, usageSession: record(MORE) },
      'Session: routing +$2.48 (×5.0) vs Haiku 5.5 · high = +$2.31 stronger models +$0.17 cache rebuilds, 41 replies, est. at list prices',
    ],
    [
      { ...OPUS, usageSession: record(EARLY) },
      'Session: routing −$0.05 (−19%) vs Opus 5.5 · xhigh, 3 replies, early sample, est. at list prices',
    ],
    [
      { nativeModel: 'claude-sonnet-5-5', nativeEffort: 'medium' },
      'Session vs Sonnet 5.5 · medium: no routed replies yet; routing −$11.42 (−22%) since Oct 10, each session against its own model',
    ],
    [
      { ...OPUS, phase: 'unavailable' },
      'Session vs Opus 5.5 · xhigh: no routed replies yet; routing −$11.42 (−22%) since Oct 10, each session against its own model',
    ],
    [{ ...OPUS, savingsStore: 'corrupted' }, 'Session vs Opus 5.5 · xhigh: no routed replies yet'],
    [
      { ...OPUS, usageStore: DATED },
      'Session vs Opus 5.5 · xhigh: no routed replies yet; routing −$13.42 (−24%) since Oct 10, each session against its own model',
    ],
  ])
    assert.equal(line(props), expected);
});
