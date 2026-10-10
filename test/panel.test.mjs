import assert from 'node:assert/strict';
import test from 'node:test';
import { bandSegments } from '../lib/band.mjs';
import { DEFAULTS, editActivity, loadConfig } from '../lib/config.mjs';
import { TIER_COLOR } from '../lib/display.mjs';
import { renderPanel, routeDraftOf, routingChanges } from '../lib/panel.mjs';
import { isSameModel } from '../lib/route.mjs';
import { controls, ELEMENTS, texts } from './harness.mjs';

const actions = new Proxy({}, { get: () => () => {} });
const KEYS_SET = { jev: null, clef: null, 'clef-flash': null };
const view = (props = {}) => ({ mode: 'auto', phase: 'routed', credentials: KEYS_SET, tab: 'now', ...props });
const pane = (props, usage = null, paneActions = actions) =>
  renderPanel(ELEMENTS, DEFAULTS, view(props), usage, paneActions);

test('the band, the pane and the router agree on which served model is a fallback', () => {
  for (const [selectedModel, actualModel, fallback] of [
    ['claude-sonnet-5-5', 'claude-sonnet-5-5', false],
    ['claude-haiku-4-5', 'claude-haiku-4-5-20251001', false],
    ['claude-sonnet-5-5', 'claude-sonnet-5-5-20260101', true],
    ['claude-sonnet-5-5', 'claude-opus-5-5', true],
  ]) {
    const routed = { tier: 'low', selectedModel, actualModel, effort: 'medium' };
    const band = bandSegments(DEFAULTS, view(routed), null, actions).flatMap((s) => s.parts);
    const label = `${selectedModel} served as ${actualModel}`;
    assert.equal(!isSameModel(selectedModel, actualModel), fallback, label);
    assert.equal(
      band.some((p) => p.text === ' fallback'),
      fallback,
      label,
    );
    assert.equal(texts(pane(routed)).includes('Served    '), fallback, label);
  }
});

test('the pane header is one on/off pair that marks the current mode and keeps the o and f hotkeys', () => {
  for (const [mode, expected] of [
    [
      'auto',
      [
        ['auto', '◉ on', 'o', 'primary'],
        ['manual', '○ off', 'f', 'secondary'],
      ],
    ],
    [
      'manual',
      [
        ['auto', '○ on', 'o', 'secondary'],
        ['manual', '◉ off', 'f', 'primary'],
      ],
    ],
  ]) {
    const pressed = [];
    const tree = pane({ mode }, null, { ...actions, mode: (to) => pressed.push(to) });
    const pair = controls(tree).filter((c) => c.key === 'auto' || c.key === 'manual');
    assert.deepEqual(
      pair.map((c) => [c.key, c.label, c.hotkey, c.variant]),
      expected,
      mode,
    );
    for (const c of pair) c.onPress();
    assert.deepEqual(pressed, ['auto', 'manual'], mode);
    const lines = texts(tree);
    assert.equal(lines[0], 'ROUTING', mode);
    assert.ok(lines.includes('  off keeps the /model choice'), mode);
    assert.ok(lines.includes('Jev ready'), mode);
  }
});

test('a pending pin shows on the Now tab with unpin', () => {
  let unpinned = 0;
  const tree = pane({ tier: 'low', selectedModel: 'claude-sonnet-5-5', pendingPin: 'high' }, null, {
    ...actions,
    unpin: () => {
      unpinned += 1;
    },
  });
  const lines = texts(tree);
  const at = lines.indexOf('Pinned    ');
  assert.deepEqual(lines.slice(at, at + 3), ['Pinned    ', 'next turn → ', 'high']);
  controls(tree)
    .find((c) => c.key === 'unpin')
    .onPress();
  assert.equal(unpinned, 1);
  assert.ok(!texts(pane({ tier: 'low', selectedModel: 'claude-sonnet-5-5' })).includes('Pinned    '));
});

