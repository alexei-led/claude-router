import {
  ACTIVITIES,
  activeClassifier,
  CLASSIFIER_OPTIONS,
  endpointSettings,
  resolveRoute,
  routeSpec,
  sameRoute,
} from './config.mjs';
import { cellForModel, isSameModel } from './route.mjs';

// Cost order, cheapest first, so the colors read as a scale. Hex values: every surface draws them.
export const TIER_COLOR = { micro: '#5fd7af', low: '#5f9fe0', medium: '#d7af5f', high: '#e0708a' };

// Why routing starts off: the session's model is no tier's model. Set at session start, read by the band.
export const NOT_A_TIER_REASON = 'not a routing tier';

export function modelName(id) {
  if (!id) return 'no response yet';
  return id
    .replace(/^claude-/, '')
    .replace(/-([0-9])-([0-9])(-\d{8})?$/, ' $1.$2')
    .replace(/^./, (c) => c.toUpperCase());
}

// "Opus 5.5 · high"; a model with no effort reading shows its name alone.
export const routeLabel = (model, effort) =>
  `${modelName(model)}${effort === null || effort === undefined ? '' : ` · ${effort}`}`;

// A configured route by its model's name; a null effort is the session's, and a model without efforts shows none.
export function routeName(config, route) {
  const model = config.models[route.model];
  return `${modelName(model.id)}${model.efforts.length ? ` · ${route.effort ?? 'session'}` : ''}`;
}

// One letter per activity for the REPLIES strip: `docs` is `w` (writing), since `debug` has `d`.
export const ACTIVITY_LETTER = { code: 'c', debug: 'd', explore: 'e', plan: 'p', review: 'r', ops: 'o', docs: 'w' };

// Changes of tier between consecutive replies; a reply routing did not choose breaks no run.
export const switchCount = (tiers) => tiers.slice(1).filter((tier, i) => tier && tiers[i] && tier !== tiers[i]).length;

export const percent = (value) => `${Math.round(value * 100)}%`;

export const REASONS = {
  ready: 'ready for the next turn',
  'same-tier': 'the task fits the current tier',
  'no-advice': 'keeping the current model without classifier advice',
  continuation: 'continuing the previous task',
  uncertain: 'the classifier could not justify a change',
  upgrade: 'enough support for a stronger model',
  jump: 'clear need for a stronger model',
  downgrade: 'enough support for a cheaper model',
  'upgrade-pending': 'waiting before upgrading',
  'downgrade-pending': 'switching is not justified yet',
  hold: 'staying after an escalation',
  escalation: 'repeated tool failures need a stronger model',
  'cash-gate': 'estimated cold cache write exceeds the cap',
  'context-fit': 'a larger context window is needed',
  'context-unknown': 'context is not measured reliably',
  'model-unavailable': 'the requested model is not available',
  pinned: 'one-turn model pin',
  'activity-up': 'the activity needs a stronger route',
  'activity-down': 'a cheaper route fits the activity and pays back its cache',
  'activity-pending': 'a route for the activity does not pay back yet',
};

// The active decision model behind the router. Named in the UI only where it explains a reading or a failure.
export const classifierLabel = (config) => activeClassifier(config).label;
// The credentials error of classifier `id` from the view, or null when its key and endpoint settings are all there.
// Not yet read counts as a missing key, unless the classifier takes no key.
export const missingCredentials = (config, view, id) => {
  if (view.credentials && Object.hasOwn(view.credentials, id)) return view.credentials[id];
  return config.classifiers[id].keyOption === null ? null : 'missing-key';
};
// What classifier `id` lacks, named by the setting the person enters: "no API token", "no account ID".
export function missingText(config, id, missing) {
  const entry = config.classifiers[id];
  const option = missing === 'missing-key' ? entry.keyOption : endpointSettings(entry.endpoint)[0];
  return `no ${CLASSIFIER_OPTIONS[option] ?? 'setting'}`;
}

// Every setting the configured classifiers read, grouped by classifier: "Jev: API key · Clef, Clef Flash: API token,
// account ID · Ollama: no key needed".
export function credentialsNeeded(config) {
  // Grouped by option name, not by its words: Jev's "API key" and OpenAI's "API key" are different settings.
  const groups = new Map();
  for (const entry of Object.values(config.classifiers)) {
    const options = [entry.keyOption, ...endpointSettings(entry.endpoint)].filter((option) => option !== null);
    const key = options.join(', ');
    const group = groups.get(key) ?? {
      needs: options.map((option) => CLASSIFIER_OPTIONS[option]).join(', ') || 'no key needed',
      labels: [],
    };
    group.labels.push(entry.label);
    groups.set(key, group);
  }
  return [...groups.values()].map(({ needs, labels }) => `${labels.join(', ')}: ${needs}`).join(' · ');
}

