// Golden snapshots of the terminal element trees `renderBand` and `renderPanel` draw, so a later change to either (a
// second renderer, a shared view model) proves the terminal output is unchanged. One text file per case under
// test/fixtures/ui-golden/, named <band|pane>-<case>-<columns>.txt. UPDATE_GOLDEN=1 rewrites them; otherwise the test
// compares. Handlers are dropped; every other prop (key, label, variant, hotkey, style) is kept.
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import test, { after } from 'node:test';

// Times print through toLocaleTimeString: fix the zone before any module builds a date.
process.env.TZ = 'UTC';

const { renderBand } = await import('../lib/band.mjs');
const { DEFAULTS, editActivity, loadConfig } = await import('../lib/config.mjs');
const { GATEWAY_SETTINGS, NOT_A_TIER_REASON } = await import('../lib/display.mjs');
const { renderPanel, routeDraftOf } = await import('../lib/panel.mjs');
const { emptySubagentStore, recordAgent, spawnRecord } = await import('../lib/subagents.mjs');
const { BAND_STATES, CLAUDE, ROUTED, SESSION_RECORDS } = await import('./band-states.mjs');
const { ELEMENTS, goldenText, quiet } = await import('./harness.mjs');
const { at, NOW, OTHER, reply, SESSION, STORE } = await import('./usage-fixtures.mjs');
const { emptyUsage, recordUsage } = await import('../lib/usage.mjs');

const GOLDEN = new URL('./fixtures/ui-golden/', import.meta.url);
const UPDATE = process.env.UPDATE_GOLDEN === '1';

// Compares the tree's text form with its golden file, or writes the file when UPDATE_GOLDEN=1.
const cases = new Set();
function golden(name, tree) {
  cases.add(name);
  const actual = goldenText(tree);
  const file = new URL(`${name}.txt`, GOLDEN);
  if (UPDATE) {
    mkdirSync(GOLDEN, { recursive: true });
    writeFileSync(file, actual);
    return;
  }
  assert.equal(actual, readFileSync(file, 'utf8'));
}

// One model at different efforts: the session and Usage show the effort mix, not a saving.
const EFFORT_ONLY = {
  ...DEFAULTS,
  activityRouting: 'off',
  routes: Object.fromEntries(
    Object.entries(DEFAULTS.routes).map(([tier, route]) => [tier, { model: 'opus', effort: route.effort }]),
  ),
};
// Haiku bills credits, the rest the plan: the mixed wording.
const MIXED_BILLING = {
  ...DEFAULTS,
  models: Object.fromEntries(
    Object.entries(DEFAULTS.models).map(([key, model]) => [
      key,
      { ...model, billing: key === 'haiku' ? 'credits' : 'plan' },
    ]),
  ),
};
const SLOW = {
  ...DEFAULTS,
  classifiers: { ...DEFAULTS.classifiers, jev: { ...DEFAULTS.classifiers.jev, timeoutMs: 500 } },
};
// One reply so far: the early-session note.
const EARLY = recordUsage(emptyUsage(), [reply(at(2026, 10, 13, 10), 'code')], { now: at(2026, 10, 13, 10) });
const LEGACY = {
  version: 1,
  since: 1,
  replies: 400,
  routedUsd: 41.18,
  yoursUsd: 52.6,
  cheaperUsd: -14.9,
  strongerUsd: 0,
  switchUsd: 3.48,
};
const ACTIVITY_STORE = {
  version: 1,
  confusion: { code: { code: 10, read: 3 }, ops: { ops: 4, code: 1 }, debug: { code: 2 }, uncertain: { talk: 2 } },
  runs: {},
  lateral: { taken: 4, refused: 2 },
};
const ACTIVITY_METRICS = {
  version: 1,
  latency: { jev: [0, 0, 0, 3, 15, 1, 1, ...Array(15).fill(0)], openai: [9, ...Array(21).fill(0)] },
  downMoves: { moves: 12, escalations: 1 },
};

