// The terminal band's hover controls, drawn over its readings instead of on a row of their own: they cover none of the
// band's Buttons, fit the band, and each is drawn once.
import assert from 'node:assert/strict';
import test from 'node:test';

process.env.TZ = 'UTC';

const { renderBand } = await import('../lib/band.mjs');
const { partsWidth, SEPARATOR } = await import('../lib/ui/model/band.mjs');
const { DEFAULTS } = await import('../lib/config.mjs');
const { BAND_STATES, CLAUDE } = await import('./band-states.mjs');
const { ELEMENTS, find, kids, quiet, recorder } = await import('./harness.mjs');
const { NOW } = await import('./usage-fixtures.mjs');

const COLUMNS = [140, 120, 100, 80, 70, 60, 40, null];

const band = (view, usage, columns, actions = quiet) =>
  renderBand(ELEMENTS, DEFAULTS, view, usage ?? null, { columns, now: NOW }, actions);
const elementKids = (node) => kids(node).filter((child) => typeof child === 'object');
// The hover controls: what the band draws over its resting row.
const isHover = (node) => node.props.position === 'absolute';
const hoverOf = (tree) => find(tree, (node) => node.type === 'Box' && isHover(node));
const restingOf = (row) => elementKids(row).filter((node) => !isHover(node));
// An element back as the band's own part, so the band's own `partsWidth` measures it.
const asPart = (node) =>
  node.type === 'Button' ? { button: node.props } : { text: String(node.props.children ?? ''), style: {} };
const buttonsOf = (node) => find(node, (one) => one.type === 'Button');
const labelsOf = (tree) => {
  const [overlay] = hoverOf(tree);
  return overlay ? buttonsOf(overlay).map((node) => node.props.label) : null;
};
// The cells each Button of the resting row spans, and the row's width.
function buttonSpans(row) {
  let col = 0;
  const spans = [];
  for (const node of restingOf(row)) {
    const width = partsWidth([asPart(node)]);
    if (node.type === 'Button') spans.push({ key: node.props.key, from: col, to: col + width });
    col += width;
  }
  return { spans, width: col };
}
const reach = (overlay) => {
  const from = overlay.props.left;
  return { from, to: from + partsWidth(elementKids(overlay).map(asPart)) };
};

for (const [name, { view, usage }] of Object.entries(BAND_STATES))
  for (const columns of COLUMNS)
    test(`${name} at ${columns ?? 'no'} columns: the hover controls cover no Button, fit the band and appear once`, () => {
      const tree = band(view, usage, columns);
      const rows = elementKids(tree);
      assert.equal(rows.length, view.bandDetail ? 2 : 1, 'rows');
      const { spans, width } = buttonSpans(rows[0]);
      if (columns !== null) assert.ok(width <= columns, `resting row is ${width} wide`);
      const placed = hoverOf(tree).map(reach);
      const covered = spans
        .filter((span) => placed.some((one) => one.from < span.to && one.to > span.from))
        .map((span) => span.key);
      assert.deepEqual(covered, [], 'Buttons under a hover control');
      for (const [i, one] of placed.entries())
        for (const other of placed.slice(i + 1)) assert.ok(one.to <= other.from || other.to <= one.from, 'overlap');
      if (columns !== null) assert.ok(Math.max(0, ...placed.map((one) => one.to)) <= columns, 'past the band');
      const cut = hoverOf(tree).flatMap((overlay) =>
        find(overlay, (node) => node.type === 'Text' && String(node.props.children).endsWith('…')),
      );
      assert.deepEqual(cut, [], 'a hover control cut short');
      const keys = hoverOf(tree).flatMap((overlay) => buttonsOf(overlay).map((node) => node.props.key));
      assert.deepEqual(
        keys.filter((key, i) => keys.indexOf(key) !== i),
        [],
        'a hover control drawn twice',
      );
    });

for (const name of ['routed', 'routed-goal', 'native-fallback'])
  test(`${name}: with readings at the row's end, the hover controls leave the first reading showing`, () => {
    const tree = band(BAND_STATES[name].view, CLAUDE, 100);
    const [row] = elementKids(tree);
    const [overlay] = hoverOf(tree);
    const [first] = restingOf(row);
    assert.ok(overlay.props.left >= partsWidth([asPart(first)]) + SEPARATOR.length);
    assert.equal(buttonSpans(row).spans.at(-1).to, 100, 'Router stays at the right edge');
  });

for (const [columns, left] of [
  [140, 69],
  [60, 24],
])
  test(`with nothing at the row's end, at ${columns} columns the hover controls start at column ${left}: the wider stretch`, () => {
    const [overlay] = hoverOf(band(BAND_STATES.routed.view, null, columns));
    assert.equal(overlay.props.left, left);
  });

test('the hover controls keep the pins, Turn off and the detail toggle, each pressing its action', () => {
  const { actions, calls } = recorder();
  const tree = band(BAND_STATES.ready.view, null, 200, actions);
  const buttons = hoverOf(tree).flatMap(buttonsOf);
  assert.deepEqual(
    buttons.map((node) => node.props.key),
    ['band-pin-micro', 'band-pin-low', 'band-pin-medium', 'band-pin-high', 'band-manual', 'band-detail'],
  );
  for (const node of buttons) node.props.onPress();
  assert.deepEqual(calls, [
    ['pin', 'micro'],
    ['pin', 'low'],
    ['pin', 'medium'],
    ['pin', 'high'],
    ['mode', 'manual'],
    ['toggleDetail'],
  ]);
});

// Narrowing drops the pins' route names first, then the rows toggle and the pins; Turn off is the last to go.
for (const [columns, bandDetail, labels] of [
  [140, false, ['▂ Haiku·medium', '▂▄ Haiku·high', '▂▄▆ Opus·medium', '▂▄▆█ Opus·xhigh', 'Turn off', '2 rows']],
  [100, false, ['▂', '▂▄', '▂▄▆', '▂▄▆█', 'Turn off', '2 rows']],
  [60, false, ['Turn off']],
  // Two rows keep 1 row beside Turn off: the only way back to one row.
  [70, true, ['Turn off', '1 row']],
  [40, false, null],
])
  test(`at ${columns} columns${bandDetail ? ' with two rows' : ''} the hover controls are ${labels?.join(' | ') ?? 'absent'}`, () => {
    assert.deepEqual(labelsOf(band({ ...BAND_STATES.routed.view, bandDetail }, CLAUDE, columns)), labels);
  });

test('a band with no width draws every hover control unpadded', () => {
  const [overlay] = hoverOf(band(BAND_STATES.routed.view, null, null));
  assert.ok(buttonsOf(overlay).some((node) => node.props.key === 'band-manual'));
  const padding = elementKids(overlay).filter(
    (node) => node.type === 'Text' && /^ +$/.test(node.props.children) && node.props.children.length > 2,
  );
  assert.deepEqual(padding, []);
});
