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
const sonnetLow = { tier: 'low', selectedModel: 'claude-sonnet-5-5', effort: 'medium', activity: 'code' };
const haikuLow = { tier: 'low', selectedModel: 'claude-haiku-5-5', effort: 'high', activity: 'code' };
const reading = { activityChoice: 'code', activityProbabilities: { code: 0.81, ops: 0.09, explore: 0.06, plan: 0 } };
const would = (activity, model, effort) => ({ wouldRoute: { activity, tier: 'low', model, effort, reason: 'x' } });
const after = (lines, label) => (lines.includes(label) ? lines[lines.indexOf(label) + 1] : null);

test('the Now tab shows the activity reading and the route its cell resolves to in each mode', () => {
  for (const [mode, props, route] of [
    ['on', sonnetLow, 'low + code → Sonnet 5.5 · medium   (override)   base: Haiku 5.5 · high'],
    ['on', { ...haikuLow, activity: 'ops' }, 'low + ops → Haiku 5.5 · high (base)'],
    ['on', { ...haikuLow, activity: null }, 'low → Haiku 5.5 · high (base)'],
    [
      'shadow',
      { ...haikuLow, ...would('code', 'claude-sonnet-5-5', 'medium') },
      'low + code would use Sonnet 5.5 · medium (shadow; using Haiku 5.5 · high)',
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
    'ACTIVITIES · routing shadow',
    'micro    low      medium   high',
    '  base                          H·med    H·high   O·med    O·xh',
    '  code debug plan review        ·        S·med    ·        ·',
    '  explore ops                   ·        ·        S·med    ·',
    '  docs                          ·        S·med    S·med    ·',
    '  5 distinct routes = 5 caches once activity routing is on',
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
  draft = editActivity(draft, config, 'docs', 'low', 'remove');
  draft = { ...draft, activityRouting: 'on' };
  const changes = routingChanges(config, view({ routeDraft: draft }));
  assert.deepEqual(changes.cells, [
    ['code', 'high'],
    ['docs', 'low'],
  ]);
  assert.equal(changes.mode, true);
  assert.equal(changes.count, 3);
  const lines = texts(routing(config, draft));
  const at = lines.indexOf('router.json changes:');
  assert.deepEqual(lines.slice(at + 1, at + 7), [
    '- activities.code.high           no override',
    '+ activities.code.high           Opus 5.5 · max',
    '- activities.docs.low            Sonnet 5.5 · medium',
    '+ activities.docs.low            no override',
    '- activityRouting                shadow',
    '+ activityRouting                on',
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
  assert.ok(matrix(tree).includes('  code                          ·        ·        ·        ·'));
  const add = controls(tree).find((c) => c.key === 'activity-add');
  assert.ok(add.options.some((o) => o.value === 'code.low'));
  assert.equal(routingChanges(config, view()).count, 0);
});

test('the Routing tab controls call the pane actions with the activity and tier', () => {
  const { calls, actions: recorded } = recording();
  const found = (key) => controls(routing(DEFAULTS, null, recorded)).find((c) => c.key === key);
  found('activity-mode').onSelect('on');
  found('activity-model-code-low').onSelect('opus');
  found('activity-effort-code-low').onSelect('session');
  found('activity-effort-docs-medium').onSelect('high');
  found('activity-remove-ops-medium').onPress();
  found('activity-add').onSelect('code.high');
  found('activity-add').onSelect('');
  assert.deepEqual(calls, [
    ['activityMode', 'on'],
    ['activityModel', 'code', 'low', 'opus'],
    ['activityEffort', 'code', 'low', null],
    ['activityEffort', 'docs', 'medium', 'high'],
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
  shadow: { differs: 5, turns: 20 },
};

test('the Usage tab shows activity counts, switches, agreement and the shadow readout by mode', () => {
  for (const [mode, activityStats, expected] of [
    ['off', null, ['ACTIVITY · routing off', '  Not asked. Set activity routing to shadow or on in the Routing tab.']],
    ['shadow', null, ['ACTIVITY · this session', '   routing shadow', '  no activity readings yet']],
    [
      'shadow',
      STATS,
      [
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
        'Shadow     on would route 5 of 20 turns differently',
      ],
    ],
    [
      'on',
      {
        ...STATS,
        byActivity: { ops: STATS.byActivity.code },
        agreement: { matched: 0, total: 0 },
        shadow: { differs: 0, turns: 0 },
      },
      [
        'ACTIVITY · this session',
        '   routing on',
        '                       turns  requests  share',
        '  ops      ',
        '██████████',
        '     12        71   100%',
        'Switches   9 · 4 by tier · 5 by activity',
      ],
    ],
  ]) {
    const { calls, actions: recorded } = recording();
    const tree = renderPanel(
      ELEMENTS,
      { ...DEFAULTS, activityRouting: mode },
      view({ tab: 'usage', activityStats }),
      null,
      recorded,
    );
    const lines = texts(tree);
    const at = lines.findIndex((l) => l.startsWith('ACTIVITY'));
    assert.deepEqual(lines.slice(at, at + expected.length), expected, `${mode} ${Boolean(activityStats)}`);
    assert.equal(lines[at + expected.length], ' ', `${mode}: no further activity lines`);
    const reset = controls(tree).find((c) => c.key === 'reset-activity-stats');
    reset.onPress();
    assert.deepEqual(calls, [['resetActivityStats']], `${mode}: the stored counts can always be reset`);
  }
});
