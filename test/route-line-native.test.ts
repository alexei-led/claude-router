import { expect, mock, test } from 'claude-code/testing';
import { MIN_CLAUDE_CODE } from '../lib/config.mjs';

const LINE = {
  model: 'claude-sonnet-5-5',
  effort: 'high',
  tier: 'medium',
  reason: 'downgrade',
  activity: 'code',
  estimate: null,
};

// A route line in the engine: the row a turn placed draws on each surface the engine hands a Placed instance, and a row
// another plugin placed is left to its own hook.
test('a placed route line draws on the terminal and desktop, and another plugin’s row is left alone', async ($, on) => {
  mock.store(on);
  mock.env(on, { HOME: '/fixture', CLAUDE_CONFIG_DIR: '/fixture/team' });
  on('state.get', { plugin: 'router', key: 'lines' }, (_$, e) => ({
    value: { value: e.id === 'rl-t1' ? LINE : undefined, version: e.id === 'rl-t1' ? 1 : 0 },
  }));
  on('fs.exists', () => ({ value: false }));
  on('session.id', () => ({ value: 'route-line' }));
  on('session.model', () => ({ value: 'claude-opus-5-5' }));
  on('session.cwd', () => ({ value: '/fixture/project' }));
  on('session.version', () => ({ value: { version: MIN_CLAUDE_CODE } }));
  on('ui.log', () => ({ value: undefined }));
  const drawn: Record<string, boolean> = {};
  for (const surface of ['terminal', 'desktop'] as const) {
    for (const [id, plugin] of [
      ['rl-t1', 'router'],
      ['rl-t1', 'other'],
      ['rl-gone', 'router'],
    ] as const) {
      const row = await $.ui.mount({
        plugin: 'router',
        surface,
        component: 'Placed',
        requestId: `${surface}-${id}-${plugin}`,
        viewport: { columns: 100, rows: 24 },
        props: { id, plugin },
      });
      drawn[`${surface} ${id} ${plugin}`] = Boolean(await row.find({ text: 'Sonnet 5.5' }));
      await row.unmount();
    }
  }
  expect(drawn).toEqual({
    'terminal rl-t1 router': true,
    'terminal rl-t1 other': false,
    'terminal rl-gone router': false,
    'desktop rl-t1 router': true,
    'desktop rl-t1 other': false,
    'desktop rl-gone router': false,
  });
});
