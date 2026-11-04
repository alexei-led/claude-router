import { activeClassifier, resolveRoute, TIERS } from './config.mjs';
import { resetText } from './costs.mjs';
import {
  BILLING_WORDS,
  classifierLabel,
  classifierStatus,
  classifierWarns,
  costText,
  diffText,
  gaugeCells,
  limitColor,
  modeLever,
  modelColor,
  modelName,
  NOT_A_TIER_REASON,
  percentPair,
  reasonActivity,
  reasonNamesActivity,
  routeLabel,
  routingModeOf,
  savingsColor,
  sessionCost,
  shortReason,
  shortRoute,
  shownConfig,
  TIER_COLOR,
  tierBars,
  unavailableReason,
  usageMetrics,
  usd,
} from './display.mjs';
import { isSameModel } from './route.mjs';
import { PASS_WHY } from './subagents.mjs';

const BARS = '▂▄▆█';
// Groups on a row sit apart by space alone: the meter, colours and glyphs already separate them.
const SEPARATOR = '   ';
// The hover row's controls sit closer: they are buttons, not readings.
const GAP = '  ';
// Space the band keeps for the trailing Router button.
const ROUTER_BUTTON = 8;
// Cells in the band's gauges: the context window and a plan window.
const CONTEXT_CELLS = 5;
const PLAN_CELLS = 8;

// Hex, like TIER_COLOR, so every surface draws the same shades. Yellow stays out: it marks a fault that needs action.
// Activity is Claude Code's orange for a turn's action; italic sets it apart from the high and medium tier colors.
const COLOR = {
  accent: '#7c9cff',
  off: '#2a3040',
  muted: '#8b93a7',
  warn: '#f0b429',
  activity: '#d77757',
  gauge: '#87d787',
};

const part = (text, style = {}) => ({ text, style });
const dim = (text) => part(text, { dimColor: true });
const button = (props) => ({ button: props });
// `priority` 0 never drops; higher numbers drop first when the band is narrow. `right` segments sit at the row's end.
const segment = (priority, ...parts) => ({ priority, parts: parts.flat().filter(Boolean) });
const right = (seg) => ({ ...seg, right: true });
const partWidth = (p) => (p.button ? p.button.label.length + (p.button.plain ? 0 : 4) : p.text.length);
const partsWidth = (parts) => parts.reduce((n, p) => n + partWidth(p), 0);
const lineWidth = (segments, separator) =>
  segments.reduce((sum, s, i) => sum + (i ? separator.length : 0) + partsWidth(s.parts), 0);

// Drops the highest-priority segments and parts, later ones first on a tie, until the line fits `columns`. If the
// priority-0 segments alone are too wide, the later ones go too, and the first is cut with an ellipsis: Ink would
// otherwise shrink every Text in the row and garble it.
export function fitSegments(segments, columns, separator = SEPARATOR) {
  const kept = [...segments];
  while (lineWidth(kept, separator) > columns) {
    let drop = null;
    kept.forEach((s, i) => {
      s.parts.forEach((p, j) => {
        if (p.priority > 0 && (!drop || p.priority >= drop.priority)) drop = { priority: p.priority, i, j };
      });
      if (kept.length > 1 && s.priority > 0 && (!drop || s.priority >= drop.priority))
        drop = { priority: s.priority, i };
    });
    if (drop?.j !== undefined)
      kept[drop.i] = { ...kept[drop.i], parts: kept[drop.i].parts.filter((_, j) => j !== drop.j) };
    else if (drop) kept.splice(drop.i, 1);
    else if (kept.length > 1) kept.pop();
    else break;
  }
  const overflow = lineWidth(kept, separator) - columns;
  if (overflow > 0 && kept.length) {
    const parts = [...kept[0].parts];
    const last = parts.findLastIndex((p) => !p.button && p.text.length > overflow);
    if (last >= 0) parts[last] = { ...parts[last], text: `${parts[last].text.slice(0, -overflow - 1)}…` };
    kept[0] = { ...kept[0], parts };
  }
  return kept;
}

// Signal-strength bars: lit up to the tier in its color, dim above it or when `dim`.
function meter(tier, off = false) {
  const lit = off ? -1 : TIERS.indexOf(tier);
  return [...BARS].map((bar, i) => part(bar, i <= lit ? { color: TIER_COLOR[tier] } : { dimColor: true }));
}

// The classifier is working: every bar in the accent colour.
const pendingMeter = () => [...BARS].map((bar) => part(bar, { color: COLOR.accent }));

// "Haiku 5.5 · high", the model in bold so the eye finds it first.
const routeParts = (model, effort) => [
  part(modelName(model), { bold: true }),
  effort === null || effort === undefined ? null : part(` · ${effort}`),
];