// The active classifier with what went wrong: "Jev: no API key", "Clef timed out". Short: the band keeps it whole.
export function classifierStatus(config, error) {
  const label = activeClassifier(config).label;
  return error === 'missing-key' || error === 'missing-account'
    ? `${label}: ${missingText(config, config.classifier, error)}`
    : `${label} ${CLASSIFIER_ERRORS[error]?.text ?? error}`;
}

// Every classifier error: its words after the label (missing credentials name the setting instead), whether the band
// warns (busy and cancelled are routine and pass silently), and whether the wait counts as a timed reading (a request
// that was never sent does not).
const CLASSIFIER_ERRORS = {
  'missing-key': { text: null, warn: true, timed: false },
  'missing-account': { text: null, warn: true, timed: false },
  paused: { text: 'paused after failures', warn: true, timed: false },
  busy: { text: 'busy', warn: false, timed: false },
  timeout: { text: 'timed out', warn: true, timed: true },
  auth: { text: 'rejected the key', warn: true, timed: true },
  http: { text: 'request failed', warn: true, timed: true },
  unreachable: { text: 'unreachable', warn: true, timed: true },
  policy: { text: 'blocked by network policy', warn: true, timed: true },
  malformed: { text: 'sent a bad answer', warn: true, timed: true },
  cancelled: { text: 'cancelled', warn: false, timed: true },
};
export const classifierWarns = (error) => CLASSIFIER_ERRORS[error]?.warn === true;
// No error, or one outside the table, times the wait.
export const classifierTimed = (error) => CLASSIFIER_ERRORS[error]?.timed !== false;
// One or two words for the band; REASONS holds the sentence the pane shows.
export const SHORT_REASONS = {
  ready: 'ready',
  'same-tier': '= fits',
  'no-advice': '= no advice',
  continuation: '→ continuing',
  uncertain: '= uncertain',
  upgrade: '↑ upgrade',
  jump: '↑ jump',
  downgrade: '↓ downgrade',
  'upgrade-pending': '… waiting to go up',
  'downgrade-pending': '… waiting to go down',
  hold: '= holding',
  escalation: '↑ tool errors',
  'cash-gate': '= cash cap',
  'context-fit': '↑ context',
  'context-unknown': '= context unknown',
  'model-unavailable': '! model unavailable',
  'native-fallback': '! fallback',
  pinned: '⏵ pinned',
  interrupted: 'interrupted',
  'activity-up': '↗ {activity}',
  'activity-down': '↘ {activity}',
  'activity-pending': '… {activity}: not worth a switch',
};

// The band's words for `reason`; an activity move names the activity it is about, `base` for the tier's own route.
export const shortReason = (reason, activity) =>
  (SHORT_REASONS[reason] ?? reason ?? '').replace('{activity}', activity ?? 'base');

// The activity a reason is about: the applied one for a move, and for a refused move the classifier's activity when
// it carries enough mass to apply, else null (the tier's base route).
export function reasonActivity(config, view) {
  if (view.reason !== 'activity-pending') return view.activity ?? null;
  const choice = view.activityChoice;
  const mass = view.activityProbabilities?.[choice];
  return ACTIVITIES.includes(choice) && mass >= config.policy.activityMass ? choice : null;
}

// The classifier's activity answer: its choice with the share it got and the two runners-up, or null when there is
// none.
export function activityReading(view) {
  const choice = view.activityChoice ?? view.activity ?? null;
  if (!choice) return null;
  const probabilities = Object.entries(view.activityProbabilities ?? {}).filter(([, p]) => Number.isFinite(p));
  const share = probabilities.find(([name]) => name === choice)?.[1];
  const others = probabilities
    .filter(([name, p]) => name !== choice && p > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([name, p]) => `${name} ${percent(p)}`);
  return { choice, share: Number.isFinite(share) ? percent(share) : null, others };
}

