// Sample views, configs and usage records the doc-picture scripts draw from, so the terminal SVGs
// (render-doc-images.mjs) and the desktop PNGs (render-desktop-images.mjs) show the same session.
import { loadConfig } from '../lib/config.mjs';
import { emptySubagentStore, recordAgent, spawnRecord } from '../lib/subagents.mjs';
import { routeDraftOf } from '../lib/ui/model/draft.mjs';
import { emptyUsage, mergeUsage, recordUsage, replyEntry } from '../lib/usage.mjs';
import { addToStrip } from '../lib/view.mjs';

export const NOW = new Date(2026, 9, 13, 16).getTime();
export const config = { ...loadConfig(), nativePath: '~/.claude/router.json' };

export const base = {
  phase: 'routed',
  mode: 'auto',
  nativeModel: 'claude-haiku-5-5',
  selectedModel: 'claude-opus-5-5',
  actualModel: 'claude-opus-5-5',
  tier: 'high',
  effort: 'xhigh',
  reason: 'jump',
  error: null,
  credentials: {
    jev: null,
    clef: 'missing-key',
    'clef-flash': 'missing-key',
    'clef-omni': 'missing-key',
    openai: 'missing-key',
    ollama: null,
  },
  adviceMs: 347,
  probabilities: { micro: 0.02, low: 0.03, medium: 0.07, high: 0.88, uncertain: 0 },
  estimate: { threshold: 0.82, upgradeMass: 0.88, taxUsd: 0.476 },
  contextTokens: 401_800,
  contextKnown: true,
  inputTokens: 402_400,
  cacheRead: 400_600,
  cacheWrite: 1_800,
  outputTokens: 499,
  history: [
    361_000, 364_000, 366_000, 369_000, 371_000, 372_000, 375_000, 378_000, 380_000, 383_000, 386_000, 388_000, 390_000,
    392_000, 395_000, 396_000, 398_000, 399_000, 401_000, 402_400,
  ],
  tiers: [...'llllllddllllhhhhhhhh'].map((c) => ({ l: 'low', d: 'medium', h: 'high' })[c]),
  activity: 'code',
  activityChoice: 'code',
  activityProbabilities: { code: 0.84, debug: 0.08, plan: 0.05, uncertain: 0.03 },
  wouldRoute: { activity: 'code', tier: 'high', model: 'claude-opus-5-5', effort: 'xhigh', reason: 'jump' },
  pendingPin: null,
  comparison: null,
  health: { failures: 0, pausedUntil: 0 },
  configPath: '~/.claude/router.json',
  tab: 'now',
  help: false,
  bandDetail: false,
};
// Claude Code's session usage on a Claude plan.
export const usage = {
  context: { tokens: 402_400 },
  rateLimits: [
    { kind: 'five_hour', percentUsed: 48, resetsAt: new Date(NOW + 2 * 3600e3).toISOString() },
    { kind: 'seven_day', percentUsed: 43, resetsAt: new Date(NOW + 3 * 86400e3).toISOString() },
  ],
};
// The band's two-row session on an API key: no plan windows.
export const keyUsage = { context: usage.context };

// Routing vs your model: a session on Opus 5.5 at xhigh that routing ran mostly on cheaper tiers.
export const yours = { nativeModel: 'claude-opus-5-5', nativeEffort: 'xhigh' };
// Its usage record as one cell: 64 replies, routed, yours, cheaper, stronger and switch sums, no tokens.
export const savingsSession = {
  version: 2,
  since: Date.parse('2026-10-13T12:00:00Z'),
  days: {
    '2026-10-13': {
      cells: { 'balanced|code|low|claude-haiku-5-5@high': [64, 6.404, 8.236, -2.31, 0, 0.478, 0, 0, 0] },
      whatIf: {},
      yours: { 'claude-opus-5-5': 64 },
      hours: {},
      turns: 20,
      switches: { tier: 9, activity: 0 },
    },
  },
};
export const savingsStore = {
  version: 1,
  since: Date.parse('2026-10-03T12:00:00Z'),
  replies: 412,
  routedUsd: 41.18,
  yoursUsd: 52.6,
  cheaperUsd: -14.9,
  strongerUsd: 0,
  switchUsd: 3.48,
};

