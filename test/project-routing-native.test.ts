import type { PluginState } from 'claude-code';
import { expect, mock, test } from 'claude-code/testing';
import { MIN_CLAUDE_CODE } from '../lib/config.mjs';

type View = PluginState['router']['view'];

// The actual floor engine must construct both pane surfaces and dispatch their presses through the same store path.
test('floor panes Save, Clear and Undo scoped routing without writing configuration files', async ($, on) => {
  mock.store(on);
  mock.env(on, { HOME: '/fixture/home', CLAUDE_CONFIG_DIR: '/fixture/profile' });
  on('session.id', () => ({ value: 'project-routing-ui' }));
  on('session.model', () => ({ value: 'claude-haiku-5-5' }));
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000 }, rateLimits: [] } }));
  on('session.start', (_$, e) => ({ cwd: e.cwd }));
  on('session.root', () => ({ value: '/fixture/project' }));
  on('session.version', () => ({ value: { version: MIN_CLAUDE_CODE } }));
  on('settings.read', () => ({ value: {} }));
  on('command.register', () => ({ value: { command: 'router' } }));
  on('ui.log', () => ({ value: undefined }));
  const files = new Map([
    ['/fixture/profile/router.json', '{ "mode": "quality" }'],
    ['/fixture/project/.claude/router.json', '{ "mode": "quality" }'],
    ['/fixture/project/.claude/router.local.json', '{ "mode": "cost" }'],
  ]);
  const original = [...files];
  on('fs.exists', (_$, e) => ({ value: files.has(e.path) }));
  on('fs.stat', (_$, e) => ({
    value: { kind: files.has(e.path) ? 'file' : 'dir', isLink: false, realPath: e.path, size: 0, mtimeMs: 0 },
  }));
  on('fs.read', (_$, e) => ({ value: files.get(e.path) }));
  on('fs.write', (_$, e) => {
    files.set(e.path, e.text);
    return { value: undefined };
  });
  let view = { tab: 'policy' } as View;
  on('state.get', { plugin: 'router', key: 'view' }, () => ({ value: { value: view, version: 1 } }));
  on('state.set', { plugin: 'router', key: 'view' }, (_$, e) => {
    view = e.value;
    return { value: { isSet: true, version: 2 } };
  });
  await $.session.start({ cwd: '/fixture/project', surface: null, isInteractive: false });
  expect(view.routingMode).toEqual({ mode: 'cost', source: 'project local' });

  const mount = (surface: 'terminal' | 'desktop') =>
    $.ui.mount({
      plugin: 'router',
      surface,
      component: 'Pane',
      requestId: 'jev-router',
      viewport: { columns: 112, rows: 65 },
      props: {
        title: 'Router',
        isFocused: true,
        bodyColumns: 112,
        placement: 'dock',
        scroll: { offset: 0, bodyRows: 65 },
        view: {},
      },
    });
  const desktop = await mount('desktop');
  await desktop.select({ key: 'routing-mode', value: 'balanced' });
  expect(view.notice).toMatch(/^Saved:/);
  expect(view.routingMode).toEqual({ mode: 'balanced', source: 'project preference' });
  await desktop.unmount();
  const terminal = await mount('terminal');
  await terminal.press({ key: 'ask-clear-project-routing' });
  await terminal.redraw();
  await terminal.press({ key: 'clear-project-routing' });
  expect(view.routingMode).toEqual({ mode: 'cost', source: 'project local' });
  await terminal.redraw();
  await terminal.press({ key: 'undo' });
  expect(view.routingMode).toEqual({ mode: 'balanced', source: 'project preference' });
  expect([...files]).toEqual(original);
  await terminal.unmount();
});
