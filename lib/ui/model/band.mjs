import { activeClassifier, resolveRoute, TIERS } from '../../config.mjs';
import { resetText } from '../../costs.mjs';
import {
  API_ESTIMATE,
  baselineName,
  cardRoute,
  classifierLabel,
  classifierStatus,
  classifierWarns,
  costText,
  diffText,
  modeLever,
  modelName,
  NOT_A_TIER_REASON,
  percentPair,
  reasonActivity,
  reasonNamesActivity,
  repliesText,
  routingModeOf,
  sessionCost,
  sessionUsage,
  shortReason,
  shortRoute,
  shownConfig,
  tierBars,
  unavailableReason,
  usageMetrics,
  usd,
} from '../../display.mjs';
import { isSameModel } from '../../route.mjs';
import { PASS_WHY } from '../../subagents.mjs';
import { isRouting } from '../../view.mjs';
import { limitTone, modelTone, savingTone } from '../tokens.mjs';

// Groups on a row sit apart by space alone: the meter, colours and glyphs already separate them.
export const SEPARATOR = '   ';
// Cells in the band's gauges: the context window and a plan window.
const CONTEXT_CELLS = 5;
const PLAN_CELLS = 8;
// The tier meter's bars, as many cells wide as it is drawn on the terminal.
const METER_CELLS = 4;
// The pin Select's "no pin" choice.
export const NO_PIN = 'none';

/**
 * One piece of a band segment: what it says and what it means, never how a surface draws it. A terminal maps `tone` to
 * a colour and `gauge` and `meter` to glyphs; a graphical surface draws the same as theme colours, a figure and an Svg.
 * @typedef {object} Part
 * @property {string} [text]
 * @property {import('../tokens.mjs').Tone} [tone] what the text means
 * @property {boolean} [dim] secondary text
 * @property {'semibold'} [weight]
 * @property {boolean} [italic]
 * @property {boolean} [chip] drawn as a label on a ground
 * @property {number} [gauge] a gauge at this percent, `cells` wide on the terminal
 * @property {number} [cells]
 * @property {import('../tokens.mjs').Tier | 'off' | 'pending'} [meter] the tier meter: lit to the tier, off, or working
 * @property {object} [button] a Button's props
 * @property {number} [priority] 0 never drops
 */

export const part = (text, props = {}) => ({ text, ...props });
export const dim = (text) => part(text, { dim: true });
export const button = (props) => ({ button: props });
const gauge = (percent, cells, tone) => ({ gauge: percent, cells, tone });
// `priority` 0 never drops; higher numbers drop first when the band is narrow. `right` segments sit at the row's end.
export const segment = (priority, ...parts) => ({ priority, parts: parts.flat().filter(Boolean) });
export const right = (seg) => ({ ...seg, right: true });
// The columns a part takes on the terminal, which both surfaces fit the band by. A Button is its label in `[ ` and ` ]`
// unless it is plain.
const partWidth = (p) =>
  p.meter
    ? METER_CELLS
    : p.gauge !== undefined
      ? p.cells
      : p.button
        ? p.button.label.length + (p.button.plain ? 0 : 4)
        : p.text.length;
export const partsWidth = (parts) => parts.reduce((n, p) => n + partWidth(p), 0);
export const lineWidth = (segments, separator) =>
  segments.reduce((sum, s, i) => sum + (i ? separator.length : 0) + partsWidth(s.parts), 0);

// Drops the highest-priority segments and parts, later ones first on a tie, until the line fits `columns`. If the
// priority-0 segments alone are too wide, the later ones go too, and the first is cut with an ellipsis: Ink would
// otherwise shrink every Text in the row and garble it. A width that is not a finite number fits everything.
export function fitSegments(segments, columns, separator = SEPARATOR) {
  if (!Number.isFinite(columns)) return segments;
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
    const last = parts.findLastIndex((p) => p.text?.length > overflow);
    if (last >= 0) parts[last] = { ...parts[last], text: `${parts[last].text.slice(0, -overflow - 1)}…` };
    kept[0] = { ...kept[0], parts };
  }
  return kept;
}