// The route the turn's cell resolves to, against the tier's base route: `on` names the override, `shadow` what `on`
// would run beside the route in use. Null in `off`, or before a turn has a tier.
export function activityRouteText(config, view) {
  const mode = config.activityRouting;
  if (mode === 'shadow') {
    const would = view.wouldRoute;
    if (!would?.tier) return null;
    const current = view.selectedModel ?? view.nativeModel;
    const same = isSameModel(would.model, current) && (would.effort ?? null) === (view.effort ?? null);
    return (
      `${would.tier}${would.activity ? ` + ${would.activity}` : ''} would use ${routeLabel(would.model, would.effort)}` +
      ` (shadow; ${same ? 'same route' : `using ${routeLabel(current, view.effort)}`})`
    );
  }
  if (mode !== 'on' || !view.tier) return null;
  const cell = `${view.tier}${view.activity ? ` + ${view.activity}` : ''}`;
  const route = resolveRoute(config, view.tier, view.activity ?? null);
  const base = resolveRoute(config, view.tier);
  return sameRoute(route, base)
    ? `${cell} → ${routeName(config, route)} (base)`
    : `${cell} → ${routeName(config, route)}   (override)   base: ${routeName(config, base)}`;
}

// The activity lines of /router without a UI surface: "Activity: ops (81%)" and the resolved route. None in `off`.
export function activityDetailLines(config, view) {
  if (config.activityRouting === 'off') return [];
  const reading = activityReading(view);
  const route = activityRouteText(config, view);
  return [
    `Activity: ${reading ? `${reading.choice}${reading.share ? ` (${reading.share})` : ''}` : 'none yet'}`,
    ...(route ? [`Route: ${route}`] : []),
  ];
}

export const GATEWAY_SETTINGS = 'v0.8 gateway settings remain · see /router';
export const GATEWAY_CLEANUP = [
  'Remove from settings.json, then restart: model jev-router[1m], its modelPicker row,',
  'env.ANTHROPIC_BASE_URL for 127.0.0.1:43170, env.CLAUDE_CODE_GATEWAY_HINT_HEADERS,',
  'and a statusLine that runs the router scripts/statusline.mjs.',
];

export function formatTokens(value) {
  if (!Number.isFinite(value)) return 'unknown';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}K`;
  return String(Math.round(value));
}

export function bar(value, maximum, width = 16) {
  if (!Number.isFinite(value) || !(maximum > 0)) return { text: 'unknown', percent: null, color: 'gray' };
  const fraction = Math.max(0, value / maximum);
  const filled = Math.min(width, Math.round(fraction * width));
  return {
    text: `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`,
    percent: Math.round(fraction * 100),
    color: fraction > 0.8 ? 'red' : fraction > 0.6 ? 'yellow' : 'green',
  };
}

export function usageMetrics(config, view, usage) {
  const model = view.actualModel ?? view.selectedModel ?? view.nativeModel;
  const cell = cellForModel(config, model);
  const spec = cell ? routeSpec(config, resolveRoute(config, cell.tier, cell.activity)) : null;
  const window = spec?.contextWindow ?? null;
  const observed = Number.isFinite(usage?.context?.tokens) ? usage.context.tokens : null;
  const candidates = [view.contextTokens, observed === null ? null : observed + (view.outputTokens ?? 0)].filter(
    (value) => Number.isFinite(value),
  );
  const nextContext = candidates.length ? Math.max(...candidates) : null;
  const reuse = view.inputTokens > 0 && Number.isFinite(view.cacheRead) ? view.cacheRead / view.inputTokens : null;
  const cost = Number.isFinite(usage?.cost?.usd) ? usage.cost.usd : null;
  const cacheBenefit =
    spec && Number.isFinite(view.cacheRead) ? ((spec.input - spec.cacheRead) * view.cacheRead) / 1e6 : null;
  return {
    window,
    observed,
    nextContext,
    reuse,
    cost,
    cacheBenefit,
    contextBar: bar(nextContext, window),
    cacheBar: {
      ...bar(reuse, 1),
      color: reuse === null ? 'gray' : reuse >= 0.6 ? 'green' : reuse >= 0.2 ? 'yellow' : 'gray',
    },
  };
}

// Scaled from the lowest to the highest reading: a long session's inputs sit close together, and a scale from zero
// draws them all as full blocks. Equal readings draw a flat middle line.
export function sparkline(values) {
  if (!values.length || !values.every(Number.isFinite)) return 'no history yet';
  const symbols = '▁▂▃▄▅▆▇█';
  const minimum = Math.min(...values);
  const span = Math.max(...values) - minimum;
  return values.map((value) => symbols[span > 0 ? Math.round(((value - minimum) / span) * 7) : 3]).join('');
}
