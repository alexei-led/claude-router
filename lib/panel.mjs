import { compareRoutes } from './activity.mjs';
import {
  ACTIVITIES,
  ACTIVITY_MODES,
  activeClassifier,
  DEFAULTS,
  effectiveActivities,
  effectiveRoutes,
  resolveRoute,
  sameCell,
  sameRoute,
  TIERS,
  tuningOf,
} from './config.mjs';
import {
  ACTIVITY_LETTER,
  activityReading,
  activityRouteText,
  bar,
  classifierLabel,
  classifierStatus,
  credentialsNeeded,
  formatTokens,
  GATEWAY_CLEANUP,
  GATEWAY_SETTINGS,
  missingCredentials,
  missingText,
  modelName,
  percent,
  REASONS,
  routeLabel,
  routeName,
  sparkline,
  switchCount,
  TIER_COLOR,
  usageMetrics,
} from './display.mjs';
import { isSameModel } from './route.mjs';

const TABS = [
  ['now', '1', 'Now'],
  ['routing', '2', 'Routing'],
  ['classifier', '3', 'Classifier'],
  ['usage', '4', 'Usage'],
];
const TUNING_CHOICES = {
  timeoutMs: [500, 1000, 1500, 3000, 5000],
  downgradeVotes: [1, 2, 3],
  horizon: [1, 3, 5, 10],
  cashCapUsd: [0.5, 1, 2, 5],
};
const LADDER = [...TIERS].reverse();
const SESSION_EFFORT = 'session';

const ACTIVITY_MODE_HINT = {
  off: 'asks nothing new; tier routes only',
  shadow: 'asks and shows what on would do; tier routes run',
  on: 'activity overrides run',
};
const EFFORT_SHORT = { low: 'low', medium: 'med', high: 'high', xhigh: 'xh', max: 'max' };

// The route draft the Routing tab edits: the saved routes, activity overrides and mode until the person changes one.
export function routeDraftOf(config, view) {
  if (view.routeDraft) return view.routeDraft;
  const base = structuredClone({
    routes: config.routes,
    baselineTier: config.baselineTier,
    activities: config.activities,
    activityRouting: config.activityRouting,
  });
  return { ...structuredClone(base), base };
}

