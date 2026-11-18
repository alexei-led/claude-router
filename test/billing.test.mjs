import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { renderBand } from '../lib/band.mjs';
import { loadConfig } from '../lib/config.mjs';
import { savingsLine } from '../lib/display.mjs';
import { renderPanel } from '../lib/panel.mjs';
import { ELEMENTS, screen } from './harness.mjs';

const PROXY = loadConfig({
  provider: 'model-proxy',
  userFile: JSON.parse(readFileSync(new URL('./fixtures/model-proxy-router.json', import.meta.url), 'utf8')),
});
const DEEPSEEK = 'deepseek-flash[1m]';
const OPUS = 'claude-opus-5-5';
const NOW = Date.parse('2026-11-03T12:00:00Z');
const actions = new Proxy({}, { get: () => () => {} });

// A session record: `cells` as { 'tier|model@effort': [replies, routed, yours, cheaper, stronger, switch] }, every
// reply priced against `yours` ({ model id: replies }).
const record = (cells, yours) => ({
  version: 3,
  since: NOW,
  days: {
    '2026-11-03': {
      cells: Object.fromEntries(
        Object.entries(cells).map(([key, sums]) => [`balanced|none|${key}`, [...sums, 1000, 900, 10]]),
      ),
      uncompared: {},
      whatIf: {},
      yours,
      hours: {},
      turns: 10,
      switches: { tier: 2, activity: 0 },
    },
  },
});
const view = (props) => ({
  mode: 'auto',
  phase: 'routed',
  tier: 'low',
  bandDetail: true,
  usageStore: null,
  savingsStore: null,
  ...props,
});
const band = (props, usage = null) =>
  screen(renderBand(ELEMENTS, PROXY, view(props), usage, { columns: 160, now: NOW }, actions))[1];
// Claude Code's session usage on a plan: its windows show the plan; DeepSeek runs on provider credits.
const PLAN = {
  rateLimits: [
    { kind: 'five_hour', percentUsed: 37, resetsAt: '2026-11-03T11:00:00Z' },
    { kind: 'seven_day', percentUsed: 81, resetsAt: '2026-11-01T00:00:00Z' },
  ],
};
const STARTS = {
  'started on Opus: DeepSeek turns are cheaper': {
    nativeModel: OPUS,
    nativeEffort: 'xhigh',
    usageSession: record(
      { [`low|${DEEPSEEK}@low`]: [60, 4.1, 50, -45.9, 0, 0], [`high|${OPUS}@xhigh`]: [40, 20, 20, 0, 0, 0] },
      { [OPUS]: 100 },
    ),
  },
  'started on DeepSeek: Opus turns are stronger': {
    nativeModel: DEEPSEEK,
    nativeEffort: 'low',
    usageSession: record(
      { [`low|${DEEPSEEK}@low`]: [60, 4.1, 4.1, 0, 0, 0], [`high|${OPUS}@xhigh`]: [40, 20, 1.5, 0, 18.5, 0] },
      { [DEEPSEEK]: 100 },
    ),
  },
};

test('plan and credits models add up at API prices in one sum against no routing, whichever model is yours', () => {
  for (const [name, diff, yours] of [
    ['started on Opus: DeepSeek turns are cheaper', '−$45.90 (−66%)', 'Opus 5.5'],
    ['started on DeepSeek: Opus turns are stronger', '+$18.50 (×4.3)', 'DeepSeek Flash'],
  ]) {
    assert.equal(band(STARTS[name]), `session ≈$24.10 API estimate   ${diff} vs ${yours}   100 replies`, name);
    assert.equal(
      band(STARTS[name], PLAN),
      `plan 5h ▰▰▰▱▱▱▱▱ 37%   7d 81%   session ≈$24.10 API estimate   credits ≈$4.10   ${diff} vs ${yours}   100 replies`,
      `${name} on a plan`,
    );
  }
});

