// The terminal Classifier tab in a narrow pane: two lines per classifier, the status never squeezed to a word per line,
// and the layout the wide pane has when its widest row fits.
import assert from 'node:assert/strict';
import test from 'node:test';

process.env.TZ = 'UTC';

const { DEFAULTS } = await import('../lib/config.mjs');
const { classifierTwoLine, renderPanel } = await import('../lib/panel.mjs');
const { CLAUDE } = await import('./band-states.mjs');
const { ELEMENTS, find, hangs, kids, parentOf, recorder, screen, textOf } = await import('./harness.mjs');
const { NOW } = await import('./usage-fixtures.mjs');

const CLASSIFIER_IDS = Object.keys(DEFAULTS.classifiers);
const KEYS_SET = { jev: null, clef: null, 'clef-flash': null, 'clef-omni': null };
const MISSING = { ...KEYS_SET, 'clef-flash': 'missing-key' };

const classifier = (columns, credentials = MISSING, actions = recorder().actions) =>
  renderPanel(ELEMENTS, DEFAULTS, { mode: 'auto', phase: 'routed', tab: 'classifier', credentials }, CLAUDE, actions, {
    columns,
    now: NOW,
  });
// The wide layout draws a row of column titles; the two-line one does not.
const isTwoLine = (tree) => !textOf(tree).includes('prompt goes to');

for (const columns of [60, null])
  for (const id of CLASSIFIER_IDS)
    test(`at ${columns ?? 'no'} columns ${id} is two rows, its status truncated and Set up never shrunk`, () => {
      const tree = classifier(columns);
      assert.ok(isTwoLine(tree));
      const [name] = find(tree, (node) => node.props.key === `classifier-${id}`);
      const first = parentOf(tree, parentOf(tree, name));
      const block = parentOf(tree, first);
      assert.deepEqual(kids(block).length, 2, 'two rows');
      assert.equal(kids(block)[0], first);
      const status = kids(first).flatMap((cell) =>
        find(cell, (node) => node.type === 'Text' && node.props.wrap === 'truncate-end'),
      );
      assert.equal(status.length, 1, 'one status Text');
      assert.match(status[0].props.children, /^(● ready|○ no API (key|token)) *$/);
      // The status cell shrinks, keeping its mark: a long status is cut instead of pushing Set up off the row.
      assert.equal(parentOf(tree, status[0]).props.flexShrink, 1);
      const [setUp] = find(first, (node) => node.props.key === `key-${id}`);
      const missing = find(tree, (node) => node.props.key === `key-${id}`).length > 0;
      assert.equal(Boolean(setUp), missing, 'Set up is on the first row where the credential is missing');
      if (setUp) assert.equal(setUp.props.flexShrink ?? 0, 0);
    });

// The classifier rows' Buttons and what each press asks for.
function classifierPresses(columns) {
  const { actions, calls } = recorder();
  const buttons = find(classifier(columns, MISSING, actions), (node) =>
    /^(classifier|key)-/.test(node.props.key ?? ''),
  ).filter((node) => node.type === 'Button');
  for (const node of buttons) node.props.onPress();
  return { keys: buttons.map((node) => [node.props.key, node.props.label]), calls };
}

for (const columns of [60, null])
  test(`at ${columns ?? 'no'} columns the Classifier tab keeps the wide one's keys, labels and presses`, () => {
    assert.deepEqual(classifierPresses(columns), classifierPresses(100));
  });

// The widest wide row: `[ ○ Clef Flash ]`, host, probe, p95, `○ no API token  ` and `[ Set up ]`, 82 cells. With every
// key set (OpenAI still lacks one) it is `○ no API key  [ Set up ]`, 80 cells.
for (const [columns, credentials, twoLine] of [
  [80, MISSING, true],
  [81, MISSING, true],
  [82, MISSING, false],
  [84, MISSING, false],
  [79, KEYS_SET, true],
  [80, KEYS_SET, false],
])
  test(`at ${columns} columns with ${credentials === MISSING ? 'a missing token' : 'every key set'} the rows are ${twoLine ? 'two-line' : 'wide'}`, () => {
    assert.equal(isTwoLine(classifier(columns, credentials)), twoLine);
  });

for (const columns of [82, 84])
  test(`every wide row fits a ${columns}-column pane`, () => {
    const rows = screen(classifier(columns)).filter((line) => /^\[ [◉○] /.test(line));
    assert.ok(rows.length > 0);
    assert.deepEqual(
      rows.filter((line) => [...line].length > columns),
      [],
    );
  });

// The active classifier's help lines hang under its settings, as Policy's do.
for (const words of [
  'past the deadline the turn keeps its model',
  'the bounded active goal and current step also go to the classifier',
])
  for (const columns of [60, null])
    test(`at ${columns ?? 'no'} columns "${words}" hangs inside its value column`, () => {
      assert.equal(hangs(classifier(columns), words, 12), 'hangs');
    });

test('with no rows to draw the layout reads as fitting, with no -Infinity in the comparison', () => {
  assert.equal(classifierTwoLine([], 60), false);
  assert.equal(classifierTwoLine([], null), true);
});
