import { expect, mock, test } from 'claude-code/testing';
import { MIN_CLAUDE_CODE } from '../lib/config.mjs';

// The band's agent rows in the engine: a spawn the router routed, an agent the engine lists as running, a press on its
// row, and the `$.ui.view` call that press raises. The test engine has no core for `ui.view` (an unanswered call rejects
// with `no implementation for ui.view`), so whether a press counts as the person's own input, which Claude Code requires,
// can only be seen in a live session.
test('a press on a running agent’s row asks the engine to show that agent', async ($, on) => {
  mock.store(on);
  const state = new Map<string, { value: unknown; version: number }>();
  on('state.get', (_$, e) => ({ value: state.get(`${e.key}:${e.id ?? ''}`) ?? { value: undefined, version: 0 } }));
  on('state.set', (_$, e) => {
    const key = `${e.key}:${e.id ?? ''}`;
    const previous = state.get(key)?.version ?? 0;
    state.set(key, { value: e.value, version: previous + 1 });
    return { value: { isSet: true, version: previous + 1 } };
  });
  mock.env(on, { HOME: '/fixture', CLAUDE_CONFIG_DIR: '/fixture/team', TYPESAFE_API_KEY: 'synthetic-key' });
  on('fs.exists', () => ({ value: false }));
  on('command.register', () => ({ value: { command: 'router' } }));
  on('session.id', () => ({ value: 'band-agents' }));
  on('session.model', () => ({ value: 'claude-opus-5-5' }));
  on('session.cwd', () => ({ value: '/fixture/project' }));
  on('session.version', () => ({ value: { version: MIN_CLAUDE_CODE } }));
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 8000 }, rateLimits: [] } }));
  on('settings.read', () => ({ value: {} }));
  on('ui.log', () => ({ value: undefined }));
  on('session.start', (_$, e) => ({ cwd: e.cwd }));
  on('agent.list', () => ({
    value: [{ id: 'agent-1', type: 'Explore', description: 'Find the cache key', status: 'running' }],
  }));
  on('agent.spawn', (_$, e) => ({ model: e.model ?? 'claude-opus-5-5', agentId: 'agent-1' }));
  const toasts: string[] = [];
  on('ui.toast', (_$, e) => {
    toasts.push(e.text);
    return { value: undefined };
  });
  const viewed: unknown[] = [];
  on('ui.view', (_$, e) => {
    viewed.push(e);
    return { value: {} };
  });
  await $.session.start({ cwd: '/fixture/project', surface: 'terminal', isInteractive: true });
  await $.agent.spawn({ prompt: 'Find where the cache key is built.', description: 'Find the cache key' });
  const band = await $.ui.mount({
    plugin: 'router',
    surface: 'terminal',
    component: 'AbovePrompt',
    requestId: 'band',
    viewport: { columns: 100, rows: 24 },
    props: {
      hasSurvey: false,
      isWorking: false,
      maxRows: 4,
      bodyColumns: 100,
      scroll: { offset: 0, bodyRows: 4 },
      view: {},
    },
  });
  expect(await band.find({ key: 'band-agent-agent-1' })).toBeDefined();
  await band.press({ key: 'band-agent-agent-1' });
  expect({ viewed, toasts }).toEqual({ viewed: [{ agentId: 'agent-1' }], toasts: [] });
  await band.unmount();
});