test('help explains what the numbers are and that savings are not measured', () => {
  const lines = texts(pane({ help: true }));
  const at = lines.indexOf('ABOUT THESE NUMBERS');
  assert.deepEqual(lines.slice(at, at + 6), [
    'ABOUT THESE NUMBERS',
    'Cost, context and cache are Claude readings. $ estimates use the',
    'list prices in router.json; plan prices are equivalents, not cash.',
    'Routing savings are not measured. Cache benefit is before writes.',
    'The context bar uses the routed model’s window, 20% in reserve.',
    'A switch estimate prices 5m–1h cache writes; minus means cheaper.',
  ]);
  assert.ok(!texts(pane({ help: false })).includes('ABOUT THESE NUMBERS'));
});

test('the Usage tab compares the tiers of the last switch estimate', () => {
  for (const [paybackTurns, payback] of [
    [3, 'Payback               3 later turns'],
    [null, 'Payback               none projected'],
  ]) {
    const comparison = { incumbent: 'low', candidate: 'high', minUsd: -0.0123, maxUsd: 0.5, paybackTurns };
    const lines = texts(pane({ tab: 'usage', comparison }));
    const at = lines.indexOf('Compared tiers        low → high');
    assert.deepEqual(lines.slice(at, at + 3), [
      'Compared tiers        low → high',
      'Next-turn difference  −$0.012 to +$0.500',
      payback,
    ]);
  }
  assert.ok(!texts(pane({ tab: 'usage' })).some((line) => line.startsWith('Compared tiers')));
});

test('the Usage trend colors each reply by its tier and labels the range', () => {
  const nodes = [];
  (function walk(node) {
    if (node?.type === 'Text') nodes.push(node.props);
    if (Array.isArray(node?.props?.children)) node.props.children.forEach(walk);
  })(pane({ tab: 'usage', history: [1000, 5000], tiers: ['micro', 'low', 'high'] }));
  const at = nodes.findIndex((n) => n.children === '▁');
  assert.deepEqual(
    nodes.slice(at, at + 3).map((n) => [n.children, n.color ?? null]),
    [
      ['▁', TIER_COLOR.low],
      ['█', TIER_COLOR.high],
      ['  1.0K … 5.0K', null],
    ],
  );
});

const recording = () => {
  const calls = [];
  return {
    calls,
    actions: new Proxy(
      {},
      {
        get:
          (_, name) =>
          (...args) =>
            calls.push([name, ...args]),
      },
    ),
  };
};
const sonnetLow = { tier: 'low', selectedModel: 'claude-sonnet-5-5', effort: 'high', activity: 'code' };
const haikuLow = { tier: 'low', selectedModel: 'claude-haiku-5-5', effort: 'high', activity: 'code' };
const reading = { activityChoice: 'code', activityProbabilities: { code: 0.81, ops: 0.09, explore: 0.06, plan: 0 } };
const would = (activity, model, effort) => ({ wouldRoute: { activity, tier: 'low', model, effort, reason: 'x' } });
const after = (lines, label) => (lines.includes(label) ? lines[lines.indexOf(label) + 1] : null);

test('the Now tab shows the activity reading and the route its cell resolves to in each mode', () => {
  for (const [mode, props, route] of [
    ['on', sonnetLow, 'low + code → Sonnet 5.5 · high   (override)   base: Haiku 5.5 · high'],
    ['on', { ...haikuLow, activity: 'ops' }, 'low + ops → Haiku 5.5 · high (base)'],
    ['on', { ...haikuLow, activity: null }, 'low → Haiku 5.5 · high (base)'],
    [
      'shadow',
      { ...haikuLow, ...would('code', 'claude-sonnet-5-5', 'high') },
      'low + code would use Sonnet 5.5 · high (shadow; using Haiku 5.5 · high)',
    ],
    [
      'shadow',
      { ...haikuLow, ...would('ops', 'claude-haiku-5-5', 'high') },
      'low + ops would use Haiku 5.5 · high (shadow; same route)',
    ],
    ['shadow', haikuLow, null],
    ['off', haikuLow, null],
  ]) {
    const config = { ...DEFAULTS, activityRouting: mode };
    const lines = texts(renderPanel(ELEMENTS, config, view({ ...props, ...reading }), null, actions));
    const name = `${mode} ${JSON.stringify(props)}`;
    assert.equal(after(lines, 'Route     '), route, name);
    assert.equal(after(lines, 'Activity  '), mode === 'off' ? null : 'code 81%', name);
    if (mode !== 'off') assert.equal(lines[lines.indexOf('Activity  ') + 2], '   ops 9% · explore 6%', name);
  }
});

