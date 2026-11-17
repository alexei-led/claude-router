import type { PluginState } from 'claude-code';
import { expect, mock, test } from 'claude-code/testing';
import { SESSION, STORE } from './usage-fixtures.mjs';

type View = PluginState['router']['view'];
const TABS = ['now', 'routes', 'policy', 'classifier', 'usage'];
const SURFACES = ['desktop', 'vscode', 'mobile'] as const;

// A routed view with a pending pin, plan windows, a priced session and its strip, so each tab draws its full cards.
const ROUTED = {
  phase: 'routed',
  mode: 'auto',
  tier: 'high',
  nativeModel: 'claude-opus-5-5',
  selectedModel: 'claude-opus-5-5',
  actualModel: 'claude-opus-5-5',
  effort: 'xhigh',
  reason: 'upgrade',
  error: null,
  credentials: { jev: null },
  pendingPin: 'low',
  probabilities: { high: 0.88, medium: 0.07, low: 0.03 },
  inputTokens: 1000,
  cacheRead: 900,
  usageSession: SESSION,
  usageStore: STORE,
  strip: { per: 1, cells: [{ low: 2 }, { medium: 1 }, { high: 1 }, { none: 1 }] },
  bandDetail: true,
};

function setup(on: Parameters<Parameters<typeof test>[1]>[1], initial: object) {
  mock.store(on);
  on('session.id', () => ({ value: 'ui-surfaces' }));
  on('session.model', () => ({ value: 'claude-opus-5-5' }));
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { tokens: 300_000, window: 1_000_000 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 37, resetsAt: new Date(Date.now() + 3600e3).toISOString() },
        { kind: 'seven_day', percentUsed: 81 },
      ],
    },
  }));
  on('ui.log', () => ({ value: undefined }));
  const state = { view: initial as unknown as View };
  on('state.get', { plugin: 'router', key: 'view' }, () => ({ value: { value: state.view, version: 1 } }));
  on('state.set', { plugin: 'router', key: 'view' }, (_$, e) => {
    state.view = e.value;
    return { value: { isSet: true, version: 2 } };
  });
  return state;
}

// What the engine said when it could not draw the tree, or null when it drew it.
async function refusal(drawing: { drawn: () => Promise<unknown> }) {
  try {
    await drawing.drawn();
    return null;
  } catch (error) {
    return String((error as Error)?.message ?? error);
  }
}

// Desktop, VS Code and mobile draw the same graphical trees: every tab of the pane and the band must pass each
// surface's own element table, so the engine never refuses them and draws its own.
test('desktop, vscode and mobile: every pane tab and the band mount without a refusal', async ($, on) => {
  const state = setup(on, ROUTED);
  const refused: string[] = [];
  for (const surface of SURFACES) {
    for (const tab of TABS) {
      for (const view of [
        ROUTED,
        { ...ROUTED, error: 'missing-key', credentials: { jev: 'missing-key' } },
        // The cards this wave added: About the router, Unsaved changes with a notice and Undo, the input trend.
        {
          ...ROUTED,
          help: true,
          tuning: { horizon: 10 },
          notice: 'Saved: x',
          lastWrite: { label: 'x' },
          usageDetail: true,
          history: [12_000, 48_000, 30_000],
        },
      ]) {
        state.view = { ...view, tab } as unknown as View;
        const pane = await $.ui.mount({
          plugin: 'router',
          surface,
          component: 'Pane',
          requestId: 'jev-router',
          viewport: { columns: 120, rows: 60 },
          props: {
            title: 'Router',
            isFocused: true,
            bodyColumns: 120,
            placement: 'dock',
            scroll: { offset: 0, bodyRows: 60 },
            view: {},
          },
        });
        const said = await refusal(pane);
        const name = view.error ?? (view.help ? 'cards' : 'routed');
        if (said) refused.push(`${surface} ${tab} ${name}: ${said}`);
        else if (!(await pane.find({ key: `tab-${tab}` }))) refused.push(`${surface} ${tab}: no tab row`);
        await pane.unmount();
      }
    }
    for (const columns of [100, 40]) {
      state.view = { ...ROUTED } as unknown as View;
      const band = await $.ui.mount({
        plugin: 'router',
        surface,
        component: 'AbovePrompt',
        requestId: 'band',
        viewport: { columns, rows: 24 },
        props: {
          hasSurvey: false,
          isWorking: false,
          maxRows: 4,
          bodyColumns: columns,
          scroll: { offset: 0, bodyRows: 4 },
          view: {},
        },
      });
      const said = await refusal(band);
      if (said) refused.push(`${surface} band at ${columns}: ${said}`);
      else if (!(await band.find({ key: 'details' }))) refused.push(`${surface} band at ${columns}: no Router button`);
      // On mobile an app that did not name Select draws none, so the pending pin keeps its own way to cancel.
      if (!said && surface === 'mobile' && !(await band.find({ key: 'band-unpin' })))
        refused.push(`mobile band at ${columns}: a pending pin without its ✕`);
      await band.unmount();
    }
  }
  expect(refused).toEqual([]);
});

// Set up on a surface without `/plugin configure`'s dialog: the pane shows how to add the key, and no command runs.
test('desktop, vscode and mobile: the key help card mounts, and Set up runs no command', async ($, on) => {
  const missing = { ...ROUTED, error: 'missing-key', credentials: { jev: 'missing-key' }, tab: 'now' };
  const state = setup(on, missing);
  let commands = 0;
  on('command.run', () => {
    commands += 1;
    return { value: { text: '' } };
  });
  const problems: string[] = [];
  for (const surface of SURFACES) {
    state.view = { ...missing } as unknown as View;
    const mount = () =>
      $.ui.mount({
        plugin: 'router',
        surface,
        component: 'Pane',
        requestId: 'jev-router',
        viewport: { columns: 120, rows: 60 },
        props: {
          title: 'Router',
          isFocused: true,
          bodyColumns: 120,
          placement: 'dock',
          scroll: { offset: 0, bodyRows: 60 },
          view: {},
        },
      });
    let pane = await mount();
    await pane.press({ key: 'key' });
    await pane.unmount();
    if ((state.view as unknown as { keyHelp?: { id: string } }).keyHelp?.id !== 'jev')
      problems.push(`${surface}: no key help`);
    pane = await mount();
    const said = await refusal(pane);
    if (said) problems.push(`${surface}: ${said}`);
    else {
      if (!(await pane.find({ key: 'key-help-copy' }))) problems.push(`${surface}: no Copy command`);
      if (!(await pane.find({ key: 'key-help-done' }))) problems.push(`${surface}: no Done`);
      if (!(await pane.find({ type: 'Code' }))) problems.push(`${surface}: no Code`);
    }
    await pane.unmount();
  }
  expect(problems).toEqual([]);
  expect(commands).toBe(0);
});
