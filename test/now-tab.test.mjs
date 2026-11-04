import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULTS } from '../lib/config.mjs';
import { renderPanel } from '../lib/panel.mjs';
import { emptyUsage, recordUsage } from '../lib/usage.mjs';
import { controls, ELEMENTS, screen } from './harness.mjs';
import { at, NOW, reply, SESSION, STORE } from './usage-fixtures.mjs';

const view = (props = {}) => ({
  mode: 'auto',
  phase: 'routed',
  credentials: { jev: null },
  tab: 'now',
  tier: 'high',
  selectedModel: 'claude-opus-5-5',
  effort: 'xhigh',
  nativeModel: 'claude-opus-5-5',
  usageSession: SESSION,
  usageStore: STORE,
  strip: { per: 1, cells: [{ low: 2 }, { medium: 1 }, { high: 1, low: 1 }, { none: 1 }] },
  ...props,
});
const recording = () => {
  const calls = [];
  const actions = new Proxy(
    {},
    {
      get:
        (_, name) =>
        (...args) =>
          calls.push([name, ...args]),
    },
  );
  return { calls, actions };
};
const render = (props = {}, { columns = 100, actions = recording().actions, usage = null } = {}) =>
  renderPanel(ELEMENTS, DEFAULTS, view(props), usage, actions, { columns, now: NOW });
const lines = (props, options) => screen(render(props, options)).map((line) => line.trimEnd());
const after = (all, head, count) => all.slice(all.indexOf(head), all.indexOf(head) + count);
const block = (all, head) => {
  const from = all.findIndex((line) => line.startsWith(head));
  return all.slice(from, all.indexOf('', from));
};
const SESSION_HEAD = 'SESSION  since 09:00 · 20 replies · 4 switches';
// Claude Code's usage on a plan: the 5h window resets in an hour, the 7d window reports no reset.
const PLAN = {
  rateLimits: [
    { kind: 'five_hour', percentUsed: 37, resetsAt: new Date(NOW + 3600e3).toISOString() },
    { kind: 'seven_day', percentUsed: 81 },
  ],
};

test('next turn names the tier meter, the route and why, then one pin per tier low to high with its support', () => {
  const { calls, actions } = recording();
  const probabilities = { high: 0.88, medium: 0.07, low: 0.03 };
  const tree = render({ probabilities, reason: 'upgrade', pendingPin: 'medium' }, { actions });
  assert.deepEqual(
    after(
      screen(tree).map((l) => l.trimEnd()),
      'NEXT TURN',
      6,
    ),
    [
      'NEXT TURN',
      '  ▂▄▆█  Opus 5.5 · xhigh',
      '  why   ↑ needs stronger',
      '  pin   [ ▂ Haiku·medium — ] [ ▂▄ Haiku·high 3% ]',
      '        [ ▂▄▆ Opus·medium 7% ] [ ▶ ▂▄▆█ Opus·xhigh 88% ]',
      '        ⏵ next turn ▂▄▆ Opus·medium  [ unpin ]',
    ],
  );
  const pins = controls(tree).filter((c) => c.key.startsWith('pin-'));
  assert.deepEqual(
    pins.map((c) => [c.key, c.variant]),
    [
      ['pin-micro', 'secondary'],
      ['pin-low', 'secondary'],
      ['pin-medium', 'primary'],
      ['pin-high', 'secondary'],
    ],
  );
  pins[0].onPress();
  controls(tree)
    .find((c) => c.key === 'unpin')
    .onPress();
  assert.deepEqual(calls, [['pin', 'micro'], ['unpin']]);
});

test('a narrow pane puts one pin on each row, and a turn without a reason shows no why', () => {
  const narrow = lines({}, { columns: 60 });
  assert.deepEqual(after(narrow, 'NEXT TURN', 6), [
    'NEXT TURN',
    '  ▂▄▆█  Opus 5.5 · xhigh',
    '  pin   [ ▂ Haiku·medium — ]',
    '        [ ▂▄ Haiku·high — ]',
    '        [ ▂▄▆ Opus·medium — ]',
    '        [ ▶ ▂▄▆█ Opus·xhigh — ]',
  ]);
});

test('with routing off or unavailable the next turn says which model runs, and offers no pins', () => {
  for (const [props, expected] of [
    [{ mode: 'manual' }, ['  ○ Opus 5.5 · xhigh   routing off · /model choice', '  pin   needs routing on (o)']],
    [
      { phase: 'unavailable', error: 'bad', nativeEffort: 'xhigh' },
      ['  ✕ Opus 5.5 · xhigh   routing unavailable · Claude’s model', '  pin   needs routing'],
    ],
  ]) {
    // A reason, an activity and a classifier reading from an earlier routed turn no longer apply.
    const stale = { ...props, reason: 'upgrade', activity: 'code', activityChoice: 'code', probabilities: { high: 1 } };
    assert.deepEqual(after(lines(stale), 'NEXT TURN', 4).slice(1), [...expected, '']);
    assert.ok(!controls(render(props)).some((c) => c.key.startsWith('pin-')));
  }
});

test('the session leads with its total and how it is paid, then the difference against no routing and the parts', () => {
  const { calls, actions } = recording();
  const tree = render({}, { actions });
  assert.deepEqual(
    block(
      screen(tree).map((l) => l.trimEnd()),
      'SESSION',
    ),
    [
      SESSION_HEAD,
      '  $4.30  billed at list prices  [ Usage ]',
      '  −$4.70 (−52%) vs no routing  of $9.00',
      '  main    $4.30  ████████████████  −$4.70 vs Opus 5.5',
      '  tiers ███·',
      '        ▂▄ 3   ▂▄▆ 1   ▂▄▆█ 1   · not routed 1',
    ],
  );
  controls(tree)
    .find((c) => c.key === 'usage-session')
    .onPress();
  assert.deepEqual(calls, [['usageFor', 'session']]);
});

