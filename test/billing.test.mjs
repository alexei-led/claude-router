import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { renderBand } from '../lib/band.mjs';
import { DEFAULTS, loadConfig } from '../lib/config.mjs';
import { billingSplit, savingsLine } from '../lib/display.mjs';
import { renderPanel } from '../lib/panel.mjs';
import { readUsage, summarize } from '../lib/usage.mjs';
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
// Started on Opus: DeepSeek turns cost credits and save plan quota.
const ON_OPUS = record(
  { [`low|${DEEPSEEK}@low`]: [60, 4.1, 50, -45.9, 0, 0], [`high|${OPUS}@xhigh`]: [40, 20, 20, 0, 0, 0] },
  { [OPUS]: 100 },
);
// Started on DeepSeek: Opus turns spend plan quota and save credits.
const ON_DEEPSEEK = record(
  { [`low|${DEEPSEEK}@low`]: [60, 4.1, 4.1, 0, 0, 0], [`high|${OPUS}@xhigh`]: [40, 20, 1.5, 0, 18.5, 0] },
  { [DEEPSEEK]: 100 },
);
const MIXED_YOURS = record(
  { [`low|${DEEPSEEK}@low`]: [60, 4.1, 4.1, 0, 0, 0], [`high|${OPUS}@xhigh`]: [40, 20, 20, 0, 0, 0] },
  { [DEEPSEEK]: 50, [OPUS]: 50 },
);
// Five more DeepSeek replies whose cache history could not be compared: observed spend only.
const OBSERVED = structuredClone(ON_OPUS);
OBSERVED.days['2026-11-03'].uncompared = { [`balanced|none|low|${DEEPSEEK}@low`]: [5, 0.5, 0, 0, 0, 0, 100, 0, 10] };
const summaryOf = (value) => summarize(readUsage(value), { from: null, to: null });

test('a summary splits by billing only when its models span plan and credits', () => {
  for (const [name, config, value, expected] of [
    [
      'started on Opus',
      PROXY,
      ON_OPUS,
      {
        yours: 'plan',
        credits: { observedUsd: 4.1, routedUsd: 4.1, yoursUsd: 0 },
        plan: { observedUsd: 20, routedUsd: 20, yoursUsd: 70 },
      },
    ],
    [
      'started on DeepSeek',
      PROXY,
      ON_DEEPSEEK,
      {
        yours: 'credits',
        credits: { observedUsd: 4.1, routedUsd: 4.1, yoursUsd: 5.6 },
        plan: { observedUsd: 20, routedUsd: 20, yoursUsd: 0 },
      },
    ],
    [
      'your models in both billings',
      PROXY,
      MIXED_YOURS,
      {
        yours: null,
        credits: { observedUsd: 4.1, routedUsd: 4.1, yoursUsd: null },
        plan: { observedUsd: 20, routedUsd: 20, yoursUsd: null },
      },
    ],
    // Sonnet is not in the model-proxy file: the built-in Anthropic profile bills it.
    [
      'your model from a built-in profile',
      PROXY,
      record({ [`low|${DEEPSEEK}@low`]: [10, 1, 5, -4, 0, 0] }, { 'claude-sonnet-5-5': 10 }),
      {
        yours: 'plan',
        credits: { observedUsd: 1, routedUsd: 1, yoursUsd: 0 },
        plan: { observedUsd: 0, routedUsd: 0, yoursUsd: 5 },
      },
    ],
    ['one billing', DEFAULTS, record({ 'low|claude-haiku-5-5@high': [10, 1, 3, -2, 0, 0] }, { [OPUS]: 10 }), null],
    [
      'a model no profile prices',
      PROXY,
      record({ 'low|my-local-model@low': [10, 0, 5, -5, 0, 0] }, { [OPUS]: 10 }),
      null,
    ],
  ])
    assert.deepEqual(billingSplit(config, summaryOf(value)), expected, name);
});

