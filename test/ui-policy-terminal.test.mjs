// The terminal Policy tab: a field's lines hang in a column beside its label, so a wrapped line stays in that column,
// and every control keeps its press.
import assert from 'node:assert/strict';
import test from 'node:test';

process.env.TZ = 'UTC';

const { DEFAULTS } = await import('../lib/config.mjs');
const { renderPanel } = await import('../lib/panel.mjs');
const { ELEMENTS, find, hangs, recorder, screen, texts } = await import('./harness.mjs');
const { NOW } = await import('./usage-fixtures.mjs');

const VIEW = {
  mode: 'auto',
  phase: 'routed',
  tab: 'policy',
  credentials: { jev: null, clef: null, 'clef-flash': null, 'clef-omni': null },
  routingMode: { mode: 'cost', source: 'session' },
  configPath: '/fixture/router.json',
};
const LABEL_WIDTH = 13;
const HELP = [
  'each tier runs its route as configured',
  'this session runs cost (session)',
  'when the session’s model is no tier’s model',
  'else a new task runs its tier’s model; a continuation keeps it',
  'no model in router.json bills credits, so this has no effect',
  'needs Jev support of 75%, up to 90% as the switch costs more',
];

const policy = (columns, actions = recorder().actions) =>
  renderPanel(ELEMENTS, DEFAULTS, VIEW, null, actions, { columns, now: NOW });

for (const columns of [60, 80, null])
  for (const words of HELP)
    test(`at ${columns ?? 'no'} columns "${words}" hangs inside its value column`, () => {
      assert.equal(hangs(policy(columns), words, LABEL_WIDTH), 'hangs');
    });

for (const columns of [60, 80, null])
  test(`at ${columns ?? 'no'} columns no help line is padded with spaces in place of a column`, () => {
    const padded = find(
      policy(columns),
      (node) => node.type === 'Text' && /^ {3,}\S/.test(String(node.props.children)) && node.props.wrap === 'wrap',
    );
    assert.deepEqual(padded, []);
  });

const SELECTS = ['routing-mode', 'baseline', 'downgradeVotes', 'horizon', 'activityMass', 'cashCapUsd'];

for (const key of SELECTS)
  test(`the ${key} control is a Select`, () => {
    assert.equal(find(policy(60), (node) => node.props.key === key)[0]?.type, 'Select');
  });

for (const [key, args, expected] of [
  ['routing-mode', ['cost'], ['routingMode', 'cost']],
  ['baseline', ['low'], ['baseline', 'low']],
  ['horizon', [5], ['tune', 'horizon', 5]],
])
  test(`choosing in ${key} asks for ${expected.join(' ')}`, () => {
    const { actions, calls } = recorder();
    find(policy(60, actions), (node) => node.props.key === key)[0].props.onSelect(...args);
    assert.deepEqual(calls, [expected]);
  });

for (const [key, expected] of [
  ['reset-policy', ['resetPolicy']],
  ['copy-path', ['copyPath']],
])
  test(`pressing ${key} asks for ${expected[0]}`, () => {
    const { actions, calls } = recorder();
    find(policy(60, actions), (node) => node.props.key === key)[0].props.onPress();
    assert.deepEqual(calls, [expected]);
  });

// From 72 columns the POLICY block through Reset is one single-line box; the file and the subagents line stay outside.
for (const [columns, boxed] of [
  [60, false],
  [80, true],
  [88, true],
])
  test(`at ${columns} columns the policy controls draw ${boxed ? 'in one box, no line wider than the pane' : 'in no box'}`, () => {
    const tree = policy(columns);
    const boxes = find(tree, (node) => node.type === 'Box' && node.props.borderStyle !== undefined);
    assert.equal(boxes.length, boxed ? 1 : 0);
    if (!boxed) return;
    assert.equal(boxes[0]?.props.borderStyle, 'single');
    const words = texts(boxes[0]);
    assert.equal(words[0], 'POLICY');
    assert.ok(find(boxes[0], (node) => node.props.key === 'reset-policy').length);
    assert.ok(!words.includes('FILE'));
    assert.deepEqual(
      screen(tree).filter((line) => [...line].length > columns),
      [],
    );
  });