function served(view) {
  const { actualModel: actual, selectedModel: selected } = view;
  return Boolean(actual && selected && !isSameModel(selected, actual));
}

// "Jev 93% ≥ 90%": the classifier's support for the switch the policy weighed, against the bar it set.
function supportText(config, estimate) {
  if (!Number.isFinite(estimate?.threshold)) return null;
  const mass = Number.isFinite(estimate.upgradeMass) ? estimate.upgradeMass : estimate.downgradeMass;
  if (!Number.isFinite(mass)) return null;
  const [shown, bar] = percentPair(mass, estimate.threshold);
  return `${classifierLabel(config)} ${shown} ${mass >= estimate.threshold ? '≥' : '<'} ${bar}`;
}

// The routing mode as a chip, only when it is not balanced: "cost", or "cost effort only" when the mode kept the model.
function modeChip(config, view) {
  const { mode } = routingModeOf(view);
  if (mode === 'balanced') return null;
  const lever = modeLever(config, view);
  return segment(
    5,
    part(` ${mode} `, { backgroundColor: COLOR.off, color: COLOR.muted }),
    lever ? dim(` ${lever}`) : null,
  );
}

// Context fill and the last reply's cache reuse, kept at the row's end so they stay in one place turn after turn.
function gauges(config, view, usage) {
  const metrics = usageMetrics(config, view, usage);
  const out = [];
  if (metrics.contextBar.percent !== null) {
    const [filled, empty] = gaugeCells(metrics.contextBar.percent / 100, CONTEXT_CELLS);
    out.push(
      right(
        segment(
          3,
          dim('ctx '),
          part(filled, { color: metrics.contextBar.color }),
          dim(empty),
          part(` ${metrics.contextBar.percent}%`, { color: metrics.contextBar.color }),
        ),
      ),
    );
  }
  if (metrics.cacheBar.percent !== null)
    out.push(
      right(
        segment(
          4,
          dim('cache '),
          part(`${metrics.cacheBar.percent}%`, { color: metrics.cacheBar.color }),
          dim(' last'),
        ),
      ),
    );
  return out;
}

export function bandSegments(config, view, usage, actions) {
  const native = () => routeParts(view.nativeModel, view.nativeEffort);
  if (view.phase === 'unavailable')
    return [
      segment(
        0,
        part('✕ ', { color: 'red' }),
        native(),
        part(' '),
        button({ key: 'band-fix', label: 'Fix', onPress: actions.open }),
      ),
      segment(1, part('routing unavailable', { color: 'red' })),
      segment(3, part(unavailableReason(view), { color: 'red', dimColor: true })),
    ];
  // Turn on shares the first segment, which never drops and whose cut keeps buttons whole, so the band's one way back
  // on survives any width.
  if (view.mode === 'manual')
    return [
      segment(
        0,
        dim('○ '),
        native(),
        part(' '),
        button({ key: 'band-auto', label: 'Turn on', variant: 'primary', onPress: () => actions.mode('auto') }),
      ),
      segment(1, dim(`routing off${view.reason === 'model selected manually' ? ' · /model' : ''}`)),
      view.reason === NOT_A_TIER_REASON ? segment(2, dim('not a routing tier')) : null,
    ].filter(Boolean);
  if (view.phase === 'choosing')
    return [
      segment(0, pendingMeter(), dim(' choosing…')),
      segment(3, dim(`${classifierLabel(config)} ≤ ${activeClassifier(config).timeoutMs / 1000} s`)),
    ];
  const pin = view.pendingPin
    ? segment(
        0,
        part('⏵ next ', { color: COLOR.accent }),
        part(tierBars(view.pendingPin), { color: TIER_COLOR[view.pendingPin] }),
        part(` ${shortRoute(config, resolveRoute(shownConfig(config, view), view.pendingPin))}`, {
          color: TIER_COLOR[view.pendingPin],
        }),
        part(' '),
        button({ key: 'band-unpin', label: '✕', plain: true, onPress: actions.unpin }),
      )
    : null;
  if (!view.tier && view.phase === 'ready' && !view.actualModel)
    return [
      segment(0, meter(null, true), part(' '), native()),
      segment(1, dim('ready')),
      pin,
      modeChip(config, view),
    ].filter(Boolean);
  const main = segment(
    0,
    view.tier ? meter(view.tier) : dim('○'),
    part(' '),
    routeParts(view.actualModel ?? view.selectedModel ?? view.nativeModel, view.effort),
    served(view) ? part(' fallback', { color: 'yellow' }) : null,
  );
  const activity =
    view.activity && config.activityRouting !== 'off' && !reasonNamesActivity(view.reason)
      ? segment(2, part(view.activity, { color: COLOR.activity, italic: true }))
      : null;
  const reason = segment(1, dim(shortReason(view.reason, reasonActivity(config, view))));
  // The warning leads and the route yields: when the band is narrow, what to fix matters more than the model kept.
  if (classifierWarns(view.error))
    return [
      segment(0, part(`⚠ ${classifierStatus(config, view.error)}`, { color: COLOR.warn })),
      view.error === 'missing-key' || view.error === 'missing-account'
        ? segment(0, button({ key: 'band-key', label: 'Set up', variant: 'primary', onPress: actions.key }))
        : segment(2, button({ key: 'band-fix', label: 'Details', onPress: actions.open })),
      { ...main, priority: 1 },
      pin,
      { ...reason, priority: 3 },
    ].filter(Boolean);
  const support = supportText(config, view.estimate);
  // The policy's price for the switch it weighed: mostly the prompt cache the other model must write.
  const switchUsd = view.estimate?.taxUsd;
  return [
    main,
    activity,
    pin,
    reason,
    modeChip(config, view),
    support ? segment(6, dim(support)) : null,
    Number.isFinite(switchUsd) && switchUsd >= 0.005 ? segment(6, dim(`switch ≈ ${usd(switchUsd)}`)) : null,
    ...gauges(config, view, usage),
  ].filter(Boolean);
}

