import { sameRoute, TIERS, tuningOf } from './config.mjs';
import {
  bar,
  CLASSIFIER,
  CLASSIFIER_ERRORS,
  formatTokens,
  GATEWAY_CLEANUP,
  GATEWAY_SETTINGS,
  REASONS,
  sparkline,
  usageMetrics,
} from './native-display.mjs';

export const TABS = [
  ['now', '1', 'Now'],
  ['tiers', '2', 'Tiers'],
  ['tuning', '3', 'Tuning'],
  ['usage', '4', 'Usage'],
];
export const TUNING_CHOICES = {
  timeoutMs: [500, 1000, 1500, 3000],
  downgradeVotes: [1, 2, 3],
  horizon: [1, 3, 5, 10],
  cashCapUsd: [0.5, 1, 2, 5],
};
// Cost order, cheapest first, so the colors read as a scale. Hex values: every surface draws them.
export const TIER_COLOR = { micro: '#5fd7af', low: '#5f9fe0', medium: '#d7af5f', high: '#e0708a' };
const LADDER = [...TIERS].reverse();
const SESSION_EFFORT = 'session';

export function modelName(id) {
  if (!id) return 'no response yet';
  return id
    .replace(/^claude-/, '')
    .replace(/-([0-9])-([0-9])(-\d{8})?$/, ' $1.$2')
    .replace(/^./, (c) => c.toUpperCase());
}

export function routeName(config, route) {
  const model = config.models[route.model];
  return `${modelName(model.id)}${model.efforts.length ? ` · ${route.effort ?? SESSION_EFFORT}` : ''}`;
}

// The draft the Tiers tab edits: the saved routes until the person changes one.
export function routeDraftOf(config, view) {
  return (
    view.routeDraft ?? {
      routes: Object.fromEntries(TIERS.map((tier) => [tier, { ...config.routes[tier] }])),
      baselineTier: config.baselineTier,
    }
  );
}

const dollars = (value) => (Number.isFinite(value) ? `$${value.toFixed(3)}` : 'not reported');
const difference = (value) => `${value < 0 ? '−' : '+'}$${Math.abs(value).toFixed(3)}`;
const percent = (value) => `${Math.round(value * 100)}%`;
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
  const body = { now: nowTab, tiers: tiersTab, tuning: tuningTab, usage: usageTab }[tab];
  return ui.Box({
    flexDirection: 'column',
    children: [
      ...header(ui, view, actions),
      ...body(ui, config, view, usage, actions, modelOptions),
      ...(view.help ? helpLines(ui) : []),
      view.notice ? ui.text(view.notice, { color: 'yellow' }) : null,
      ui.Button({ key: 'close', label: 'Close', hotkey: 'q', role: 'dismiss', onPress: actions.close }),
    ],
  });
}

