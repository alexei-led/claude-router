import { compareRoutes } from './activity.mjs';
import { latencyP95, readMetrics, readStore, storeSummary } from './activity-stats.mjs';
import {
  ACTIVITIES,
  ACTIVITY_MODES,
  activeClassifier,
  defaultsFor,
  effectiveActivities,
  effectiveRoutes,
  ROUTING_MODES,
  resolveRoute,
  sameCell,
  sameRoute,
  TIERS,
  tuningOf,
} from './config.mjs';
import { effortSharesCache, routeEffort } from './cost.mjs';
import { periodCost, resetText } from './costs.mjs';
import { decisionLines } from './decisions.mjs';
import {
  API_ESTIMATE,
  activityReading,
  baselineName,
  classifierLabel,
  classifierState,
  classifierStatus,
  comparedModel,
  costText,
  diffText,
  EARLY_NOTE,
  formatTokens,
  GATEWAY_CLEANUP,
  GATEWAY_SETTINGS,
  limitTone,
  liveUsage,
  missingCredentials,
  missingText,
  modeLever,
  modelColor,
  modelName,
  percent,
  percentPair,
  probeOf,
  reasonActivity,
  recordedModels,
  repliesText,
  routeLabel,
  routeName,
  routingModeOf,
  routingModeText,
  savingsColor,
  sessionCost,
  sessionUsage,
  shortReason,
  shortRoute,
  shownConfig,
  signedUsd,
  sparkline,
  switchesLost,
  UNROUTED,
  unavailableReason,
  uncomparedText,
  unpricedLine,
  usageMetrics,
  usd,
  whyText,
  yourModel,
} from './display.mjs';
import { cellForModel, isSameModel } from './route.mjs';
import { modelSpec } from './savings.mjs';
import {
  modelTotals,
  PASS_LABEL,
  PASS_REASONS,
  PASS_WHY,
  readSubagentStore,
  summarizeSubagents,
} from './subagents.mjs';
import { graphicalClassifier } from './ui/graphical/classifier.mjs';
import { graphicalNow } from './ui/graphical/now.mjs';
import { graphicalPolicy } from './ui/graphical/policy.mjs';
import { graphicalRoutes } from './ui/graphical/routes.mjs';
import { renderShell } from './ui/graphical/shell.mjs';
import { paintersOf } from './ui/painter.mjs';
import { dayLabel, sinceText } from './ui/strip.mjs';
import { terminalClassifier } from './ui/terminal/classifier.mjs';
import { lostLine, terminalNow } from './ui/terminal/now.mjs';
import { terminalPolicy } from './ui/terminal/policy.mjs';
import { terminalRoutes } from './ui/terminal/routes.mjs';
import { dimLines, pack } from './ui/terminal/wrap.mjs';
import { isGraphical, toneColor } from './ui/tokens.mjs';
import {
  allTime,
  breakdown,
  cellsWhere,
  dayKey,
  INSIGHT_REPLIES,
  insights,
  mostlyOn,
  PERIODS,
  periodRange,
  summarize,
  trend,
} from './usage.mjs';

// Routes and Policy edit one draft and save together; Classifier saves each pick at once.
const TABS = [
  ['now', '1', 'Now'],
  ['routes', '2', 'Routes'],
  ['policy', '3', 'Policy'],
  ['classifier', '4', 'Classifier'],
  ['usage', '5', 'Usage'],
];
const DRAFT_TABS = ['routes', 'policy'];
const TUNING_CHOICES = {
  timeoutMs: [500, 1000, 1500, 3000, 5000],
  downgradeVotes: [1, 2, 3],
  horizon: [1, 3, 5, 10],
  cashCapUsd: [0.5, 1, 2, 5],
  activityMass: [0.5, 0.6, 0.7, 0.8],
};
const LADDER = [...TIERS].reverse();
// The effort option that sends no effort of its own: the request keeps the one Claude Code sends.
const SESSION_EFFORT = 'session';
const INHERIT = 'inherit';
// The Routes grid's marks, as its legend explains them, each in its tone.
// `card` is the glyph a card draws where the terminal's is too slight in a Button.
/** @type {Record<string, { glyph: string, card?: string, tone: import('./ui/tokens.mjs').Tone, text: string }>} */
const ROUTE_MARKS = {
  inherits: { glyph: '·', card: '—', tone: 'muted', text: 'runs the tier’s model' },
  preset: { glyph: '°', tone: 'muted', text: 'built-in default' },
  edited: { glyph: '●', tone: 'warning', text: 'unsaved' },
};
const UNPRICED_OUTPUT = '$? out';
// "Opus · medium": a route as a card names it, in the words the editor's Selects show; "inherit" where it leaves the
// effort to the session, and no effort on a model without efforts.
function cardRoute(config, route) {
  const model = config.models[route.model];
  return `${modelName(model.id)}${model.efforts.length ? ` · ${route.effort ?? INHERIT}` : ''}`;
}

// The Routes grid's row of the tiers' own routes; every other row is an activity.
const TIER_ROW = 'tier';

const ACTIVITY_MODE_HINT = {
  off: 'not asked; every turn runs its tier’s model',
  on: 'an activity can change its tier’s model',
};
// What `subagentRouting` does, under the router.json path: it is set in the file, not in the pane.
const SUBAGENT_LINE = {
  off: 'Subagents keep their own model (subagentRouting off).',
  on: 'Subagents: on. Agents that pin no model get one at spawn, kept for every step.',
};
// The same on a card, which names no router.json key.
const SUBAGENT_CARD = {
  off: 'Subagents keep their own model.',
  on: 'Subagents that pin no model get one at spawn, kept for every step.',
};
const EFFORT_SHORT = { low: 'low', medium: 'med', high: 'high', xhigh: 'xh', max: 'max', [INHERIT]: 'inh' };

// The route draft the Routes and Policy tabs edit: the saved routes, activity overrides and mode until the person
// changes one.
export function routeDraftOf(config, view) {
  if (view.routeDraft) return view.routeDraft;
  const base = structuredClone({
    ...(config.provider && config.provider !== 'anthropic' ? { provider: config.provider } : {}),
    routes: config.routes,
    baselineTier: config.baselineTier,
    activities: config.activities,
    activityRouting: config.activityRouting,
  });
  return { ...structuredClone(base), base };
}

