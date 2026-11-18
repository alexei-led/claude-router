import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULTS } from '../lib/config.mjs';
import { renderPanel } from '../lib/panel.mjs';
import { emptyUsage, recordUsage } from '../lib/usage.mjs';
import { controls, ELEMENTS, find, screen, texts, unboxed } from './harness.mjs';
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
const lines = (props, options) => unboxed(screen(render(props, options)));
const after = (all, head, count) => all.slice(all.indexOf(head), all.indexOf(head) + count);
const block = (all, head) => {
  const from = all.findIndex((line) => line.startsWith(head));
  return all.slice(from, all.indexOf('', from));
};
// The SESSION line ends with the band's second-row toggle.
const SESSION_HEAD = 'SESSION  since 09:00 · 20 replies · 4 switches  [ band: 2 rows ]';
// Claude Code's usage on a plan: the 5h window resets in an hour, the 7d window reports no reset.
const PLAN = {
  rateLimits: [
    { kind: 'five_hour', percentUsed: 37, resetsAt: new Date(NOW + 3600e3).toISOString() },
    { kind: 'seven_day', percentUsed: 81 },
  ],
};

test('next turn names the tier meter, the route and why, then pins from one dropdown under what it offers', () => {
  const probabilities = { high: 0.88, medium: 0.07, low: 0.03 };
  assert.deepEqual(after(lines({ probabilities, reason: 'upgrade' }), 'NEXT TURN', 7), [
    'NEXT TURN',
    '  ▂▄▆█  Opus 5.5 · xhigh',
    '  why   ↑ needs stronger',
    '  pin next turn to a tier · now Opus 5.5 · xhigh',
    '    none ▾',
    '    other models: /model, with routing off',
    '',
  ]);
});

const pinSelect = (props, actions) => controls(render(props, { actions })).find((c) => c.key === 'pin');
test('the pin dropdown offers no pin, then each tier low to high with its route and support, the running tier marked', () => {
  const pin = pinSelect({ probabilities: { high: 0.88, medium: 0.07, low: 0.03 } });
  assert.equal(pin.value, 'none');
  assert.deepEqual(
    pin.options.map((o) => [o.value, o.label]),
    [
      ['none', 'Pin to a tier'],
      ['micro', '▂ Haiku·medium —'],
      ['low', '▂▄ Haiku·high 3%'],
      ['medium', '▂▄▆ Opus·medium 7%'],
      ['high', '▶ ▂▄▆█ Opus·xhigh 88%'],
    ],
  );
});

test('a pending pin is the dropdown’s value, and its no-pin choice reads No pin', () => {
  const pin = pinSelect({ pendingPin: 'medium' });
  assert.equal(pin.value, 'medium');
  assert.equal(pin.options[0].label, 'No pin');
});

for (const [value, call] of [
  ['high', ['pin', 'high']],
  ['micro', ['pin', 'micro']],
  ['none', ['unpin']],
])
  test(`picking ${value} in the pin dropdown asks for ${call.join(' ')}`, () => {
    const { calls, actions } = recording();
    pinSelect({ pendingPin: 'medium' }, actions).onSelect(value);
    assert.deepEqual(calls, [call]);
  });