// Subagent records: `[day, type or pass:reason, model, core model]` per agent, one flush each.
function agentStore(agents) {
  let store = emptySubagentStore();
  for (const [day, kind, model, core] of agents) {
    const pass = kind.startsWith('pass:') ? kind.slice(5) : null;
    const agent = {
      ...spawnRecord({
        sessionId: 's1',
        spawn: { subagentType: pass ? 'x' : kind },
        pass,
        choice: pass ? null : 'haiku',
        routedModel: model,
        coreModel: core,
        move: model === core || pass ? null : model.includes('opus') ? 'up' : 'down',
      }),
      requests: 2,
      pricedRequests: 2,
      actualUsd: model.includes('opus') ? 0.5 : 0.1,
      otherUsd: pass ? 0 : model === core ? 0.1 : core.includes('opus') ? 0.5 : 0.2,
    };
    store = recordAgent(store, agent, at(2026, 10, day));
  }
  return store;
}
const AGENTS = agentStore([
  [9, 'Explore', 'claude-haiku-5-5', 'claude-opus-5-5'],
  [11, 'Explore', 'claude-haiku-5-5', 'claude-opus-5-5'],
  [13, 'Explore', 'claude-haiku-5-5', 'claude-opus-5-5'],
  [13, 'dev-flow:reviewer', 'claude-opus-5-5', 'claude-sonnet-5-5'],
  [13, 'dev-flow:reviewer', 'claude-sonnet-5-5', 'claude-sonnet-5-5'],
  [13, 'dev-flow:reviewer', 'claude-haiku-5-5', 'claude-sonnet-5-5'],
  [13, 'pass:workflow', 'claude-opus-5-5', null],
]);

// A live reply whose cache rebuild cost more than the cheaper model saved.
const LOST = { ...reply(at(2026, 10, 13, 10), 'code'), sums: [1, 1, 0.5, -0.1, 0, 0.6, 0, 0, 0] };

const DECISIONS = [
  {
    kind: 'start',
    at: NOW - 600e3,
    origin: 'composer',
    cls: 'code',
    p: 0.91,
    act: 'code',
    actP: 0.8,
    same: false,
    tier: 'medium',
    activity: 'code',
    route: 'claude-sonnet-5-5@high',
    reason: 'jump',
  },
  {
    kind: 'start',
    at: NOW - 300e3,
    origin: 'composer',
    err: 'timeout',
    tier: 'medium',
    route: 'claude-sonnet-5-5@high',
    reason: 'no-advice',
  },
];

// ---- the band ---------------------------------------------------------------------------------------------------

for (const [name, { view, usage = null }] of Object.entries(BAND_STATES))
  for (const columns of [100, 40])
    test(`band ${name} at ${columns} columns`, () => {
      golden(`band-${name}-${columns}`, renderBand(ELEMENTS, DEFAULTS, view, usage, { columns, now: NOW }, quiet));
    });

// So narrow that only the first segment survives, cut with an ellipsis.
for (const columns of [14, 20])
  test(`band routed at ${columns} columns`, () => {
    golden(`band-routed-${columns}`, renderBand(ELEMENTS, DEFAULTS, ROUTED, CLAUDE, { columns, now: NOW }, quiet));
  });

// A subagent's band is its own row: moved up, moved down, kept, passed through, failed, and without its record.
const AGENT = { routedModel: 'claude-haiku-5-5', coreModel: 'claude-opus-5-5', move: 'down', choice: 'haiku' };
const SUBAGENT_BANDS = {
  moved: { agent: AGENT },
  'moved-up': { agent: { ...AGENT, routedModel: 'claude-opus-5-5', coreModel: 'claude-haiku-5-5', move: 'up' } },
  kept: { agent: { ...AGENT, routedModel: 'claude-opus-5-5', move: null } },
  passed: { agent: { ...AGENT, move: null, pass: 'workflow' } },
  'core-failed': { agent: { ...AGENT, move: null, choice: 'core', failed: true } },
  'core-silent': { agent: { ...AGENT, move: null, choice: 'core' } },
  'no-record': { agent: null },
  'routing-off': { agent: null, config: { ...DEFAULTS, subagentRouting: 'off' } },
};
for (const [name, { agent, config = { ...DEFAULTS, subagentRouting: 'on' } }] of Object.entries(SUBAGENT_BANDS))
  for (const columns of [100, 40])
    test(`band subagent ${name} at ${columns} columns`, () => {
      golden(
        `band-subagent-${name}-${columns}`,
        renderBand(ELEMENTS, config, ROUTED, null, { columns, agentId: 'a1', agent, now: NOW }, quiet),
      );
    });

// ---- the pane ---------------------------------------------------------------------------------------------------