const dollars = (value) => (Number.isFinite(value) ? usd(value) : 'not reported');
// The host and port as the request sees them: user info before an `@` is not the host. An endpoint that does not
// parse, such as one with a placeholder in its host, shows as written up to its path, and is not this machine.
function urlOf(endpoint) {
  try {
    return new URL(endpoint);
  } catch {
    return null;
  }
}
const hostOf = (endpoint) => urlOf(endpoint)?.host ?? endpoint.replace(/^https?:\/\//, '').split('/')[0];
const LOCAL_HOSTS = ['127.0.0.1', 'localhost', '[::1]'];
const isLocal = (endpoint) => LOCAL_HOSTS.includes(urlOf(endpoint)?.hostname);
const windowSize = (tokens) => (tokens >= 1e6 ? `${tokens / 1e6}M` : `${Math.round(tokens / 1e3)}K`);
const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
const contextSuffix = (metrics) =>
  Number.isFinite(metrics.nextContext)
    ? `~${formatTokens(metrics.nextContext)} / ${formatTokens(metrics.window)}`
    : 'no reading yet';

export function renderPanel(
  elements,
  config,
  view,
  usage,
  actions,
  { modelOptions = Object.keys(config.models), columns = null, now = Date.now(), surface = undefined } = {},
) {
  const ui = paintersOf(elements, surface);
  const tab = TABS.some(([id]) => id === view.tab) ? view.tab : 'now';
  const body = { now: nowTab, routes: routesTab, policy: policyTab, classifier: classifierTab, usage: usageTab }[tab];
  const graphical = isGraphical(surface);
  const notices = noticeLines(ui, config, view, actions, graphical);
  const preface = [
    ...(view.help ? helpLines(ui) : []),
    ...(config.provider && config.provider !== 'anthropic'
      ? [ui.dim(`profile ${[config.provider, view.configPath ?? config.nativePath].filter(Boolean).join(' · ')}`)]
      : []),
  ];
  const content = body(ui, config, view, usage, actions, modelOptions, columns, now, surface);
  const bar = statusBar(ui, config, view, tab, actions);
  if (graphical)
    return renderShell(ui, config, view, tab, actions, [...preface, ...content], {
      tabs: TABS,
      unsaved: unsavedTabs(config, view),
      notices,
      bar,
    });
  // No Close button: Esc and the pane's own close dismiss it.
  return ui.Box({
    flexDirection: 'column',
    children: [...header(ui, config, view, tab, actions, notices), ...preface, ...content, ...bar],
  });
}

// The warnings that apply to the next turn, drawn once under the tab row on every tab: an ignored project config, a
// native fallback, and classifier credentials that are missing. They matter only while routing is on. The graphical
// pane has no header text for an unavailable router, so its reason joins them.
function noticeLines(ui, config, view, actions, graphical) {
  const unavailable = view.phase === 'unavailable';
  const out = [];
  if (graphical && unavailable) {
    out.push(ui.notice('warning', unavailableReason(view)));
    if (view.error === GATEWAY_SETTINGS) for (const line of GATEWAY_CLEANUP) out.push(ui.notice('warning', line));
  }
  if (graphical && !unavailable && view.error) out.push(ui.notice('warning', classifierStatus(config, view.error)));
  if (view.mode !== 'auto' || unavailable) return out;
  const current = view.selectedModel ?? view.nativeModel;
  const missing = missingCredentials(config, view, config.classifier);
  if (view.projectError) out.push(ui.notice('warning', `  Ignored: ${view.projectError}`));
  if (view.actualModel && current && !isSameModel(current, view.actualModel))
    out.push(ui.notice('warning', `  ! served by ${modelName(view.actualModel)} · native fallback`));
  if (missing)
    out.push(
      ui.notice(
        'warning',
        `  ${classifierStatus(config, missing)}, keeping the model  `,
        ui.Button({ key: 'key', label: 'Set up', hotkey: 'k', onPress: actions.key }),
      ),
    );
  return out;
}

// Which tabs hold an unsaved draft.
function unsavedTabs(config, view) {
  const changes = routingChanges(config, view);
  return {
    routes: changes.tiers.length + changes.cells.length + Number(changes.mode) > 0,
    policy: changes.policy.length + Number(changes.baseline) > 0,
  };
}

// Routing's state, its one mode control and the classifier's state on one line. While routing is unavailable, on and
// off would change nothing, so the line says why instead of offering them.
function routingState(ui, config, view, actions) {
  if (view.phase === 'unavailable')
    return [
      ui.line(ui.head('ROUTER'), '  ', ui.text('unavailable', { color: 'yellow' }), ui.dim('  Claude’s model is kept')),
      ui.text(unavailableReason(view), { color: 'yellow' }),
      ...(view.error === GATEWAY_SETTINGS ? GATEWAY_CLEANUP.map((line) => ui.text(line, { color: 'yellow' })) : []),
    ];
  const state = classifierState(config, view);
  // A radio pair, marked as the Classifier tab marks its active row.
  const option = (mode, label, hotkey) =>
    ui.Button({
      key: mode,
      label: `${view.mode === mode ? '◉' : '○'} ${label}`,
      hotkey,
      variant: view.mode === mode ? 'primary' : 'secondary',
      onPress: () => actions.mode(mode),
    });
  return [
    ui.line(
      ui.head('ROUTER'),
      '  ',
      option('auto', 'on', 'o'),
      ' ',
      option('manual', 'off', 'f'),
      '  ',
      ui.text(state.text, { color: toneColor(state.tone, 'terminal') }),
    ),
  ];
}

// The tabs carry their number keys in their labels, so every key the pane answers is on screen.
function header(ui, config, view, tab, actions, notices) {
  const unsaved = unsavedTabs(config, view);
  return [
    ...routingState(ui, config, view, actions),
    ui.line(
      ...TABS.flatMap(([id, hotkey, label]) => [
        ui.Button({
          key: `tab-${id}`,
          label: `${hotkey} ${label}${unsaved[id] ? ' ●' : ''}`,
          hotkey,
          variant: tab === id ? 'primary' : 'secondary',
          onPress: () => actions.tab(id),
        }),
        ' ',
      ]),
      ui.Button({ key: 'help', label: '?', variant: view.help ? 'primary' : 'secondary', onPress: actions.help }),
    ),
    ...notices,
    ui.text(' '),
  ];
}

// "Jev 93% ≥ 90% · switch ≈ $0.48": the support for the switch the policy weighed against the bar it set, and the switch
// cost. Null without a reading.
function supportText(label, estimate) {
  if (!Number.isFinite(estimate?.threshold)) return null;
  const mass = Number.isFinite(estimate.upgradeMass) ? estimate.upgradeMass : estimate.downgradeMass;
  const cost = Number.isFinite(estimate.taxUsd) ? ` · switch ≈ ${usd(estimate.taxUsd)}` : '';
  if (!Number.isFinite(mass)) return `${label} needs ${percent(estimate.threshold)}${cost}`;
  const [gave, needs] = percentPair(mass, estimate.threshold);
  return `${label} ${gave} ${mass >= estimate.threshold ? '≥' : '<'} ${needs}${cost}`;
}

// Three questions, in order: what runs next and why, what the plan and the session cost, and how full the context is.
// The cost table, today’s totals and the subagent list are on Usage. The model holds the readings as text, numbers and
// tones; the terminal draws it as rows and the graphical surfaces as cards.
function nowTab(ui, config, view, usage, actions, _modelOptions, columns, now, surface) {
  const model = nowOf(config, view, usage, actions, now);
  return isGraphical(surface) ? graphicalNow(ui, model, { columns, now }) : terminalNow(ui, model, { columns, now });
}

function nowOf(config, view, usage, actions, now) {
  const cost = sessionCost(config, view, usage, now);
  return {
    next: nextOf(config, view, actions),
    decisions: view.decisionRows?.length ? decisionLines(view.decisionRows, 5) : [],
    plan: cost.limits.map((limit) => ({
      label: limit.label,
      percent: limit.percent,
      tone: limitTone(limit.percent),
      reset: resetText(limit.resetsAt, now),
    })),
    session: sessionOf(config, view, cost, actions, now),
    context: contextOf(config, view, usage, actions, now),
  };
}

// NEXT TURN. With routing off or unavailable only the model applies: no tier, activity or reason from an earlier turn.
function nextOf(config, view, actions) {
  const unavailable = view.phase === 'unavailable';
  const current = view.selectedModel ?? view.nativeModel;
  if (unavailable)
    return {
      state: 'unavailable',
      label: routeLabel(view.nativeModel, view.nativeEffort),
      note: 'routing unavailable · Claude’s model',
      pinNote: 'needs routing',
    };
  if (view.mode !== 'auto')
    return {
      state: 'off',
      label: routeLabel(current, view.effort),
      note: 'routing off · /model choice',
      pinNote: 'needs routing on (o)',
    };
  const mode = config.activityRouting;
  const reading = mode === 'off' ? null : activityReading(view);
  const shown = shownConfig(config, view);
  const base = view.tier ? resolveRoute(shown, view.tier) : null;
  const override =
    mode === 'on' && view.activity && base && !sameRoute(resolveRoute(shown, view.tier, view.activity), base);
  const { mode: routingMode, source } = routingModeOf(view);
  const lever = modeLever(config, view);
  return {
    state: 'routed',
    label: routeLabel(current, view.effort),
    tier: view.tier ?? null,
    reading: reading && {
      choice: reading.choice,
      isActivity: ACTIVITIES.includes(reading.choice),
      share: reading.share || null,
      other: reading.others[0] ?? null,
    },
    phase: view.taskPhase ? `phase ${view.taskPhase} · route activity ${view.activity ?? 'base'}` : null,
    why: view.reason ? shortReason(view.reason, reasonActivity(config, view)) : null,
    support: supportText(classifierLabel(config), view.estimate),
    override: override ? `${whyText(config, view)} · tier route ${routeName(shown, base)}` : null,
    mode:
      routingMode !== 'balanced' || source === 'session'
        ? {
            name: routingMode,
            from: `from ${source}${lever ? ` · ${lever} on this tier` : ''}`,
            clear: source === 'session' ? '/router mode default clears it' : null,
          }
        : null,
    // One per tier, low to high: the route it runs and the classifier's support on the last turn.
    pins: TIERS.map((tier) => {
      const support = view.probabilities?.[tier];
      return {
        tier,
        route: shortRoute(config, resolveRoute(shown, tier)),
        support: Number.isFinite(support) ? percent(support) : null,
      };
    }),
    pendingPin: view.pendingPin ?? null,
    // A press pins the next turn; pressing the pending pin again unpins it.
    pick: (tier) => (view.pendingPin === tier ? actions.unpin() : actions.pin(tier)),
  };
}

// The estimate's billing product is context, never evidence of an invoice or measured quota use.
function billingWords(cost) {
  if (cost.billing === 'plan') return `${API_ESTIMATE} · plan quota, not a charge`;
  if (cost.billing === 'mixed') return `${API_ESTIMATE} · credits ${costText(cost.creditsUsd, cost.billing)}`;
  return `${API_ESTIMATE} · configured rates, not an invoice`;
}

// SESSION: one total with the subagents, the difference against no routing, the main thread and the subagents on one
// scale, then the replies by tier.
function sessionOf(config, view, cost, actions, now) {
  const since = liveUsage(view, view.usageSession).since;
  const switches = sessionUsage(view, now).switches;
  const switchCount = switches.tier + switches.activity;
  const head = [
    Number.isFinite(since) ? `since ${sinceText(since, now)}` : null,
    cost.replies ? plural(cost.replies, 'reply', 'replies') : null,
    cost.agents ? plural(cost.agents, 'agent') : null,
    switchCount ? plural(switchCount, 'switch', 'switches') : null,
  ].filter(Boolean);
  const compared = cost.diffUsd !== null;
  const r = cost.readout;
  const priced = Boolean(cost.replies || cost.agents);
  // A part's difference against no routing, and what it is measured against.
  const against = (diff, versus) => (diff === null ? null : { usd: diff, text: signedUsd(diff), versus });
  return {
    head: head.join(' · '),
    running: view.subagentsRunning ?? 0,
    bandDetail: Boolean(view.bandDetail),
    toggleDetail: actions.toggleDetail,
    // Replies without a list price reach the strip but not the usage record: the tiers still show, the cost cannot.
    priced,
    empty: priced ? null : view.strip?.cells?.length ? 'unpriced' : 'none',
    strip: view.strip,
    since,
    total: costText(cost.totalUsd, cost.billing),
    billing: billingWords(cost),
    usage: () => actions.usageFor('session'),
    diff: compared
      ? {
          usd: cost.diffUsd,
          text: diffText(cost.diffUsd, cost.baseUsd),
          versus: baselineName(view, sessionUsage(view, now), cost),
          of: costText(cost.baseUsd, cost.billing),
        }
      : null,
    note: compared
      ? cost.early
        ? `${repliesText(cost)}: ${EARLY_NOTE}`
        : null
      : cost.effortOnly
        ? 'effort routing on one model: no saving is estimated'
        : cost.uncomparedReplies
          ? `${uncomparedText(cost)}: no saving shown`
          : null,
    scale: Math.max(cost.mainUsd, cost.agentUsd),
    parts: [
      {
        name: 'main',
        usd: cost.mainUsd,
        amount: costText(cost.mainUsd, cost.billing),
        against: against(
          compared && cost.replies ? cost.mainDiff : null,
          comparedModel(config, view, sessionUsage(view, now)),
        ),
      },
      ...(cost.agents
        ? [
            {
              name: 'agents',
              usd: cost.agentUsd,
              amount: costText(cost.agentUsd, cost.billing),
              against: against(compared ? cost.agentDiff : null, 'their picks'),
            },
          ]
        : []),
    ],
    effortMix: cost.effortOnly ? cost.effortMix : [],
    lost: Boolean(cost.comparable && !r.early && switchesLost(r)),
    policy: () => actions.tab('policy'),
  };
}

// The readings' colours from usageMetrics as tones, so the thresholds stay in display.mjs.
/** @type {Record<string, import('./ui/tokens.mjs').Tone>} */
const COLOR_TONE = { red: 'danger', yellow: 'warning', green: 'success', gray: 'muted' };

// CONTEXT: the window's fill on the model that runs next, and the cache reuse of the last reply and of the session.
function contextOf(config, view, usage, actions, now) {
  const metrics = usageMetrics(config, view, usage);
  const session = sessionUsage(view, now).observed;
  const fill = metrics.contextBar.percent;
  const history = view.history ?? [];
  const { comparison } = view;
  return {
    fill,
    fillTone: COLOR_TONE[metrics.contextBar.color],
    suffix: contextSuffix(metrics),
    empty: 'no reading yet',
    // The cache reuse of the last reply and of the session, each a figure and its words.
    cache: {
      tone: COLOR_TONE[metrics.cacheBar.color],
      last: metrics.cacheBar.percent === null ? null : { figure: `${metrics.cacheBar.percent}%`, words: 'last reply' },
      session: session.inputTokens
        ? { figure: percent(session.cacheReadTokens / session.inputTokens), words: 'session' }
        : null,
      empty: 'no reply yet',
    },
    detail: {
      open: Boolean(view.usageDetail),
      toggle: actions.usageDetail,
      observed: metrics.observed,
      estimated: view.contextTokens,
      cacheRead: view.cacheRead,
      cacheWrite: view.cacheWrite,
      output: view.outputTokens,
      history,
      tiers: view.tiers ?? [],
      replies: `last ${plural(history.length, 'reply', 'replies')}`,
      // The estimates the last decision weighed, as label and value.
      estimates: [
        ['Cache hits saved', dollars(metrics.cacheBenefit)],
        Number.isFinite(view.estimate?.taxUsd) ? ['Switch cost', dollars(view.estimate.taxUsd)] : null,
        ...(comparison
          ? [
              ['Compared tiers', `${comparison.incumbent} → ${comparison.candidate}`],
              ['Next-turn difference', `${signedUsd(comparison.minUsd)} to ${signedUsd(comparison.maxUsd)}`],
              [
                'Payback',
                comparison.paybackTurns === null ? 'none projected' : `${comparison.paybackTurns} later turns`,
              ],
            ]
          : []),
      ].filter(Boolean),
    },
  };
}

// Rows: [key, label, format, router.json field]. Typed as tuples so tsc keeps each position's type.
/** @type {[string, string, (value: number) => string, string][]} */
export const POLICY_ROWS = [
  ['downgradeVotes', 'Votes to go down', String, 'policy.downgradeVotes'],
  ['horizon', 'Payback horizon', (v) => plural(v, 'turn'), 'policy.downgradeHorizonTurns'],
  ['cashCapUsd', 'Credits cap', (v) => `$${v.toFixed(2)}`, 'policy.cashCapUsd'],
  ['activityMass', 'Activity threshold', percent, 'policy.activityMass'],
];

// What Routes and Policy changed and have not saved: tiers, baseline, activity cells and mode against the saved config,
// policy values against the values the draft started from. `cells` lists [activity, tier] pairs.
export function routingChanges(config, view) {
  const raw = routeDraftOf(config, view);
  const draft = { ...effectiveRoutes(raw, config), ...effectiveActivities(raw, config) };
  const saved = tuningOf(config);
  const base = view.tuningBase ?? saved;
  const tuning = { ...saved, ...view.tuning };
  const tiers = TIERS.filter((tier) => !sameRoute(draft.routes[tier], config.routes[tier]));
  const baseline = draft.baselineTier !== config.baselineTier;
  const cells = ACTIVITIES.flatMap((activity) =>
    TIERS.filter((tier) => !sameCell(draft.activities[activity]?.[tier], config.activities[activity]?.[tier])).map(
      (tier) => [activity, tier],
    ),
  );
  const mode = draft.activityRouting !== config.activityRouting;
  const policy = POLICY_ROWS.map(([key]) => key).filter(
    (key) => Object.hasOwn(view.tuning ?? {}, key) && view.tuning[key] !== base[key],
  );
  const count = tiers.length + Number(baseline) + cells.length + Number(mode) + policy.length;
  return { draft, saved, tuning, tiers, baseline, cells, mode, policy, count };
}

// "sonnet·high": the route's models key and its effort, short enough for the terminal grid; `inherit` for a route that
// leaves the effort to the session, and no effort for a model without efforts. The key, not the model name: two Haiku
// versions in router.json still read apart.
function gridRoute(config, route, narrow) {
  if (!config.models[route.model].efforts.length) return route.model;
  const effort = route.effort ?? INHERIT;
  return `${route.model}·${narrow ? (EFFORT_SHORT[effort] ?? effort) : effort}`;
}
const routeKey = (route) => `${route.model}@${route.effort ?? ''}`;
const builtIn = (config, activity, tier) => defaultsFor(config.provider).activities[activity]?.[tier] ?? null;
const sharesEffort = (config, route) => effortSharesCache(config, config.models[route.model]?.id);
// The cache a route runs on: one per model on a model that keeps one cache across efforts, else one per route.
const cacheOf = (config, route) => (sharesEffort(config, route) ? route.model : routeKey(route));

// Why an override may be a mistake: no effect, a route above the next tier's, or a cache no other cell runs on.
function overrideWarnings(config, uses, activity, tier) {
  const route = resolveRoute(config, tier, activity);
  if (sameRoute(route, config.routes[tier])) return [];
  const above = config.routes[TIERS[TIERS.indexOf(tier) + 1]];
  return [
    above && compareRoutes(config, route, above) > 0 ? 'stronger than the tier above' : null,
    uses.get(cacheOf(config, route)) === 1
      ? config.cache.mode === 'automatic'
        ? 'a route only this cell uses; cache sharing is unknown'
        : `${sharesEffort(config, route) ? 'a model' : 'a model + effort'} only this cell uses: one more cache`
      : null,
  ].filter(Boolean);
}

// The model and effort choices of one route; `session` is offered as `inherit`. `effort` is null for a model without
// efforts. `name` and `text` are what a surface without Select shows.
function routeChoices(config, key, route, modelOptions, onModel, onEffort) {
  const model = config.models[route.model];
  const aliases = modelOptions.includes(route.model) ? modelOptions : [route.model, ...modelOptions];
  return {
    key,
    model: {
      value: route.model,
      name: modelName(model.id),
      options: aliases.map((alias) => ({ value: alias, label: modelName(config.models[alias].id) })),
      pick: onModel,
    },
    effort: model.efforts.length
      ? {
          value: route.effort ?? SESSION_EFFORT,
          text: route.effort ?? INHERIT,
          options: [
            { value: SESSION_EFFORT, label: INHERIT },
            ...model.efforts.map((effort) => ({ value: effort, label: effort })),
          ],
          pick: (effort) => onEffort(effort === SESSION_EFFORT ? null : effort),
        }
      : null,
  };
}

// Routes per cache: the tiers' routes, and the overrides when `overrides` is set. The count shows the overrides once
// activity routing is on; the one-more-cache warning always counts them, so it reads the same in every mode. `shared`
// says, per counted route, whether its model keeps one cache across efforts.
function cacheUses(draft, overrides) {
  const uses = new Map();
  const shared = [];
  const count = (route) => {
    shared.push(sharesEffort(draft, route));
    uses.set(cacheOf(draft, route), (uses.get(cacheOf(draft, route)) ?? 0) + 1);
  };
  for (const tier of TIERS) count(draft.routes[tier]);
  if (overrides)
    for (const activity of ACTIVITIES)
      for (const tier of TIERS) {
        const route = resolveRoute(draft, tier, activity);
        if (!sameRoute(route, draft.routes[tier])) count(route);
      }
  return { uses, shared };
}

// The Routes tab: one grid of tier (columns) by activity (rows), the tiers' own routes on top. A cell press opens its
// editor under the grid. Nothing is written until Save; the cache count reads the whole draft. The model holds every
// cell's routes, marks and handlers; the terminal draws it as rows and the graphical surfaces as cards.
function routesTab(ui, config, view, _usage, actions, modelOptions, columns, _now, surface) {
  const model = routesOf(config, view, actions, modelOptions, columns);
  return isGraphical(surface) ? graphicalRoutes(ui, model) : terminalRoutes(ui, model, { columns });
}

function routesOf(config, view, actions, modelOptions, columns) {
  const changes = routingChanges(config, view);
  const draft = { ...config, ...changes.draft };
  const mode = draft.activityRouting;
  // Efforts are cut short below 80 columns; a graphical pane lists each row's tiers there, and with no width.
  const narrow = Number.isFinite(columns) && columns < 80;
  const { uses, shared } = cacheUses(draft, mode === 'on');
  const selected = view.routeCell ?? null;
  // One grid cell: its route in the effort words the editor's Select offers, or the inherit mark where it runs the
  // tier's, as the terminal grid writes it; then its marks.
  const cell = (row, tier, route, { inherits = false, preset = false, edited = false, muted = false }) => ({
    tier,
    key: `cell-${row}-${tier}`,
    text: inherits ? ROUTE_MARKS.inherits.glyph : gridRoute(draft, route, narrow),
    // A card's: the display name the model Select shows and the full effort word the effort Select shows.
    label: inherits ? ROUTE_MARKS.inherits.card : cardRoute(draft, route),
    inherits,
    marks: [preset ? ROUTE_MARKS.preset : null, edited ? ROUTE_MARKS.edited : null].filter(Boolean),
    // Runs nothing now: the tier's model, or an override while activity routing is not on.
    muted,
    selected: selected === `${row}.${tier}`,
    press: () => actions.selectCell(`${row}.${tier}`),
  });
  const rows = [
    // The tiers' own routes: "every turn" in the terminal grid, "Default" on a card.
    {
      id: TIER_ROW,
      kind: TIER_ROW,
      label: 'every turn',
      title: 'Default',
      cells: TIERS.map((tier) => cell(TIER_ROW, tier, draft.routes[tier], { edited: changes.tiers.includes(tier) })),
    },
    ...ACTIVITIES.map((activity) => ({
      id: activity,
      kind: 'activity',
      label: activity,
      title: activity,
      cells: TIERS.map((tier) => {
        const route = resolveRoute(draft, tier, activity);
        const edited = changes.cells.some(([a, t]) => a === activity && t === tier);
        if (sameRoute(route, draft.routes[tier]))
          return cell(activity, tier, route, { inherits: true, edited, muted: true });
        const preset = builtIn(draft, activity, tier);
        return cell(activity, tier, route, {
          preset: Boolean(preset) && sameRoute(route, { model: preset.model, effort: preset.effort ?? null }),
          edited,
          muted: mode !== 'on',
        });
      }),
    })),
  ];
  const editor = editorOf(draft, changes, selected, cacheUses(draft, true).uses, actions, modelOptions);
  return {
    narrow,
    layout: narrow || !Number.isFinite(columns) ? 'list' : 'grid',
    tiers: TIERS,
    mode: {
      label: 'Activity routing',
      value: mode,
      options: ACTIVITY_MODES,
      changed: changes.mode,
      hint: ACTIVITY_MODE_HINT[mode],
      pick: (m) => actions.activityMode(m),
    },
    overrides: overridesOf(view, config.activityRouting, mode),
    rows,
    editor,
    // What a cell press does, until one is pressed.
    hint: editor ? null : 'Select a cell to change its model and effort.',
    legend: [ROUTE_MARKS.inherits, ROUTE_MARKS.preset, ROUTE_MARKS.edited],
    unsaved: ROUTE_MARKS.edited,
    cache:
      config.cache.mode === 'automatic'
        ? {
            text: 'Automatic prefix cache: hits are observed; lifetime and sharing across efforts are unknown. No cache-write premium.',
            wrap: false,
          }
        : config.cache.mode === 'disabled'
          ? { text: 'Prompt caching disabled: input is priced at the uncached rate.', wrap: false }
          : { text: cacheSentence(uses.size, shared, mode), wrap: true },
    // Two adjacent tiers on one route: that step changes nothing.
    steps: LADDER.slice(0, -1)
      .filter((upper, i) => sameRoute(draft.routes[upper], draft.routes[LADDER[i + 1]]))
      .map(
        (upper) =>
          `${LADDER[LADDER.indexOf(upper) + 1]} and ${upper} run the same model and effort: that step changes nothing`,
      ),
    reset: { label: 'Reset routes to defaults', press: actions.resetRoutes },
    note: 'A new model ID needs the active file → models: price, window, efforts.',
  };
}

// Why the cache count matters: a model keeps one cache across efforts (the 5.5 models on an API key or a subscription)
// or one per effort (other providers).
function cacheSentence(n, shared, mode) {
  const scope = mode === 'on' ? '' : ' (tiers only: activity routing is not on)';
  const per = shared.every(Boolean)
    ? 'one per model; effort changes keep it'
    : shared.some(Boolean)
      ? 'one per model, or per model + effort where efforts cache apart'
      : 'one per model + effort';
  return `${plural(n, 'prompt cache')} in use${scope}: ${per}. A switch to a cold cache writes the whole context again, the switch cost on Now.`;
}

// The editor of the selected grid cell: a tier's own route with its prices, or an activity's cell with what it runs,
// its built-in default, and the two ways back. Null with no cell, or one that names no tier and row.
function editorOf(draft, changes, selected, uses, actions, modelOptions) {
  const [row, tier] = selected?.split('.') ?? [];
  if (!TIERS.includes(tier) || (row !== TIER_ROW && !ACTIVITIES.includes(row))) return null;
  if (row === TIER_ROW) {
    const route = draft.routes[tier];
    const model = draft.models[route.model];
    const output = model.output ?? null;
    const span = `${windowSize(model.contextWindow)} window`;
    return {
      kind: TIER_ROW,
      tier,
      name: `Default at ${tier}`,
      choices: routeChoices(
        draft,
        `route-${tier}`,
        route,
        modelOptions,
        (alias) => actions.routeModel(tier, alias),
        (effort) => actions.routeEffort(tier, effort),
      ),
      changed: changes.tiers.includes(tier),
      // Per million tokens. Without an output price in router.json the terminal has always written `$? out`;
      // a card leaves the output price out.
      rates: {
        terminal: `$${model.input} in · ${output === null ? UNPRICED_OUTPUT : `$${output} out`} per M tokens · ${span}`,
        graphical: `$${model.input} in${output === null ? '' : ` · $${output} out`} per M tokens · ${span}`,
      },
    };
  }
  const activity = row;
  const route = resolveRoute(draft, tier, activity);
  const base = draft.routes[tier];
  const preset = builtIn(draft, activity, tier);
  const presetRoute = preset ? { model: preset.model, effort: preset.effort ?? null } : null;
  const own = !sameRoute(route, base);
  // A saved cell that resolves to the tier's route and is no built-in one changes nothing; 1.6 wrote such cells.
  const noEffect = !own && !presetRoute && Boolean(draft.activities[activity]?.[tier]);
  const drop = own || noEffect;
  const back = Boolean(presetRoute) && !sameRoute(route, presetRoute);
  return {
    kind: 'activity',
    activity,
    tier,
    name: `${activity} at ${tier}`,
    choices: routeChoices(
      draft,
      `activity-${activity}-${tier}`,
      route,
      modelOptions,
      (alias) => actions.activityModel(activity, tier, alias),
      (effort) => actions.activityEffort(activity, tier, effort),
    ),
    changed: changes.cells.some(([a, t]) => a === activity && t === tier),
    state: !own
      ? presetRoute && !sameRoute(route, presetRoute)
        ? 'runs the tier’s model; the built-in default is removed'
        : noEffect
          ? 'same as the tier’s model: no effect'
          : 'runs the tier’s model'
      : presetRoute && sameRoute(route, presetRoute)
        ? 'built-in default'
        : 'your override',
    // Back to the tier's route, and back to the built-in default, where each would change the cell.
    remove: drop
      ? {
          key: `activity-tier-${activity}-${tier}`,
          // The terminal names the way back; a card names what it removes and says what runs after.
          label: { terminal: `Use tier model: ${routeName(draft, base)}`, graphical: 'Remove override' },
          note: `tier model: ${routeName(draft, base)}`,
          press: () => actions.removeActivity(activity, tier),
        }
      : null,
    restore: back
      ? {
          key: `activity-default-${activity}-${tier}`,
          label: `Restore default: ${routeName(draft, presetRoute)}`,
          press: () => actions.restoreActivity(activity, tier),
        }
      : null,
    warnings: overrideWarnings(draft, uses, activity, tier),
  };
}

// Whether the overrides run now: the saved mode decides, since a draft runs nothing until Save. A different draft mode
// says what Save will change. Null while they run and Save changes nothing.
function overridesOf(view, saved, drafted) {
  const why = (mode) =>
    view.phase === 'unavailable'
      ? 'routing is unavailable'
      : view.mode === 'manual'
        ? 'routing is off'
        : mode === 'on'
          ? null
          : `activity routing is ${mode}`;
  const now = why(saved);
  const after = drafted === saved || Boolean(why(drafted)) === Boolean(now) ? null : why(drafted) ? 'not' : 'in';
  if (!now && !after) return null;
  return {
    warning: Boolean(now),
    text: now ? `Activity overrides not in use: ${now}` : 'Activity overrides in use',
    after: after ? `${after === 'not' ? 'not in use' : 'in use'} after Save` : null,
  };
}

// A Select's data over TUNING_CHOICES[key], with a saved value outside them kept as the first option; picking that one
// changes nothing. `text` is what a terminal without Select shows; `title` and each option's `title` are a card's.
function choiceOf(key, value, format, pick) {
  const values = TUNING_CHOICES[key].includes(value) ? TUNING_CHOICES[key] : [value, ...TUNING_CHOICES[key]];
  return {
    key,
    value: String(value),
    text: format(value),
    title: format(value),
    options: values.map((v) => ({ value: String(v), label: format(v), title: format(v) })),
    pick: (picked) => (TUNING_CHOICES[key].includes(Number(picked)) ? pick(Number(picked)) : undefined),
  };
}

// What the profile's routing mode does, under its control on the Policy tab.
const MODE_HINT = {
  cost: 'a cheaper model or one effort level less where a turn allows',
  balanced: 'each tier runs its route as configured',
  quality: 'one effort level more, or the tier above, where a turn allows',
};
// The model's words start lower case, as the terminal writes them; a card starts them with a capital.
const sentence = (words) => words.charAt(0).toUpperCase() + words.slice(1);
// "default 5 turns" beside a changed value in the terminal, "Default 5 turns" on a card.
const defaultOf = (value) => ({ terminal: `default ${value}`, graphical: `Default ${value}` });
// The Policy form's cards on a graphical surface, in order. Switching up holds no control, only its derived line.
const POLICY_GROUPS = ['Routing mode', 'Switching down', 'Switching up', 'Activities', 'Credits'];
// Each tuning value's card and help line on a graphical surface; the label is POLICY_ROWS'.
export const POLICY_FORM = {
  downgradeVotes: { group: 'Switching down', help: 'Agreeing turns before a cheaper model runs' },
  horizon: { group: 'Switching down', help: 'A cache write must pay back within this many turns' },
  activityMass: {
    group: 'Activities',
    help: 'Below this certainty a new task runs its tier’s model; a continuation keeps it',
  },
  cashCapUsd: { group: 'Credits', help: 'The most one cold cache write may cost, on a model that bills credits' },
};

// The Policy tab: each control inside the sentence it completes, its default named when the value differs. One Save
// writes it with the Routes draft. The model holds every control's value, options, marks and words; the terminal draws
// it as sentences and the graphical surfaces as a form of cards.
function policyTab(ui, config, view, _usage, actions, _modelOptions, _columns, _now, surface) {
  const model = policyOf(config, view, actions);
  return isGraphical(surface) ? graphicalPolicy(ui, model) : terminalPolicy(ui, model);
}

function policyOf(config, view, actions) {
  const changes = routingChanges(config, view);
  const { draft, tuning, policy } = changes;
  const preset = defaultsFor(config.provider);
  const defaults = tuningOf(preset);
  const { upgradeBase, upgradeSlope } = config.policy;
  const credits = Object.values(config.models).some((model) => model.billing === 'credits');
  const active = routingModeOf(view);
  const creditsHelp = credits
    ? 'on a model that bills credits'
    : 'no model in router.json bills credits, so this has no effect';
  const tune = Object.fromEntries(
    POLICY_ROWS.map(([key, label, format]) => {
      const form = POLICY_FORM[key];
      return [
        key,
        {
          key,
          group: form.group,
          label,
          control: choiceOf(key, tuning[key], format, (value) => actions.tune(key, value)),
          changed: policy.includes(key),
          default: tuning[key] === defaults[key] ? null : defaultOf(format(defaults[key])),
          // A setting with no effect says so in its help line.
          help: key === 'cashCapUsd' && !credits ? sentence(creditsHelp) : form.help,
        },
      ];
    }),
  );
  const mode = {
    key: 'routing-mode',
    group: 'Routing mode',
    label: 'Mode',
    control: {
      key: 'routing-mode',
      value: config.mode,
      text: config.mode,
      title: sentence(config.mode),
      options: ROUTING_MODES.map((m) => ({ value: m, label: m, title: sentence(m) })),
      pick: (m) => actions.routingMode(m),
    },
    note: 'saved at once',
    hint: MODE_HINT[config.mode],
    help: `${sentence(MODE_HINT[config.mode])} · saved at once`,
    // A session or project mode runs instead of the profile's.
    session:
      active.source === 'session' || active.source === 'project' ? `this session runs ${routingModeText(view)}` : null,
  };
  const baseline = {
    key: 'baseline',
    group: 'Routing mode',
    label: 'Start tier',
    control: {
      key: 'baseline',
      value: draft.baselineTier,
      text: draft.baselineTier,
      // A card names a tier with a capital, as it does a mode.
      title: sentence(draft.baselineTier),
      options: TIERS.map((tier) => ({ value: tier, label: tier, title: sentence(tier) })),
      pick: (tier) => actions.baseline(tier),
    },
    changed: changes.baseline,
    default: draft.baselineTier === preset.baselineTier ? null : defaultOf(preset.baselineTier),
    hint: 'when the session’s model is no tier’s model',
  };
  baseline.help = sentence(baseline.hint);
  const up = `needs ${classifierLabel(config)} support of ${percent(upgradeBase)}, up to ${percent(upgradeBase + upgradeSlope)} as the switch costs more`;
  const fields = [mode, baseline, ...Object.values(tune)];
  return {
    unsaved: ROUTE_MARKS.edited,
    mode,
    baseline,
    tune,
    up,
    activitiesHint: 'else a new task runs its tier’s model; a continuation keeps it',
    creditsHint: creditsHelp,
    groups: POLICY_GROUPS.map((title) => ({
      title,
      fields: fields.filter((field) => field.group === title),
      notes: title === 'Switching up' ? [sentence(up)] : [],
      // A session or project mode runs instead of the profile's.
      warnings: title === 'Routing mode' && mode.session ? [sentence(mode.session)] : [],
    })),
    reset: { label: 'Reset policy to defaults', press: actions.resetPolicy },
    file: {
      path: view.configPath ?? 'profile router.json',
      title: 'Settings file',
      copy: view.configPath ? { label: { terminal: 'copy', graphical: 'Copy path' }, press: actions.copyPath } : null,
    },
    subagents: { text: SUBAGENT_LINE[config.subagentRouting], label: SUBAGENT_CARD[config.subagentRouting] },
  };
}

// One row per configured classifier, as columns to compare: where the prompt goes, its activity probe and p95 wait,
// and whether its credentials are complete. A row press and the deadline are single values with nothing to review as
// a set, so each writes router.json at once; Undo in the status bar puts it back. Under the rows, the active
// classifier's own settings and readings, and its accuracy across sessions. The model holds every classifier's
// readings, words and tones; the terminal draws it as rows and the graphical surfaces as one card per classifier.
function classifierTab(ui, config, view, _usage, actions, _modelOptions, columns, _now, surface) {
  const model = classifierOf(config, view, actions);
  return isGraphical(surface) ? graphicalClassifier(ui, model) : terminalClassifier(ui, model, { columns });
}

// Where a classifier's prompt goes: this machine, or the endpoint's host.
const whereOf = (entry) => (isLocal(entry.endpoint) ? 'this machine' : hostOf(entry.endpoint));
const pausedText = (health) => `paused until ${new Date(health.pausedUntil).toLocaleTimeString()}`;

function classifierOf(config, view, actions) {
  const active = activeClassifier(config);
  const health = view.health ?? { failures: 0, pausedUntil: 0 };
  const paused = health.pausedUntil > Date.now();
  const rows = Object.entries(config.classifiers).map(([id, entry]) =>
    classifierRowOf(config, view, actions, id, entry, paused ? health : null),
  );
  const wait = waitOf(config, view, active);
  const { matched = 0, total = 0 } = view.activityStats?.agreement ?? {};
  const store = storeSummary(readStore(view.activityStore));
  const healthParts = {
    paused: paused ? pausedText(health) : null,
    steady: 'not paused',
    failures: plural(health.failures, 'recent failure'),
    last: Number.isFinite(view.adviceMs) ? `last ${view.adviceMs} ms` : null,
  };
  return {
    rows,
    probeNote: {
      terminal: 'probe: historical turn-activity questions, not goal/phase accuracy; p95 from that run',
      graphical: 'Probe: historical turn-activity questions, not goal/phase accuracy; p95 from that run',
    },
    active: {
      label: active.label,
      mark: { glyph: '●', tone: /** @type {const} */ ('accent'), text: 'Active' },
      deadline: {
        label: 'Deadline',
        control: choiceOf('timeoutMs', active.timeoutMs, (v) => `${v} ms`, actions.classifierTimeout),
        help: {
          terminal: 'past the deadline the turn keeps its model',
          graphical: 'Past the deadline the turn keeps its model',
        },
      },
      wait: { text: wait.slow ? `${wait.text}: slower than the deadline` : wait.text, slow: wait.slow },
      sends: {
        label: 'Sends',
        text: {
          terminal: `prompt + ${config.context.recentTurns} recent turns → ${whereOf(active)}`,
          graphical: `Prompt + ${config.context.recentTurns} recent turns → ${whereOf(active)}`,
        },
        help: {
          terminal: 'the bounded active goal and current step also go to the classifier',
          graphical: 'The bounded active goal and current step also go to the classifier',
        },
      },
      health: {
        label: 'Health',
        ...healthParts,
        // A card's one line.
        value: sentence(
          [healthParts.paused ?? healthParts.steady, healthParts.failures, healthParts.last]
            .filter(Boolean)
            .join(' · '),
        ),
        tone: /** @type {import('./ui/tokens.mjs').Tone} */ (paused ? 'warning' : 'primary'),
      },
      credentials: {
        label: 'Credentials',
        button: { key: 'key', label: 'Edit', hotkey: 'k', press: actions.key },
        note: 'opens /plugin configure',
      },
      // How often this session's tools fit the classifier's accepted activity; none before a labelled turn.
      session: total
        ? { head: 'THIS SESSION', text: `Tool compatibility (not accuracy): ${agreement(matched, total)}` }
        : null,
      // A card's readings: the wait against the deadline, and this session's agreement.
      readings: [
        {
          label: 'Wait',
          value: wait.measured
            ? wait.slow
              ? `${wait.text} · slower than the deadline`
              : wait.text
            : 'None measured yet',
          tone: /** @type {import('./ui/tokens.mjs').Tone} */ (wait.slow ? 'warning' : 'primary'),
        },
        total
          ? {
              label: 'Tool agreement',
              value: `${agreement(matched, total)} this session`,
              tone: /** @type {import('./ui/tokens.mjs').Tone} */ ('primary'),
              help: 'Compatibility with the tools a turn used, not accuracy',
            }
          : null,
      ].filter(Boolean),
    },
    store: store.labelled > 0 ? storeUsageOf(store, view.activityMetrics) : null,
  };
}

// One classifier: the terminal row's columns, and a card's status, readings and credentials Button. `paused` is the
// health while the classifier is paused, else null.
function classifierRowOf(config, view, actions, id, entry, paused) {
  const isActive = id === config.classifier;
  const missing = missingCredentials(config, view, id);
  const probe = probeOf(config, id);
  const local = isLocal(entry.endpoint);
  // The active classifier's last error, when it is not one of the missing credentials the row already names. While
  // routing is unavailable the error is the router's reason, which the notices show.
  const failed =
    isActive && view.phase !== 'unavailable' && view.error && !['missing-key', 'missing-account'].includes(view.error)
      ? view.error
      : null;
  /** @type {{ tone: import('./ui/tokens.mjs').Tone, text: string }} */
  const status = missing
    ? { tone: 'warning', text: sentence(missingText(config, id, missing)) }
    : isActive && paused
      ? { tone: 'warning', text: sentence(pausedText(paused)) }
      : failed
        ? { tone: 'warning', text: `Last error: ${classifierStatus(config, failed)}` }
        : { tone: 'success', text: 'Ready' };
  return {
    key: `classifier-${id}`,
    label: entry.label,
    active: isActive,
    press: () => actions.classifier(id),
    // A card's header: Use on every card but the active one's.
    use: isActive ? null : { label: 'Use' },
    // The terminal's columns.
    where: { text: whereOf(entry), local },
    probe: probe ? `${probe.correct}/${probe.probes}` : null,
    p95: probe ? `${probe.p95Ms} ms` : null,
    state: missing
      ? { tone: /** @type {const} */ ('warning'), text: `○ ${missingText(config, id, missing)}  ` }
      : { tone: /** @type {const} */ ('success'), text: '● ready' },
    setup: missing ? { key: `key-${id}`, label: 'Set up', press: actions.key } : null,
    // A card's.
    status,
    readings: [
      {
        label: 'Prompt goes to',
        value: local ? 'This machine' : whereOf(entry),
        tone: /** @type {import('./ui/tokens.mjs').Tone} */ (local ? 'success' : 'primary'),
      },
      probe
        ? {
            label: 'Activity probe',
            value: `${probe.correct} of ${probe.probes} right · p95 ${probe.p95Ms} ms`,
            tone: /** @type {import('./ui/tokens.mjs').Tone} */ ('primary'),
          }
        : null,
    ].filter(Boolean),
    // One credentials Button per card: Set up where something is missing, else the active one's Edit.
    // The active one's answers k either way, as the terminal's Edit does.
    credentials: missing
      ? { key: `key-${id}`, label: 'Set up', ...(isActive ? { hotkey: 'k' } : {}), press: actions.key }
      : isActive
        ? { key: 'key', label: 'Edit credentials', hotkey: 'k', press: actions.key, note: 'Opens /plugin configure' }
        : null,
  };
}

// The active classifier's wait: live p95 over this session's turns, else its probe's; slow past the deadline.
function waitOf(config, view, active) {
  const { latency } = readMetrics(view.activityMetrics);
  const live = latencyP95(Object.hasOwn(latency, config.classifier) ? latency[config.classifier] : null);
  const probe = probeOf(config, config.classifier);
  const p95 = live ? live.ms : probe?.p95Ms;
  const text = live
    ? `p95 ${live.over ? '>' : '≤'} ${live.ms} ms over ${plural(live.turns, 'turn')}`
    : probe
      ? `p95 ${probe.p95Ms} ms in its probe`
      : 'no wait measured yet';
  return {
    text,
    measured: Boolean(live || probe),
    slow: Number.isFinite(p95) && (p95 > active.timeoutMs || live?.over),
  };
}

// "19 of 22 turns (86%)".
const agreement = (matched, total) => `${matched} of ${total} turns (${percent(matched / total)})`;

// The counts kept across sessions, read from the stores as last loaded: how often the tools a turn used fit the
// classifier's activity, and what the activity moves led to. Agreement uses the classifier's raw answer, so it can
// differ from the session's. Each row is the terminal's line and a card's label and value.
function storeUsageOf(summary, metrics) {
  const { downMoves } = readMetrics(metrics);
  const rows = [
    { text: `Labelled   ${summary.labelled} turns`, label: 'Labelled', value: plural(summary.labelled, 'turn') },
  ];
  const { matched, total } = summary.agreement;
  if (total > 0)
    rows.push({
      text: `Tool compatibility (not accuracy): ${agreement(matched, total)}`,
      label: 'Tool agreement',
      value: agreement(matched, total),
    });
  const { focus } = summary;
  if (focus.total > 0)
    rows.push({
      text: `Code/ops/explore  classifier vs tools: ${agreement(focus.matched, focus.total)}`,
      label: 'Code, ops and explore',
      value: agreement(focus.matched, focus.total),
    });
  if (summary.disagreements.length) {
    const pairs = summary.disagreements.map((d) => `${d.predicted} → ${d.observed} ${d.n}`).join(' · ');
    rows.push({ text: `Mismatch   ${pairs}`, label: 'Mismatches', value: pairs });
  }
  const { taken, refused } = summary.lateral;
  if (taken + refused > 0)
    rows.push({
      text: `Activity moves  ${taken} taken · ${refused} refused`,
      label: 'Activity moves',
      value: `${taken} taken · ${refused} refused`,
    });
  const { moves, escalations } = downMoves;
  if (moves > 0) {
    rows.push({
      text: `Escalations  after a cheaper activity move: ${escalations} in ${moves} move${moves === 1 ? '' : 's'}`,
      label: 'Escalations',
      value: `${escalations} after ${plural(moves, 'cheaper activity move')}`,
    });
  }
  return {
    head: 'ACROSS SESSIONS · since the last reset',
    title: 'Across sessions',
    hint: 'Since the last reset',
    rows,
    unpriced: unpricedLine(metrics),
  };
}

// Green for a write or its undo, red for a refused write, yellow for everything else that needs a look.
const noticeColor = (notice) =>
  /^Not saved/.test(notice) ? 'red' : /^(Saved|Undid|Path copied)/.test(notice) ? 'green' : 'yellow';

// The one place for commit state on every tab: the unsaved Routes and Policy draft with Save and Discard (the
// router.json lines it writes on those two tabs, a count elsewhere), the last notice, and Undo for the last write.
function statusBar(ui, config, view, tab, actions) {
  const changes = routingChanges(config, view);
  const out = [];
  if (changes.count) {
    out.push(ui.text(' '));
    if (DRAFT_TABS.includes(tab)) {
      const diff = (key, before, after) => [
        ui.text(`- ${key.padEnd(30)} ${before}`, { color: 'red' }),
        ui.text(`+ ${key.padEnd(30)} ${after}`, { color: 'green' }),
      ];
      out.push(ui.dim('router.json changes:'));
      for (const tier of changes.tiers)
        out.push(
          ...diff(
            `routes.${tier}`,
            routeName(config, config.routes[tier]),
            routeName(config, changes.draft.routes[tier]),
          ),
        );
      if (changes.baseline) out.push(...diff('baselineTier', config.baselineTier, changes.draft.baselineTier));
      const draft = { ...config, ...changes.draft };
      const cellName = (c, activity, tier) =>
        c.activities[activity]?.[tier] ? routeName(c, resolveRoute(c, tier, activity)) : 'no override';
      for (const [activity, tier] of changes.cells)
        out.push(
          ...diff(`activities.${activity}.${tier}`, cellName(config, activity, tier), cellName(draft, activity, tier)),
        );
      if (changes.mode) out.push(...diff('activityRouting', config.activityRouting, changes.draft.activityRouting));
      for (const [key, , format, field] of POLICY_ROWS.filter(([key]) => changes.policy.includes(key)))
        out.push(...diff(field, format(changes.saved[key]), format(changes.tuning[key])));
    }
    out.push(
      ui.line(
        ui.text(`● ${changes.count} unsaved routing change${changes.count === 1 ? '' : 's'}  `, { color: 'yellow' }),
        ui.Button({
          key: 'save-routing',
          label: 'Save',
          hotkey: 's',
          variant: 'primary',
          onPress: actions.saveRouting,
        }),
        ' ',
        ui.Button({ key: 'discard-routing', label: 'Discard', hotkey: 'd', onPress: actions.discardRouting }),
        DRAFT_TABS.includes(tab) ? null : ui.dim('  listed on Routes and Policy'),
      ),
    );
  }
  const undo = view.lastWrite ? ui.Button({ key: 'undo', label: 'Undo', hotkey: 'u', onPress: actions.undo }) : null;
  const confirmsWrite = Boolean(undo && view.notice?.startsWith('Saved'));
  if (view.notice || undo) out.push(ui.text(' '));
  if (view.notice)
    out.push(ui.line(ui.text(`${view.notice}  `, { color: noticeColor(view.notice) }), confirmsWrite ? undo : null));
  if (undo && !confirmsWrite) out.push(ui.line(ui.dim(`Last change: ${view.lastWrite.label}  `), undo));
  return out;
}

// The footer as [text, joiner] pieces, packed to the pane: two lines at full width, more in a narrow pane, never a
// line that ends in a joiner.
const SAVINGS_FOOTER = [
  ['≈$ = tokens × configured API rates (list/custom)', ' · '],
  ['not invoices or measured quota savings', ' · '],
  ['answer quality not measured', ''],
];
const FULL_WIDTH = 68;

const footer = (ui, columns) =>
  pack(SAVINGS_FOOTER, Math.min(FULL_WIDTH, columns ?? FULL_WIDTH), '  ').map((line) => ui.dim(line));

// The tier whose route is your model at your effort, for its color; else any tier on your model.
function yourTier(config, view) {
  const runs = (tier) => {
    const route = resolveRoute(config, tier);
    return (
      isSameModel(config.models[route.model].id, view.nativeModel) &&
      routeEffort(config, route, view.nativeEffort) === (view.nativeEffort ?? null)
    );
  };
  return TIERS.find(runs) ?? cellForModel(config, view.nativeModel)?.tier ?? null;
}

// Prices summed over the priced requests, and how many were not priced (a model without a price in router.json).
const pricedText = (text, counts) =>
  counts.pricedRequests < counts.requests ? `${text} (${counts.requests - counts.pricedRequests} unpriced)` : text;

// "Oct 7 – Oct 13" for a period's span, or "since Oct 10", its `first` day, for one without a range; null without one.
function spanText(period, now, first) {
  const { from, to } = periodRange(period, now);
  if (period === 'today') return `today, ${dayLabel(to)}`;
  if (from) return `${dayLabel(from)} – ${dayLabel(to)}`;
  return first ? `since ${dayLabel(first)}` : null;
}

// The subagent rows: the open mark, the type, its squares, agents, cost, and against Claude Code's pick with its arrow.
const AGENT_TYPE = 19;
const AGENT_SQUARES = 12;
const AGENT_ROW = 4 + AGENT_TYPE + AGENT_SQUARES + 3 + 9 + 11;
// The summary strip's squares at most: past this each model gets its share of them, not one per agent.
const AGENT_STRIP = 25;
// The models in the order their squares go, by family; any other after them by name.
const FAMILIES = ['haiku', 'sonnet', 'opus', 'fable'];
const clipped = (text, width) => (text.length < width ? text : `${text.slice(0, width - 2)}…`);
const familyRank = (id) => {
  const rank = FAMILIES.findIndex((family) => id.includes(family));
  return rank < 0 ? FAMILIES.length : rank;
};
const byFamily = (a, b) => familyRank(a[0]) - familyRank(b[0]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
const colored = (ui, id, text) => {
  const color = modelColor(id);
  return ui.text(text, color ? { color } : {});
};

// Each model's agents in a period and how many the router moved, across the routed types and the pass-throughs.
function agentsByModel(s) {
  const models = new Map();
  for (const kind of ['routed', 'passed'])
    for (const counts of Object.values(s[kind]))
      for (const [id, m] of Object.entries(counts.models)) {
        const sum = models.get(id) ?? { agents: 0, moved: 0 };
        models.set(id, { agents: sum.agents + m.agents, moved: sum.moved + (m.moved ?? 0) });
      }
  return [...models].filter(([, m]) => m.agents > 0).sort(byFamily);
}

// Squares for `models` ([id, { agents, moved }]), colored by model, filled for the agents the router moved. `scale`:
// one per agent up to `max`, then each model's share of `max`, at least one. Else one per agent up to `max`, and
// `rest` counts the agents past them.
function squares(ui, models, max, scale) {
  const total = models.reduce((n, [, m]) => n + m.agents, 0);
  const shown = (n) => (!scale || total <= max || !n ? n : Math.max(1, Math.round((n / total) * max)));
  const parts = [];
  let left = max;
  for (const [id, m] of models) {
    const n = Math.min(shown(m.agents), left);
    const filled = Math.min(n, shown(m.moved));
    if (filled) parts.push(colored(ui, id, '■'.repeat(filled)));
    if (n > filled) parts.push(colored(ui, id, '□'.repeat(n - filled)));
    left -= n;
  }
  return { parts, width: max - left, rest: scale ? 0 : total - (max - left) };
}

// "routing −$0.21 (−5%) vs Claude Code’s picks on 7 routed agents", in the session readout's words: the routed
// agents' cost against Claude Code's picks.
function agentVerdict(ui, routed) {
  const agents = routed.reduce((n, [, c]) => n + c.agents, 0);
  const totals = routed.map(([, c]) => modelTotals(c));
  const cost = totals.reduce((n, t) => n + t.usd, 0);
  const core = totals.reduce((n, t) => n + t.coreUsd, 0);
  const counts = {
    requests: routed.reduce((n, [, c]) => n + c.requests, 0),
    pricedRequests: routed.reduce((n, [, c]) => n + c.pricedRequests, 0),
  };
  if (!counts.pricedRequests) return ui.dim(`  ${plural(agents, 'routed agent')}, not priced`);
  const difference = cents(cost - core);
  const on = pricedText(` on ${plural(agents, 'routed agent')}`, counts);
  const share = core > 0 && difference ? ` (${difference < 0 ? '−' : '+'}${percent(Math.abs(difference) / core)})` : '';
  return ui.line(
    '  ',
    ui.text(`routing ${signedUsd(difference)}${share}`, { bold: true, color: savingsColor(difference) }),
    ' vs Claude Code’s picks',
    ui.dim(on),
  );
}

// The strip of every agent by model, what the router moved, and how routing paid off.
function agentSummary(ui, s, columns) {
  const models = agentsByModel(s);
  const total = models.reduce((n, [, m]) => n + m.agents, 0);
  const moved = models.reduce((n, [, m]) => n + m.moved, 0);
  const strip = squares(ui, models, AGENT_STRIP, true);
  const labels = models.map(([id, m]) => [id, `${modelName(id)} ${m.agents}`]);
  const names = labels.flatMap(([id, text], i) => [i ? ui.dim(' · ') : null, colored(ui, id, text)]);
  const namesWidth = labels.reduce((n, [, text], i) => n + (i ? 3 : 0) + text.length, 0);
  const out =
    Number.isFinite(columns) && 2 + strip.width + 2 + namesWidth > columns
      ? [ui.line('  ', ...strip.parts), ui.line('  ', ...names)]
      : [ui.line('  ', ...strip.parts, '  ', ...names)];
  out.push(
    ui.line(
      `  ${plural(total, 'agent')}`,
      ui.dim(' · '),
      `■ ${moved} moved by the router`,
      ui.dim(' · '),
      `□ ${total - moved} on Claude Code’s pick`,
    ),
  );
  const routed = Object.entries(s.routed).filter(([, c]) => c.agents > 0);
  if (routed.length) out.push(agentVerdict(ui, routed));
  return out;
}

// Agents per day from the period's first day, or the first recorded one, to today, with the busiest day.
function agentTrend(ui, s, period, now) {
  if (period === 'session' || period === 'today' || !s.perDay.length) return [];
  const counts = new Map(s.perDay);
  const start = periodRange(period, now).from ?? s.perDay[0][0];
  const [y, m, d] = start.split('-').map(Number);
  const days = [];
  for (let i = 0; ; i += 1) {
    const key = dayKey(new Date(y, m - 1, d + i).getTime());
    if (key > dayKey(now)) break;
    days.push([key, counts.get(key) ?? 0]);
  }
  if (days.length < 2) return [];
  const [peakDay, peak] = days.reduce((top, day) => (day[1] > top[1] ? day : top));
  // A long All period keeps its last days, as many as the row has room for.
  const values = days.map(([, n]) => n).slice(-(AGENT_ROW - 30));
  return [
    ui.line('  per day ', ui.text(sparkline(values), { bold: true }), ui.dim(`  peak ${peak} on ${dayLabel(peakDay)}`)),
  ];
}

// "+$0.44 ▲" against Claude Code's pick, in the savings colors; a dim dash when it rounds to nothing.
const pickDifference = (ui, value) =>
  value
    ? ui.text(`${signedUsd(value)} ${value > 0 ? '▲' : '▼'}`.padStart(11), { color: savingsColor(value) })
    : ui.dim('—'.padStart(9));

// What a routed model row holds: "2 moved up", or "1 kept, 2 down".
function moveText(m) {
  const kept = m.agents - m.moved;
  const other = m.moved - m.up - m.down;
  const parts = [
    kept ? `${kept} kept` : null,
    m.up ? `${m.up} up` : null,
    m.down ? `${m.down} down` : null,
    other ? `${other} moved` : null,
  ].filter(Boolean);
  if (parts.length > 1 || kept) return parts.join(', ');
  return `${m.moved} moved${m.up ? ' up' : m.down ? ' down' : ''}`;
}

// One row of the subagent table; open, the models it ran on with their cost, and its requests and retry proxies.
function agentRow(ui, view, actions, { id, name, counts, routed, why, narrow, columns, billing }) {
  const open = view.usageOpen === id;
  const models = Object.entries(counts.models)
    .filter(([, m]) => m.agents > 0)
    .sort(byFamily);
  const marks = squares(
    ui,
    models.map(([model, m]) => [model, { agents: m.agents, moved: m.moved ?? 0 }]),
    AGENT_SQUARES - 3,
    false,
  );
  const t = modelTotals(counts);
  // A row none of whose requests had a price says so rather than $0.00.
  const priced = counts.pricedRequests > 0;
  const costCell = (value) => (priced ? costText(value, billing).padStart(9) : ui.dim('no price'.padStart(9)));
  const out = [
    ui.line(
      '  ',
      ui.Button({
        key: `row-${id}`,
        label: open ? '▾' : '▸',
        plain: true,
        onPress: () => actions.usageOpen(open ? null : id),
      }),
      ' ',
      ui.cell(AGENT_TYPE, clipped(name, AGENT_TYPE)),
      ui.cell(AGENT_SQUARES, ui.line(...marks.parts, marks.rest ? ui.dim(`+${marks.rest}`) : null)),
      String(counts.agents).padStart(3),
      narrow ? null : costCell(t.usd),
      routed && priced ? pickDifference(ui, cents(t.usd - t.coreUsd)) : null,
      !routed && why && !narrow ? ui.dim(`  ${why}`) : null,
    ),
  ];
  if (!open) return out;
  for (const [model, m] of models)
    out.push(
      ui.line(
        '      ',
        ui.cell(17, colored(ui, model, `${m.moved ? '■' : '□'} ${modelName(model)}`)),
        ui.cell(15, ui.dim(routed ? moveText(m) : plural(m.agents, 'agent'))),
        narrow ? null : costCell(m.usd),
        routed && priced ? pickDifference(ui, cents(m.usd - m.coreUsd)) : null,
      ),
    );
  const notes = [
    `${(counts.requests / counts.agents).toFixed(1)} requests per agent`,
    routed ? `${counts.respawns || 'none'} respawned within 10 min` : null,
    counts.failures ? plural(counts.failures, 'classifier failure') : null,
    counts.pricedRequests < counts.requests ? `${counts.requests - counts.pricedRequests} requests not priced` : null,
  ].filter(Boolean);
  out.push(...dimLines(ui, `      ${notes.join(' · ')}`, columns));
  return out;
}

// Subagents in the chosen period: this session's record, or every session's in every project (one $.store per
// plugin install). A strip of every agent by the model it ran on, filled where the router moved it off Claude Code's
// pick, and the routed agents' cost against those picks. Then the routed types and the pass-throughs, each with its
// squares, agents and cost, opening to its models; a pass-through says why Claude Code picked.
function subagentUsage(ui, config, view, actions, period, now, columns, billing) {
  const mode = config.subagentRouting;
  const record = readSubagentStore(period === 'session' ? view.subagentSession : view.subagentStore);
  const s = summarizeSubagents(record, periodRange(period, now));
  const first = Number.isFinite(record.since) ? dayKey(record.since) : null;
  const scope =
    period === 'session' ? 'this session' : `all projects · ${spanText(period, now, first) ?? 'nothing yet'}`;
  const out = [ui.line(ui.head('SUBAGENTS'), ui.dim(` · ${scope}   subagent routing ${mode}`))];
  const routed = Object.entries(s.routed)
    .filter(([, c]) => c.agents > 0)
    .sort((a, b) => b[1].agents - a[1].agents || (a[0] < b[0] ? -1 : 1));
  const passed = PASS_REASONS.filter((reason) => s.passed[reason]?.agents > 0).sort(
    (a, b) => s.passed[b].agents - s.passed[a].agents,
  );
  const undated = s.undated
    ? [
        ui.dim(
          `  + ${plural(s.undated.agents, 'agent')} from before 1.14.0, not split by model · ${costText(s.undated.usd, billing)}`,
        ),
      ]
    : [];
  if (!routed.length && !passed.length) {
    const older = !s.undated && periodRange(period, now).from !== null && readSubagentStore(view.subagentStore).undated;
    return [
      ...out,
      ui.dim(
        mode === 'off'
          ? '  Not recorded: subagentRouting is off in router.json.'
          : `  No subagents ${PERIOD_PHRASE[period]}.`,
      ),
      ...undated,
      ...(older ? [ui.dim('  Agents from before 1.14.0 have no date: All shows them.')] : []),
    ];
  }
  const narrow = Number.isFinite(columns) && columns < AGENT_ROW;
  out.push(...agentSummary(ui, s, columns), ...agentTrend(ui, s, period, now), ...undated);
  const rowOf = (fields) => agentRow(ui, view, actions, { narrow, columns, billing, ...fields });
  if (routed.length) {
    out.push(
      ui.text(' '),
      ui.line(ui.text('  ROUTED', { bold: true }), ui.dim(' · the router picked the model at spawn')),
      ui.dim(
        `    ${'type'.padEnd(AGENT_TYPE)}${'agents'.padEnd(AGENT_SQUARES + 3)}${narrow ? '' : 'cost'.padStart(9)}${'vs CC'.padStart(9)}`,
      ),
    );
    for (const [type, counts] of routed)
      out.push(...rowOf({ id: `subagent:${type}`, name: type, counts, routed: true }));
  }
  if (passed.length) {
    out.push(ui.text(' '), ui.line(ui.text('  NOT ROUTED', { bold: true }), ui.dim(' · Claude Code picked the model')));
    for (const reason of passed)
      out.push(
        ...rowOf({
          id: `subagent-pass:${reason}`,
          name: PASS_LABEL[reason],
          counts: s.passed[reason],
          routed: false,
          why: PASS_WHY[reason],
        }),
      );
  }
  out.push(
    ui.text(' '),
    ...dimLines(ui, '  ■ moved by the router · □ Claude Code’s pick · color: the model', columns),
    ...(routed.length
      ? dimLines(ui, '  vs CC: the same tokens on Claude Code’s pick, at configured API rates', columns)
      : []),
  );
  return out;
}

const PERIOD_LABEL = { session: 'Session', today: 'Today', '7d': '7d', '30d': '30d', month: 'Month', all: 'All' };
// "No routed replies …" for each period.
const PERIOD_PHRASE = {
  session: 'this session',
  today: 'today',
  '7d': 'in the last 7 days',
  '30d': 'in the last 30 days',
  month: 'this month',
  all: 'yet',
};
const GROUPS = [
  ['activity', 'Activity'],
  ['model', 'Model'],
  ['tier', 'Tier'],
];
// What an open row lists: the routes of an activity, the activities of a model or a tier.
const CHILD_BY = { activity: 'route', model: 'activity', tier: 'activity' };
// The ledger's label column after its sign, and its amount column.
const LEDGER_AMOUNT = 9;
// The breakdown: the open mark, the name, replies, cost and vs yours; "mostly on" or the share only where it fits.
const NAME = 20;
const BREAKDOWN = 4 + NAME + 8 + 10 + 15;
// Tiers in their own order; `none` (not routed) last.
const TIER_RANK = (name) => (TIERS.includes(name) ? TIERS.indexOf(name) : TIERS.length);
const TAIL = 23;
// Bars at full scale: the routed share of your model, and the costliest row of What if.
const BAR = 22;
const SPARK = '▁▂▃▄▅▆▇█';

// "Opus 5.5 · high" for a cell's `id@effort`.
function routeText(route) {
  const at = route.lastIndexOf('@');
  const effort = route.slice(at + 1);
  return routeLabel(route.slice(0, at), effort === 'session' ? null : effort);
}
// A cents difference, so a row never reads "+$0.00" for a fraction of a cent.
const cents = (usd) => Math.round(usd * 100) / 100;
const differenceText = (ui, usdValue, width) => {
  const value = cents(usdValue);
  return ui.text(signedUsd(value).padStart(width), savingsColor(value) ? { color: savingsColor(value) } : {});
};

// A breakdown row's name: an activity as its verb, a tier in its color, a model or a route by name.
function groupName(ui, by, name) {
  if (name === 'none') return ui.dim(by === 'activity' ? 'no activity' : 'not routed');
  if (by === 'activity') return ui.activity(name);
  if (by === 'tier') return ui.bars(name);
  return ui.text(by === 'model' ? modelName(name) : routeText(name));
}

// The period buttons; `p` presses the one after the shown period, so it steps through them.
function periodRow(ui, period, actions) {
  const next = PERIODS[(PERIODS.indexOf(period) + 1) % PERIODS.length];
  return ui.line(
    ...PERIODS.flatMap((id) => [
      ui.Button({
        key: `period-${id}`,
        label: PERIOD_LABEL[id],
        ...(id === next ? { hotkey: 'p' } : {}),
        variant: id === period ? 'primary' : 'secondary',
        onPress: () => actions.period(id),
      }),
      ' ',
    ]),
    ui.dim('  p next'),
  );
}

// Whose replies the period holds and what each is compared with.
function scopeLine(ui, config, view, period, summary, now) {
  if (period === 'session') {
    const recorded = recordedModels(config, view, summary);
    if (recorded)
      return ui.dim(
        Object.keys(summary.yours).length > 1
          ? `this session · each reply vs the model /model selected: ${recorded}`
          : `this session · your model ${recorded}`,
      );
    const tier = yourTier(config, view);
    return ui.line(
      ui.dim('this session · your model '),
      tier ? ui.tier(tier, yourModel(view)) : ui.text(yourModel(view)),
    );
  }
  const span = spanText(period, now, summary.days[0]?.[0]) ?? 'no dated replies yet';
  return ui.dim(`all projects · ${span} · each session vs its own model`);
}

// Replies, turns, tokens and the cache share of the input.
const statsLine = (ui, s) =>
  ui.dim(
    `  ${plural(s.replies, 'reply', 'replies')} · ${plural(s.turns, 'turn')} · input ${formatTokens(s.inputTokens)}` +
      ` · cache hit ${s.inputTokens ? percent(s.cacheReadTokens / s.inputTokens) : '—'} · output ${formatTokens(s.outputTokens)}`,
  );

// The period's cost by activity, model or tier, most first; `g` presses the next grouping. A row opens to what it
// holds and its cost parts. A narrow pane drops "mostly on" (or the share) before any number.
function breakdownLines(ui, view, actions, summary, columns, compare, billing) {
  const by = GROUPS.some(([id]) => id === view.usageGroup) ? view.usageGroup : 'activity';
  const next = GROUPS[(GROUPS.findIndex(([id]) => id === by) + 1) % GROUPS.length][0];
  const out = [
    ui.line(
      ui.head('BY  '),
      ...GROUPS.flatMap(([id, label]) => [
        ui.Button({
          key: `group-${id}`,
          label,
          ...(id === next ? { hotkey: 'g' } : {}),
          variant: id === by ? 'primary' : 'secondary',
          onPress: () => actions.usageGroup(id),
        }),
        ' ',
      ]),
      ui.dim('  g next'),
    ),
  ];
  const cells = summary.observed.cells;
  // Tiers read low to high, as the band's bars; activities and models lead with the costliest.
  const groups =
    by === 'tier' ? breakdown(cells, by).sort((a, b) => TIER_RANK(a.name) - TIER_RANK(b.name)) : breakdown(cells, by);
  const missing = new Map(breakdown(summary.observed.uncompared, by).map((g) => [g.name, g]));
  if (!groups.length) return [...out, ui.dim('  no routed replies in this period')];
  const tail = !Number.isFinite(columns) || columns >= BREAKDOWN + TAIL;
  const tailHead = by === 'model' ? 'share' : 'mostly on';
  out.push(
    ui.dim(
      `    ${''.padEnd(NAME)}${'replies'.padStart(8)}${'cost'.padStart(10)}${compare ? `vs ${UNROUTED}`.padStart(15) : ''}${tail ? `   ${tailHead}` : ''}`,
    ),
  );
  const numbers = (sums, unavailable) => [
    `${String(sums[0]).padStart(8)}${costText(sums[1], billing).padStart(10)}`,
    !compare ? null : unavailable ? ui.dim('—'.padStart(15)) : differenceText(ui, sums[1] - sums[2], 15),
  ];
  for (const group of groups) {
    const id = `${by}:${group.name}`;
    const open = view.usageOpen === id;
    const route = by === 'model' ? null : mostlyOn(cellsWhere(cells, by, group.name));
    out.push(
      ui.line(
        '  ',
        ui.Button({
          key: `row-${id}`,
          label: open ? '▾' : '▸',
          plain: true,
          onPress: () => actions.usageOpen(open ? null : id),
        }),
        ' ',
        ui.cell(NAME, groupName(ui, by, group.name)),
        ...numbers(group.sums, missing.has(group.name)),
        !tail
          ? null
          : by === 'model'
            ? ui.dim(`   ${percent(summary.observed.routedUsd > 0 ? group.sums[1] / summary.observed.routedUsd : 0)}`)
            : route
              ? ui.dim(`   ${routeText(route)}`)
              : null,
      ),
    );
    if (!open) continue;
    for (const child of group.children)
      out.push(
        ui.line(
          '      ',
          ui.cell(NAME - 2, groupName(ui, CHILD_BY[by], child.name)),
          ...numbers(
            child.sums,
            missing.get(group.name)?.children.some((c) => c.name === child.name),
          ),
        ),
      );
    const [, , , cheaper, stronger, switched, input, , output] = group.sums;
    out.push(
      ...dimLines(
        ui,
        missing.has(group.name)
          ? `      comparison unavailable · input ${formatTokens(input)} · output ${formatTokens(output)}`
          : `      cheaper ${signedUsd(cents(cheaper))} · stronger ${signedUsd(cents(stronger))} · cache rebuilds ${signedUsd(cents(switched))} · input ${formatTokens(input)} · output ${formatTokens(output)}`,
        columns,
      ),
    );
  }
  return out;
}

// What the period's tokens would cost on each model alone, as your model for every reply (compareModels), beside what
// routing spent and your own models; a model some reply had no price on is left out.
function compareLines(ui, summary, billing) {
  if (summary.observed.uncomparedReplies)
    return [ui.dim('What if unavailable: some replies have no comparable cache history.')];
  const yours = Object.keys(summary.yours);
  const single = yours.length === 1 ? yours[0] : null;
  const rows = Object.entries(summary.whatIf)
    .filter(([, [n]]) => n === summary.replies)
    .map(([model, [, value]]) => ({
      label: `${modelName(model)}${model === single ? ' · yours' : ''}`,
      value,
      routed: false,
      yours: model === single,
    }));
  if (!rows.some((row) => row.yours))
    rows.push({
      label: yours.length > 1 ? 'Your models' : 'Your model',
      value: summary.yoursUsd,
      routed: false,
      yours: true,
    });
  rows.push({ label: 'Routed', value: summary.routedUsd, routed: true, yours: false });
  rows.sort((a, b) => a.value - b.value);
  const max = Math.max(...rows.map((row) => row.value));
  return [
    ...rows.map((row) => {
      const filled = max > 0 ? Math.max(0, Math.min(BAR, Math.round((row.value / max) * BAR))) : 0;
      return ui.line(
        '  ',
        ui.cell(22, ui.text(row.label, row.routed ? { bold: true } : {})),
        ui.text('█'.repeat(filled), { color: row.routed ? 'cyan' : 'gray' }),
        ' '.repeat(BAR - filled),
        costText(row.value, billing).padStart(LEDGER_AMOUNT),
        row.routed ? '' : row.yours ? ui.dim('—'.padStart(11)) : differenceText(ui, row.value - summary.yoursUsd, 11),
      );
    }),
    ui.dim('  same tokens and output on each model alone · answer quality not measured'),
  ];
}

// Routed cost per hour, day or week as one line of blocks, a dot for a bucket without replies; and the What if switch.
function trendLines(ui, view, actions, summary, period, now, billing) {
  const toggle = ui.Button({
    key: 'usage-compare',
    label: view.usageCompare ? 'Trend' : 'What if',
    hotkey: 'c',
    onPress: actions.usageCompare,
  });
  const t = trend(summary, period, now);
  if (t.values.length < 2)
    return [ui.line(ui.head(`COST BY ${t.unit.toUpperCase()}`), ui.dim(`  one ${t.unit} so far   `), toggle)];
  const max = Math.max(...t.values);
  const glyphs = t.values.map((v) => (v > 0 ? SPARK[Math.min(7, Math.floor((v / max) * 8))] : '·')).join('');
  return [
    ui.line(
      ui.head(`COST BY ${t.unit.toUpperCase()} `),
      ui.text(glyphs, { color: 'cyan' }),
      ui.dim(`  peak ${costText(max, billing)}   `),
      toggle,
    ),
  ];
}

// The evidence worth a look, each with the tab that changes it: the cell that carried most of the cost, the switch
// writes against the saving, the cell that ran above your model. Never which model to use.
function insightLines(ui, summary, actions, columns) {
  if (summary.observed.uncomparedReplies || summary.replies < INSIGHT_REPLIES) return [];
  const list = insights(summary);
  if (!list.length) return [];
  return [
    ui.text(' '),
    ui.line(ui.head('WORTH A LOOK'), ui.dim(' · from the numbers; answer quality is not measured')),
    ...list.map((insight) => insightLine(ui, insight, actions, columns)),
  ];
}

// One finding with the tab that changes it.
function insightLine(ui, insight, actions, columns) {
  const where = ({ activity, tier }) => [
    ...(ACTIVITIES.includes(activity) ? [ui.activity(activity), ui.dim(' · ')] : []),
    TIERS.includes(tier) ? ui.bars(tier) : ui.dim('not routed'),
  ];
  const link = (insight) =>
    TIERS.includes(insight.tier)
      ? ui.Button({
          key: `insight-${insight.kind}`,
          label: 'Routes',
          onPress: () =>
            actions.openRoute(
              ACTIVITIES.includes(insight.activity) ? `${insight.activity}.${insight.tier}` : `tier.${insight.tier}`,
            ),
        })
      : null;
  return insight.kind === 'switch'
    ? ui.line(
        `  Cache rebuilds used ${percent(insight.share)} of the cheaper-model saving  `,
        ui.Button({ key: 'insight-switch', label: 'Policy', onPress: () => actions.tab('policy') }),
      )
    : ui.line(
        '  ',
        ...where(insight),
        insight.kind === 'cost'
          ? ` carried ${percent(insight.share)} of the cost`
          : ` ran ${usd(insight.usd)} above your model`,
        insight.route && (!Number.isFinite(columns) || columns >= 90)
          ? ui.dim(` · mostly ${routeText(insight.route)}`)
          : null,
        '  ',
        link(insight),
      );
}

// Delete history waits for a second press, as nothing brings the records back.
function deleteLine(ui, view, actions) {
  if (!view.confirmDelete)
    return ui.Button({
      key: 'delete-history',
      label: 'Delete history',
      dimColor: true,
      onPress: () => actions.confirmDelete(true),
    });
  return ui.line(
    ui.text('Delete the usage, activity and subagent history of every session?  ', { color: 'yellow' }),
    ui.Button({ key: 'delete-confirm', label: 'Delete', variant: 'primary', onPress: actions.resetStats }),
    ' ',
    ui.Button({ key: 'delete-keep', label: 'Keep', onPress: () => actions.confirmDelete(false) }),
  );
}

// Answer first for the chosen period: routing against your model as a ledger that adds up, the tokens, the cost by
// activity, model or tier, the trend or What if, and what is worth a look. Subagents follow, for the same period.
function usageTab(ui, config, view, usage, actions, _modelOptions, columns, now) {
  const period = PERIODS.includes(view.usagePeriod) ? view.usagePeriod : 'session';
  const record = liveUsage(view, period === 'session' ? view.usageSession : view.usageStore);
  const summary = summarize(record, periodRange(period, now));
  // All adds the undated savings totals kept from before the usage records.
  const kept = period === 'all' ? allTime(record, view.savingsStore) : null;
  const legacy = kept?.legacy ?? null;
  const agents = summarizeSubagents(
    readSubagentStore(period === 'session' ? view.subagentSession : view.subagentStore),
    period === 'session' ? { from: null, to: null } : periodRange(period, now),
  );
  const cost = periodCost(config, {
    summary: kept ? { ...summary, ...kept.totals, observed: kept.observed } : summary,
    agents,
    usage,
  });
  const out = [periodRow(ui, period, actions), scopeLine(ui, config, view, period, summary, now), ui.text(' ')];
  out.push(...costTable(ui, config, view, period, cost, legacy, actions, columns));
  if (summary.observed.replies) out.push(ui.text(' '), statsLine(ui, { ...summary.observed, turns: summary.turns }));
  if (summary.observed.replies) {
    out.push(
      ui.text(' '),
      ...breakdownLines(ui, view, actions, summary, columns, !cost.effortOnly, cost.billing),
      ui.text(' '),
    );
    out.push(
      ...(view.usageCompare
        ? [
            ui.line(
              ui.head('WHAT IF'),
              ui.dim(' · the same tokens on one model   '),
              ui.Button({ key: 'usage-compare', label: 'Trend', hotkey: 'c', onPress: actions.usageCompare }),
            ),
            ...compareLines(ui, summary, cost.billing),
          ]
        : trendLines(ui, view, actions, summary, period, now, cost.billing)),
      ...insightLines(ui, summary, actions, columns),
    );
  }
  out.push(
    ui.text(' '),
    ...subagentUsage(ui, config, view, actions, period, now, columns, cost.billing),
    ui.text(' '),
    ...footer(ui, columns),
  );
  out.push(ui.text(' '), deleteLine(ui, view, actions));
  return out;
}

// Why a period has no cost to show.
function emptyCost(ui, config, view, period) {
  if (period === 'session' && !modelSpec(config, view.nativeModel))
    return [ui.dim(`${modelName(view.nativeModel)} has no list price in router.json models.`)];
  const off = period === 'session' && (view.phase === 'unavailable' || view.mode === 'manual');
  return [
    ui.dim(
      off
        ? `Routing is ${view.phase === 'unavailable' ? 'unavailable' : 'off'}: replies use your model and are not counted.`
        : `No routed replies ${PERIOD_PHRASE[period]}.`,
    ),
  ];
}

// The answer first: the difference against no routing, or why there is none.
function costHeadline(ui, cost) {
  if (cost.diffUsd !== null)
    return ui.line(
      ui.text(diffText(cost.diffUsd, cost.baseUsd), { bold: true, color: savingsColor(cost.diffUsd) }),
      ` vs ${UNROUTED}`,
      cost.early ? ui.text(`   ${repliesText(cost)}: ${EARLY_NOTE}`, { color: 'yellow' }) : null,
    );
  return ui.dim(
    cost.effortOnly
      ? 'Effort routing on one model: no saving is estimated; cost uses configured API rates.'
      : `${uncomparedText(cost).replace(/^./, (c) => c.toUpperCase())}: no saving is shown.`,
  );
}

// The period's cost as one table that adds up: the main thread with the parts of its difference, the subagents and the
// total. "No routing" is your model on the main thread and Claude Code's pick for each subagent; zero rows are left out.
function costTable(ui, config, view, period, cost, legacy, actions, columns) {
  if (!cost.replies && !cost.agents) return emptyCost(ui, config, view, period);
  const compared = cost.diffUsd !== null;
  const r = cost.readout;
  // All products use configured-rate estimates, including the credits subtotal.
  const row = (label, amount, diff, base, style = {}, billing = cost.billing) =>
    ui.line(
      ui.cell(COST_LABEL, ui.text(label, style)),
      ui.text(amount === null ? ''.padStart(COST_AMOUNT) : costText(amount, billing).padStart(COST_AMOUNT), style),
      compared
        ? diff === null
          ? ui.text(''.padStart(COST_DIFF))
          : ui.text(signedUsd(diff).padStart(COST_DIFF), {
              ...style,
              ...(savingsColor(diff) ? { color: savingsColor(diff) } : {}),
            })
        : null,
      compared && base !== null ? ui.dim(costText(base, billing).padStart(COST_BASE)) : null,
    );
  const part = (label, value, note = null) =>
    value
      ? ui.line(
          ui.cell(COST_LABEL, ui.dim(`  ${label}`)),
          ''.padStart(COST_AMOUNT),
          ui.text(signedUsd(value).padStart(COST_DIFF), savingsColor(value) ? { color: savingsColor(value) } : {}),
          note ? ui.dim(`   ${note}`) : null,
        )
      : null;
  // The rebuilds' share of what the cheaper models saved; past all of it the switches lost money, which lostLine says.
  const share = r.switchUsd > 0 && -r.cheaperUsd > 0 ? r.switchUsd / -r.cheaperUsd : null;
  const switches = share !== null && share <= 1 ? `${percent(share)} of the saving` : null;
  const total =
    period === 'session'
      ? 'session'
      : { today: 'today', '7d': '7 days', '30d': '30 days', month: 'month', all: 'all' }[period];
  const out = [
    costHeadline(ui, cost),
    ui.text(' '),
    ui.line(
      ui.cell(COST_LABEL, ''),
      ui.dim('cost'.padStart(COST_AMOUNT)),
      compared ? ui.dim(`vs ${UNROUTED}`.padStart(COST_DIFF)) : null,
      compared ? ui.dim(UNROUTED.padStart(COST_BASE)) : null,
    ),
    row(
      `main · ${plural(cost.replies, 'reply', 'replies')}`,
      cost.mainUsd,
      cost.mainDiff,
      compared ? r.yoursUsd : null,
    ),
    compared ? part('cheaper models', r.cheaperUsd) : null,
    compared ? part('stronger models', r.strongerUsd) : null,
    compared ? part('cache rebuilds', r.switchUsd, switches) : null,
    cost.agents
      ? row(
          `agents · ${cost.agents}`,
          cost.agentUsd,
          compared ? cost.agentDiff : null,
          compared ? cost.agentBaseUsd : null,
        )
      : null,
    ui.dim('─'.repeat(COST_LABEL + COST_AMOUNT + (compared ? COST_DIFF + COST_BASE : 0))),
    row(`${total} · ${API_ESTIMATE}`, cost.totalUsd, cost.diffUsd, cost.baseUsd, { bold: true }),
    cost.billing === 'mixed' ? row('  credits estimate', cost.creditsUsd, null, null, {}, 'billed') : null,
  ].filter(Boolean);
  if (legacy?.replies)
    out.push(
      ...dimLines(
        ui,
        `includes ${usd(legacy.routedUsd)} routed before dated records, kept without a breakdown`,
        columns,
      ),
    );
  if (compared && !r.early && switchesLost(r)) out.push(lostLine(ui, () => actions.tab('policy')));
  return out;
}
// The cost table's columns: label, cost, difference, no routing.
const COST_LABEL = 26;
const COST_AMOUNT = 8;
const COST_DIFF = 15;
const COST_BASE = 12;

function helpLines(ui) {
  return [
    ui.head('ABOUT THESE NUMBERS'),
    ui.dim('≈$ is tokens × configured API rates in router.json (list/custom).'),
    ui.dim('These are estimates, not invoices or measured plan-quota savings.'),
    ui.dim('No routing: your model on the main thread, Claude Code’s pick per agent,'),
    ui.dim('same tokens and output length. Answer quality is not measured.'),
    ui.dim('For the whole session cost, with side calls such as titles and compaction'),
    ui.dim('that the router does not see, run /cost.'),
    ui.dim('Plan bars are Claude Code’s 5-hour and 7-day readings. Tiers show as'),
    ui.dim('bars ▂▄▆█, low to high; a route never moves past 80% of its window.'),
    ui.text(' '),
  ];
}