test('on a plan /router labels the total and credits as API estimates, as the band does', () => {
  const props = STARTS['started on Opus: DeepSeek turns are cheaper'];
  assert.equal(
    savingsLine(PROXY, view(props), PLAN, NOW),
    'Plan: 5h 37% · 7d 81%\nSession: ≈$24.10 API estimate · credits ≈$4.10 · −$45.90 (−66%) vs Opus 5.5 ≈$70.00 · 100 replies',
  );
  assert.equal(
    savingsLine(PROXY, view(props), null, NOW),
    'Session: ≈$24.10 API estimate · −$45.90 (−66%) vs Opus 5.5 ≈$70.00 · 100 replies',
  );
});

test('Now and Usage identify configured-rate estimates for every billing product, not invoice or quota evidence', () => {
  for (const [config, usage, model, note] of [
    [loadConfig(), PLAN, OPUS, 'API estimate · plan quota, not a charge'],
    [loadConfig({ provider: 'deepseek' }), null, DEEPSEEK, 'API estimate · configured rates, not an invoice'],
    [PROXY, PLAN, DEEPSEEK, 'API estimate · credits ≈$24.10'],
  ]) {
    const props = view({
      nativeModel: model,
      nativeEffort: 'high',
      usageSession: record({ [`low|${model}@high`]: [10, 24.1, 30, -5.9, 0, 0] }, { [model]: 10 }),
    });
    const now = screen(
      renderPanel(ELEMENTS, config, { ...props, tab: 'now' }, usage, actions, { columns: 140, now: NOW }),
    );
    assert.ok(now.includes(`  ≈$24.10  ${note}  [ Usage ]`), note);
    const shown = screen(
      renderPanel(ELEMENTS, config, { ...props, tab: 'usage', usagePeriod: 'session', help: true }, usage, actions, {
        columns: 140,
        now: NOW,
      }),
    );
    assert.ok(shown.some((line) => line.startsWith('session · API estimate') && line.includes('≈$24.10')));
    assert.ok(shown.includes('≈$ is tokens × configured API rates in router.json (list/custom).'));
    assert.ok(shown.includes('These are estimates, not invoices or measured plan-quota savings.'));
    assert.ok(
      !shown.some((line) => /what was billed|what is billed|billed at list prices|billed as credits/.test(line)),
    );
  }
});

test('a plan window shows its reset only while it is ahead', () => {
  const props = STARTS['started on Opus: DeepSeek turns are cheaper'];
  const ahead = { ...PLAN, rateLimits: [{ kind: 'five_hour', percentUsed: 37, resetsAt: '2026-11-03T13:30:00Z' }] };
  const reset = new Date('2026-11-03T13:30:00Z').toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  assert.ok(band(props, ahead).startsWith(`plan 5h ▰▰▰▱▱▱▱▱ 37% ↻${reset} `));
  assert.match(band(props, PLAN), /^plan 5h ▰▰▰▱▱▱▱▱ 37% {3}7d/);
});

test('after /model moved between plan and credits models, /router still compares in one sum', () => {
  const line = savingsLine(
    PROXY,
    view({
      nativeModel: OPUS,
      nativeEffort: 'xhigh',
      usageSession: record(
        { [`low|${DEEPSEEK}@low`]: [60, 4.1, 4.1, 0, 0, 0], [`high|${OPUS}@xhigh`]: [40, 20, 20, 0, 0, 0] },
        { [DEEPSEEK]: 50, [OPUS]: 50 },
      ),
    }),
    null,
    NOW,
  );
  assert.equal(line, 'Session: ≈$24.10 API estimate · $0.00 vs unrouted ≈$24.10 · 100 replies');
});

test('the Usage tab labels mixed totals and credits as API estimates', () => {
  const props = { ...STARTS['started on Opus: DeepSeek turns are cheaper'], tab: 'usage', usagePeriod: 'session' };
  const lines = screen(renderPanel(ELEMENTS, PROXY, view(props), PLAN, actions, { columns: 100, now: NOW }));
  const at = lines.findIndex((line) => line.startsWith('session · API estimate'));
  assert.deepEqual(lines.slice(at, at + 2), [
    'session · API estimate     ≈$24.10        −$45.90     ≈$70.00',
    '  credits estimate          ≈$4.10',
  ]);
});