test('a narrow pane keeps the pin dropdown on one line, and a turn without a reason shows no why', () => {
  assert.deepEqual(after(lines({}, { columns: 60 }), 'NEXT TURN', 6), [
    'NEXT TURN',
    '  ▂▄▆█  Opus 5.5 · xhigh',
    '  pin next turn to a tier · now Opus 5.5 · xhigh',
    '    none ▾',
    '    other models: /model, with routing off',
    '',
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
    assert.ok(!controls(render(props)).some((c) => c.key === 'pin' || c.key.startsWith('pin-')));
  }
});

test('the session leads with its total and how it is paid, then the difference against no routing and the parts', () => {
  const { calls, actions } = recording();
  const tree = render({}, { actions });
  assert.deepEqual(block(unboxed(screen(tree)), 'SESSION'), [
    SESSION_HEAD,
    '  ≈$4.30  API estimate · configured rates, not an invoice  [ Usage ]',
    '  −$4.70 (−52%) vs Opus 5.5 ≈$9.00',
    '  main   ≈$4.30  ████████████████  −$4.70 vs Opus 5.5',
    '  tiers ███·',
    '        ▂▄ 3   ▂▄▆ 1   ▂▄▆█ 1   · not routed 1',
  ]);
  controls(tree)
    .find((c) => c.key === 'usage-session')
    .onPress();
  assert.deepEqual(calls, [['usageFor', 'session']]);
});

test('on a plan the pane shows the plan windows and the session as API estimate with ≈', () => {
  const all = lines({}, { usage: PLAN });
  assert.deepEqual(block(all, 'PLAN'), [
    'PLAN  Claude plan usage',
    `  5h    ▰▰▰▰▰▰▰▱▱▱▱▱▱▱▱▱▱▱▱▱  37%   resets ${new Date(NOW + 3600e3).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`,
    '  7d    ▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▱▱▱▱  81%',
  ]);
  assert.deepEqual(block(all, 'SESSION').slice(1, 4), [
    '  ≈$4.30  API estimate · plan quota, not a charge  [ Usage ]',
    '  −$4.70 (−52%) vs Opus 5.5 ≈$9.00',
    '  main   ≈$4.30  ████████████████  −$4.70 vs Opus 5.5',
  ]);
  assert.ok(!all.some((line) => line.includes('/cost')));
});

test('a session without replies says so, and replies without a list price keep their tiers but no cost', () => {
  assert.deepEqual(block(lines({ usageSession: null, usageStore: null, strip: null }), 'SESSION'), [
    'SESSION  [ band: 2 rows ]',
    '  no replies yet',
  ]);
  assert.deepEqual(block(lines({ usageSession: null, usageStore: null }), 'SESSION'), [
    'SESSION  [ band: 2 rows ]',
    '  no priced replies: cost unknown',
    '  tiers ███·',
    '        ▂▄ 3   ▂▄▆ 1   ▂▄▆█ 1   · not routed 1',
  ]);
});

test('an early session names its replies so far and why, and a narrow pane drops the unrouted amount first', () => {
  const early = recordUsage(emptyUsage(), [reply(at(2026, 10, 13, 10), 'code')], { now: NOW });
  for (const [columns, expected] of [
    [100, '  −$0.20 (−40%) vs Opus 5.5 ≈$0.50'],
    [30, '  −$0.20 (−40%) vs Opus 5.5'],
  ])
    assert.deepEqual(
      block(lines({ usageSession: early }, { columns }), 'SESSION').slice(2, 4),
      [expected, '  1 reply so far: one model switch can still move this a lot'],
      `${columns} columns`,
    );
});

test('the session counts the running turn’s replies and warns when the switches cost more than they saved', () => {
  const { calls, actions } = recording();
  const lost = { ...reply(at(2026, 10, 13, 10), 'code'), sums: [1, 1, 0.5, -0.1, 0, 0.6, 0, 0, 0] };
  assert.deepEqual(block(lines({ usageSession: emptyUsage(), usageLive: [lost, lost] }), 'SESSION').slice(0, 3), [
    'SESSION  2 replies  [ band: 2 rows ]',
    '  ≈$2.00  API estimate · configured rates, not an invoice  [ Usage ]',
    '  +$1.00 (+100%) vs Opus 5.5 ≈$1.00',
  ]);
  const warned = render({ usageSession: emptyUsage(), usageLive: Array(10).fill(lost) }, { actions });
  assert.ok(unboxed(screen(warned)).includes('  ▲ switches cost more than they saved  [ Policy ]'));
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

// The pane draws each Now section in a box from 72 columns and with no width; narrower, the plain lines.
const bordered = (tree) => find(tree, (node) => node.type === 'Box' && node.props.borderStyle !== undefined);
for (const [columns, heads] of [
  [60, []],
  [64, []],
  [71, []],
  [72, ['NEXT TURN', 'PLAN', 'SESSION', 'CONTEXT']],
  [80, ['NEXT TURN', 'PLAN', 'SESSION', 'CONTEXT']],
  [88, ['NEXT TURN', 'PLAN', 'SESSION', 'CONTEXT']],
  [null, ['NEXT TURN', 'PLAN', 'SESSION', 'CONTEXT']],
])
  test(`at ${columns ?? 'no'} columns the Now sections draw in ${heads.length ? 'single-line boxes' : 'no box'}`, () => {
    const tree = render({}, { columns, usage: PLAN });
    const boxes = bordered(tree);
    assert.deepEqual(
      boxes.map((box) => texts(box)[0]),
      heads,
    );
    assert.ok(boxes.every((box) => box.props.borderStyle === 'single'));
    if (columns === null || !heads.length) return;
    const wide = screen(tree).filter((line) => [...line].length > columns);
    assert.deepEqual(wide, [], `${columns} columns`);
  });

for (const [columns, main] of [
  [60, '  main   ≈$4.30  ████████████████  −$4.70 vs Opus 5.5'],
  [52, '  main   ≈$4.30  ████████████████'],
])
  test(`at ${columns} columns the main cost bar ${main.includes(' vs ') ? 'keeps' : 'drops'} its note against no routing`, () => {
    assert.ok(lines({}, { columns }).includes(main));
  });