// ---- band states ----
export const COLUMNS = 112;
export const states = [
  ['Routing on: routed to the high tier on a clear jump', base, false],
  [
    'Two rows on a Claude plan, with the hover controls shown over the readings: plan windows, the session as a configured-rate API estimate against your model, pins',
    { ...base, ...yours, bandDetail: true, usageSession: savingsSession, estimate: null },
    true,
  ],
  [
    'Two rows on an API key: the session as a configured-rate API estimate, not an invoice, against your model',
    { ...base, ...yours, bandDetail: true, usageSession: savingsSession, estimate: null },
    false,
    keyUsage,
  ],
  [
    'A pin waits for the next turn; ✕ cancels it',
    {
      ...base,
      tier: 'low',
      selectedModel: 'claude-haiku-5-5',
      actualModel: 'claude-haiku-5-5',
      effort: 'high',
      activity: 'ops',
      reason: 'same-tier',
      estimate: null,
      pendingPin: 'medium',
    },
    false,
  ],
  [
    'No classifier key: routing keeps the model and offers Set up',
    {
      ...base,
      tier: 'low',
      selectedModel: 'claude-haiku-5-5',
      actualModel: 'claude-haiku-5-5',
      effort: 'high',
      reason: 'no-advice',
      activity: null,
      error: 'missing-key',
      credentials: {
        jev: 'missing-key',
        clef: 'missing-key',
        'clef-flash': 'missing-key',
        'clef-omni': 'missing-key',
        openai: 'missing-key',
        ollama: null,
      },
      estimate: null,
    },
    false,
  ],
  [
    'Routing off: /model chose the model; Turn on resumes routing',
    { ...base, mode: 'manual', reason: 'model selected manually', nativeModel: 'claude-sonnet-5-5' },
    false,
  ],
  [
    'Activity routing on: an ops turn at medium moves from Opus to Haiku',
    {
      ...base,
      tier: 'medium',
      selectedModel: 'claude-haiku-5-5',
      actualModel: 'claude-haiku-5-5',
      effort: 'high',
      activity: 'ops',
      reason: 'activity-down',
      estimate: null,
    },
    false,
  ],
  [
    'Cost mode for this session: high runs Opus at high instead of xhigh',
    {
      ...base,
      tier: 'high',
      selectedModel: 'claude-opus-5-5',
      actualModel: 'claude-opus-5-5',
      effort: 'high',
      reason: 'same-tier',
      estimate: null,
      routingMode: { mode: 'cost', source: 'session' },
    },
    false,
  ],
];

export const activityStore = {
  version: 1,
  confusion: { code: { code: 40, read: 4 }, ops: { ops: 18, read: 3, code: 1 }, explore: { read: 12, talk: 5 } },
  runs: {},
  lateral: { taken: 9, refused: 4 },
};

export const draft = {
  ...routeDraftOf(config, {}),
  routes: { ...config.routes, medium: { model: 'sonnet', effort: 'xhigh' } },
  activities: { ...config.activities, code: { ...config.activities.code, high: { model: 'opus', effort: 'max' } } },
};

