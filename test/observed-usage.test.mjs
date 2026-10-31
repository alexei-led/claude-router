import assert from 'node:assert/strict';
import test from 'node:test';
import { sessionRow } from '../lib/band.mjs';
import { loadConfig } from '../lib/config.mjs';
import { savingsLine } from '../lib/display.mjs';
import { renderPanel } from '../lib/panel.mjs';
import { compareModels } from '../lib/savings.mjs';
import {
  allTime,
  emptyUsage,
  mergeUsage,
  readUsage,
  recordUsage,
  replyEntry,
  summarize,
  withReplies,
} from '../lib/usage.mjs';
import { drain, ELEMENTS, harness, press, screen, start, step } from './harness.mjs';

const NOW = new Date(2026, 9, 31, 12).getTime();
const ALL = { from: null, to: null };
const USAGE = { input_tokens: 100, cache_read_input_tokens: 800, cache_creation_input_tokens: 200, output_tokens: 10 };
const entry = (overrides = {}) =>
  replyEntry({
    at: NOW,
    mode: 'cost',
    activity: 'code',
    tier: 'low',
    route: 'MiniMax-M3.1-Flash@low',
    yours: 'MiniMax-M3.1-Flash',
    reply: null,
    observedUsd: 0.002,
    replies: {},
    usage: USAGE,
    ...overrides,
  });

test('observed replies survive unavailable comparisons, live and after persistence', () => {
  const record = recordUsage(emptyUsage(), [entry()], { now: NOW });
  for (const stored of [withReplies(emptyUsage(), [entry()]), readUsage(JSON.parse(JSON.stringify(record)))]) {
    const s = summarize(stored, ALL);
    assert.equal(s.replies, 0);
    assert.equal(s.yoursUsd, 0);
    assert.equal(s.observed.replies, 1);
    assert.equal(s.observed.routedUsd, 0.002);
    assert.equal(s.observed.inputTokens, 1100);
    assert.equal(s.observed.cacheReadTokens, 800);
    assert.equal(s.observed.outputTokens, 10);
  }
  const compared = entry({
    reply: { routedUsd: 0.001, yoursUsd: 0.003, cheaperUsd: -0.002, strongerUsd: 0, switchUsd: 0 },
  });
  const mixed = summarize(mergeUsage([record, recordUsage(emptyUsage(), [compared], { now: NOW })]), ALL);
  assert.equal(mixed.replies, 1);
  assert.equal(mixed.observed.replies, 2);
  assert.equal(mixed.observed.routedUsd, 0.003);
});

test('band and pane show observed-only totals without invented savings in every period', () => {
  const config = loadConfig({ provider: 'minimax' });
  const record = recordUsage(emptyUsage(), [entry()], { now: NOW });
  const view = {
    phase: 'routed',
    mode: 'auto',
    nativeModel: config.models.flash.id,
    nativeEffort: 'high',
    usageSession: record,
    usageStore: record,
    tab: 'usage',
    routingMode: { mode: 'cost', source: 'session' },
  };
  const band = sessionRow(config, view, 120, NOW)
    .map((p) => p.text)
    .join('');
  assert.match(band, /observed/);
  assert.match(band, /1 repl/);
  assert.ok(!band.includes('no replies yet'));
  for (const period of ['session', 'today', '7d', '30d', 'month', 'all']) {
    const lines = screen(
      renderPanel(ELEMENTS, config, { ...view, usagePeriod: period }, null, new Proxy({}, { get: () => () => {} }), {
        columns: 62,
        now: NOW,
      }),
    ).join('\n');
    assert.match(lines, /observed/i);
    assert.match(lines, /comparison unavailable/i);
    assert.match(lines, /input 1\.1K/);
    assert.match(lines, /coding/);
    assert.ok(!lines.includes('No routed replies'));
    assert.ok(!lines.includes('routing +'));
  }
});

test('observed-only records retain period bounds, zero prices and migration safety', () => {
  const yesterday = NOW - 86400000;
  const compared = entry({
    at: yesterday,
    reply: { routedUsd: 0.001, yoursUsd: 0.003, cheaperUsd: -0.002, strongerUsd: 0, switchUsd: 0 },
  });
  const old = recordUsage(emptyUsage(), [compared], { now: yesterday });
  const v2 = structuredClone(old);
  v2.version = 2;
  delete v2.days[Object.keys(v2.days)[0]].uncompared;
  const migrated = readUsage(v2);
  assert.equal(summarize(migrated, ALL).observed.replies, 1);
  const record = recordUsage(migrated, [entry({ observedUsd: 0 })], { now: NOW });
  const today = Object.keys(record.days).sort().at(-1);
  const s = summarize(record, { from: today, to: today });
  assert.equal(s.observed.replies, 1);
  assert.equal(s.observed.routedUsd, 0);
  assert.equal(s.replies, 0);
  assert.throws(() => entry({ observedUsd: null }), /known price/);
  const damaged = structuredClone(record);
  damaged.days[today].uncompared[entry().cell][2] = 10;
  assert.equal(summarize(readUsage(damaged), ALL).observed.replies, 1);
});

