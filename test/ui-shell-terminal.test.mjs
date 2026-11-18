// The terminal pane's frame: a header that says a warning once, a tab row that fits the pane, the help behind `?`, and
// the way back from two band rows.
import assert from 'node:assert/strict';
import test from 'node:test';

process.env.TZ = 'UTC';

const { renderBand } = await import('../lib/band.mjs');
const { DEFAULTS } = await import('../lib/config.mjs');
const { renderPanel } = await import('../lib/panel.mjs');
const { routeDraftOf } = await import('../lib/ui/model/draft.mjs');
const { BAND_STATES, CLAUDE } = await import('./band-states.mjs');
const { duplicates, ELEMENTS, find, kids, parentOf, quiet, recorder, textOf } = await import('./harness.mjs');
const { NOW } = await import('./usage-fixtures.mjs');

const KEYS_SET = { jev: null, clef: null, 'clef-flash': null, 'clef-omni': null };
const TABS = ['now', 'routes', 'policy', 'classifier', 'usage'];
const NO_KEYS = { 'keys set': KEYS_SET, 'no keys': {} };

const pane = (view, columns, actions = quiet) =>
  renderPanel(ELEMENTS, DEFAULTS, { mode: 'auto', phase: 'routed', ...view }, CLAUDE, actions, { columns, now: NOW });
const headerOf = (tree) => kids(tree)[0];
const tabRowOf = (tree) => kids(tree).find((node) => find(node, (one) => one.props.key === 'tab-now').length);
const buttonsOf = (tree) => find(tree, (node) => node.type === 'Button');
const hasText = (tree, words) => find(tree, (node) => node.type === 'Text' && node.props.children === words).length > 0;

for (const tab of TABS)
  test(`${tab}: a header over the classifier warning says see below instead of repeating it`, () => {
    const tree = pane({ tab, credentials: {} }, 80);
    assert.doesNotMatch(textOf(headerOf(tree)), /no API key/);
    assert.ok(hasText(headerOf(tree), 'see below'));
    assert.equal(textOf(tree).split('no API key, keeping the model').length - 1, 1, 'the warning appears once');
  });

for (const [name, view, status] of [
  ['ready', { credentials: KEYS_SET, adviceMs: 347 }, 'Jev ready · 347 ms'],
  ['timed out', { credentials: KEYS_SET, error: 'timeout' }, 'Jev timed out'],
  // Routing off draws no notice, so the header still names the missing key.
  ['routing off', { credentials: {}, mode: 'manual', phase: 'manual' }, 'Jev: no API key'],
])
  test(`a header without a notice keeps its classifier status: ${name}`, () => {
    const head = headerOf(pane({ tab: 'now', ...view }, 80));
    assert.ok(hasText(head, status), textOf(head));
  });

// The tab row's width as the terminal draws it: a Button is its label in `[ ` and ` ]`.
const rowWidth = (row) =>
  kids(row).reduce(
    (n, node) => n + (node.type === 'Button' ? node.props.label.length + 4 : String(node.props.children).length),
    0,
  );
// Unsaved Routes and Policy drafts: both tabs carry a ● mark, the widest row.
const BASE_DRAFT = routeDraftOf(DEFAULTS, {});
const UNSAVED_DRAFT = {
  ...BASE_DRAFT,
  baselineTier: 'micro',
  routes: { ...BASE_DRAFT.routes, micro: { model: 'sonnet', effort: 'high' } },
};
const TAB_ROW_VIEWS = {
  plain: { tab: 'now', credentials: KEYS_SET },
  unsaved: { tab: 'routes', credentials: KEYS_SET, tuning: { horizon: 10 }, routeDraft: UNSAVED_DRAFT },
  unavailable: { tab: 'now', phase: 'unavailable', error: 'bad router.json' },
};

for (const [name, view] of Object.entries(TAB_ROW_VIEWS))
  for (const columns of [60, 70, 80, 120])
    test(`${name} at ${columns} columns: the tab row fits and keeps every tab, its hotkey and help`, () => {
      const tree = pane(view, columns);
      const row = tabRowOf(tree);
      assert.ok(rowWidth(row) <= columns, `the row is ${rowWidth(row)} wide`);
      // A click lands on one Button: a space keeps neighbours apart.
      const parts = kids(row);
      const touching = parts.filter((node, i) => node.type === 'Button' && parts[i + 1]?.type === 'Button');
      assert.deepEqual(touching, [], 'two Buttons touch');
      const keyed = Object.fromEntries(buttonsOf(tree).map((node) => [node.props.key, node.props.hotkey]));
      assert.deepEqual(
        TABS.map((id) => keyed[`tab-${id}`]),
        TABS.map((_id, i) => String(i + 1)),
      );
      const help = buttonsOf(tree).filter((node) => node.props.key === 'help');
      assert.equal(help.length, 1);
      // The help Button is on the tab row, or at the header line's end when the row has no room for it.
      assert.ok(parts.includes(help[0]) || kids(headerOf(tree)).at(-1) === help[0]);
      if (kids(headerOf(tree)).includes(help[0]))
        assert.ok(textOf(headerOf(tree)).length <= columns, textOf(headerOf(tree)));
    });