// Usage records: seven days of a developer on Opus 5.5 · xhigh whose turns routing ran mostly on cheaper tiers. Per
// reply each kind adds up: your model + cheaper + switch writes = routed.
export const KINDS = {
  code: [
    'code',
    'medium',
    'claude-sonnet-5-5@high',
    { routedUsd: 0.08, yoursUsd: 0.13, cheaperUsd: -0.052, switchUsd: 0.002 },
  ],
  hard: ['code', 'high', 'claude-opus-5-5@xhigh', { routedUsd: 0.13, yoursUsd: 0.13, cheaperUsd: 0, switchUsd: 0 }],
  ops: [
    'ops',
    'low',
    'claude-haiku-5-5@high',
    { routedUsd: 0.03, yoursUsd: 0.12, cheaperUsd: -0.094, switchUsd: 0.004 },
  ],
  explore: [
    'explore',
    'low',
    'claude-haiku-5-5@high',
    { routedUsd: 0.028, yoursUsd: 0.11, cheaperUsd: -0.086, switchUsd: 0.004 },
  ],
  plan: [
    'plan',
    'micro',
    'claude-haiku-5-5@low',
    { routedUsd: 0.012, yoursUsd: 0.09, cheaperUsd: -0.08, switchUsd: 0.002 },
  ],
};
export const MIX = ['code', 'code', 'ops', 'explore', 'hard', 'code', 'plan', 'ops', 'code', 'explore', 'hard', 'code'];
export const TOKENS = {
  input_tokens: 4000,
  cache_read_input_tokens: 62_000,
  cache_creation_input_tokens: 3000,
  output_tokens: 900,
};
export function kindEntry(kind, when) {
  const [activity, tier, route, prices] = KINDS[kind];
  const replies = { 'claude-haiku-5-5': 0.2, 'claude-sonnet-5-5': 0.6, 'claude-opus-5-5': 1 };
  return replyEntry({
    mode: 'balanced',
    at: when,
    activity,
    tier,
    route,
    yours: 'claude-opus-5-5',
    reply: { strongerUsd: 0, ...prices },
    replies: Object.fromEntries(
      Object.entries(replies).map(([model, f]) => [model, { yoursUsd: prices.yoursUsd * f }]),
    ),
    usage: TOKENS,
  });
}
export function usageDay(record, daysAgo, replies) {
  let next = record;
  for (let i = 0; i < replies; i += 3) {
    const when = new Date(2026, 9, 13 - daysAgo, 9 + Math.floor((i / replies) * 7), (i * 7) % 60).getTime();
    const entries = MIX.slice(i % MIX.length, (i % MIX.length) + Math.min(3, replies - i)).map((kind) =>
      kindEntry(kind, when),
    );
    next = recordUsage(next, entries, {
      now: when,
      switched: i % 12 === 0 ? 'tier' : i % 18 === 9 ? 'activity' : null,
    });
  }
  return next;
}
// This session, 14:18 to 16:00: 86 replies in runs of one kind, a route switch where the tier changes.
export const SESSION_RUNS = [
  ['explore', 6],
  ['code', 2],
  ['ops', 10],
  ['hard', 8],
  ['explore', 9],
  ['hard', 7],
  ['code', 6],
  ['ops', 16],
  ['code', 4],
  ['hard', 18],
];
export const sessionKinds = SESSION_RUNS.flatMap(([kind, n]) => Array(n).fill(kind));
export const SESSION_START = new Date(2026, 9, 13, 14, 18).getTime();
export const replyAt = (i) => SESSION_START + Math.round((i * 102 * 60_000) / sessionKinds.length);
export const tierOf = (kind) => KINDS[kind][1];
export const usageSession = sessionKinds.reduce(
  (record, kind, i) =>
    recordUsage(record, [kindEntry(kind, replyAt(i))], {
      now: replyAt(i),
      switched: i && tierOf(kind) !== tierOf(sessionKinds[i - 1]) ? 'tier' : null,
    }),
  emptyUsage(),
);
export const strip = sessionKinds.reduce((built, kind) => addToStrip(built, tierOf(kind)), null);
export const usageStore = mergeUsage([
  usageSession,
  [
    [0, 18],
    [1, 30],
    [2, 27],
    [3, 0],
    [4, 6],
    [5, 33],
    [6, 21],
  ].reduce((record, [daysAgo, replies]) => usageDay(record, daysAgo, replies), emptyUsage()),
]);
// Subagents over the last week, one agent each: [days ago, type or `pass:` reason, model it ran on, Claude Code's
// pick, its cost, the same tokens on Claude Code's pick].
export const AGENT_ROWS = [
  [0, 'Explore', 'haiku', 'opus', 0.05, 0.24],
  [0, 'Explore', 'haiku', 'opus', 0.03, 0.17],
  [1, 'Explore', 'haiku', 'opus', 0.06, 0.29],
  [3, 'Explore', 'haiku', 'opus', 0.04, 0.2],
  [0, 'dev-flow:reviewer', 'opus', 'sonnet', 1.12, 0.71],
  [2, 'dev-flow:reviewer', 'sonnet', 'sonnet', 0.42, 0.42],
  [4, 'dev-flow:reviewer', 'opus', 'sonnet', 0.96, 0.6],
  [1, 'general-purpose', 'sonnet', 'opus', 0.38, 0.62],
  [5, 'general-purpose', 'haiku', 'opus', 0.09, 0.41],
  [0, 'pass:workflow', 'opus', 'opus', 0.48, 0],
  [0, 'pass:workflow', 'opus', 'opus', 0.51, 0],
  [1, 'pass:workflow', 'opus', 'opus', 0.44, 0],
  [3, 'pass:workflow', 'opus', 'opus', 0.57, 0],
  [0, 'pass:fork', 'opus', 'opus', 0.33, 0],
  [2, 'pass:pinned', 'sonnet', 'sonnet', 0.12, 0],
];
export const agentStore = (rows) =>
  rows.reduce((store, [daysAgo, kind, model, core, usd, coreUsd]) => {
    const pass = kind.startsWith('pass:') ? kind.slice(5) : null;
    const [routedModel, coreModel] = [model, core].map((key) => config.models[key].id);
    const record = spawnRecord({
      sessionId: 'docs',
      spawn: { subagentType: pass ? 'agent' : kind },
      pass,
      choice: pass ? null : model,
      routedModel,
      coreModel,
      move: pass || model === core ? null : coreUsd < usd ? 'up' : 'down',
    });
    const agent = { ...record, requests: 6, pricedRequests: 6, actualUsd: usd, otherUsd: coreUsd };
    return recordAgent(store, agent, NOW - daysAgo * 86_400_000);
  }, emptySubagentStore());