test('REPLIES letters each reply by its activity under its tier, aligned from the newest', () => {
  const lines = texts(pane({ tiers: ['low', 'low', 'medium', 'low'], activities: ['ops', null, 'docs'] }));
  const at = lines.indexOf('  2 switches');
  assert.deepEqual(lines.slice(at + 1, at + 6), ['  ', '·', 'o', '·', 'w']);
  assert.ok(lines.includes('  c code  d debug  e explore  p plan  r review  o ops  w docs'));
  const untagged = texts(pane({ tiers: ['low', 'medium'], activities: [] }));
  assert.ok(!untagged.some((l) => l.includes('w docs')));
});

const routing = (config, routeDraft = null, paneActions = actions) =>
  renderPanel(ELEMENTS, config, view({ tab: 'routing', routeDraft }), null, paneActions);
const matrix = (tree) => {
  const lines = texts(tree);
  const at = lines.findIndex((l) => l.startsWith('ACTIVITIES'));
  const end = lines.findIndex((l) => l.includes('distinct route'));
  return lines.slice(at, end + 1).map((l) => l.trimEnd());
};
const rowWarnings = (tree, activity, tier) => {
  let found;
  (function walk(node) {
    const children = Array.isArray(node?.props?.children) ? node.props.children : [];
    if (children.some((c) => c?.props?.children?.[0]?.props?.key === `activity-model-${activity}-${tier}`))
      found = children.find((c) => c?.type === 'Text' && c.props.color === 'yellow')?.props.children.trim() ?? '';
    children.forEach(walk);
  })(tree);
  return found;
};

test('the default overrides draw five distinct routes and warn about nothing', () => {
  const tree = routing(DEFAULTS);
  assert.deepEqual(matrix(tree), [
    'ACTIVITIES · routing on',
    'micro    low      medium   high',
    '  base                          H·med    H·high   O·med    O·xh',
    '  code debug plan review        ·        S·high   ·        ·',
    '  explore docs                  ·        ·        ·        ·',
    '  ops                           ·        ·        H·high   ·',
    '  5 distinct routes = 5 caches',
  ]);
  for (const [activity, tiers] of Object.entries(DEFAULTS.activities))
    for (const tier of Object.keys(tiers)) assert.equal(rowWarnings(tree, activity, tier), '', `${activity} ${tier}`);
});

test('override rows warn about no effect, a route above the next tier and a new cache', () => {
  const config = loadConfig();
  let draft = routeDraftOf(config, {});
  draft = editActivity(draft, config, 'code', 'high', 'add');
  draft = editActivity(draft, config, 'review', 'low', 'effort', 'xhigh');
  draft = editActivity(draft, config, 'review', 'low', 'model', 'opus');
  draft = editActivity(draft, config, 'ops', 'low', 'effort', 'max');
  const tree = routing(config, draft);
  for (const [activity, tier, expected] of [
    ['code', 'high', 'same as base: no effect'],
    ['review', 'low', 'stronger than the tier above'],
    ['ops', 'low', 'new (model, effort) pair: one more cache'],
    ['code', 'low', ''],
  ])
    assert.equal(rowWarnings(tree, activity, tier), expected, `${activity} ${tier}`);
});

test('the routing draft lists activity edits and the mode in the router.json diff', () => {
  const config = loadConfig();
  let draft = routeDraftOf(config, {});
  draft = editActivity(draft, config, 'code', 'high', 'effort', 'max');
  draft = editActivity(draft, config, 'review', 'low', 'remove');
  draft = { ...draft, activityRouting: 'shadow' };
  const changes = routingChanges(config, view({ routeDraft: draft }));
  assert.deepEqual(changes.cells, [
    ['code', 'high'],
    ['review', 'low'],
  ]);
  assert.equal(changes.mode, true);
  assert.equal(changes.count, 3);
  const lines = texts(routing(config, draft));
  const at = lines.indexOf('router.json changes:');
  assert.deepEqual(lines.slice(at + 1, at + 7), [
    '- activities.code.high           no override',
    '+ activities.code.high           Opus 5.5 · max',
    '- activities.review.low          Sonnet 5.5 · high',
    '+ activities.review.low          no override',
    '- activityRouting                on',
    '+ activityRouting                shadow',
  ]);
  assert.ok(lines.includes('● 3 unsaved routing changes  '));
  assert.equal(routingChanges(config, view()).count, 0);
});

