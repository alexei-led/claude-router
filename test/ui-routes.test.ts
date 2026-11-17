import type { PluginState } from 'claude-code';
import { expect, mock, test } from 'claude-code/testing';

type View = PluginState['router']['view'];

// A custom model whose display name runs past 90 characters, routed on the medium tier, so the engine lays out a long
// cell label.
const LONG_ID = `vendor-${'very-long-model-name-'.repeat(4)}final`;
const ROUTER_JSON = JSON.stringify({
  models: {
    long: {
      id: LONG_ID,
      input: 1,
      output: 2,
      cacheRead: 0.1,
      contextWindow: 200000,
      billing: 'credits',
      efforts: ['high'],
    },
  },
  routes: { medium: { model: 'long', effort: 'high' } },
});

// The graphical Routes tab mounted on desktop: the engine accepts the grid, its cell Buttons and the editor card's
// Selects; a cell press opens the editor and a Select pick changes the draft.
test('desktop Routes: the grid and the editor draw in the engine and their controls answer', async ($, on) => {
  mock.store(on);
  on('session.id', () => ({ value: 'ui-routes' }));
  on('session.model', () => ({ value: 'claude-opus-5-5' }));
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000 }, rateLimits: [] } }));
  on('session.start', (_$, e) => ({ cwd: e.cwd }));
  on('session.cwd', () => ({ value: '/fixture/project' }));
  on('command.register', () => ({ value: { command: 'router' } }));
  on('settings.read', () => ({ value: {} }));
  on('ui.log', () => ({ value: undefined }));
  mock.env(on, { HOME: '/fixture', CLAUDE_CONFIG_DIR: '/fixture/team' });
  const files = new Map<string, string>([['/fixture/team/router.json', ROUTER_JSON]]);
  on('fs.exists', (_$, e) => ({ value: files.has(e.path) }));
  on('fs.stat', () => ({ value: { isLink: false } }));
  on('fs.read', (_$, e) => ({ value: files.get(e.path) }));
  const state = {
    view: { phase: 'routed', mode: 'auto', tab: 'routes', credentials: { jev: null } } as unknown as View,
  };
  on('state.get', { plugin: 'router', key: 'view' }, () => ({ value: { value: state.view, version: 1 } }));
  on('state.set', { plugin: 'router', key: 'view' }, (_$, e) => {
    state.view = e.value;
    return { value: { isSet: true, version: 2 } };
  });
  await $.session.start({ cwd: '/fixture/project', surface: null, isInteractive: false });
  const pane = await $.ui.mount({
    plugin: 'router',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'jev-router',
    viewport: { columns: 100, rows: 60 },
    props: {
      title: 'Router',
      isFocused: true,
      bodyColumns: 100,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 60 },
      view: {},
    },
  });
  const absent: string[] = [];
  const has = async (q: Parameters<typeof pane.find>[0]) => {
    if (!(await pane.find(q))) absent.push(JSON.stringify(q));
  };
  await has({ type: 'Text', text: 'Routes' });
  await has({ type: 'Text', text: 'Prompt caches' });
  await has({ type: 'Text', text: /prompt caches in use/ });
  await has({ type: 'Text', text: 'Default' });
  await has({ type: 'Text', text: /^Vendor Very Long Model Name .* · high$/ });
  await has({ key: 'activity-mode' });
  await has({ key: 'cell-tier-medium' });
  await has({ key: 'cell-code-high' });
  await has({ key: 'reset-routes' });
  expect(absent).toEqual([]);
  expect(await pane.find({ key: 'route-medium-model' })).toBeUndefined();

  await pane.press({ key: 'cell-tier-medium' });
  expect(state.view.routeCell).toBe('tier.medium');
  await pane.redraw();
  expect(await pane.find({ type: 'Text', text: 'Edit Default at medium' })).toBeDefined();
  expect(await pane.find({ key: 'route-medium-effort' })).toBeDefined();
  await pane.select({ key: 'route-medium-model', value: 'sonnet' });
  expect(state.view.routeDraft?.routes.medium.model).toBe('sonnet');
  await pane.redraw();
  expect(await pane.find({ key: 'save-routing' })).toBeDefined();

  await pane.press({ key: 'cell-code-high' });
  await pane.redraw();
  expect(await pane.find({ type: 'Text', text: 'Edit code at high' })).toBeDefined();
  await pane.select({ key: 'activity-code-high-model', value: 'fable' });
  expect(state.view.routeDraft?.activities.code?.high?.model).toBe('fable');
  await pane.redraw();
  expect(await pane.find({ key: 'activity-tier-code-high' })).toBeDefined();
  await pane.unmount();

  // A narrow pane draws each row as its label over its wrapped tier Buttons; the same keys answer.
  const narrow = await $.ui.mount({
    plugin: 'router',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'jev-router',
    viewport: { columns: 60, rows: 60 },
    props: {
      title: 'Router',
      isFocused: true,
      bodyColumns: 60,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 60 },
      view: {},
    },
  });
  expect(await narrow.find({ type: 'Text', text: 'Default' })).toBeDefined();
  await narrow.press({ key: 'cell-tier-low' });
  expect(state.view.routeCell).toBe('tier.low');
  await narrow.redraw();
  expect(await narrow.find({ key: 'route-low-model' })).toBeDefined();
  await narrow.unmount();
});
