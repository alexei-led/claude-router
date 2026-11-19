import type { PluginState } from 'claude-code';
import { expect, mock, test } from 'claude-code/testing';
import { SESSION, STORE } from './usage-fixtures.mjs';

type View = PluginState['router']['view'];

// The graphical Now tab mounted on desktop in a wide pane, so the engine itself accepts every card: Next turn with a
// pending pin, Plan usage beside Context, a priced session with its bars and strip; then the off and unavailable Next
// turn cards. Recent decisions needs the decision engine's store and is covered by ui-now-graphical.test.mjs.
test('desktop Now: every card draws in the engine and its controls answer', async ($, on) => {
  mock.store(on);
  on('session.id', () => ({ value: 'ui-now' }));
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
  const state = {
    view: {
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
    } as unknown as View,
  };
  on('state.get', { plugin: 'router', key: 'view' }, () => ({ value: { value: state.view, version: 1 } }));
  on('state.set', { plugin: 'router', key: 'view' }, (_$, e) => {
    state.view = e.value;
    return { value: { isSet: true, version: 2 } };
  });
  const pane = await $.ui.mount({
    plugin: 'router',
    surface: 'desktop',
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
  const absent: string[] = [];
  const has = async (q: Parameters<typeof pane.find>[0]) => {
    if (!(await pane.find(q))) absent.push(JSON.stringify(q));
  };
  await has({ type: 'Text', text: 'Next turn' });
  await has({ type: 'Text', text: 'Plan usage' });
  await has({ type: 'Text', text: '37%' });
  await has({ type: 'Text', text: '81%' });
  await has({ type: 'Text', text: 'Context' });
  await has({ type: 'Text', text: 'This session' });
  await has({ type: 'Text', text: 'Main' });
  await has({ type: 'Text', text: 'not routed 1' });
  await has({ key: 'usage-session' });
  await has({ key: 'usage-detail' });
  await has({ key: 'band-detail-toggle' });
  await has({ key: 'pin-low' });
  // The pin is a clean label beside its tier meter, which the engine draws outside the Button.
  expect(((await pane.find({ key: 'pin-low' })) as unknown as { props?: { label?: string } })?.props?.label).toBe(
    'Haiku · high',
  );
  await has({ type: 'Svg' });
  expect(absent).toEqual([]);
  await pane.press({ key: 'pin-low' });
  expect(state.view.pendingPin ?? null).toBeNull();
  await pane.redraw();
  await pane.press({ key: 'usage-detail' });
  await pane.redraw();
  expect(await pane.find({ type: 'Text', text: 'Next-turn difference' })).toBeUndefined();
  expect(await pane.find({ type: 'Text', text: 'Cache hits saved' })).toBeDefined();
  const planHold = { kind: 'window', window: 'five_hour', error: 'rate_limit', streak: 1 };
  state.view = {
    ...state.view,
    holds: { accounts: { plan: { ...planHold, since: Date.now(), until: Date.now() + 3600e3 } }, models: {} },
  } as unknown as View;
  await pane.redraw();
  expect(await pane.find({ type: 'Text', text: 'Held out' })).toBeDefined();
  expect(await pane.find({ key: 'release-account-plan' })).toBeDefined();
  state.view = { ...state.view, holds: null } as unknown as View;
  await pane.redraw();
  expect(await pane.find({ type: 'Text', text: 'Held out' })).toBeUndefined();
  state.view = { ...state.view, mode: 'manual', phase: 'manual' };
  await pane.redraw();
  expect(await pane.find({ type: 'Text', text: /Routing off/ })).toBeDefined();
  expect(await pane.find({ key: 'pin-high' })).toBeUndefined();
  state.view = { ...state.view, mode: 'auto', phase: 'unavailable', error: 'bad router.json' };
  await pane.redraw();
  expect(await pane.find({ type: 'Text', text: /Routing unavailable/ })).toBeDefined();
  await pane.unmount();
});