test('the band and /router say each billing’s difference, never one sum of quota and cash', () => {
  const view = (usageSession, nativeModel, nativeEffort) => ({
    mode: 'auto',
    phase: 'routed',
    tab: 'now',
    credentials: { jev: null },
    tier: 'low',
    bandDetail: true,
    nativeModel,
    nativeEffort,
    usageSession,
  });
  const second = (v, columns = 140) => screen(renderBand(ELEMENTS, PROXY, v, null, { columns }, actions))[1];
  for (const [v, columns, expected] of [
    [
      view(ON_OPUS, OPUS, 'medium'),
      140,
      'session  routing credits +$4.10 · plan −$50.00 vs Opus 5.5 · medium  ·  100 replies',
    ],
    [view(ON_OPUS, OPUS, 'medium'), 70, 'session  routing credits +$4.10 · plan −$50.00 vs Opus 5.5 · medium'],
    [
      view(ON_DEEPSEEK, DEEPSEEK, 'high'),
      140,
      'session  routing credits −$1.50 · plan +$20.00 vs Deepseek-flash[1m] · high  ·  100 replies',
    ],
    [
      view(MIXED_YOURS, OPUS, 'medium'),
      140,
      'session  observed credits $4.10 · plan $20.00 · your models mix plan and credits  ·  100 replies',
    ],
    [
      view(OBSERVED, OPUS, 'medium'),
      140,
      'session  observed credits $4.60 · plan $20.00 · 105 replies · comparison unavailable',
    ],
  ])
    assert.equal(second(v, columns), expected, `${columns}`);
  for (const [v, expected] of [
    [
      view(ON_OPUS, OPUS, 'medium'),
      'Session: routing credits +$4.10 · plan −$50.00 vs Opus 5.5 · medium, 100 replies, est. at list prices',
    ],
    [
      view(OBSERVED, OPUS, 'medium'),
      'Session: observed credits $4.60 · plan $20.00 · 105 replies · comparison unavailable; 100 replies comparable only: routing credits +$4.10 · plan −$50.00, est. at list prices',
    ],
  ])
    assert.equal(savingsLine(PROXY, v, NOW), expected);
});

test('the pane tells routed, your model and the difference per billing', () => {
  const view = (props) => ({
    mode: 'auto',
    phase: 'routed',
    credentials: { jev: null },
    nativeModel: OPUS,
    nativeEffort: 'medium',
    usageSession: ON_OPUS,
    usageStore: ON_OPUS,
    usagePeriod: 'session',
    ...props,
  });
  const lines = (props) => screen(renderPanel(ELEMENTS, PROXY, view(props), null, actions, { columns: 100, now: NOW }));
  const after = (all, head, count) => all.slice(all.indexOf(head), all.indexOf(head) + count);
  const table = [
    '                           routed   your model   difference',
    '    Credits                 $4.10        $0.00       +$4.10',
    '    Plan                   $20.00       $70.00      −$50.00',
  ];
  const answer = 'routing credits +$4.10 · plan −$50.00 vs Opus 5.5 · medium';
  const usage = lines({ tab: 'usage', usageGroup: 'model', usageOpen: `model:${DEEPSEEK}` });
  assert.deepEqual(after(usage, answer, 6), [
    answer,
    '',
    ...table,
    '    at list prices; plan dollars stand for quota, credits are paid',
  ]);
  // A row billed otherwise than your model names its billing, and opens to its tokens without cross-billing parts.
  assert.deepEqual(after(usage, '                         replies      cost   vs yours   share', 4), [
    '                         replies      cost   vs yours   share',
    '  ▸ Opus 5.5                  40    $20.00      $0.00   83%',
    '  ▾ Deepseek-flash[1m]        60     $4.10    credits   17%',
    '      no activity             60     $4.10    credits',
  ]);
  assert.ok(usage.includes('      input 1.0K · output 10'));
  // Only the share of the cost stays worth a look: the other findings subtract one billing from the other.
  assert.ok(usage.includes('  high carried 83% of the cost · mostly Opus 5.5 · xhigh  [ Routes ]'));
  assert.ok(!usage.some((line) => line.includes('above your model')));
  const whatIf = lines({ tab: 'usage', usageCompare: true });
  assert.ok(whatIf.includes('  Routed adds plan and credits at list prices; plan dollars stand for quota'));
  const now = lines({ tab: 'now' });
  assert.deepEqual(after(now, `  ${answer}  [ Usage ]`, 4), [`  ${answer}  [ Usage ]`, ...table]);
});