const KEYS_SET = { jev: null, clef: null, 'clef-flash': null, 'clef-omni': null };
const BARE = { mode: 'auto', phase: 'routed', credentials: KEYS_SET };
const RICH = {
  ...ROUTED,
  credentials: KEYS_SET,
  adviceMs: 347,
  probabilities: { high: 0.88, medium: 0.07, low: 0.03 },
  estimate: { threshold: 0.82, upgradeMass: 0.88, taxUsd: 0.476 },
  activity: 'code',
  contextTokens: 90_000,
  inputTokens: 1000,
  cacheRead: 900,
  cacheWrite: 100,
  outputTokens: 300,
  history: [1000, 5000, 3000],
  tiers: ['low', 'medium', 'high'],
  strip: { per: 1, cells: [{ low: 2 }, { medium: 1 }, { high: 1, low: 1 }, { none: 1 }] },
  usageSession: SESSION,
  usageStore: STORE,
  savingsStore: LEGACY,
  subagentSession: AGENTS,
  subagentStore: AGENTS,
  activityStore: ACTIVITY_STORE,
  activityMetrics: ACTIVITY_METRICS,
  activityStats: { agreement: { matched: 19, total: 22 } },
  health: { failures: 1, pausedUntil: 0 },
  configPath: '/fixture/team/router.json',
  decisionRows: DECISIONS,
};
const TABS = ['now', 'routes', 'policy', 'classifier', 'usage'];

const pane = (config, view, usage, columns) => renderPanel(ELEMENTS, config, view, usage, quiet, { columns, now: NOW });

for (const tab of TABS)
  for (const columns of [60, 80, 120]) {
    test(`pane ${tab} with usage at ${columns} columns`, () => {
      golden(`pane-${tab}-usage-${columns}`, pane(DEFAULTS, { ...RICH, tab }, CLAUDE, columns));
    });
    test(`pane ${tab} without usage at ${columns} columns`, () => {
      golden(`pane-${tab}-bare-${columns}`, pane(DEFAULTS, { ...BARE, tab }, null, columns));
    });
  }

// An unsaved Routes and Policy draft: a tier route, the baseline, an activity cell, the activity mode and a policy value.
const CONFIG = loadConfig();
const draftEdit = editActivity(routeDraftOf(CONFIG, {}), CONFIG, 'code', 'high', 'add');
const DRAFT = {
  ...draftEdit,
  routes: { ...draftEdit.routes, micro: { model: 'sonnet', effort: 'high' } },
  baselineTier: 'micro',
  activities: { ...draftEdit.activities, code: { high: { model: 'opus', effort: 'max' } } },
  activityRouting: 'off',
};
const NOTICE = { notice: 'Saved routes', lastWrite: { label: 'routes' } };