test('a removed built-in override is not listed and can be added back', () => {
  const config = loadConfig({ userFile: { activities: { code: { low: { model: 'haiku', effort: 'high' } } } } });
  const tree = routing(config);
  const keys = controls(tree).map((c) => c.key);
  assert.ok(!keys.includes('activity-model-code-low'));
  assert.ok(keys.includes('activity-model-debug-low'));
  assert.ok(matrix(tree).includes('  code explore docs             ·        ·        ·        ·'));
  const add = controls(tree).find((c) => c.key === 'activity-add');
  assert.ok(add.options.some((o) => o.value === 'code.low'));
  assert.equal(routingChanges(config, view()).count, 0);
});

test('the Routing tab controls call the pane actions with the activity and tier', () => {
  const { calls, actions: recorded } = recording();
  const found = (key) => controls(routing(DEFAULTS, null, recorded)).find((c) => c.key === key);
  found('activity-mode').onSelect('shadow');
  found('activity-model-code-low').onSelect('opus');
  found('activity-effort-code-low').onSelect('session');
  found('activity-effort-ops-medium').onSelect('medium');
  found('activity-remove-ops-medium').onPress();
  found('activity-add').onSelect('code.high');
  found('activity-add').onSelect('');
  assert.deepEqual(calls, [
    ['activityMode', 'shadow'],
    ['activityModel', 'code', 'low', 'opus'],
    ['activityEffort', 'code', 'low', null],
    ['activityEffort', 'ops', 'medium', 'medium'],
    ['removeActivity', 'ops', 'medium'],
    ['addActivity', 'code', 'high'],
  ]);
});

const STATS = {
  byActivity: {
    code: { turns: 12, requests: 71, inputTokens: 0, outputTokens: 0 },
    explore: { turns: 5, requests: 22, inputTokens: 0, outputTokens: 0 },
    none: { turns: 3, requests: 3, inputTokens: 0, outputTokens: 0 },
  },
  switches: { tier: 4, activity: 5 },
  agreement: { matched: 19, total: 22 },
  shadow: { differs: 5, turns: 20, estimated: 3, minUsd: -0.3, maxUsd: -0.12 },
};
const STORE = {
  version: 1,
  confusion: { code: { code: 10, read: 3 }, ops: { ops: 4, code: 1 }, debug: { code: 2 }, uncertain: { talk: 2 } },
  runs: {},
  lateral: { taken: 4, refused: 2 },
  shadow: { differs: 6, turns: 18, estimated: 6, minUsd: -0.42, maxUsd: 0.18 },
};
const SESSION_LINES = [
  'ACTIVITY · this session',
  '   routing shadow',
  '                       turns  requests  share',
  '  code     ',
  '██████░░░░',
  '     12        71    60%',
  '  explore  ',
  '███░░░░░░░',
  '      5        22    25%',
  '  none     ',
  '██░░░░░░░░',
  '      3         3    15%',
  'Switches   9 · 4 by tier · 5 by activity',
  'Agreement  classifier vs tools: 19 of 22 turns (86%)',
];
const OFF_LINES = ['ACTIVITY · routing off', '  Not asked. Set activity routing to shadow or on in the Routing tab.'];
const ACROSS = 'ACROSS SESSIONS · since the last reset';
const ACROSS_LINES = [
  ' ',
  ACROSS,
  'Labelled   22 turns',
  'Agreement  classifier vs tools: 16 of 20 turns (80%)',
  'Code/ops/explore  classifier vs tools: 14 of 18 turns (78%)',
  'Mismatch   code → read 3 · ops → code 1',
  'Lateral    4 taken · 2 refused',
  'Shadow     on would route 6 of 18 turns differently · est. −$0.420 … +$0.180 at list prices',
];
const ACROSS_EMPTY = [' ', ACROSS, '  no turns recorded yet'];

