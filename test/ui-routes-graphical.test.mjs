// The Routes tab on desktop, VS Code and mobile: a Routes card holding the tier × activity grid, the selected cell's
// editor in its own card under it, and a Prompt caches card. The terminal rows are pinned by ui-golden.test.mjs.
import assert from 'node:assert/strict';
import test from 'node:test';

const { ACTIVITIES, DEFAULTS, TIERS } = await import('../lib/config.mjs');
const { renderPanel, routeDraftOf } = await import('../lib/panel.mjs');
const { toneColor } = await import('../lib/ui/tokens.mjs');
const { ROUTED } = await import('./band-states.mjs');
const { byKey, controls, ELEMENTS, find, kids, texts } = await import('./harness.mjs');

const SURFACES = ['desktop', 'vscode', 'mobile'];
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
const VIEW = { ...ROUTED, tab: 'routes', credentials: { jev: null } };
const draw = (props = {}, { surface = 'desktop', config = DEFAULTS, columns = 100 } = {}) =>
  renderPanel(ELEMENTS, config, { ...VIEW, ...props }, null, actions, { columns, surface });

const isCard = (n) => n.props.borderStyle === 'round';
const titleOf = (n) => texts(kids(n)[0])[0];
const cards = (tree) => find(tree, isCard);
const card = (tree, title) =>
  cards(tree).find((n) => (title instanceof RegExp ? title.test(titleOf(n)) : titleOf(n) === title));
const body = (tree) => byKey(tree, 'body');
const gridRows = (tree) => kids(byKey(tree, 'routes-grid'));
// A wide grid row: the label column, then one column per tier.
const columnsOf = (row) => 1 + kids(kids(row)[1]).length;

// A custom provider model whose router.json name runs to 90 characters, on the medium tier.
const LONG_KEY = `vendor-${'very-long-model-name-'.repeat(4)}final`.padEnd(90, 'x');
const LONG_KEYED = {
  ...DEFAULTS,
  models: { ...DEFAULTS.models, [LONG_KEY]: { ...DEFAULTS.models.sonnet, id: 'vendor-long' } },
  routes: { ...DEFAULTS.routes, medium: { model: LONG_KEY, effort: 'high' } },
};
// A custom provider model whose display name runs past 90 characters, on the medium tier.
const LONG_ID = `vendor-${'very-long-model-name-'.repeat(4)}final`;
const LONG_NAMED = {
  ...DEFAULTS,
  models: { ...DEFAULTS.models, long: { ...DEFAULTS.models.sonnet, id: LONG_ID } },
  routes: { ...DEFAULTS.routes, medium: { model: 'long', effort: 'high' } },
};
// An unsaved draft: the micro route and the code-at-medium cell changed.
const DRAFT = (() => {
  const draft = routeDraftOf(DEFAULTS, {});
  return {
    ...draft,
    routes: { ...draft.routes, micro: { model: 'sonnet', effort: 'high' } },
    activities: { ...draft.activities, code: { ...draft.activities.code, medium: { model: 'fable', effort: 'max' } } },
  };
})();