function header(ui, view, actions) {
  const auto = view.mode === 'auto';
  const jev =
    view.phase === 'unavailable'
      ? ui.text('Routing unavailable', { color: 'yellow' })
      : view.error
        ? ui.text(`${CLASSIFIER} ${CLASSIFIER_ERRORS[view.error] ?? view.error}`, { color: 'yellow' })
        : view.keySet
          ? ui.text(`${CLASSIFIER} ready${Number.isFinite(view.adviceMs) ? ` · ${view.adviceMs} ms` : ''}`, {
              color: 'green',
            })
          : ui.text(`${CLASSIFIER} key not set`, { color: 'yellow' });
  return [
    ui.line(ui.head(`ROUTER · ${auto ? 'Auto' : 'Manual'}`), '   ', jev),
    view.phase === 'unavailable' && view.error ? ui.text(view.error, { color: 'yellow' }) : null,
    ...(view.error === GATEWAY_SETTINGS ? GATEWAY_CLEANUP.map((line) => ui.text(line, { color: 'yellow' })) : []),
    ui.line(
      ui.Button({
        key: 'auto',
        label: 'Auto',
        hotkey: 'a',
        variant: auto ? 'primary' : 'secondary',
        onPress: () => actions.mode('auto'),
      }),
      ' ',
      ui.Button({
        key: 'manual',
        label: 'Manual: keep /model',
        hotkey: 'm',
        variant: auto ? 'secondary' : 'primary',
        onPress: () => actions.mode('manual'),
      }),
    ),
    ui.line(
      ...TABS.flatMap(([id, hotkey, label]) => [
        ui.Button({
          key: `tab-${id}`,
          label,
          hotkey,
          variant: (view.tab ?? 'now') === id ? 'primary' : 'secondary',
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
  const served =
    view.actualModel && current && view.actualModel !== current && !view.actualModel.startsWith(`${current}-`);
  const out = [
    ui.line(
      'Now    ',
      view.tier ? ui.tier(view.tier, `▌${view.tier}  `) : null,
      `${modelName(current)}${view.effort === null || view.effort === undefined ? '' : ` · ${view.effort}`}`,
    ),
    ui.line('Why    ', REASONS[view.reason] ?? view.reason ?? 'ready'),
    served
      ? ui.line(ui.text('Served ', { color: 'yellow' }), `${modelName(view.actualModel)} · native fallback`)
      : null,
    view.pendingPin
      ? ui.line(
          ui.text('Pinned ', { color: 'yellow' }),
          'next turn → ',
          ui.tier(view.pendingPin),
          '  ',
          ui.Button({ key: 'unpin', label: 'unpin', onPress: actions.unpin }),
        )
      : null,
    view.keySet
      ? null
      : ui.line(
          ui.text('Jev    key not set: keeping the model  ', { color: 'yellow' }),
          ui.Button({ key: 'key', label: 'Set Jev key', hotkey: 'k', onPress: actions.key }),
        ),
    ui.text(' '),
    ui.head('TIERS · next turn'),
    ui.dim(`  ${'tier'.padEnd(8)}${'route'.padEnd(22)}Jev support`),
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
        ui.Button({
          key: `pin-${tier}`,
          label: 'pin',
          dimColor: !auto,
          onPress: () => actions.pin(tier),
        }),
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
        `  switch needs ${percent(estimate.threshold)} · Jev gave ${Number.isFinite(mass) ? percent(mass) : '—'} ${direction}` +
          `${Number.isFinite(estimate.taxUsd) ? ` · tax ≈ $${estimate.taxUsd.toFixed(2)}` : ''}`,
      ),
    );
  }
  out.push(ui.dim(auto ? '  Pins serve the next turn only.' : '  Pins need Auto. Manual keeps the /model choice.'));
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

// One cell per reply, colored by the tier that served it; a dot where routing did not choose (Manual, fallback).
function replies(ui, view) {
  const tiers = view.tiers ?? [];
  if (!tiers.length) return [ui.head('REPLIES'), ui.dim('  no replies yet')];
  const switches = tiers.slice(1).filter((tier, i) => tier && tiers[i] && tier !== tiers[i]).length;
  return [
    ui.head(`REPLIES · last ${tiers.length}`),
    ui.line(
      '  ',
      ...tiers.map((tier) => (tier ? ui.tier(tier, '█') : ui.dim('·'))),
      ui.dim(`  ${switches} switch${switches === 1 ? '' : 'es'}`),
    ),
    ui.line('  ', ...TIERS.flatMap((tier) => [ui.tier(tier, '■ '), `${tier}  `])),
  ];
}

function tiersTab(ui, config, view, _usage, actions, modelOptions) {
  const draft = routeDraftOf(config, view);
  const out = [
    ui.head('ROUTES · future turns'),
    ui.dim(`${'tier'.padEnd(8)}${'model'.padEnd(14)}${'effort'.padEnd(12)}${'$/M in · out'.padEnd(14)}window`),
  ];
  for (const tier of LADDER) {
    const route = draft.routes[tier];
    const model = config.models[route.model];
    const changed = !sameRoute(route, config.routes[tier]);
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
        ui.cell(14, `${model.input} · ${model.output ?? '?'}`),
        windowSize(model.contextWindow),
        changed ? ui.text('  ●', { color: 'yellow' }) : null,
      ),
    );
  }
  out.push(
    ui.line(
      ui.Select
        ? ui.Select({
            key: 'baseline',
            label: 'Baseline tier',
            value: draft.baselineTier,
            options: TIERS.map((tier) => ({ value: tier, label: tier })),
            onSelect: (tier) => actions.baseline(tier),
          })
        : `Baseline tier: ${draft.baselineTier}`,
      ui.dim('  start here, fall back here'),
    ),
    ui.text(' '),
    ui.head('SWITCH COST · from these routes'),
  );
  for (let i = 0; i < LADDER.length - 1; i += 1) {
    const upper = draft.routes[LADDER[i]];
    const lower = draft.routes[LADDER[i + 1]];
    const pair = `${LADDER[i + 1]} → ${LADDER[i]}`.padEnd(16);
    if (sameRoute(upper, lower))
      out.push(ui.line(ui.text('! ', { color: 'yellow' }), pair, 'identical: this step changes nothing'));
    else if (upper.model === lower.model)
      out.push(ui.line(ui.dim('· '), pair, 'same model, new effort: priced as a new cache'));
    else out.push(ui.line(ui.dim('· '), pair, 'model change: priced as a cold cache write'));
  }
  const changes = TIERS.filter((tier) => !sameRoute(draft.routes[tier], config.routes[tier]));
  const baselineChanged = draft.baselineTier !== config.baselineTier;
  const dirty = changes.length > 0 || baselineChanged;
  out.push(ui.text(' '));
  if (dirty) {
    out.push(ui.dim('router.json changes:'));
    for (const tier of changes) {
      out.push(ui.text(`- routes.${tier.padEnd(7)} ${routeName(config, config.routes[tier])}`, { color: 'red' }));
      out.push(ui.text(`+ routes.${tier.padEnd(7)} ${routeName(config, draft.routes[tier])}`, { color: 'green' }));
    }
    if (baselineChanged) {
      out.push(ui.text(`- baselineTier   ${config.baselineTier}`, { color: 'red' }));
      out.push(ui.text(`+ baselineTier   ${draft.baselineTier}`, { color: 'green' }));
    }
  } else out.push(ui.dim('No changes. Pick a model or an effort above.'));
  out.push(
    ui.line(
      ui.Button({
        key: 'save-routes',
        label: 'Save routes',
        hotkey: 's',
        variant: dirty ? 'primary' : 'secondary',
        dimColor: !dirty,
        onPress: actions.saveRoutes,
      }),
      ' ',
      ui.Button({ key: 'discard-routes', label: 'Discard', dimColor: !dirty, onPress: actions.discardRoutes }),
      ' ',
      ui.Button({ key: 'reset-routes', label: 'Reset to defaults', hotkey: 'r', onPress: actions.resetRoutes }),
    ),
    ui.dim('A new model ID needs router.json → models: price, window, efforts.'),
  );
  return out;
}

function tuningTab(ui, config, view, _usage, actions) {
  const saved = tuningOf(config);
  const draft = { ...saved, ...view.tuning };
  const rows = [
    ['timeoutMs', 'Jev deadline', (v) => `${v} ms`, 'then keep the model'],
    ['downgradeVotes', 'Votes to go down', String, 'agreeing turns before cheaper'],
    ['horizon', 'Payback horizon', (v) => `${v} turns`, 'a switch repays its cache'],
    ['cashCapUsd', 'Credits cap', (v) => `$${v.toFixed(2)}`, 'max cold write on credits'],
  ];
  const dirty = rows.some(([key]) => draft[key] !== saved[key]);
  const health = view.health ?? { failures: 0, pausedUntil: 0 };
  return [
    ui.head('POLICY · future turns'),
    ...rows.map(([key, label, format, hint]) => {
      const values = TUNING_CHOICES[key].includes(draft[key])
        ? TUNING_CHOICES[key]
        : [draft[key], ...TUNING_CHOICES[key]];
      return ui.line(
        ui.cell(18, label),
        ui.cell(
          12,
          ui.Select
            ? ui.Select({
                key,
                value: String(draft[key]),
                options: values.map((value) => ({ value: String(value), label: format(value) })),
                onSelect: (picked) => {
                  if (TUNING_CHOICES[key].includes(Number(picked))) actions.tune(key, Number(picked));
                },
              })
            : format(draft[key]),
        ),
        ui.cell(2, draft[key] !== saved[key] ? ui.text('●', { color: 'yellow' }) : ''),
        ui.dim(hint),
      );
    }),
    ui.line(
      ui.Button({
        key: 'save-tuning',
        label: 'Save tuning',
        variant: dirty ? 'primary' : 'secondary',
        dimColor: !dirty,
        onPress: actions.saveTuning,
      }),
      ' ',
      ui.Button({ key: 'reset-tuning', label: 'Discard', dimColor: !dirty, onPress: actions.resetTuning }),
    ),
    ui.text(' '),
    ui.head('JEV'),
    ui.line(
      'Key      ',
      view.keySet ? ui.text('● configured  ', { color: 'green' }) : ui.text('● not set  ', { color: 'yellow' }),
      ui.Button({ key: 'key', label: view.keySet ? 'Edit key' : 'Set Jev key', hotkey: 'k', onPress: actions.key }),
    ),
    ui.text(
      `Health   ${health.pausedUntil > Date.now() ? `paused until ${new Date(health.pausedUntil).toLocaleTimeString()}` : 'active'} · ${health.failures} recent failure${health.failures === 1 ? '' : 's'}`,
    ),
    ui.text(' '),
    ui.head('CONFIG'),
    ui.line(
      `File     ${view.configPath ?? 'profile router.json'}  `,
      view.configPath ? ui.Button({ key: 'copy-path', label: 'copy', onPress: actions.copyPath }) : null,
    ),
    ui.dim('Main conversation only. Subagents keep their own model.'),
  ];
}

function usageTab(ui, config, view, usage) {
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
