import type { PluginState } from 'claude-code';
import { expect, mock, test } from 'claude-code/testing';

type View = PluginState['router']['view'];
const TABS = ['now', 'routes', 'policy', 'classifier', 'usage'];

// The engine's mocks a mounted Pane needs, with the view held in a variable the test can read back.
function setup(on: Parameters<Parameters<typeof test>[1]>[1], initial: object) {
  mock.store(on);
  on('session.id', () => ({ value: 'ui-shell' }));
  on('session.model', () => ({ value: 'claude-sonnet-5-5' }));
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000 }, rateLimits: [] } }));
  on('ui.log', () => ({ value: undefined }));
  const state = { view: initial as View };
  on('state.get', { plugin: 'router', key: 'view' }, () => ({ value: { value: state.view, version: 1 } }));
  on('state.set', { plugin: 'router', key: 'view' }, (_$, e) => {
    state.view = e.value;
    return { value: { isSet: true, version: 2 } };
  });
  return state;
}
const mountOf = ($: Parameters<Parameters<typeof test>[1]>[0], surface: 'terminal' | 'desktop') =>
  $.ui.mount({
    plugin: 'router',
    surface,
    component: 'Pane',
    requestId: 'jev-router',
    viewport: { columns: 80, rows: 40 },
    props: {
      title: 'Router',
      isFocused: true,
      bodyColumns: 80,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 40 },
      view: {},
    },
  });

// The graphical shell has hotkeyed tabs without digits and one notices slot under them on every tab; the terminal
// keeps its text frame.
test('desktop shell: tabs without digits, the same warnings under the tabs on every tab', async ($, on) => {
  setup(on, {
    phase: 'routed',
    mode: 'auto',
    nativeModel: 'claude-sonnet-5-5',
    selectedModel: 'claude-haiku-5-5',
    actualModel: 'claude-sonnet-5-5',
    projectError: 'router.json: unknown model',
    credentials: { jev: 'missing-key' },
    adviceMs: 347,
  });
  const pane = await mountOf($, 'desktop');
  const absent: string[] = [];
  const has = async (q: Parameters<typeof pane.find>[0]) => {
    if (!(await pane.find(q))) absent.push(JSON.stringify(q));
  };
  for (const tab of TABS) {
    const label = tab[0].toUpperCase() + tab.slice(1);
    await has({ key: `tab-${tab}` });
    await has({ type: 'Button', text: label });
    expect(await pane.find({ type: 'Button', text: new RegExp(`^\\d ${label}`) })).toBeUndefined();
  }
  await has({ type: 'Text', text: 'Router' });
  await has({ key: 'auto' });
  await has({ key: 'manual' });
  for (const tab of TABS) {
    await pane.press({ key: `tab-${tab}` });
    await pane.redraw();
    await has({ type: 'Text', text: /Ignored: router\.json: unknown model/ });
    await has({ type: 'Text', text: /native fallback/ });
    // Set up: the notice's on every tab but Classifier, where the active card holds it (and k).
    await has({ key: tab === 'classifier' ? 'key-jev' : 'key' });
  }
  expect(absent).toEqual([]);
  await pane.unmount();

  const terminal = await mountOf($, 'terminal');
  expect(await terminal.find({ type: 'Button', text: '1 Now' })).toBeDefined();
  expect(await terminal.find({ type: 'Text', text: /Ignored: router\.json: unknown model/ })).toBeDefined();
  await terminal.unmount();
});

// Review Focus: the draft is kept across tabs and Save works from the shell's bar, through a real press.
test('desktop shell: a Routes draft keeps its save bar on other tabs and Save stores a project preference', async ($, on) => {
  const state = setup(on, {});
  on('session.start', (_$, e) => ({ cwd: e.cwd }));
  on('session.root', () => ({ value: '/fixture/project' }));
  on('session.version', () => ({ value: { version: '2.1.321' } }));
  on('command.register', () => ({ value: { command: 'router' } }));
  on('settings.read', () => ({ value: {} }));
  mock.env(on, { HOME: '/fixture', CLAUDE_CONFIG_DIR: '/fixture/team' });
  // A write to the profile would be caught even if the pane also saved to the store.
  const files = new Map<string, string>([['/fixture/team/router.json', '{}']]);
  on('fs.exists', (_$, e) => ({ value: files.has(e.path) }));
  on('fs.stat', (_$, e) => ({
    value: { kind: files.has(e.path) ? 'file' : 'dir', isLink: false, realPath: e.path, size: 0, mtimeMs: 0 },
  }));
  on('fs.read', (_$, e) => ({ value: files.get(e.path) }));
  on('fs.write', (_$, e) => {
    files.set(e.path, e.text);
    return { value: undefined };
  });
  await $.session.start({ cwd: '/fixture/project', surface: null, isInteractive: false });
  const pane = await mountOf($, 'desktop');
  // Make the draft through the Routes editor, as a person would: open the micro cell and pick another model.
  await pane.press({ key: 'tab-routes' });
  await pane.redraw();
  await pane.press({ key: 'cell-tier-micro' });
  await pane.redraw();
  await pane.select({ key: 'route-micro-model', value: 'opus' });
  await pane.redraw();
  expect(await pane.find({ key: 'save-routing' })).toBeDefined();
  for (const tab of ['policy', 'classifier', 'usage', 'now']) {
    await pane.press({ key: `tab-${tab}` });
    await pane.redraw();
    expect(await pane.find({ key: 'save-routing' })).toBeDefined();
    expect(await pane.find({ key: 'discard-routing' })).toBeDefined();
  }
  expect(state.view.routeDraft).toBeDefined();
  await pane.press({ key: 'tab-usage' });
  await pane.redraw();
  await pane.press({ key: 'save-routing' });
  await pane.redraw();
  expect(state.view.notice).toMatch(/^Saved: routing changes/);
  expect(state.view.routeDraft ?? null).toBeNull();
  expect(files.get('/fixture/team/router.json')).toEqual('{}');
  expect(await pane.find({ key: 'save-routing' })).toBeUndefined();
  await pane.unmount();
});