// Signal-strength bars: lit up to the tier, dim above it, or all dim when off.
const meter = (tier) => ({ meter: tier ?? 'off' });

// The classifier is working: every bar in the accent tone.
const pendingMeter = () => ({ meter: 'pending' });

// "Haiku 5.5 · high", the model in bold so the eye finds it first.
const routeParts = (model, effort) => [
  part(modelName(model), { weight: 'semibold' }),
  effort === null || effort === undefined ? null : part(` · ${effort}`),
];

function served(view) {
  const { actualModel: actual, selectedModel: selected } = view;
  return Boolean(actual && selected && !isSameModel(selected, actual));
}

// "Jev 93% ≥ 90%": the classifier's support for the switch the policy weighed, against the bar it set.
export function supportText(config, estimate) {
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
  return segment(5, part(` ${mode} `, { chip: true, tone: 'muted' }), lever ? dim(` ${lever}`) : null);
}

// Context fill and the last reply's cache reuse, kept at the row's end so they stay in one place turn after turn.
function gauges(config, view, usage) {
  const metrics = usageMetrics(config, view, usage);
  const out = [];
  if (metrics.contextBar.percent !== null) {
    const { percent, tone } = metrics.contextBar;
    out.push(right(segment(3, dim('ctx '), gauge(percent, CONTEXT_CELLS, tone), part(` ${percent}%`, { tone }))));
  }
  if (metrics.cacheBar.percent !== null)
    out.push(
      right(
        segment(4, dim('cache '), part(`${metrics.cacheBar.percent}%`, { tone: metrics.cacheBar.tone }), dim(' last')),
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
        part('✕ ', { tone: 'danger' }),
        native(),
        part(' '),
        button({ key: 'band-fix', label: 'Fix', onPress: actions.open }),
      ),
      segment(1, part('routing unavailable', { tone: 'danger' })),
      segment(3, part(unavailableReason(view), { tone: 'danger', dim: true })),
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
        part('⏵ next ', { tone: 'accent' }),
        part(tierBars(view.pendingPin), { tone: `tier:${view.pendingPin}` }),
        part(` ${shortRoute(config, resolveRoute(shownConfig(config, view), view.pendingPin))}`, {
          tone: `tier:${view.pendingPin}`,
        }),
        part(' '),
        button({ key: 'band-unpin', label: '✕', plain: true, onPress: actions.unpin }),
      )
    : null;
  if (!view.tier && view.phase === 'ready' && !view.actualModel)
    return [segment(0, meter(null), part(' '), native()), segment(1, dim('ready')), pin, modeChip(config, view)].filter(
      Boolean,
    );
  const main = segment(
    0,
    view.tier ? meter(view.tier) : dim('○'),
    part(' '),
    routeParts(view.actualModel ?? view.selectedModel ?? view.nativeModel, view.effort),
    served(view) ? part(' fallback', { tone: 'warning' }) : null,
  );
  const activityText = view.goal
    ? `${view.goal}${view.taskPhase ? ` / ${view.taskPhase}` : ''}${view.activity && view.activity !== view.goal ? ` → ${view.activity}` : ''}`
    : view.activity;
  const activity =
    activityText &&
    config.activityRouting !== 'off' &&
    ((view.goal && (view.taskPhase || view.goal !== view.activity)) || !reasonNamesActivity(view.reason))
      ? segment(2, part(activityText, { tone: 'activity', italic: true }))
      : null;
  const reason = segment(1, dim(shortReason(view.reason, reasonActivity(config, view))));
  // The warning leads and the route yields: when the band is narrow, what to fix matters more than the model kept.
  if (classifierWarns(view.error))
    return [
      segment(0, part(`⚠ ${classifierStatus(config, view.error)}`, { tone: 'warning' })),
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
// with your /model (or `unrouted` with subagents):
// "plan 5h ▰▰▰▱▱▱▱▱ 37% ↻17:00   7d 62%   session ≈$7.60 API estimate   −$1.76 (−19%) vs Sonnet 5.5   24 replies".
// An effort-only profile shows its effort mix instead of a saving. When the band is narrow the reset time, the
// counts and the words go first; the 5h window and the session total stay.
export function sessionSegments(config, view, usage, now = Date.now()) {
  const cost = sessionCost(config, view, usage, now);
  const out = [];
  for (const limit of cost.limits) {
    const tone = limitTone(limit.percent);
    if (limit.kind === 'five_hour') {
      const reset = resetText(limit.resetsAt, now);
      out.push(
        segment(
          0,
          dim('plan 5h '),
          gauge(limit.percent, PLAN_CELLS, tone),
          part(` ${limit.percent}%`, { tone }),
          reset ? { ...dim(` ↻${reset}`), priority: 4 } : null,
        ),
      );
    } else out.push(segment(3, dim(`${limit.label} `), part(`${limit.percent}%`, { tone })));
  }
  if (!isRouting(view)) return out.filter(Boolean);
  if (!cost.replies && !cost.agents) return [...out, segment(2, dim('session · no replies yet'))].filter(Boolean);
  out.push(
    segment(0, dim('session '), part(costText(cost.totalUsd, cost.billing), { weight: 'semibold' }), {
      ...dim(` ${API_ESTIMATE}`),
      priority: 5,
    }),
  );
  if (cost.billing === 'mixed') out.push(segment(1, part(`credits ${costText(cost.creditsUsd, cost.billing)}`)));
  if (cost.effortOnly && cost.effortMix.length)
    out.push(segment(2, dim('effort '), part(cost.effortMix.map(([effort, n]) => `${effort} ${n}`).join(' · '))));
  else if (cost.diffUsd !== null)
    out.push(
      segment(
        1,
        part(diffText(cost.diffUsd, cost.baseUsd), {
          weight: 'semibold',
          ...(cost.diffUsd ? { tone: savingTone(cost.diffUsd) } : {}),
        }),
        dim(` vs ${baselineName(view, sessionUsage(view, now), cost)}`),
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
      dim(`${repliesText(cost)}${cost.agents ? ` · ${cost.agents} agent${cost.agents === 1 ? '' : 's'}` : ''}`),
    ),
  );
  return out.filter(Boolean);
}

// A subagent's model and how it was chosen: "agent ■ Haiku 5.5  ↓ from Sonnet 5.5 (Claude Code’s pick)". The square is
// filled when the router moved it off Claude Code's pick, as the Usage tab's squares show it. A band too narrow for the
// reason keeps the name. Without its record (routing off, or the router reloaded since the spawn) only the mode is
// known: a subagent's model is chosen once, at spawn, and never changes between its steps.
export function agentParts(config, agent, columns) {
  if (!agent)
    return [
      dim(
        config.subagentRouting === 'on'
          ? 'agent · model chosen at spawn'
          : 'agent · keeps its own model (subagent routing off)',
      ),
    ];
  const moved = !agent.pass && agent.move;
  const name = part(`${moved ? '■' : '□'} ${modelName(agent.routedModel)}`, {
    weight: 'semibold',
    tone: modelTone(agent.routedModel),
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

/**
 * The pin Select's data, or null where no pin is offered: not while routing is off, unavailable or choosing, nor while
 * the classifier needs a fix.
 * @returns {{ value: string, options: { value: string, label: string }[] } | null}
 */
export function pinOf(config, view) {
  if (!isRouting(view) || view.phase === 'choosing' || classifierWarns(view.error)) return null;
  const shown = shownConfig(config, view);
  const pending = view.pendingPin;
  return {
    value: pending ?? NO_PIN,
    options: [
      { value: NO_PIN, label: pending ? 'No pin' : 'Pin next turn' },
      ...TIERS.map((tier) => ({ value: tier, label: cardRoute(config, resolveRoute(shown, tier), { short: true }) })),
    ],
  };
}
