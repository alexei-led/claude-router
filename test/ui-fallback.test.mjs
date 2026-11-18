// A graphical renderer that throws must not blank the band or the pane: given an onFallback, the surface gets the
// terminal tree, which is what it drew before the graphical renderers, and onFallback is told of the error.
import assert from 'node:assert/strict';
import test from 'node:test';

process.env.TZ = 'UTC';

const { renderBand } = await import('../lib/band.mjs');
const { DEFAULTS } = await import('../lib/config.mjs');
const { renderPanel } = await import('../lib/panel.mjs');
const { CLAUDE, ROUTED } = await import('./band-states.mjs');
const { ELEMENTS, goldenText, quiet } = await import('./harness.mjs');
const { NOW } = await import('./usage-fixtures.mjs');

// A table whose Svg throws: only the graphical trees draw one.
const BROKEN = {
  ...ELEMENTS,
  Svg: () => {
    throw new Error('no Svg here');
  },
};
const VIEW = { ...ROUTED, credentials: { jev: null }, tab: 'now' };

for (const surface of ['desktop', 'vscode', 'mobile'])
  test(`${surface}: a graphical band or pane that throws draws the terminal tree and reports the error`, () => {
    const seen = [];
    const onFallback = (error) => seen.push(error.message);
    const band = (elements, at) =>
      renderBand(elements, DEFAULTS, VIEW, CLAUDE, { columns: 100, now: NOW, surface: at, onFallback }, quiet);
    assert.equal(goldenText(band(BROKEN, surface)), goldenText(band(ELEMENTS, 'terminal')), 'band');
    const pane = (elements, at) =>
      renderPanel(elements, DEFAULTS, VIEW, CLAUDE, quiet, { columns: 100, now: NOW, surface: at, onFallback });
    assert.equal(goldenText(pane(BROKEN, surface)), goldenText(pane(ELEMENTS, 'terminal')), 'pane');
    assert.deepEqual(seen, ['no Svg here', 'no Svg here']);
    // A table that draws is unaffected.
    assert.notEqual(goldenText(pane(ELEMENTS, surface)), goldenText(pane(ELEMENTS, 'terminal')));
  });

test('with no onFallback a graphical throw propagates, and the terminal never falls back', () => {
  assert.throws(
    () => renderBand(BROKEN, DEFAULTS, VIEW, CLAUDE, { columns: 100, now: NOW, surface: 'desktop' }, quiet),
    /no Svg here/,
  );
  const brokenBox = {
    ...ELEMENTS,
    Box: () => {
      throw new Error('x');
    },
  };
  assert.throws(() => renderPanel(brokenBox, DEFAULTS, VIEW, CLAUDE, quiet, { surface: 'terminal', onFallback() {} }));
});