const MANY_CELLS = {
  per: 1,
  cells: Array.from({ length: 60 }, (_, i) => ({ [['low', 'medium', 'high', 'none'][i % 4]]: 1 })),
};
const EXTRAS = {
  'now-help': { tab: 'now', help: true },
  'now-pending-pin': { tab: 'now', pendingPin: 'low', reason: 'pin' },
  'now-activity-override': {
    tab: 'now',
    tier: 'low',
    selectedModel: 'claude-sonnet-5-5',
    actualModel: 'claude-sonnet-5-5',
    effort: 'high',
    activity: 'code',
    reason: 'same-tier',
    taskPhase: 'build',
  },
  'now-no-priced-replies': { tab: 'now', usageSession: null },
  'now-early-session': { tab: 'now', usageSession: EARLY },
  'now-mixed-billing': { tab: 'now' },
  'now-no-strip': { tab: 'now', usageSession: null, strip: null },
  'now-fallback': {
    tab: 'now',
    actualModel: 'claude-sonnet-5-5',
    reason: 'native-fallback',
    routingMode: { mode: 'cost', source: 'session' },
    taskPhase: 'build',
    projectError: 'router.json: unknown model',
    subagentsRunning: 2,
  },
  'now-downgrade': {
    tab: 'now',
    reason: 'downgrade',
    activity: 'ops',
    estimate: { threshold: 0.9, downgradeMass: 0.93 },
    routingMode: { mode: 'quality', source: 'project' },
  },
  'now-usage-detail': {
    tab: 'now',
    usageDetail: true,
    comparison: { incumbent: 'low', candidate: 'high', minUsd: -0.0123, maxUsd: 0.5, paybackTurns: 3 },
  },
  'now-detail-none': { tab: 'now', usageDetail: true, history: [], comparison: null, estimate: null },
  'now-decisions': { tab: 'now', decisionRows: DECISIONS },
  'now-lost': {
    tab: 'now',
    usageSession: emptyUsage(),
    usageLive: Array(10).fill(LOST),
  },
  'now-effort-only': { tab: 'now', subagentSession: null },
  'now-strip-many': { tab: 'now', strip: MANY_CELLS },
  'now-strip-restarted': { tab: 'now', strip: { ...RICH.strip, from: at(2026, 10, 13, 12) } },
  'now-off': { tab: 'now', mode: 'manual', phase: 'manual', selectedModel: null, nativeModel: 'claude-opus-5-5' },
  'now-unavailable': { tab: 'now', phase: 'unavailable', error: GATEWAY_SETTINGS, tier: null },
  'now-unavailable-plain': { tab: 'now', phase: 'unavailable', error: 'bad router.json', tier: null },
  'now-no-classifier-key': { tab: 'now', credentials: {} },
  // The warnings sit under the tab row on every tab, not only Now.
  'routes-warnings': {
    tab: 'routes',
    projectError: 'router.json: unknown model',
    actualModel: 'claude-sonnet-5-5',
    credentials: {},
  },
  'routes-draft': { tab: 'routes', routeDraft: DRAFT, ...NOTICE },
  'status-last-change': { tab: 'now', lastWrite: { label: 'classifier jev' } },
  'status-not-saved': { tab: 'routes', notice: 'Not saved: router.json is read-only' },
  'status-other-notice': { tab: 'policy', notice: 'Reload the session to apply' },
  'routes-draft-on-now': { tab: 'now', routeDraft: DRAFT },
  'routes-cell-tier': { tab: 'routes', routeCell: 'tier.low' },
  'routes-cell-activity': { tab: 'routes', routeCell: 'code.high', routeDraft: DRAFT },
  'routes-cell-default': { tab: 'routes', routeCell: 'ops.medium' },
  'routes-cell-automatic': { tab: 'routes', routeCell: 'code.high', routeDraft: DRAFT },
  'routes-cell-restore': {
    tab: 'routes',
    routeCell: 'ops.medium',
    routeDraft: { ...routeDraftOf(CONFIG, {}), activities: { ops: { medium: { model: 'opus', effort: 'max' } } } },
  },
  'routes-cell-no-effect': {
    tab: 'routes',
    routeCell: 'explore.high',
    routeDraft: { ...routeDraftOf(CONFIG, {}), activities: { explore: { high: { model: 'opus', effort: 'xhigh' } } } },
  },
  'routes-same-model': {
    tab: 'routes',
    routeDraft: { ...routeDraftOf(CONFIG, {}), routes: { ...CONFIG.routes, high: CONFIG.routes.medium } },
  },
  'routes-off': { tab: 'routes', mode: 'manual', phase: 'manual' },
  'routes-unavailable': { tab: 'routes', phase: 'unavailable', error: 'bad router.json' },
  'policy-draft': {
    tab: 'policy',
    tuning: { horizon: 10, downgradeVotes: 2, cashCapUsd: 1, activityMass: 0.8 },
    routeDraft: { ...routeDraftOf(CONFIG, {}), baselineTier: 'micro' },
    routingMode: { mode: 'cost', source: 'session' },
  },
  'classifier-missing-key': { tab: 'classifier', credentials: { ...KEYS_SET, 'clef-flash': 'missing-key' } },
  'classifier-slow': {
    tab: 'classifier',
    activityMetrics: { ...ACTIVITY_METRICS, latency: { jev: [0, 0, 0, 3, 15, 1, 1, ...Array(15).fill(0)] } },
  },
  'classifier-slow-probe': { tab: 'classifier', activityMetrics: null },
  'classifier-no-health': { tab: 'classifier', health: undefined, adviceMs: undefined },
  'classifier-empty': { tab: 'classifier', activityStore: null, activityMetrics: null, activityStats: null },
  'usage-open-activity': { tab: 'usage', usageOpen: 'activity:code' },
  'usage-open-model': { tab: 'usage', usageOpen: 'model:claude-haiku-5-5', usageGroup: 'model' },
  'usage-open-tier': { tab: 'usage', usageOpen: 'tier:high', usageGroup: 'tier' },
  'usage-open-subagent': {
    tab: 'usage',
    usageOpen: 'subagent:dev-flow:reviewer',
    usagePeriod: 'today',
  },
  'usage-open-pass': { tab: 'usage', usageOpen: 'subagent-pass:workflow', usagePeriod: 'today' },
  'usage-mixed-billing': { tab: 'usage' },
  'usage-compare': { tab: 'usage', usageCompare: true },
  'usage-confirm-delete': { tab: 'usage', confirmDelete: true },
  'usage-today': { tab: 'usage', usagePeriod: 'today' },
  'usage-7d': { tab: 'usage', usagePeriod: '7d' },
  'usage-30d': { tab: 'usage', usagePeriod: '30d' },
  'usage-month': { tab: 'usage', usagePeriod: 'month' },
  'usage-all': { tab: 'usage', usagePeriod: 'all' },
  'usage-all-compare': { tab: 'usage', usagePeriod: 'all', usageCompare: true, usageStore: STORE },
  'usage-other-session': { tab: 'usage', usagePeriod: '7d', usageStore: OTHER, subagentStore: null },
  'usage-effort-only': { tab: 'usage', subagentSession: null },
  'usage-empty': { tab: 'usage', usageSession: null, usageStore: null, subagentSession: null, subagentStore: null },
  'usage-subagents-off': { tab: 'usage', subagentSession: null },
  'usage-off': { tab: 'usage', mode: 'manual', phase: 'manual', usageSession: null },
  'usage-unavailable': { tab: 'usage', phase: 'unavailable', error: 'bad router.json', usageSession: null },
  'usage-unpriced-model': { tab: 'usage', usageSession: null, nativeModel: 'claude-unlisted-1' },
};
const OWN_CONFIG = {
  'now-mixed-billing': MIXED_BILLING,
  'usage-mixed-billing': MIXED_BILLING,
  'classifier-slow': SLOW,
  'classifier-slow-probe': { ...SLOW, classifier: 'ollama' },
  'now-effort-only': EFFORT_ONLY,
  'usage-effort-only': EFFORT_ONLY,
  'usage-subagents-off': { ...DEFAULTS, subagentRouting: 'off' },
  'routes-cell-automatic': { ...DEFAULTS, cache: { ...DEFAULTS.cache, mode: 'automatic' } },
};
for (const [name, props] of Object.entries(EXTRAS))
  for (const columns of [60, 80]) {
    test(`pane ${name} at ${columns} columns`, () => {
      const config = OWN_CONFIG[name] ?? DEFAULTS;
      const view = { ...RICH, ...props };
      golden(`pane-${name}-${columns}`, pane(config, view, CLAUDE, columns));
    });
  }

