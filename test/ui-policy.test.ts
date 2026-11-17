import type { PluginState } from 'claude-code';
import { expect, mock, test } from 'claude-code/testing';

type View = PluginState['router']['view'];

// The graphical Policy tab mounted on desktop: the engine accepts the form's cards, fields and Selects; a Select pick
// changes the draft, marks the tab and opens the save bar.
test('desktop Policy: the form draws in the engine and its Selects answer', async ($, on) => {
  mock.store(on);
  on('session.id', () => ({ value: 'ui-policy' }));
  on('session.model', () => ({ value: 'claude-opus-5-5' }));
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000 }, rateLimits: [] } }));
  on('session.start', (_$, e) => ({ cwd: e.cwd }));
  on('session.cwd', () => ({ value: '/fixture/project' }));
  on('command.register', () => ({ value: { command: 'router' } }));
  on('settings.read', () => ({ value: {} }));
  on('ui.log', () => ({ value: undefined }));
  mock.env(on, { HOME: '/fixture', CLAUDE_CONFIG_DIR: '/fixture/team' });
  const files = new Map<string, string>([['/fixture/team/router.json', '{}']]);
  on('fs.exists', (_$, e) => ({ value: files.has(e.path) }));
  on('fs.stat', () => ({ value: { isLink: false } }));
  on('fs.read', (_$, e) => ({ value: files.get(e.path) }));
  const state = {
    view: { phase: 'routed', mode: 'auto', tab: 'policy', credentials: { jev: null } } as unknown as View,
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
  for (const title of ['Routing mode', 'Switching down', 'Switching up', 'Activities', 'Credits'])
    await has({ type: 'Text', text: title });
  await has({ type: 'Text', text: 'Votes to go down' });
  await has({ type: 'Text', text: 'Agreeing turns before a cheaper model runs' });
  await has({ type: 'Text', text: /^Needs Jev support of 75%/ });
  await has({ type: 'Text', text: 'No model in router.json bills credits, so this has no effect' });
  for (const key of ['routing-mode', 'baseline', 'downgradeVotes', 'horizon', 'activityMass', 'cashCapUsd'])
    await has({ key });
  await has({ key: 'reset-policy' });
  expect(absent).toEqual([]);
  expect(await pane.find({ key: 'save-routing' })).toBeUndefined();

  await pane.select({ key: 'downgradeVotes', value: '3' });
  expect(state.view.tuning?.downgradeVotes).toBe(3);
  await pane.redraw();
  expect(await pane.find({ key: 'save-routing' })).toBeDefined();
  expect(await pane.find({ type: 'Button', text: 'Policy ●' })).toBeDefined();
  expect(await pane.find({ type: 'Text', text: 'Default 2' })).toBeDefined();
  await pane.select({ key: 'baseline', value: 'micro' });
  expect(state.view.routeDraft?.baselineTier).toBe('micro');
  await pane.unmount();
});