for (const surface of SURFACES) {
  test(`${surface}: the grid is one header row and a Default row and one per activity, every row with the same columns`, () => {
    const rows = gridRows(draw({}, { surface }));
    assert.equal(rows.length, 2 + ACTIVITIES.length);
    assert.equal(rows[0].props.key, 'grid-head');
    assert.deepEqual(
      rows.slice(1).map((row) => row.props.key),
      ['grid-tier', ...ACTIVITIES.map((activity) => `grid-${activity}`)],
    );
    for (const row of rows) assert.equal(columnsOf(row), 1 + TIERS.length, row.props.key);
    // A row label wraps rather than being cut.
    for (const row of rows.slice(1)) assert.equal(kids(kids(row)[0])[0].props.wrap, 'wrap', row.props.key);
    // The label column has one fixed width on every row, so the tier columns line up.
    const widths = new Set(rows.map((row) => kids(row)[0].props.width));
    assert.equal(widths.size, 1);
    assert.ok(Number.isFinite([...widths][0]));
    // Equal tier columns.
    for (const row of rows)
      for (const col of kids(kids(row)[1])) assert.equal(col.props.width, `${100 / TIERS.length}%`);
  });

  test(`${surface}: the header names every tier beside its meter; Default holds each tier's route`, () => {
    const tree = draw({}, { surface });
    const head = byKey(tree, 'grid-head');
    for (const tier of TIERS) assert.ok(texts(head).includes(tier), tier);
    assert.equal(find(head, (n) => n.type === 'Svg').length, TIERS.length);
    assert.deepEqual(texts(kids(byKey(tree, 'grid-tier'))[0]), ['Default']);
    assert.deepEqual(texts(byKey(tree, 'cell-tier-medium')), ['Opus 5.5 · medium']);
    assert.deepEqual(texts(byKey(tree, 'cell-tier-low')), ['Haiku 5.5 · high']);
  });

  test(`${surface}: an activity cell shows its override, or a muted dash where it runs the tier's model`, () => {
    const tree = draw({}, { surface });
    // code at low is a built-in default: marked °.
    assert.deepEqual(texts(byKey(tree, 'cell-code-low')), ['Sonnet 5.5 · high', '°']);
    const inherits = byKey(tree, 'cell-code-medium');
    assert.deepEqual(texts(inherits), ['—']);
    assert.equal(kids(inherits)[0].props.color, toneColor('muted', 'graphical'));
    for (const cell of [inherits, byKey(tree, 'cell-code-low')]) assert.equal(cell.type, 'Button');
  });

  for (const columns of [100, 60])
    test(`${surface}: at ${columns} columns a cell names its model and effort as the editor's Selects show them, inherit included`, () => {
      const draft = routeDraftOf(DEFAULTS, {});
      const routes = {
        ...draft.routes,
        medium: { model: 'opus', effort: null },
        low: { model: 'haiku', effort: 'medium' },
      };
      const tree = draw({ routeCell: 'tier.medium', routeDraft: { ...draft, routes } }, { surface, columns });
      const shown = (key) => {
        const select = byKey(card(tree, /^Edit /), key);
        return select.props.options.find((option) => option.value === select.props.value).label;
      };
      assert.equal(shown('route-medium-effort'), 'inherit');
      const route = texts(byKey(tree, 'cell-tier-medium')).find((one) => one.includes('·'));
      assert.equal(route, `${shown('route-medium-model')} · ${shown('route-medium-effort')}`);
      // A full effort word in every layout: never the terminal's short ones, nor "session".
      assert.ok(texts(byKey(tree, 'cell-tier-low')).includes('Haiku 5.5 · medium'));
      for (const cell of find(byKey(tree, 'routes-grid'), (n) => n.type === 'Button'))
        assert.doesNotMatch(texts(cell).join(' '), /session|·(med|inh|xh)\b/, cell.props.key);
    });

  test(`${surface}: a cell press selects it; the selected cell is primary and an unsaved one carries a dot`, () => {
    calls.length = 0;
    byKey(draw({}, { surface }), 'cell-tier-medium').props.onPress();
    assert.deepEqual(calls, [['selectCell', 'tier.medium']]);
    const tree = draw({ routeCell: 'code.medium', routeDraft: DRAFT }, { surface });
    assert.equal(byKey(tree, 'cell-code-medium').props.variant, 'primary');
    assert.equal(byKey(tree, 'cell-tier-medium').props.variant, 'secondary');
    assert.ok(texts(byKey(tree, 'cell-code-medium')).includes('●'));
    assert.ok(texts(byKey(tree, 'cell-tier-micro')).includes('●'));
    assert.ok(!texts(byKey(tree, 'cell-tier-low')).includes('●'));
  });

  test(`${surface}: selecting a cell adds exactly one editor card after the grid card and no row inside the grid`, () => {
    const plain = draw({}, { surface });
    assert.equal(card(plain, /^Edit /), undefined);
    const tree = draw({ routeCell: 'tier.medium' }, { surface });
    assert.equal(gridRows(tree).length, gridRows(plain).length);
    const editors = cards(tree).filter((n) => /^Edit /.test(titleOf(n)));
    assert.equal(editors.length, 1);
    assert.equal(titleOf(editors[0]), 'Edit Default at medium');
    const stack = kids(kids(body(tree))[0]);
    const routes = stack.findIndex((n) => isCard(n) && titleOf(n) === 'Routes');
    assert.ok(routes >= 0);
    assert.equal(stack[routes + 1], editors[0]);
    assert.ok(byKey(editors[0], 'route-medium-model'));
    assert.equal(byKey(card(tree, 'Routes'), 'route-medium-model'), undefined);
  });

  test(`${surface}: the tier editor's Selects keep their keys and answer`, () => {
    const editor = card(draw({ routeCell: 'tier.medium' }, { surface }), /^Edit /);
    calls.length = 0;
    byKey(editor, 'route-medium-model').props.onSelect('sonnet');
    byKey(editor, 'route-medium-effort').props.onSelect('session');
    byKey(editor, 'route-medium-effort').props.onSelect('high');
    assert.deepEqual(calls, [
      ['routeModel', 'medium', 'sonnet'],
      ['routeEffort', 'medium', null],
      ['routeEffort', 'medium', 'high'],
    ]);
    assert.match(texts(editor).join(' '), /\$4 in · \$20 out per M tokens · 1M window/);
  });

  test(`${surface}: an override's editor has its state, Remove override and Restore default, and its warnings`, () => {
    const view = { routeCell: 'code.medium', routeDraft: DRAFT };
    const editor = card(draw(view, { surface }), 'Edit code at medium');
    assert.ok(editor);
    assert.ok(byKey(editor, 'activity-code-medium-model'));
    assert.ok(byKey(editor, 'activity-code-medium-effort'));
    const words = texts(editor).join('\n');
    assert.match(words, /Your override/);
    assert.match(words, /Stronger than the tier above/);
    const remove = byKey(editor, 'activity-tier-code-medium');
    assert.equal(remove.props.label, 'Remove override');
    calls.length = 0;
    remove.props.onPress();
    assert.deepEqual(calls, [['removeActivity', 'code', 'medium']]);
    for (const warning of find(editor, (n) => n.type === 'Text' && /Stronger/.test(n.props.children)))
      assert.equal(warning.props.color, toneColor('warning', 'graphical'));
    // A built-in default moved off its preset offers the way back.
    const moved = (() => {
      const draft = routeDraftOf(DEFAULTS, {});
      return { ...draft, activities: { ...draft.activities, code: { low: { model: 'opus', effort: 'low' } } } };
    })();
    const back = card(draw({ routeCell: 'code.low', routeDraft: moved }, { surface }), 'Edit code at low');
    assert.ok(byKey(back, 'activity-default-code-low'));
  });

  test(`${surface}: the activity mode control and its hint sit in the Routes card header`, () => {
    const routes = card(draw({}, { surface }), 'Routes');
    const header = kids(routes)[0];
    const select = byKey(header, 'activity-mode');
    assert.equal(select?.type, 'Select');
    assert.equal(select.props.value, 'on');
    assert.ok(texts(header).includes('An activity can change its tier’s model'));
    calls.length = 0;
    select.props.onSelect('off');
    assert.deepEqual(calls, [['activityMode', 'off']]);
    assert.ok(byKey(routes, 'reset-routes'));
    assert.equal(byKey(routes, 'reset-routes').props.hotkey, 'r');
  });

  test(`${surface}: the cache lines are a Prompt caches card; the warnings are in the warning tone`, () => {
    const tree = draw({ mode: 'manual', phase: 'manual' }, { surface });
    assert.match(texts(card(tree, 'Prompt caches')).join(' '), /prompt caches in use/);
    const off = find(
      card(tree, 'Routes'),
      (n) => n.type === 'Text' && /not in use: routing is off/.test(n.props.children),
    );
    assert.equal(off.length, 1);
    assert.equal(off[0].props.color, toneColor('warning', 'graphical'));
    const same = draw(
      { routeDraft: { ...routeDraftOf(DEFAULTS, {}), routes: { ...DEFAULTS.routes, high: DEFAULTS.routes.medium } } },
      { surface },
    );
    assert.match(texts(card(same, 'Routes')).join(' '), /Medium and high run the same model and effort/);
  });

  test(`${surface}: a cell names a model by its display name, not its 90-character router.json key`, () => {
    const tree = draw({}, { surface, config: LONG_KEYED });
    assert.deepEqual(texts(byKey(tree, 'cell-tier-medium')), ['Vendor Long · high']);
    assert.doesNotMatch(texts(byKey(tree, 'routes-grid')).join(' '), new RegExp(LONG_KEY));
    for (const tier of TIERS) assert.ok(texts(byKey(tree, 'grid-head')).includes(tier), tier);
  });

  test(`${surface}: a 90-character display name truncates in its cell and the tier header stays visible`, () => {
    const tree = draw({}, { surface, config: LONG_NAMED });
    const label = find(byKey(tree, 'cell-tier-medium'), (n) => n.type === 'Text' && n.props.children.length > 80)[0];
    assert.ok(label, 'the long label');
    assert.equal(label.props.wrap, 'truncate-end');
    const column = find(byKey(tree, 'grid-tier'), (n) => kids(n).includes(byKey(tree, 'cell-tier-medium')))[0];
    assert.equal(column.props.overflow, 'hidden');
    for (const tier of TIERS) assert.ok(texts(byKey(tree, 'grid-head')).includes(tier), tier);
    for (const row of gridRows(tree)) assert.equal(columnsOf(row), 1 + TIERS.length);
  });

  for (const columns of [60, null])
    test(`${surface}: at ${columns ?? 'no'} columns each row is its label over its tiers, wrapped, the label never clipped`, () => {
      const tree = draw({}, { surface, columns });
      assert.equal(byKey(tree, 'grid-head'), undefined);
      const rows = gridRows(tree);
      assert.equal(rows.length, 1 + ACTIVITIES.length);
      for (const row of rows) {
        const [label, cells] = kids(row);
        assert.equal(row.props.flexDirection, 'column');
        assert.equal(label.type, 'Text');
        assert.equal(label.props.wrap, 'wrap');
        assert.equal(cells.props.flexWrap, 'wrap');
        assert.equal(kids(cells).length, TIERS.length);
      }
      // Without the header, each Button names its tier by its bars.
      assert.deepEqual(texts(byKey(tree, 'cell-tier-medium')), ['▂▄▆', 'Opus 5.5 · medium']);
    });

  test(`${surface}: the body uses tones, never terminal colours or dim text`, () => {
    const tree = draw({ routeCell: 'code.medium', routeDraft: DRAFT, mode: 'manual', phase: 'manual' }, { surface });
    const graphical = new Set([
      ...['primary', 'muted', 'accent', 'success', 'warning', 'danger', 'activity'].map((t) =>
        toneColor(t, 'graphical'),
      ),
      ...TIERS.map((tier) => toneColor(`tier:${tier}`, 'graphical')),
    ]);
    for (const node of find(body(tree), (n) => n.type === 'Text')) {
      assert.equal(node.props.dimColor, undefined, node.props.children);
      assert.equal(node.props.bold, undefined, node.props.children);
      if (node.props.color) assert.ok(graphical.has(node.props.color), `${node.props.children}: ${node.props.color}`);
    }
    for (const control of controls(body(tree))) assert.equal(control.plain, undefined, control.key);
  });

  test(`${surface}: a view with no usage or readings shows no NaN, undefined or stray ?`, () => {
    for (const routeCell of [undefined, 'tier.micro', 'code.medium']) {
      const tree = draw({ routeCell, adviceMs: Number.NaN, inputTokens: Number.NaN }, { surface });
      const words = texts(body(tree)).join('\n');
      assert.doesNotMatch(words, /NaN|undefined|\?/, routeCell);
      assert.doesNotMatch(
        controls(body(tree))
          .map((c) => c.label ?? '')
          .join(' '),
        /NaN|undefined|\?/,
      );
    }
    // A model with no output price omits it rather than print a question mark.
    const unpriced = {
      ...DEFAULTS,
      models: { ...DEFAULTS.models, opus: { ...DEFAULTS.models.opus, output: undefined } },
    };
    const words = texts(card(draw({ routeCell: 'tier.medium' }, { surface, config: unpriced }), /^Edit /)).join(' ');
    assert.doesNotMatch(words, /\?/);
    assert.match(words, /\$4 in per M tokens · 1M window/);
  });
}