const dollars = (value) => (Number.isFinite(value) ? `$${value.toFixed(3)}` : 'not reported');
const difference = (value) => `${value < 0 ? '−' : '+'}$${Math.abs(value).toFixed(3)}`;
const hostOf = (endpoint) => endpoint.replace(/^https?:\/\//, '').split('/')[0];
const windowSize = (tokens) => (tokens >= 1e6 ? `${tokens / 1e6}M` : `${Math.round(tokens / 1e3)}K`);
const contextSuffix = (metrics) =>
  Number.isFinite(metrics.nextContext)
    ? `~${formatTokens(metrics.nextContext)} / ${formatTokens(metrics.window)}`
    : 'no reading yet';

function kit({ Box, Text, Button, Select }) {
  const text = (children, style = {}) => Text({ ...style, children });
  return {
    Box,
    Button,
    Select,
    text,
    dim: (children) => text(children, { dimColor: true }),
    head: (children) => text(children, { bold: true, color: 'cyan' }),
    tier: (tier, children = tier) => text(children, { bold: true, color: TIER_COLOR[tier] }),
    // One row of mixed parts; strings become plain Text, nulls are dropped.
    line: (...parts) =>
      Box({
        children: parts
          .filter((part) => part !== null && part !== '')
          .map((p) => (typeof p === 'string' ? text(p) : p)),
      }),
    // A fixed-width column, so controls of different widths still line up.
    cell: (width, part) => Box({ width, children: [typeof part === 'string' ? text(part) : part] }),
    gauge: (name, value, suffix) =>
      text(`${name}${value.text}${value.percent === null ? '' : ` ${String(value.percent).padStart(3)}%`}  ${suffix}`, {
        color: value.color,
      }),
  };
}

export function renderPanel(
  elements,
  config,
  view,
  usage,
  actions,
  { modelOptions = Object.keys(config.models) } = {},
) {
  const ui = kit(elements);
  const tab = TABS.some(([id]) => id === view.tab) ? view.tab : 'now';
  const body = { now: nowTab, routing: routingTab, classifier: classifierTab, usage: usageTab }[tab];
  return ui.Box({
    flexDirection: 'column',
    children: [
      ...header(ui, config, view, tab, actions),
      ...body(ui, config, view, usage, actions, modelOptions),
      ...(view.help ? helpLines(ui) : []),
      ...statusBar(ui, config, view, actions),
      ui.Button({ key: 'close', label: 'Close', hotkey: 'q', role: 'dismiss', onPress: actions.close }),
    ],
  });
}

function header(ui, config, view, tab, actions) {
  const auto = view.mode === 'auto';
  const label = classifierLabel(config);
  const error = view.error ?? missingCredentials(config, view, config.classifier);
  const status =
    view.phase === 'unavailable'
      ? ui.text('Routing unavailable', { color: 'yellow' })
      : error
        ? ui.text(classifierStatus(config, error), { color: 'yellow' })
        : ui.text(`${label} ready${Number.isFinite(view.adviceMs) ? ` · ${view.adviceMs} ms` : ''}`, {
            color: 'green',
          });
  return [
    ui.line(ui.head(`ROUTING · ${auto ? 'on' : 'off'}`), '   ', status),
    view.phase === 'unavailable' && view.error ? ui.text(view.error, { color: 'yellow' }) : null,
    ...(view.error === GATEWAY_SETTINGS ? GATEWAY_CLEANUP.map((line) => ui.text(line, { color: 'yellow' })) : []),
    ui.line(
      ui.Button({
        key: 'auto',
        label: 'Routing on',
        hotkey: 'o',
        variant: auto ? 'primary' : 'secondary',
        onPress: () => actions.mode('auto'),
      }),
      ' ',
      ui.Button({
        key: 'manual',
        label: 'Routing off',
        hotkey: 'f',
        variant: auto ? 'secondary' : 'primary',
        onPress: () => actions.mode('manual'),
      }),
      ui.dim('  Routing off keeps the /model choice'),
    ),
    ui.line(
      ...TABS.flatMap(([id, hotkey, label]) => [
        ui.Button({
          key: `tab-${id}`,
          label: id === 'routing' && routingChanges(config, view).count ? `${label} ●` : label,
          hotkey,
          variant: tab === id ? 'primary' : 'secondary',
          onPress: () => actions.tab(id),
        }),
        ' ',
      ]),
      ui.Button({ key: 'help', label: '?', variant: view.help ? 'primary' : 'secondary', onPress: actions.help }),
    ),
    ui.text(' '),
  ];
}

function nowTab(ui, config, view, usage, actions) {
  const metrics = usageMetrics(config, view, usage);
  const auto = view.mode === 'auto';
  const current = view.selectedModel ?? view.nativeModel;
  const label = classifierLabel(config);
  const missing = missingCredentials(config, view, config.classifier);
  const served = view.actualModel && current && !isSameModel(current, view.actualModel);
  const reading = config.activityRouting === 'off' ? null : activityReading(view);
  const route = activityRouteText(config, view);
  const out = [
    ui.line('Now       ', view.tier ? ui.tier(view.tier, `▌${view.tier}  `) : null, routeLabel(current, view.effort)),
    reading
      ? ui.line(
          'Activity  ',
          `${reading.choice}${reading.share ? ` ${reading.share}` : ''}`,
          reading.others.length ? ui.dim(`   ${reading.others.join(' · ')}`) : null,
        )
      : null,
    ui.line('Why       ', REASONS[view.reason] ?? view.reason ?? 'ready'),
    route ? ui.line('Route     ', route) : null,
    served
      ? ui.line(ui.text('Served    ', { color: 'yellow' }), `${modelName(view.actualModel)} · native fallback`)
      : null,
    view.pendingPin
      ? ui.line(
          ui.text('Pinned    ', { color: 'yellow' }),
          'next turn → ',
          ui.tier(view.pendingPin),
          '  ',
          ui.Button({ key: 'unpin', label: 'unpin', onPress: actions.unpin }),
        )
      : null,
    missing
      ? ui.line(
          ui.text(`${classifierStatus(config, missing)}, keeping the model  `, { color: 'yellow' }),
          ui.Button({ key: 'key', label: 'Set up', hotkey: 'k', onPress: actions.key }),
        )
      : null,
    ui.text(' '),
    ui.head('TIERS · next turn'),
    ui.dim(`  ${'tier'.padEnd(8)}${'route'.padEnd(22)}${label} support`),
  ];
  for (const tier of LADDER) {
    const support = view.probabilities?.[tier];
    const meter = Number.isFinite(support) ? bar(support, 1, 10) : null;
    out.push(
      ui.line(
        view.tier === tier ? ui.tier(tier, '▶ ') : '  ',
        ui.tier(tier, tier.padEnd(8)),
        routeName(config, config.routes[tier]).padEnd(22),
        meter ? ui.text(meter.text, { color: TIER_COLOR[tier] }) : ui.dim('—'.padEnd(10)),
        meter ? ` ${percent(support).padStart(4)}  ` : '       ',
        auto ? ui.Button({ key: `pin-${tier}`, label: 'pin', onPress: () => actions.pin(tier) }) : null,
      ),
    );
  }
  const estimate = view.estimate;
  if (Number.isFinite(estimate?.threshold)) {
    const [direction, mass] = Number.isFinite(estimate.upgradeMass)
      ? ['up', estimate.upgradeMass]
      : ['down', estimate.downgradeMass];
    out.push(
      ui.dim(
        `  switch needs ${percent(estimate.threshold)} · ${label} gave ${Number.isFinite(mass) ? percent(mass) : '—'} ${direction}` +
          `${Number.isFinite(estimate.taxUsd) ? ` · tax ≈ $${estimate.taxUsd.toFixed(2)}` : ''}`,
      ),
    );
  }
  out.push(
    ui.dim(auto ? '  Pins serve the next turn only.' : '  Pins need routing on. Routing off keeps the /model choice.'),
  );
  out.push(ui.text(' '), ...replies(ui, view));
  out.push(
    ui.text(' '),
    ui.gauge('Context  ', metrics.contextBar, contextSuffix(metrics)),
    ui.gauge(
      'Cache    ',
      metrics.cacheBar,
      metrics.cacheBar.percent === null ? 'no reply yet' : 'reused on the last reply',
    ),
    ui.line(
      `Cost     ${dollars(metrics.cost)} `,
      ui.dim('by Claude'),
      Number.isFinite(metrics.cacheBenefit) ? ` · cache saved ≈ $${metrics.cacheBenefit.toFixed(2)}` : '',
    ),
  );
  return out;
}

// One cell per reply, colored by the tier that served it; a dot where routing did not choose (routing off, fallback).
// Under it, the reply's activity letter, aligned from the end: a view from before 1.6 has fewer activities.
function replies(ui, view) {
  const tiers = view.tiers ?? [];
  if (!tiers.length) return [ui.head('REPLIES'), ui.dim('  no replies yet')];
  const switches = switchCount(tiers);
  const activities = view.activities ?? [];
  const letters = tiers.map((_, i) => activities[activities.length - tiers.length + i] ?? null);
  return [
    ui.head(`REPLIES · last ${tiers.length}`),
    ui.line(
      '  ',
      ...tiers.map((tier) => (tier ? ui.tier(tier, '█') : ui.dim('·'))),
      ui.dim(`  ${switches} switch${switches === 1 ? '' : 'es'}`),
    ),
    ...(letters.some(Boolean)
      ? [ui.line('  ', ...letters.map((activity) => (activity ? ui.text(ACTIVITY_LETTER[activity]) : ui.dim('·'))))]
      : []),
    ui.line('  ', ...TIERS.flatMap((tier) => [ui.tier(tier, '■ '), `${tier}  `])),
    ...(letters.some(Boolean)
      ? [ui.dim(`  ${ACTIVITIES.map((activity) => `${ACTIVITY_LETTER[activity]} ${activity}`).join('  ')}`)]
      : []),
  ];
}

// Rows: [key, label, format, hint, router.json field]. Typed as tuples so tsc keeps each position's type.
/** @type {[string, string, (value: number) => string, string, string][]} */
const POLICY_ROWS = [
  ['downgradeVotes', 'Votes to go down', String, 'agreeing turns before cheaper', 'policy.downgradeVotes'],
  ['horizon', 'Payback horizon', (v) => `${v} turns`, 'a switch repays its cache', 'policy.downgradeHorizonTurns'],
  ['cashCapUsd', 'Credits cap', (v) => `$${v.toFixed(2)}`, 'max cold write on credits', 'policy.cashCapUsd'],
];

// What the Routing tab changed and has not saved: tiers, baseline, activity cells and mode against the saved config,
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

const marker = (ui, changed) => ui.cell(2, changed ? ui.text('●', { color: 'yellow' }) : '');

// Routes and policy are edited as one set: the switch-cost lines read the whole ladder, so nothing here is written
// until Save in the status bar.
function routingTab(ui, config, view, _usage, actions, modelOptions) {
  const changes = routingChanges(config, view);
  const { draft, tuning, tiers, baseline, policy } = changes;
  const out = [
    ui.line(ui.head('ROUTES'), ui.dim(' · applies next turn · edit, then Save')),
    ui.dim(`${'tier'.padEnd(8)}${'model'.padEnd(14)}${'effort'.padEnd(14)}${'$/M in · out'.padEnd(14)}window`),
  ];
  for (const tier of LADDER) {
    const route = draft.routes[tier];
    const model = config.models[route.model];
    const aliases = modelOptions.includes(route.model) ? modelOptions : [route.model, ...modelOptions];
    out.push(
      ui.line(
        ui.cell(8, ui.tier(tier)),
        ui.cell(
          14,
          ui.Select
            ? ui.Select({
                key: `route-model-${tier}`,
                value: route.model,
                options: aliases.map((alias) => ({ value: alias, label: modelName(config.models[alias].id) })),
                onSelect: (alias) => actions.routeModel(tier, alias),
              })
            : modelName(model.id),
        ),
        ui.cell(
          12,
          !model.efforts.length
            ? ui.dim('none')
            : ui.Select
              ? ui.Select({
                  key: `route-effort-${tier}`,
                  value: route.effort ?? SESSION_EFFORT,
                  options: [SESSION_EFFORT, ...model.efforts].map((effort) => ({ value: effort, label: effort })),
                  onSelect: (effort) => actions.routeEffort(tier, effort === SESSION_EFFORT ? null : effort),
                })
              : (route.effort ?? SESSION_EFFORT),
        ),
        marker(ui, tiers.includes(tier)),
        ui.cell(14, `${model.input} · ${model.output ?? '?'}`),
        windowSize(model.contextWindow),
      ),
    );
  }
  out.push(
    ui.line(
      ui.cell(
        34,
        ui.Select
          ? ui.Select({
              key: 'baseline',
              label: 'Baseline tier',
              value: draft.baselineTier,
              options: TIERS.map((tier) => ({ value: tier, label: tier })),
              onSelect: (tier) => actions.baseline(tier),
            })
          : `Baseline tier: ${draft.baselineTier}`,
      ),
      marker(ui, baseline),
      ui.dim('start here, fall back here'),
    ),
    ui.text(' '),
    ui.head('SWITCH COST · from these routes'),
    ...switchCost(ui, draft.routes),
    ui.Button({ key: 'reset-routes', label: 'Reset routes to defaults', hotkey: 'r', onPress: actions.resetRoutes }),
    ui.dim('A new model ID needs router.json → models: price, window, efforts.'),
    ui.text(' '),
    ...activitySections(ui, config, changes, actions, modelOptions),
    ui.text(' '),
    ui.line(ui.head('POLICY'), ui.dim(' · applies next turn · edit, then Save')),
    ...POLICY_ROWS.map(([key, label, format, hint]) =>
      ui.line(
        ui.cell(20, label),
        ui.cell(
          12,
          choice(ui, key, tuning[key], format, (value) => actions.tune(key, value)),
        ),
        marker(ui, policy.includes(key)),
        ui.dim(hint),
      ),
    ),
    ui.Button({ key: 'reset-policy', label: 'Reset policy to defaults', onPress: actions.resetPolicy }),
    ui.text(' '),
    ui.head('CONFIG'),
    ui.line(
      `File     ${view.configPath ?? 'profile router.json'}  `,
      view.configPath ? ui.Button({ key: 'copy-path', label: 'copy', onPress: actions.copyPath }) : null,
    ),
    ui.dim('Main conversation only. Subagents keep their own model.'),
  );
  return out;
}

function switchCost(ui, routes) {
  return LADDER.slice(0, -1).map((upperTier, i) => {
    const upper = routes[upperTier];
    const lower = routes[LADDER[i + 1]];
    const pair = `${LADDER[i + 1]} → ${upperTier}`.padEnd(16);
    if (sameRoute(upper, lower))
      return ui.line(ui.text('! ', { color: 'yellow' }), pair, 'identical: this step changes nothing');
    if (upper.model === lower.model)
      return ui.line(ui.dim('· '), pair, 'same model, new effort: priced as a new cache');
    return ui.line(ui.dim('· '), pair, 'model change: priced as a cold cache write');
  });
}

// "S·med": the model's initial and a short effort, for the matrix.
function shortRoute(config, route) {
  const model = config.models[route.model];
  const effort = model.efforts.length ? `·${EFFORT_SHORT[route.effort] ?? 'ses'}` : '';
  return `${modelName(model.id)[0]}${effort}`;
}
const routeKey = (route) => `${route.model}@${route.effort ?? ''}`;

// Why an override may be a mistake: no effect, a route above the next tier's, or a pair no other cell runs.
function overrideWarnings(config, uses, activity, tier) {
  const route = resolveRoute(config, tier, activity);
  if (sameRoute(route, config.routes[tier])) return ['same as base: no effect'];
  const above = config.routes[TIERS[TIERS.indexOf(tier) + 1]];
  return [
    above && compareRoutes(config, route, above) > 0 ? 'stronger than the tier above' : null,
    uses.get(routeKey(route)) === 1 ? 'new (model, effort) pair: one more cache' : null,
  ].filter(Boolean);
}

// ACTIVITIES, the effective matrix of the draft, and OVERRIDES, its editable cells. Both join the routing draft.
function activitySections(ui, config, changes, actions, modelOptions) {
  const draft = { ...config, ...changes.draft };
  const mode = draft.activityRouting;
  const cellRoutes = ACTIVITIES.flatMap((activity) => TIERS.map((tier) => resolveRoute(draft, tier, activity)));
  const uses = new Map();
  for (const route of [...TIERS.map((tier) => draft.routes[tier]), ...cellRoutes])
    uses.set(routeKey(route), (uses.get(routeKey(route)) ?? 0) + 1);
  // Activities with the same row share it, so the matrix stays as short as the overrides are few.
  const rows = new Map();
  for (const activity of ACTIVITIES) {
    const cells = TIERS.map((tier) => {
      const route = resolveRoute(draft, tier, activity);
      return sameRoute(route, draft.routes[tier]) ? '·' : shortRoute(draft, route);
    });
    const row = rows.get(cells.join()) ?? { names: [], cells };
    rows.set(cells.join(), { ...row, names: [...row.names, activity] });
  }
  const distinct = uses.size;
  const matrixRow = (name, cells) => ui.text(`  ${name.padEnd(30)}${cells.map((c) => c.padEnd(9)).join('')}`);
  const out = [
    ui.line(ui.cell(32, ui.head(`ACTIVITIES · routing ${mode}`)), ui.dim(TIERS.map((t) => t.padEnd(9)).join(''))),
    matrixRow(
      'base',
      TIERS.map((tier) => shortRoute(draft, draft.routes[tier])),
    ),
    ...[...rows.values()].map(({ names, cells }) => matrixRow(names.join(' '), cells)),
    ui.dim(
      `  ${distinct} distinct route${distinct === 1 ? '' : 's'} = ${distinct} cache${distinct === 1 ? '' : 's'}` +
        `${mode === 'on' ? '' : ' once activity routing is on'}`,
    ),
    ui.text(' '),
    ui.line(ui.head('OVERRIDES'), ui.dim(' · applies next turn · edit, then Save')),
    ui.line(
      ui.cell(
        26,
        ui.Select
          ? ui.Select({
              key: 'activity-mode',
              label: 'Activity routing',
              value: mode,
              options: ACTIVITY_MODES.map((m) => ({ value: m, label: m })),
              onSelect: (m) => actions.activityMode(m),
            })
          : `Activity routing: ${mode}`,
      ),
      marker(ui, changes.mode),
      ui.dim(ACTIVITY_MODE_HINT[mode]),
    ),
  ];
  const free = [];
  for (const activity of ACTIVITIES) {
    for (const tier of TIERS) {
      const edited = changes.cells.some(([a, t]) => a === activity && t === tier);
      const route = resolveRoute(draft, tier, activity);
      // A built-in override set to the tier's route is how a removal is saved: it lists as free, not as no effect.
      const removed =
        sameRoute(route, draft.routes[tier]) && DEFAULTS.activities[activity]?.[tier] !== undefined && !edited;
      if (!draft.activities[activity]?.[tier] || removed) {
        free.push([activity, tier]);
        continue;
      }
      out.push(overrideRow(ui, draft, route, activity, tier, edited, actions, modelOptions, uses));
    }
  }
  if (ui.Select && free.length)
    out.push(
      ui.Select({
        key: 'activity-add',
        value: '',
        options: [
          { value: '', label: 'add an override…' },
          ...free.map(([activity, tier]) => ({ value: `${activity}.${tier}`, label: `${activity} at ${tier}` })),
        ],
        onSelect: (picked) => {
          const [activity, tier] = picked.split('.');
          return tier ? actions.addActivity(activity, tier) : undefined;
        },
      }),
    );
  return out;
}

function overrideRow(ui, draft, route, activity, tier, edited, actions, modelOptions, uses) {
  const model = draft.models[route.model];
  const aliases = modelOptions.includes(route.model) ? modelOptions : [route.model, ...modelOptions];
  const warnings = overrideWarnings(draft, uses, activity, tier);
  return ui.line(
    ui.cell(10, activity),
    ui.cell(8, ui.tier(tier)),
    ui.cell(
      14,
      ui.Select
        ? ui.Select({
            key: `activity-model-${activity}-${tier}`,
            value: route.model,
            options: aliases.map((alias) => ({ value: alias, label: modelName(draft.models[alias].id) })),
            onSelect: (alias) => actions.activityModel(activity, tier, alias),
          })
        : modelName(model.id),
    ),
    ui.cell(
      12,
      !model.efforts.length
        ? ui.dim('none')
        : ui.Select
          ? ui.Select({
              key: `activity-effort-${activity}-${tier}`,
              value: route.effort ?? SESSION_EFFORT,
              options: [SESSION_EFFORT, ...model.efforts].map((effort) => ({ value: effort, label: effort })),
              onSelect: (effort) => actions.activityEffort(activity, tier, effort === SESSION_EFFORT ? null : effort),
            })
          : (route.effort ?? SESSION_EFFORT),
    ),
    marker(ui, edited),
    ui.Button({
      key: `activity-remove-${activity}-${tier}`,
      label: 'remove',
      onPress: () => actions.removeActivity(activity, tier),
    }),
    warnings.length ? ui.text(`  ${warnings.join(' · ')}`, { color: 'yellow' }) : null,
  );
}

// A Select over TUNING_CHOICES[key], with a saved value outside them kept as the first option.
function choice(ui, key, value, format, pick) {
  if (!ui.Select) return format(value);
  const values = TUNING_CHOICES[key].includes(value) ? TUNING_CHOICES[key] : [value, ...TUNING_CHOICES[key]];
  return ui.Select({
    key,
    value: String(value),
    options: values.map((v) => ({ value: String(v), label: format(v) })),
    onSelect: (picked) => (TUNING_CHOICES[key].includes(Number(picked)) ? pick(Number(picked)) : undefined),
  });
}

// One row per configured classifier. A row press and the deadline are single values with nothing to review as a set,
// so each writes router.json at once; Undo in the status bar puts it back.
function classifierTab(ui, config, view, _usage, actions) {
  const active = activeClassifier(config);
  const health = view.health ?? { failures: 0, pausedUntil: 0 };
  const rows = Object.entries(config.classifiers).map(([id, entry]) => {
    const isActive = id === config.classifier;
    const missing = missingCredentials(config, view, id);
    return ui.line(
      ui.Button({
        key: `classifier-${id}`,
        label: `${isActive ? '◉' : '○'} ${entry.label.padEnd(11)}`,
        variant: isActive ? 'primary' : 'secondary',
        onPress: () => actions.classifier(id),
      }),
      ' ',
      ui.cell(20, ui.dim(hostOf(entry.endpoint))),
      missing
        ? ui.text(`○ ${missingText(config, id, missing)}  `, { color: 'yellow' })
        : ui.text('● ready', { color: 'green' }),
      missing
        ? ui.Button({ key: `key-${id}`, label: 'Set up', onPress: actions.key })
        : isActive && Number.isFinite(view.adviceMs)
          ? ui.dim(`  ${view.adviceMs} ms`)
          : null,
    );
  });
  return [
    ui.line(ui.head('CLASSIFIER'), ui.dim(' · applies next turn · saves at once')),
    ui.dim('Asked once per new turn.'),
    ...rows,
    ui.line(
      ui.cell(9, 'Deadline'),
      ui.cell(
        12,
        choice(ui, 'timeoutMs', active.timeoutMs, (v) => `${v} ms`, actions.classifierTimeout),
      ),
      ui.dim('then keep the model'),
    ),
    ui.text(
      `Health   ${health.pausedUntil > Date.now() ? `paused until ${new Date(health.pausedUntil).toLocaleTimeString()}` : 'active'} · ${health.failures} recent failure${health.failures === 1 ? '' : 's'}`,
    ),
    ui.dim(`Sends    prompt + ${config.context.recentTurns} recent turns → ${hostOf(active.endpoint)}`),
    ui.line(
      'Credentials  ',
      ui.Button({ key: 'key', label: 'Edit', hotkey: 'k', onPress: actions.key }),
      ui.dim('  opens /plugin configure'),
    ),
    ui.dim(`             ${credentialsNeeded(config)}`),
  ];
}

// Green for a write or its undo, red for a refused write, yellow for everything else that needs a look.
const noticeColor = (notice) =>
  /^Not saved/.test(notice) ? 'red' : /^(Saved|Undid|Path copied)/.test(notice) ? 'green' : 'yellow';

// The one place for commit state on every tab: the unsaved routing diff with Save and Discard, the last notice, and
// Undo for the last write to router.json.
function statusBar(ui, config, view, actions) {
  const changes = routingChanges(config, view);
  const out = [];
  if (changes.count) {
    const diff = (key, before, after) => [
      ui.text(`- ${key.padEnd(30)} ${before}`, { color: 'red' }),
      ui.text(`+ ${key.padEnd(30)} ${after}`, { color: 'green' }),
    ];
    out.push(ui.text(' '), ui.dim('router.json changes:'));
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
    for (const [key, , format, , field] of POLICY_ROWS.filter(([key]) => changes.policy.includes(key)))
      out.push(...diff(field, format(changes.saved[key]), format(changes.tuning[key])));
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

// Session counts by activity, the switches by cause, the tool agreement and the shadow readout. Counts only: what the
// would-route turns cost is not recorded, so no dollar figure is shown. Reset is always offered: the counts kept
// across sessions may exist before this session has any.
function activityUsage(ui, config, view, actions) {
  const stats = view.activityStats ?? null;
  const mode = config.activityRouting;
  const reset = ui.Button({
    key: 'reset-activity-stats',
    label: 'Reset activity stats',
    onPress: actions.resetActivityStats,
  });
  if (mode === 'off' && !stats)
    return [
      ui.head('ACTIVITY · routing off'),
      ui.dim('  Not asked. Set activity routing to shadow or on in the Routing tab.'),
      reset,
    ];
  const out = [ui.line(ui.head('ACTIVITY · this session'), ui.dim(`   routing ${mode}`))];
  const rows = Object.entries(stats?.byActivity ?? {}).filter(([, counts]) => counts?.turns > 0);
  if (!rows.length) out.push(ui.dim('  no activity readings yet'));
  else {
    const total = rows.reduce((sum, [, counts]) => sum + counts.turns, 0);
    out.push(
      ui.dim(`  ${''.padEnd(9)}${''.padEnd(10)}${'turns'.padStart(7)}${'requests'.padStart(10)}${'share'.padStart(7)}`),
    );
    for (const [name, counts] of rows.sort((a, b) => b[1].turns - a[1].turns)) {
      const share = counts.turns / total;
      out.push(
        ui.line(
          `  ${name.padEnd(9)}`,
          ui.text(bar(share, 1, 10).text, { color: 'cyan' }),
          `${String(counts.turns).padStart(7)}${String(counts.requests).padStart(10)}${percent(share).padStart(7)}`,
        ),
      );
    }
  }
  if (stats) {
    const { tier, activity } = stats.switches;
    out.push(ui.text(`Switches   ${tier + activity} · ${tier} by tier · ${activity} by activity`));
    const { matched, total } = stats.agreement;
    if (total > 0)
      out.push(ui.text(`Agreement  classifier vs tools: ${matched} of ${total} turns (${percent(matched / total)})`));
    if (mode === 'shadow' || stats.shadow.turns > 0)
      out.push(ui.text(`Shadow     on would route ${stats.shadow.differs} of ${stats.shadow.turns} turns differently`));
  }
  out.push(reset);
  return out;
}

function usageTab(ui, config, view, usage, actions) {
  const metrics = usageMetrics(config, view, usage);
  const history = view.history ?? [];
  const tiers = view.tiers ?? [];
  const glyphs = sparkline(history);
  const trend = history.length
    ? ui.line(
        '  ',
        ...[...glyphs].map((glyph, i) => {
          const tier = tiers[tiers.length - history.length + i];
          return tier ? ui.tier(tier, glyph) : ui.text(glyph);
        }),
        ui.dim(`  ${formatTokens(Math.min(...history))} … ${formatTokens(Math.max(...history))}`),
      )
    : ui.dim('  no replies yet');
  return [
    ui.head('USAGE · Claude readings'),
    ui.line(`Cost       ${dollars(metrics.cost)} `, ui.dim('reported by Claude')),
    ui.gauge('Context    ', metrics.contextBar, contextSuffix(metrics)),
    ui.dim(`           observed ${formatTokens(metrics.observed)} · estimated ${formatTokens(view.contextTokens)}`),
    ui.gauge('Cache      ', metrics.cacheBar, metrics.cacheBar.percent === null ? 'no reply yet' : 'last reply'),
    ui.dim(`           read ${formatTokens(view.cacheRead)} · written ${formatTokens(view.cacheWrite)} tokens`),
    ui.text(`Output     ${formatTokens(view.outputTokens)} tokens on the last reply`),
    ui.text(' '),
    ui.head('INPUT PER REPLY · lowest to highest'),
    trend,
    ...(usage?.rateLimits ?? [])
      .filter((limit) => Number.isFinite(limit.percentUsed))
      .map((limit) => ui.gauge(`${limit.kind.replaceAll('_', ' ').padEnd(11)}`, bar(limit.percentUsed, 100), 'used')),
    ui.text(' '),
    ...activityUsage(ui, config, view, actions),
    ui.text(' '),
    ui.head('ESTIMATES · configured list prices'),
    ui.text(`Cache read benefit    ${dollars(metrics.cacheBenefit)}`),
    Number.isFinite(view.estimate?.taxUsd) ? ui.text(`Switch tax            ${dollars(view.estimate.taxUsd)}`) : null,
    ...(view.comparison
      ? [
          ui.text(`Compared tiers        ${view.comparison.incumbent} → ${view.comparison.candidate}`),
          ui.text(
            `Next-turn difference  ${difference(view.comparison.minUsd)} to ${difference(view.comparison.maxUsd)}`,
          ),
          ui.text(
            `Payback               ${view.comparison.paybackTurns === null ? 'none projected' : `${view.comparison.paybackTurns} later turns`}`,
          ),
        ]
      : []),
    ui.dim('Press ? for what these estimates leave out.'),
  ];
}

function helpLines(ui) {
  return [
    ui.text(' '),
    ui.head('ABOUT THESE NUMBERS'),
    ui.dim('Cost, context and cache are Claude readings. $ estimates use the'),
    ui.dim('list prices in router.json; plan prices are equivalents, not cash.'),
    ui.dim('Routing savings are not measured. Cache benefit is before writes.'),
    ui.dim('The context bar uses the routed model’s window, 20% in reserve.'),
    ui.dim('A switch estimate prices 5m–1h cache writes; minus means cheaper.'),
  ];
}
