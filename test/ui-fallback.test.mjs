// A graphical renderer that throws must not blank the band or the pane: the surface gets the terminal tree, which is
// what it drew before the graphical renderers, and nothing is logged.
import assert from 'node:assert/strict';
import test from 'node:test';

process.env.TZ = 'UTC';

const { renderBand } = await import('../lib/band.mjs');
const { DEFAULTS } = await import('../lib/config.mjs');
const { renderPanel } = await import('../lib/panel.mjs');
const { CLAUDE, ROUTED } = await import('./band-states.mjs');
const { ELEMENTS, goldenText } = await import('./harness.mjs');
const { NOW } = await import('./usage-fixtures.mjs');

const actions = new Proxy({}, { get: () => () => undefined });
// A table whose Svg throws: only the graphical trees draw one.
const BROKEN = {
  ...ELEMENTS,
  Svg: () => {
    throw new Error('no Svg here');
  },
};
const VIEW = { ...ROUTED, credentials: { jev: null }, tab: 'now' };

test('a graphical band or pane that throws draws the terminal tree instead', () => {
  const logged = [];
  const { error, warn, log } = console;
  console.error = console.warn = console.log = (...args) => logged.push(args);
  try {
    for (const surface of ['desktop', 'vscode', 'mobile']) {
      const band = (elements, at) =>
        renderBand(elements, DEFAULTS, VIEW, CLAUDE, { columns: 100, now: NOW, surface: at }, actions);
      assert.equal(goldenText(band(BROKEN, surface)), goldenText(band(ELEMENTS, 'terminal')), `${surface} band`);
      const pane = (elements, at) =>
        renderPanel(elements, DEFAULTS, VIEW, CLAUDE, actions, { columns: 100, now: NOW, surface: at });
      assert.equal(goldenText(pane(BROKEN, surface)), goldenText(pane(ELEMENTS, 'terminal')), `${surface} pane`);
      // A table that draws is unaffected.
      assert.notEqual(goldenText(pane(ELEMENTS, surface)), goldenText(pane(ELEMENTS, 'terminal')));
    }
  } finally {
    Object.assign(console, { error, warn, log });
  }
  assert.deepEqual(logged, []);
  // The terminal itself still throws what it throws: there is no tree under it to fall back to.
  assert.throws(() =>
    renderPanel(
      {
        ...ELEMENTS,
        Box: () => {
          throw new Error('x');
        },
      },
      DEFAULTS,
      VIEW,
      CLAUDE,
      actions,
      { surface: 'terminal' },
    ),
  );
});