test('the Usage tab shows the session activity block and the counts across sessions by mode', () => {
  const ops = { ...STATS, byActivity: { ops: STATS.byActivity.code }, agreement: { matched: 0, total: 0 } };
  const before = { ...STORE, shadow: { differs: 6, turns: 18 } };
  for (const [name, mode, activityStats, activityStore, expected] of [
    ['off, nothing recorded', 'off', null, null, OFF_LINES],
    ['off, counts from earlier sessions', 'off', null, STORE, [...OFF_LINES, ...ACROSS_LINES]],
    ['off, a corrupted store', 'off', null, { ...STORE, version: 2 }, OFF_LINES],
    [
      'off, no code, ops or explore answers',
      'off',
      null,
      {
        ...STORE,
        confusion: { debug: { code: 2, talk: 1 } },
        lateral: { taken: 0, refused: 0 },
        shadow: { differs: 0, turns: 0 },
      },
      [
        ...OFF_LINES,
        ' ',
        ACROSS,
        'Labelled   3 turns',
        'Agreement  classifier vs tools: 2 of 3 turns (67%)',
        'Mismatch   debug → talk 1',
      ],
    ],
    [
      'shadow, nothing yet',
      'shadow',
      null,
      null,
      ['ACTIVITY · this session', '   routing shadow', '  no activity readings yet', ...ACROSS_EMPTY],
    ],
    [
      'shadow, with data and a partial estimate',
      'shadow',
      STATS,
      STORE,
      [
        ...SESSION_LINES,
        'Shadow     on would route 5 of 20 turns differently · est. −$0.300 … −$0.120 for 3 at list prices',
        ...ACROSS_LINES,
      ],
    ],
    [
      'shadow, no differing turn had an estimate',
      'shadow',
      { ...STATS, shadow: { differs: 5, turns: 20, estimated: 0, minUsd: 0, maxUsd: 0 } },
      { ...STORE, shadow: { differs: 0, turns: 0 } },
      [...SESSION_LINES, 'Shadow     on would route 5 of 20 turns differently', ...ACROSS_LINES.slice(0, -1)],
    ],
    [
      'shadow, a 1.6.0 session view and store',
      'shadow',
      { ...STATS, shadow: { differs: 5, turns: 20 } },
      before,
      [
        ...SESSION_LINES,
        'Shadow     on would route 5 of 20 turns differently',
        ...ACROSS_LINES.slice(0, -1),
        'Shadow     on would route 6 of 18 turns differently',
      ],
    ],
    [
      'shadow, a corrupted store',
      'shadow',
      null,
      'garbage',
      ['ACTIVITY · this session', '   routing shadow', '  no activity readings yet', ...ACROSS_EMPTY],
    ],
    [
      'on, with data',
      'on',
      { ...ops, shadow: { differs: 0, turns: 0, estimated: 0, minUsd: 0, maxUsd: 0 } },
      STORE,
      [
        'ACTIVITY · this session',
        '   routing on',
        '                       turns  requests  share',
        '  ops      ',
        '██████████',
        '     12        71   100%',
        'Switches   9 · 4 by tier · 5 by activity',
        ...ACROSS_LINES,
      ],
    ],
    [
      'on, nothing across sessions',
      'on',
      null,
      null,
      ['ACTIVITY · this session', '   routing on', '  no activity readings yet', ...ACROSS_EMPTY],
    ],
  ]) {
    const { calls, actions: recorded } = recording();
    const tree = renderPanel(
      ELEMENTS,
      { ...DEFAULTS, activityRouting: mode },
      view({ tab: 'usage', activityStats, activityStore }),
      null,
      recorded,
    );
    const lines = texts(tree);
    const at = lines.findIndex((l) => l.startsWith('ACTIVITY'));
    assert.deepEqual(lines.slice(at, at + expected.length), expected, name);
    assert.equal(lines[at + expected.length], ' ', `${name}: no further activity lines`);
    const reset = controls(tree).find((c) => c.key === 'reset-activity-stats');
    reset.onPress();
    assert.deepEqual(calls, [['resetActivityStats']], `${name}: the stored counts can always be reset`);
  }
});
