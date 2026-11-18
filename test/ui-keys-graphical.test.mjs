// One owner per key and per hotkey on every graphical tab, over the views the graphical tests draw: a duplicate key
// makes a press reach the wrong control, a duplicate hotkey answers twice.
import assert from 'node:assert/strict';
import test from 'node:test';

process.env.TZ = 'UTC';

const { DEFAULTS } = await import('../lib/config.mjs');
const { renderPanel } = await import('../lib/panel.mjs');
const { routeDraftOf } = await import('../lib/ui/model/draft.mjs');
const { BAND_STATES, CLAUDE, ROUTED } = await import('./band-states.mjs');
const { duplicates, ELEMENTS } = await import('./harness.mjs');
const { NOW, SESSION, STORE } = await import('./usage-fixtures.mjs');

const SURFACES = ['desktop', 'vscode', 'mobile'];
const TABS = ['now', 'routes', 'policy', 'classifier', 'usage'];
const actions = new Proxy({}, { get: () => () => undefined });
const SAVED = routeDraftOf(DEFAULTS, {});
const DRAFT = { ...SAVED, routes: { ...SAVED.routes, micro: { ...SAVED.routes.high } } };
const KEYS_SET = { jev: null, clef: null, 'clef-flash': null, 'clef-omni': null };
const VIEWS = {
  ...Object.fromEntries(Object.entries(BAND_STATES).map(([name, { view }]) => [`band ${name}`, view])),
  routed: { ...ROUTED, credentials: KEYS_SET, usageSession: SESSION, usageStore: STORE },
  'missing key': { ...ROUTED, credentials: { jev: 'missing-key' } },
  'missing key error': { ...ROUTED, error: 'missing-key', credentials: { jev: 'missing-key' } },
  'other classifiers missing': {
    ...ROUTED,
    credentials: { jev: null, clef: 'missing-key', 'clef-flash': 'missing-account', 'clef-omni': null },
  },
  warned: {
    ...ROUTED,
    projectError: 'router.json: unknown model',
    actualModel: 'claude-sonnet-5-5',
    selectedModel: 'claude-haiku-5-5',
    credentials: {},
  },
  draft: { ...ROUTED, credentials: KEYS_SET, routeDraft: DRAFT, routeCell: 'tier.micro' },
  'activity cell': { ...ROUTED, credentials: KEYS_SET, routeDraft: DRAFT, routeCell: 'code.medium' },
  written: { ...ROUTED, credentials: KEYS_SET, notice: 'Saved: x', lastWrite: { label: 'x' }, help: true },
  'usage open': {
    ...ROUTED,
    credentials: KEYS_SET,
    usageSession: SESSION,
    usageStore: STORE,
    usageOpen: 'activity:code',
  },
};

test('no graphical tab holds a key or a hotkey twice', () => {
  const found = [];
  // Each view also with an unsaved draft and a write to undo, so the save bar's s, d and u are in the walk.
  const extras = [
    ['', {}],
    [' + save bar', { routeDraft: DRAFT, lastWrite: { label: 'x' }, notice: 'Saved: x' }],
  ];
  for (const surface of SURFACES)
    for (const tab of TABS)
      for (const [name, view] of Object.entries(VIEWS))
        for (const [extra, more] of extras) {
          const tree = renderPanel(ELEMENTS, DEFAULTS, { ...view, ...more, tab }, CLAUDE, actions, {
            columns: 100,
            now: NOW,
            surface,
          });
          const { keys, hotkeys } = duplicates(tree);
          if (keys.length || hotkeys.length)
            found.push(`${surface} ${tab} ${name}${extra}: keys ${keys} hotkeys ${hotkeys}`);
        }
  assert.deepEqual(found, []);
});