test('on a plan the pane shows the plan windows and the session as API value with ≈', () => {
  const all = lines({}, { usage: PLAN });
  assert.deepEqual(block(all, 'PLAN'), [
    'PLAN  Claude plan usage',
    `  5h    ▰▰▰▰▰▰▰▱▱▱▱▱▱▱▱▱▱▱▱▱  37%   resets ${new Date(NOW + 3600e3).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`,
    '  7d    ▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▱▱▱▱  81%',
  ]);
  assert.deepEqual(block(all, 'SESSION').slice(1, 4), [
    '  ≈$4.30  API value · plan quota, not billed  [ Usage ]',
    '  −$4.70 (−52%) vs no routing  of ≈$9.00',
    '  main   ≈$4.30  ████████████████  −$4.70 vs Opus 5.5',
  ]);
  assert.ok(!all.some((line) => line.includes('/cost')));
});

test('a session without replies says so, and replies without a list price keep their tiers but no cost', () => {
  assert.deepEqual(block(lines({ usageSession: null, usageStore: null, strip: null }), 'SESSION'), [
    'SESSION',
    '  no replies yet',
  ]);
  assert.deepEqual(block(lines({ usageSession: null, usageStore: null }), 'SESSION'), [
    'SESSION',
    '  no priced replies: cost unknown',
    '  tiers ███·',
    '        ▂▄ 3   ▂▄▆ 1   ▂▄▆█ 1   · not routed 1',
  ]);
});

test('an early session marks its difference as an early sample, and a narrow pane drops that note first', () => {
  const early = recordUsage(emptyUsage(), [reply(at(2026, 10, 13, 10), 'code')], { now: NOW });
  for (const [columns, expected] of [
    [100, '  −$0.20 (−40%) vs no routing  of $0.50 · early sample'],
    [50, '  −$0.20 (−40%) vs no routing'],
  ])
    assert.equal(block(lines({ usageSession: early }, { columns }), 'SESSION')[2], expected, `${columns} columns`);
});

test('the session counts the running turn’s replies and warns when the switches cost more than they saved', () => {
  const { calls, actions } = recording();
  const lost = { ...reply(at(2026, 10, 13, 10), 'code'), sums: [1, 1, 0.5, -0.1, 0, 0.6, 0, 0, 0] };
  assert.deepEqual(block(lines({ usageSession: emptyUsage(), usageLive: [lost, lost] }), 'SESSION').slice(0, 3), [
    'SESSION  2 replies',
    '  $2.00  billed at list prices  [ Usage ]',
    '  +$1.00 (+100%) vs no routing  of $1.00 · early sample',
  ]);
  const warned = render({ usageSession: emptyUsage(), usageLive: Array(10).fill(lost) }, { actions });
  assert.ok(screen(warned).includes('  ▲ switches cost more than they saved  [ Policy ]'));
  controls(warned)
    .find((c) => c.key === 'session-policy')
    .onPress();
  assert.deepEqual(calls, [['tab', 'policy']]);
});

test('a strip cell shows the tier with most replies, the stronger one on a tie, and a dot where routing served most', () => {
  const strip = { per: 2, cells: [{ low: 1, high: 1 }, { micro: 2 }, { none: 1, low: 1 }, { none: 2 }] };
  assert.deepEqual(block(lines({ strip }), 'SESSION').slice(-2), [
    '  tiers ███·  2 replies per cell',
    '        ▂ 2   ▂▄ 2   ▂▄▆█ 1   · not routed 3',
  ]);
});

test('a strip that started after the session’s first reply, as after a restart, says since when', () => {
  const strip = { per: 1, cells: [{ low: 2 }, { high: 1 }], from: at(2026, 10, 13, 15) };
  assert.ok(lines({ strip }).includes('  tiers ██  since 15:00'));
  assert.ok(lines({ strip: { ...strip, from: at(2026, 10, 13, 8) } }).includes('  tiers ██'));
});

test('a narrow pane merges strip cells in pairs until the strip fits', () => {
  const strip = { per: 1, cells: Array.from({ length: 48 }, () => ({ low: 1 })) };
  for (const [columns, cells, note] of [
    [100, 48, ''],
    [52, 12, '  4 replies per cell'],
    [40, 6, '  8 replies per cell'],
  ])
    assert.ok(lines({ strip }, { columns }).includes(`  tiers ${'█'.repeat(cells)}${note}`), `${columns} columns`);
});

test('context shows the window fill once Claude Code reports it, and the cache reuse of the last reply', () => {
  assert.deepEqual(after(lines({}), 'CONTEXT', 3), [
    'CONTEXT',
    '  ctx    no reading yet',
    '  cache  no reply yet · 73% session   [ details ]',
  ]);
  const read = lines(
    { contextTokens: 250_000, inputTokens: 1000, cacheRead: 900, outputTokens: 0 },
    { usage: { context: { tokens: 250_000 } } },
  );
  const [, ctx, cache] = after(read, 'CONTEXT', 3);
  assert.match(ctx, /^ {2}ctx {4}▰{5}▱{15} {2}25% {3}/);
  assert.equal(cache, '  cache  90% last reply · 73% session   [ details ]');
});