export const SUBAGENTS = agentStore(AGENT_ROWS);
// The Now tab's session: today's agents.
export const SESSION_AGENTS = agentStore(AGENT_ROWS.filter(([daysAgo]) => daysAgo === 0));

// The pane tabs' views. The Now and Usage tabs read the session and the usage store above.
const usageView = (props) => ({
  ...base,
  ...yours,
  tab: 'usage',
  usageSession,
  usageStore,
  savingsStore,
  subagentStore: SUBAGENTS,
  subagentSession: SESSION_AGENTS,
  ...props,
});
export const paneViews = {
  now: {
    ...base,
    ...yours,
    usageSession,
    usageStore,
    strip,
    subagentSession: SESSION_AGENTS,
    subagentsRunning: 1,
  },
  routes: { ...base, tab: 'routes', routeDraft: draft, routeCell: 'code.high' },
  policy: {
    ...base,
    tab: 'policy',
    tuning: { downgradeVotes: 3 },
    tuningBase: null,
    configPath: '~/.claude/router.json',
    projectRoot: '/work/example',
    projectLocalFile: 'router.local.json',
    canClearProject: true,
  },
  classifier: {
    ...base,
    tab: 'classifier',
    adviceMs: null,
    credentials: {
      jev: 'missing-key',
      clef: null,
      'clef-flash': null,
      'clef-omni': null,
      openai: 'missing-key',
      ollama: null,
    },
    notice: 'Saved: classifier Clef → Clef Flash. Applies from the next turn.',
    lastWrite: { label: 'classifier Clef → Clef Flash' },
    activityStore,
    activityMetrics: { version: 1, latency: {}, downMoves: { moves: 7, escalations: 0 } },
  },
  usage: usageView({ usagePeriod: '7d', usageGroup: 'activity', usageOpen: 'activity:code' }),
  usageWhatIf: usageView({ usagePeriod: 'session', usageGroup: 'tier', usageCompare: true }),
};
// The classifier tab compares from a config on Clef Flash.
export const classifierConfig = { ...config, classifier: 'clef-flash' };
