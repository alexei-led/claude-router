import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { renderBand } from '../lib/band.mjs';
import { loadConfig } from '../lib/config.mjs';
import { savingsLine } from '../lib/display.mjs';
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
const band = (props) => screen(renderBand(ELEMENTS, PROXY, view(props), null, { columns: 160 }, actions))[1];

test('plan and credits models add up at API prices: one sum, its parts and the cost, whichever model is yours', () => {
  for (const [name, props, expected] of [
    [
      'started on Opus: DeepSeek turns are cheaper models',
      {
        nativeModel: OPUS,
        nativeEffort: 'xhigh',
        usageSession: record(
          { [`low|${DEEPSEEK}@low`]: [60, 4.1, 50, -45.9, 0, 0], [`high|${OPUS}@xhigh`]: [40, 20, 20, 0, 0, 0] },
          { [OPUS]: 100 },
        ),
      },
      'session  routing −$45.90 (−66%) vs Opus 5.5 · xhigh  =  −$45.90 cheaper models  ·  $24.10 at API prices · 100 replies',
    ],
    [
      'started on DeepSeek: Opus turns are stronger models',
      {
        nativeModel: DEEPSEEK,
        nativeEffort: 'low',
        usageSession: record(
          { [`low|${DEEPSEEK}@low`]: [60, 4.1, 4.1, 0, 0, 0], [`high|${OPUS}@xhigh`]: [40, 20, 1.5, 0, 18.5, 0] },
          { [DEEPSEEK]: 100 },
        ),
      },
      'session  routing +$18.50 (×4.3) vs DeepSeek Flash · low  =  +$18.50 stronger models  ·  $24.10 at API prices · 100 replies',
    ],
  ]) {
    const row = band(props);
    assert.equal(row, expected, name);
    assert.doesNotMatch(row, /\b(plan|credits|observed)\b/, name);
  }
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
    NOW,
  );
  assert.match(line, /^Session: routing \$0\.00 vs .+, \$24\.10 at API prices, 100 replies$/);
  assert.doesNotMatch(line, /mix plan and credits/);
});
