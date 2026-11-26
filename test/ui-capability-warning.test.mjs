// The pane's one line naming the routed cells auto cannot rank, on the terminal and a graphical surface.
import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULTS, TIERS } from '../lib/config.mjs';
import { renderPanel } from '../lib/panel.mjs';
import { ELEMENTS, quiet, texts } from './harness.mjs';

const config = (engine, aliases) => ({
  ...DEFAULTS,
  routingEngine: engine,
  activityRouting: 'off',
  models: Object.fromEntries(aliases.map((alias) => [alias, { ...DEFAULTS.models.opus, capability: {} }])),
  routes: Object.fromEntries(
    TIERS.map((tier, i) => [tier, { model: aliases[Math.min(i, aliases.length - 1)], effort: 'high' }]),
  ),
});
const warnings = (given, { surface = 'terminal', ...view } = {}) => {
  const shown = { mode: 'auto', phase: 'routed', credentials: { jev: null }, tab: 'now', ...view };
  const tree = renderPanel(ELEMENTS, given, shown, null, quiet, { columns: 88, surface });
  return texts(tree)
    .map((text) => text.trim())
    .filter((text) => text.startsWith('Auto cannot rank'));
};
const LINE = 'Auto cannot rank deepseek@high: set models.<alias>.capability';

test('auto and shadow warn once about unrated routes on every surface; the table engine does not', () => {
  for (const surface of ['terminal', 'desktop']) {
    for (const [engine, expected] of [
      ['auto', [LINE]],
      ['shadow', [LINE]],
      ['table', []],
    ])
      assert.deepEqual(warnings(config(engine, ['deepseek']), { surface }), expected, `${surface} ${engine}`);
  }
});

test('no warning when every routed cell is rated, or while routing is off or unavailable', () => {
  const rated = config('auto', ['deepseek']);
  rated.models.deepseek = { ...rated.models.deepseek, capability: { high: 2 } };
  assert.deepEqual(warnings(rated), []);
  assert.deepEqual(warnings(config('auto', ['deepseek']), { mode: 'manual' }), []);
  assert.deepEqual(warnings(config('auto', ['deepseek']), { phase: 'unavailable' }), []);
});

test('under shadow the pane also names the routes the active routing mode moves to', () => {
  const given = { ...config('shadow', ['deepseek']), activities: {} };
  given.models.deepseek = { ...given.models.deepseek, capability: { high: 2 } };
  const routingMode = { mode: 'quality', source: 'profile' };
  assert.deepEqual(warnings(given), []);
  assert.deepEqual(warnings(given, { routingMode }), [
    'Auto cannot rank deepseek@xhigh: set models.<alias>.capability',
  ]);
  assert.deepEqual(warnings({ ...given, routingEngine: 'auto' }, { routingMode }), []);
});

test('a long list keeps the cells that fit the docked pane and counts the rest', () => {
  const [line] = warnings(config('auto', ['kimi-fast', 'glm-flash', 'deepseek', 'glm-fast']));
  assert.equal(line, 'Auto cannot rank kimi-fast@high, glm-flash@high +2 more: set models.<alias>.capability');
  assert.ok(line.length <= 86);
  const long = 'a-very-long-model-alias-that-alone-overflows-the-pane';
  assert.deepEqual(warnings(config('auto', [long, 'other'])), [
    `Auto cannot rank ${long}@high +1 more: set models.<alias>.capability`,
  ]);
});