for (const [columns, labels] of [
  [80, ['1 Now', '2 Routes', '3 Policy', '4 Classifier', '5 Usage', '?']],
  [60, ['Now', 'Routes', 'Policy', 'Classifier', 'Usage', '?']],
])
  test(`the tab row at ${columns} columns reads ${labels.join(' | ')}`, () => {
    const row = tabRowOf(pane({ tab: 'now', credentials: KEYS_SET }, columns));
    assert.deepEqual(
      kids(row)
        .filter((node) => node.type === 'Button')
        .map((node) => node.props.label),
      labels,
    );
  });

// The engine cannot tell two elements with one key or hotkey apart.
for (const tab of TABS)
  for (const [credentials, keys] of Object.entries(NO_KEYS))
    test(`${tab} with ${credentials}: every key and hotkey is drawn once, at any width`, () => {
      const clashes = [60, 100, null].map((columns) => duplicates(pane({ tab, credentials: keys }, columns)));
      assert.deepEqual(clashes, Array(3).fill({ keys: [], hotkeys: [] }));
    });

test('on the Classifier tab the warning has no Set up of its own: the Credentials row has the action', () => {
  const tree = pane({ tab: 'classifier', credentials: {} }, 100);
  const owners = find(tree, (node) => node.type === 'Button' && node.props.hotkey === 'k');
  assert.deepEqual(
    owners.map((node) => [node.props.key, node.props.label]),
    [['key', 'Edit']],
  );
  assert.match(textOf(tree), /Jev: no API key, keeping the model/);
});

test('on another tab the classifier warning keeps its Set up', () => {
  const setUp = find(pane({ tab: 'now', credentials: {} }, 100), (node) => node.props.key === 'key');
  assert.deepEqual(
    setUp.map((node) => node.props.label),
    ['Set up'],
  );
});

// The help behind `?`: whole paragraphs the terminal wraps to the pane (the goldens pin their words).
for (const columns of [50, 60, 100, null])
  test(`the help at ${columns ?? 'no'} columns is one wrapping Text per paragraph, not lines cut to a width`, () => {
    const nodes = kids(pane({ tab: 'now', credentials: KEYS_SET, help: true }, columns));
    const head = nodes.findIndex((node) => node.type === 'Text' && node.props.children === 'ABOUT THESE NUMBERS');
    assert.ok(head >= 0);
    const paragraphs = nodes.slice(head + 1).filter((node) => node.props.wrap === 'wrap');
    assert.ok(paragraphs.length >= 6, `${paragraphs.length} paragraphs`);
    for (const node of paragraphs) assert.ok(!String(node.props.children).includes('\n'));
  });

// The terminal's way back from two band rows that needs no band room: a toggle on the Now tab's SESSION line.
const SESSION_VIEWS = {
  routed: { credentials: KEYS_SET },
  empty: { credentials: KEYS_SET, usageSession: null, strip: null },
  off: { mode: 'manual', phase: 'manual', nativeModel: 'claude-opus-5-5' },
  unavailable: { phase: 'unavailable', error: 'bad router.json' },
};

for (const [name, view] of Object.entries(SESSION_VIEWS))
  for (const bandDetail of [true, false])
    for (const columns of [40, 60, 100, null])
      test(`${name} with ${bandDetail ? 'two rows' : 'one row'} at ${columns ?? 'no'} columns: the SESSION line toggles the band's rows`, () => {
        const { actions, calls } = recorder();
        const tree = pane({ tab: 'now', bandDetail, ...view }, columns, actions);
        const toggles = find(tree, (node) => node.props.key === 'band-detail-toggle');
        assert.equal(toggles.length, 1);
        assert.equal(toggles[0].props.label, bandDetail ? 'band: 1 row' : 'band: 2 rows');
        assert.ok(kids(parentOf(tree, toggles[0])).some((node) => node.props.children === 'SESSION'));
        toggles[0].props.onPress();
        assert.deepEqual(calls, [['toggleDetail']]);
      });

test('with two band rows the terminal always has a way back to one, at every width', () => {
  const view = { ...BAND_STATES.routed.view, bandDetail: true };
  const noWayBack = [];
  for (let columns = 24; columns <= 160; columns += 1) {
    const back = [
      ...find(
        renderBand(ELEMENTS, DEFAULTS, view, null, { columns, now: NOW }, quiet),
        (node) => node.props.key === 'band-detail',
      ),
      ...find(
        pane({ ...view, tab: 'now', credentials: KEYS_SET }, columns),
        (node) => node.props.key === 'band-detail-toggle',
      ),
    ];
    if (!back.length) noWayBack.push(columns);
  }
  assert.deepEqual(noWayBack, []);
});

test('in a 70-column pane the band itself offers 1 row on hover', () => {
  const view = { ...BAND_STATES.routed.view, bandDetail: true };
  const tree = renderBand(ELEMENTS, DEFAULTS, view, null, { columns: 70, now: NOW }, quiet);
  assert.ok(find(tree, (node) => node.props.key === 'band-detail' && node.props.label === '1 row').length);
});