// The second row: the plan windows on a Claude plan, then this session's cost with its subagents, and how it compares
// with no routing: "plan 5h ▰▰▰▱▱▱▱▱ 37% ↻17:00   7d 62%   session ≈$7.60 API value   −$1.76 (−19%) vs no routing".
// An effort-only profile shows its effort mix instead of a saving. When the band is narrow the reset time, the
// counts and the words go first; the 5h window and the session total stay.
export function sessionSegments(config, view, usage, now = Date.now()) {
  const cost = sessionCost(config, view, usage, now);
  const out = [];
  for (const limit of cost.limits) {
    const color = limitColor(limit.percent);
    if (limit.kind === 'five_hour') {
      const [filled, empty] = gaugeCells(limit.percent / 100, PLAN_CELLS);
      const reset = resetText(limit.resetsAt, now);
      out.push(
        segment(
          0,
          dim('plan 5h '),
          part(filled, { color }),
          dim(empty),
          part(` ${limit.percent}%`, { color }),
          reset ? { ...dim(` ↻${reset}`), priority: 4 } : null,
        ),
      );
    } else out.push(segment(3, dim(`${limit.label} `), part(`${limit.percent}%`, { color })));
  }
  const routing = view.mode === 'auto' && view.phase !== 'unavailable';
  if (!routing) return out.filter(Boolean);
  if (!cost.replies && !cost.agents) return [...out, segment(2, dim('session · no replies yet'))].filter(Boolean);
  out.push(
    segment(0, dim('session '), part(costText(cost.totalUsd, cost.billing), { bold: true }), {
      ...dim(` ${BILLING_WORDS[cost.billing]}`),
      priority: 5,
    }),
  );
  if (cost.billing === 'mixed') out.push(segment(1, part(`billed ${usd(cost.creditsUsd)}`)));
  if (cost.effortOnly && cost.effortMix.length)
    out.push(segment(2, dim('effort '), part(cost.effortMix.map(([effort, n]) => `${effort} ${n}`).join(' · '))));
  else if (cost.diffUsd !== null)
    out.push(
      segment(
        1,
        part(diffText(cost.diffUsd, cost.baseUsd), { bold: true, color: savingsColor(cost.diffUsd) }),
        dim(' vs no routing'),
        cost.early ? { ...dim(' · early'), priority: 7 } : null,
      ),
    );
  else if (cost.uncomparedReplies)
    out.push(
      segment(
        2,
        dim(
          cost.uncomparedReplies === cost.replies
            ? 'not compared'
            : `${cost.uncomparedReplies} of ${cost.replies} not compared`,
        ),
      ),
    );
  out.push(
    segment(
      6,
      dim(
        `${cost.replies} repl${cost.replies === 1 ? 'y' : 'ies'}${cost.agents ? ` · ${cost.agents} agent${cost.agents === 1 ? '' : 's'}` : ''}`,
      ),
    ),
  );
  return out.filter(Boolean);
}

// The second row's parts at `columns`.
export const sessionRow = (config, view, usage, columns, now = Date.now()) =>
  fitSegments(sessionSegments(config, view, usage, now), columns).flatMap((s, i) =>
    i ? [part(SEPARATOR), ...s.parts] : s.parts,
  );