// The Classifier tab at 100 columns: the wide layout, which a narrow pane's two-line rows leave alone.
for (const [name, props] of [
  ['classifier-wide', { tab: 'classifier' }],
  ['classifier-missing-key', EXTRAS['classifier-missing-key']],
])
  test(`pane ${name} at 100 columns`, () => {
    golden(`pane-${name}-100`, pane(DEFAULTS, { ...RICH, ...props }, CLAUDE, 100));
  });

// A non-anthropic provider profile and the cache modes that change the Routes footer.
for (const [name, config] of [
  ['provider-kimi', loadConfig({ provider: 'kimi' })],
  ['provider-zai', loadConfig({ provider: 'zai' })],
  ['provider-minimax', loadConfig({ provider: 'minimax' })],
  ['provider-mimo', loadConfig({ provider: 'mimo' })],
  ['provider-deepseek', loadConfig({ provider: 'deepseek' })],
  ['cache-automatic', { ...DEFAULTS, cache: { ...DEFAULTS.cache, mode: 'automatic' } }],
  ['cache-disabled', { ...DEFAULTS, cache: { ...DEFAULTS.cache, mode: 'disabled' } }],
  ['classifier-ollama', { ...DEFAULTS, classifier: 'ollama' }],
])
  for (const tab of TABS)
    test(`pane ${name} ${tab}`, () => {
      const view = { ...RICH, tab, routeCell: tab === 'routes' ? 'tier.micro' : undefined };
      golden(`pane-${name}-${tab}-80`, pane(config, view, CLAUDE, 80));
    });

// A host without Select draws the model, effort and tuning choices as text.
const { Select: _select, ...WITHOUT_SELECT } = ELEMENTS;
for (const tab of ['routes', 'policy', 'classifier'])
  test(`pane ${tab} without Select`, () => {
    const view = { ...RICH, tab, routeCell: tab === 'routes' ? 'code.high' : undefined, routeDraft: DRAFT };
    const options = { columns: 80, now: NOW };
    golden(`pane-${tab}-no-select-80`, renderPanel(WITHOUT_SELECT, DEFAULTS, view, CLAUDE, quiet, options));
  });

// A pane that reports no width: nothing is cut or wrapped.
for (const tab of TABS)
  test(`pane ${tab} without a width`, () => {
    const view = { ...RICH, tab, usageOpen: 'activity:code' };
    golden(`pane-${tab}-unbounded`, renderPanel(ELEMENTS, DEFAULTS, view, CLAUDE, quiet, { now: NOW }));
  });