test('All adds legacy spend without losing observed-only coverage', () => {
  const record = recordUsage(emptyUsage(), [entry()], { now: NOW });
  const legacy = {
    version: 1,
    since: 1,
    replies: 2,
    routedUsd: 1,
    yoursUsd: 2,
    cheaperUsd: -1,
    strongerUsd: 0,
    switchUsd: 0,
  };
  const all = allTime(record, legacy);
  assert.equal(all.totals.replies, 2);
  assert.equal(all.observed.replies, 3);
  assert.equal(all.observed.uncomparedReplies, 1);
  assert.ok(Math.abs(all.observed.routedUsd - 1.002) < 1e-9);
});

test('text status and an unpriced native model cannot hide observed spend', () => {
  const config = loadConfig({ provider: 'minimax' });
  const record = recordUsage(emptyUsage(), [entry()], { now: NOW });
  const view = { nativeModel: 'unpriced-native-model', usageSession: record, usageStore: record };
  assert.match(savingsLine(config, view, NOW), /observed/);
  assert.match(savingsLine(config, view, NOW), /comparison unavailable/);
  assert.match(
    sessionRow(config, view, 120, NOW)
      .map((p) => p.text)
      .join(''),
    /observed/,
  );
});

test('mixed comparison coverage never treats unmeasured savings as zero', () => {
  const config = loadConfig({ provider: 'minimax' });
  const compared = entry({
    reply: { routedUsd: 0.001, yoursUsd: 0.003, cheaperUsd: -0.002, strongerUsd: 0, switchUsd: 0 },
  });
  const record = recordUsage(emptyUsage(), [entry(), compared], { now: NOW });
  const base = {
    phase: 'routed',
    mode: 'auto',
    nativeModel: config.models.flash.id,
    tab: 'usage',
    usageSession: record,
    usageStore: record,
    usageOpen: 'activity:code',
  };
  const actions = new Proxy({}, { get: () => () => {} });
  const lines = screen(renderPanel(ELEMENTS, config, base, null, actions, { columns: 62, now: NOW })).join('\n');
  assert.match(lines, /2 replies/);
  assert.match(lines, /1 comparable reply only/);
  assert.match(lines, /comparison unavailable.*input/i);
  const whatIf = screen(
    renderPanel(ELEMENTS, config, { ...base, usageCompare: true }, null, actions, { now: NOW }),
  ).join('\n');
  assert.match(whatIf, /What if unavailable/);
});

test('MiMo native effort does not create a different cache identity when efforts are unsupported', () => {
  const config = loadConfig({ provider: 'mimo' }),
    model = config.models.pro.id;
  const args = {
    usage: { ...USAGE, model },
    served: { model, effort: null },
    effort: 'high',
    yours: model,
    ttl: null,
    now: NOW,
  };
  const compared = compareModels(config, {}, args);
  assert.ok(compared.reply);
  assert.equal(compared.reply.routedUsd, compared.reply.yoursUsd);
  const kimi = loadConfig({ provider: 'kimi' }),
    id = kimi.models.k3.id;
  assert.equal(
    compareModels(
      kimi,
      {},
      { ...args, usage: { ...USAGE, model: id }, served: { model: id, effort: 'low' }, effort: 'max', yours: id },
    ).reply,
    null,
  );
});

test('native hook records provider cost with no comparison and keeps it after turn completion', async () => {
  const h = harness();
  h.env.set('CLAUDE_ROUTER_PROVIDER', 'minimax');
  h.files.set('/fixture/team/minimax-router.json', '{}');
  h.model('MiniMax-M3.1-Flash[1m]');
  await start(h);
  await h.event('command.run', { command: 'router', args: 'pin high' });
  await drain(
    h.step(
      { ...step, model: 'MiniMax-M3.1-Flash[1m]', effort: 'high' },
      { usage: { ...USAGE, model: 'MiniMax-M3.1-Flash' } },
    ),
  );
  assert.equal(summarize(withReplies(emptyUsage(), h.view().usageLive), ALL).observed.replies, 1);
  await h.event('turn.complete', { turnId: 't1' });
  assert.equal(summarize(readUsage(h.view().usageSession), ALL).observed.replies, 1);
  await press(h, 'tab-usage');
  assert.match(screen(await h.render()).join('\n'), /observed/i);
});
