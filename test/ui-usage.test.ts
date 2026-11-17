import type { PluginState } from 'claude-code';
import { expect, mock, test } from 'claude-code/testing';
import { emptyUsage, recordUsage } from '../lib/usage.mjs';
import { reply } from './usage-fixtures.mjs';

type View = PluginState['router']['view'];

// Three days of replies up to now, so the last 7 days have a trend: code and explore replies, each day's at noon or
// now, whichever is earlier.
const DAY = 86_400_000;
function record(now: number) {
  let out = emptyUsage();
  for (const back of [2, 1, 0]) {
    const when = now - back * DAY;
    out = recordUsage(out, [reply(when, 'code'), reply(when, 'explore'), reply(when, 'hard')], { now: when });
  }
  return out;
}

// The graphical Usage tab mounted on desktop: the engine accepts its cards, tables, bars and the trend Svg; the period,
// grouping, What if, an open row and Delete history answer by key, and a narrow pane still draws.
test('desktop Usage: the cards draw in the engine and their controls answer', async ($, on) => {
  mock.store(on);
  on('session.id', () => ({ value: 'ui-usage' }));
  on('session.model', () => ({ value: 'claude-opus-5-5' }));
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000 }, rateLimits: [] } }));
  on('session.cwd', () => ({ value: '/fixture/project' }));
  on('command.register', () => ({ value: { command: 'router' } }));
  on('settings.read', () => ({ value: {} }));
  on('ui.log', () => ({ value: undefined }));
  mock.env(on, { HOME: '/fixture', CLAUDE_CONFIG_DIR: '/fixture/team' });
  on('fs.exists', () => ({ value: false }));
  on('fs.stat', () => ({ value: { isLink: false } }));
  const usage = record(Date.now());
  const state = {
    view: {
      phase: 'routed',
      mode: 'auto',
      tab: 'usage',
      usagePeriod: '7d',
      nativeModel: 'claude-opus-5-5',
      nativeEffort: 'xhigh',
      credentials: { jev: null },
      usageSession: usage,
      usageStore: usage,
    } as unknown as View,
  };
  on('state.get', { plugin: 'router', key: 'view' }, () => ({ value: { value: state.view, version: 1 } }));
  on('state.set', { plugin: 'router', key: 'view' }, (_$, e) => {
    state.view = e.value;
    return { value: { isSet: true, version: 2 } };
  });
  const mount = (columns: number) =>
    $.ui.mount({
      plugin: 'router',
      surface: 'desktop',
      component: 'Pane',
      requestId: 'jev-router',
      viewport: { columns, rows: 200 },
      props: {
        title: 'Router',
        isFocused: true,
        bodyColumns: columns,
        placement: 'dock',
        scroll: { offset: 0, bodyRows: 200 },
        view: {},
      },
    });
  const pane = await mount(100);
  // Every find that comes back empty, named, so one failure says which.
  const misses: string[] = [];
  const need = async (where: typeof pane, q: Parameters<typeof pane.find>[0]) => {
    if (!(await where.find(q))) misses.push(JSON.stringify(q));
  };
  for (const title of ['Summary', 'Trend', 'Breakdown', 'About these numbers'])
    await need(pane, { type: 'Text', text: title });
  await need(pane, { type: 'Text', text: /^All projects · / });
  await need(pane, { type: 'Text', text: 'Replies' });
  await need(pane, { type: 'Svg' });
  for (const key of [
    'period-session',
    'period-7d',
    'group-model',
    'usage-compare',
    'row-activity:code',
    'delete-history',
  ])
    await need(pane, { key });
  expect(await pane.find({ type: 'Text', text: /p next|g next/ })).toBeUndefined();

  await pane.press({ key: 'group-model' });
  expect(state.view.usageGroup).toBe('model');
  await pane.press({ key: 'usage-compare' });
  expect(state.view.usageCompare).toBe(true);
  await pane.redraw();
  await need(pane, { type: 'Text', text: 'Routed' });
  await pane.press({ key: 'row-model:claude-sonnet-5-5' });
  expect(state.view.usageOpen).toBe('model:claude-sonnet-5-5');
  await pane.redraw();
  await need(pane, { type: 'Text', text: /^Cheaper / });

  await pane.press({ key: 'delete-history' });
  expect(state.view.confirmDelete).toBe(true);
  await pane.redraw();
  await need(pane, { key: 'delete-confirm' });
  await pane.press({ key: 'delete-keep' });
  expect(state.view.confirmDelete).toBe(false);
  await pane.press({ key: 'period-session' });
  expect(state.view.usagePeriod).toBe('session');
  await pane.unmount();

  // A narrow pane drops the replies and share columns; the same keys answer.
  state.view = { ...state.view, usagePeriod: '7d' } as View;
  const narrow = await mount(60);
  await need(narrow, { type: 'Text', text: 'Breakdown' });
  expect(await narrow.find({ type: 'Text', text: 'Replies' })).toBeUndefined();
  await narrow.press({ key: 'period-all' });
  expect(state.view.usagePeriod).toBe('all');
  await narrow.unmount();
  expect(misses).toEqual([]);
});