// Band rows that need a second row or no width.
const NOT_A_TIER = { mode: 'manual', phase: 'manual', nativeModel: 'claude-sonnet-5-5', reason: NOT_A_TIER_REASON };
const BAND_EXTRAS = {
  'detail-effort-only': {
    config: EFFORT_ONLY,
    view: { ...ROUTED, ...SESSION_RECORDS, bandDetail: true },
    usage: CLAUDE,
  },
  'detail-no-replies': { view: { ...ROUTED, bandDetail: true }, usage: CLAUDE },
  'detail-agents': {
    config: MIXED_BILLING,
    view: { ...ROUTED, ...SESSION_RECORDS, subagentSession: AGENTS, bandDetail: true },
    usage: CLAUDE,
  },
  'detail-not-a-tier': { view: { ...NOT_A_TIER, bandDetail: true }, usage: CLAUDE },
  'routed-unbounded': { view: { ...ROUTED, ...SESSION_RECORDS, bandDetail: true }, usage: CLAUDE, columns: null },
  'off-unbounded': { view: NOT_A_TIER, columns: null },
};
for (const [name, { config = DEFAULTS, view, usage = null, columns = 100 }] of Object.entries(BAND_EXTRAS))
  test(`band ${name}`, () => {
    const tree = renderBand(ELEMENTS, config, view, usage, { columns, now: NOW }, quiet);
    golden(`band-${name}-${columns ?? 'unbounded'}`, tree);
  });

// The Review Focus pin: no usage, no limits and NaN readings must never print as "NaN" or "undefined".
test('a view without readings draws no NaN and no undefined, on the band and on every tab', () => {
  const blank = {
    mode: 'auto',
    phase: 'routed',
    credentials: KEYS_SET,
    tier: 'low',
    effort: undefined,
    contextTokens: Number.NaN,
    inputTokens: Number.NaN,
    cacheRead: Number.NaN,
    cacheWrite: Number.NaN,
    outputTokens: Number.NaN,
    adviceMs: Number.NaN,
    estimate: { threshold: Number.NaN, upgradeMass: Number.NaN, taxUsd: Number.NaN },
    probabilities: { low: Number.NaN },
    history: [Number.NaN],
    strip: { per: 1, cells: [] },
  };
  const readings = { context: { tokens: Number.NaN }, rateLimits: [], cost: { usd: Number.NaN } };
  const bad = /NaN|undefined/;
  // Walks the raw tree: JSON would turn NaN into null and drop undefined props.
  const flaws = (node, path = 'tree') => {
    if (typeof node === 'number') return Number.isNaN(node) ? [`${path} is NaN`] : [];
    if (typeof node === 'string') return bad.test(node) ? [`${path} reads "${node}"`] : [];
    if (node === null || typeof node !== 'object') return [];
    return Object.entries(node).flatMap(([key, value]) =>
      value === undefined ? [`${path}.${key} is undefined`] : flaws(value, `${path}.${key}`),
    );
  };
  for (const columns of [100, 40]) {
    const band = renderBand(ELEMENTS, DEFAULTS, blank, null, { columns, now: NOW }, quiet);
    golden(`band-blank-${columns}`, band);
    assert.deepEqual(flaws(band), [], `band at ${columns}`);
    const nan = renderBand(ELEMENTS, DEFAULTS, blank, readings, { columns, now: NOW }, quiet);
    golden(`band-blank-nan-${columns}`, nan);
    assert.deepEqual(flaws(nan), [], `band with NaN readings at ${columns}`);
  }
  for (const tab of TABS)
    for (const [name, reading] of [
      ['null', null],
      ['nan', readings],
    ]) {
      const tree = pane(DEFAULTS, { ...blank, tab }, reading, 80);
      golden(`pane-blank-${name}-${tab}-80`, tree);
      assert.deepEqual(flaws(tree), [], `pane ${tab} with ${name} readings`);
    }
});

// An after hook, so it holds in any test order: every golden file belongs to a case above, and every case has its file.
// A filtered run (--test-name-pattern) draws fewer cases and skips the check.
after(() => {
  if (UPDATE || process.execArgv.some((arg) => arg.startsWith('--test-name-pattern'))) return;
  const files = readdirSync(GOLDEN)
    .filter((file) => file.endsWith('.txt'))
    .map((file) => file.slice(0, -4));
  assert.deepEqual([...files].sort(), [...cases].sort());
});