// The row revealed under the pointer: a pin per tier, low to high, each named by what it runs ("▂▄ Haiku·high"), then
// Turn off and the one- or two-row choice. No digit hotkeys, since a bare digit in an empty prompt would press them.
// When the row is narrow the pins lose their model names first; Turn off and the row choice stay.
function hoverSegments(config, view, actions, routing, columns) {
  const shown = shownConfig(config, view);
  const pins = (named) =>
    segment(
      1,
      dim('pin '),
      TIERS.flatMap((tier, i) => [
        i ? part(' ') : null,
        button({
          key: `band-pin-${tier}`,
          label: `${tierBars(tier)}${named ? ` ${shortRoute(config, resolveRoute(shown, tier))}` : ''}`,
          onPress: () => actions.pin(tier),
        }),
      ]),
    );
  const rest = [
    routing
      ? segment(0, button({ key: 'band-manual', label: 'Turn off', onPress: () => actions.mode('manual') }))
      : null,
    segment(
      view.bandDetail ? 0 : 3,
      button({ key: 'band-detail', label: view.bandDetail ? '1 row' : '2 rows', onPress: actions.toggleDetail }),
    ),
  ].filter(Boolean);
  if (!routing) return rest;
  const named = [pins(true), ...rest];
  return Number.isFinite(columns) && lineWidth(named, GAP) > columns ? [pins(false), ...rest] : named;
}

// A subagent's model and how it was chosen: "agent ■ Haiku 5.5  ↓ from Sonnet 5.5 (Claude Code’s pick)". The square is
// filled when the router moved it off Claude Code's pick, as the Usage tab's squares show it.
function agentParts(agent, columns) {
  const color = modelColor(agent.routedModel);
  const moved = !agent.pass && agent.move;
  const name = part(`${moved ? '■' : '□'} ${modelName(agent.routedModel)}`, {
    bold: true,
    ...(color ? { color } : {}),
  });
  const glyph = { up: '↑', down: '↓' }[agent.move] ?? '↕';
  const why = agent.pass
    ? `= Claude Code’s pick: ${PASS_WHY[agent.pass]}`
    : moved
      ? `${glyph} from ${modelName(agent.coreModel)} (Claude Code’s pick)`
      : agent.choice === 'core'
        ? `= Claude Code’s pick: ${agent.failed ? 'classifier did not answer' : 'the router sent no model'}`
        : '= Claude Code’s pick, kept by the router';
  const parts = [dim('agent '), name, dim(`  ${why}`)];
  return Number.isFinite(columns) && partsWidth(parts) > columns ? parts.slice(0, 2) : parts;
}

export function renderBand(
  { Box, Text, Button },
  config,
  view,
  usage,
  { columns, agentId, agent = null, now = Date.now() },
  actions,
) {
  const draw = (p) => (p.button ? Button(p.button) : Text({ ...p.style, children: p.text }));
  const row = (parts) => Box({ children: parts.map(draw) });
  // A subagent's model is chosen once, at spawn, and never changes between its steps. Without its record (routing
  // off, or the router reloaded since the spawn) only the mode is known.
  if (agentId)
    return row(
      agent
        ? agentParts(agent, columns)
        : [
            dim(
              config.subagentRouting === 'on'
                ? 'agent · model chosen at spawn'
                : 'agent · keeps its own model (subagent routing off)',
            ),
          ],
    );
  const width = Number.isFinite(columns) ? Math.max(0, columns - ROUTER_BUTTON) : columns;
  const kept = fitSegments(bandSegments(config, view, usage, actions), width);
  const join = (segs) => segs.flatMap((s, i) => (i ? [part(SEPARATOR), ...s.parts] : s.parts));
  const left = join(kept.filter((s) => !s.right));
  const end = join(kept.filter((s) => s.right));
  const pad = end.length
    ? Number.isFinite(width)
      ? Math.max(SEPARATOR.length, width - partsWidth(left) - partsWidth(end))
      : SEPARATOR.length
    : 0;
  const line = [...left, ...(pad ? [part(' '.repeat(pad))] : []), ...end];
  line.push(part('  '), button({ key: 'details', label: 'Router', plain: true, onPress: actions.open }));
  const routing = view.mode === 'auto' && view.phase !== 'unavailable';
  const second = view.bandDetail ? sessionRow(config, view, usage, columns, now) : [];
  const hover = fitSegments(hoverSegments(config, view, actions, routing, columns), columns, GAP);
  return Box({
    key: 'router-band',
    flexDirection: 'column',
    children: [
      row(line),
      second.length ? row(second) : null,
      Box({
        display: 'none',
        hover: { display: 'flex' },
        children: hover.flatMap((s, i) => (i ? [part(GAP), ...s.parts] : s.parts)).map(draw),
      }),
    ],
  });
}

export function switchToast(config, previous, next, estimate) {
  const label = (decision) => routeLabel(decision.model, decision.effort);
  const support = supportText(config, estimate);
  // "Model changed: Sonnet 5.5 · medium → Haiku 5.5 · high · ↓ ops"
  const why = shortReason(next.reason, next.activity);
  return `Model changed: ${label(previous)} → ${label(next)} · ${why}${support ? ` (${support})` : ''}`;
}
