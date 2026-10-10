import { activeClassifier, TIERS } from './config.mjs';
import {
  classifierLabel,
  classifierStatus,
  classifierWarns,
  differenceShare,
  modelName,
  NOT_A_TIER_REASON,
  percent,
  reasonActivity,
  routeLabel,
  SAVINGS_COLOR,
  shortReason,
  signedUsd,
  switchCount,
  TIER_COLOR,
  unavailableReason,
  usageMetrics,
} from './display.mjs';
import { isSameModel } from './route.mjs';
import { emptyTotals, readout } from './savings.mjs';

const BARS = '▂▄▆█';
const SEPARATOR = '  ·  ';
// The hover row's controls sit apart without the dot: they are buttons, not readings.
const GAP = '  ';
// Space the band keeps for the trailing Router button.
const ROUTER_BUTTON = 8;
const STRIP = 20;

// Hex, like TIER_COLOR, so every surface draws the same shades. Yellow stays out: it marks a fault that needs action.
const COLOR = { accent: '#7c9cff', off: '#2a3040', muted: '#8b93a7', warn: '#f0b429', ink: '#0d1016' };

const part = (text, style = {}) => ({ text, style });
// A filled chip: the text on a background, as the prototype's status pills.
const pill = (text, background) => part(` ${text} `, { backgroundColor: background, color: COLOR.ink, bold: true });
const button = (props) => ({ button: props });
// `priority` 0 never drops; higher numbers drop first when the band is narrow. A part may carry its own priority to
// drop from inside a segment it shares no separator with.
const segment = (priority, ...parts) => ({ priority, parts: parts.flat().filter(Boolean) });
const partWidth = (p) => (p.button ? p.button.label.length + (p.button.plain ? 0 : 4) : p.text.length);
const lineWidth = (segments, separator) =>
  segments.reduce((sum, s, i) => sum + (i ? separator.length : 0) + s.parts.reduce((n, p) => n + partWidth(p), 0), 0);

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
function meter(tier, dim = false) {
  const lit = dim ? -1 : TIERS.indexOf(tier);
  return [...BARS].map((bar, i) => part(bar, i <= lit ? { color: TIER_COLOR[tier] } : { dimColor: true }));
}

// The classifier is working: every bar in the accent colour.
const pendingMeter = () => [...BARS].map((bar) => part(bar, { color: COLOR.accent }));

const route = (view) => routeLabel(view.actualModel ?? view.selectedModel ?? view.nativeModel, view.effort);

// The turn's activity between the tier and the route, in neutral ink so the tier keeps its color; dim and marked in
// shadow, where the route shown is still the one in use. It drops before the reason when the band is narrow.
function activityPart(config, view) {
  if (!view.activity || config.activityRouting === 'off') return null;
  const shadow = config.activityRouting === 'shadow';
  return { ...part(`${view.activity}${shadow ? ' (shadow)' : ''} → `, shadow ? { dimColor: true } : {}), priority: 2 };
}

function served(view) {
  const { actualModel: actual, selectedModel: selected } = view;
  return Boolean(actual && selected && !isSameModel(selected, actual));
}

function supportText(config, estimate) {
  if (!Number.isFinite(estimate?.threshold)) return null;
  const mass = Number.isFinite(estimate.upgradeMass) ? estimate.upgradeMass : estimate.downgradeMass;
  if (!Number.isFinite(mass)) return null;
  return `${classifierLabel(config)} ${percent(mass)} ${mass >= estimate.threshold ? '≥' : '<'} ${percent(estimate.threshold)}`;
}

export function bandSegments(config, view, usage, actions) {
  if (view.phase === 'unavailable')
    return [
      segment(0, part('✕ Routing unavailable', { color: 'red' })),
      segment(2, part(unavailableReason(view), { color: 'red' })),
      segment(1, button({ key: 'band-fix', label: 'Fix', onPress: actions.open })),
    ];
  // The state and Turn on lead in the first segment, which never drops, and a cut keeps buttons whole: the band's one
  // way back on stays at any width. The model and why go first, then the word Routing.
  if (view.mode === 'manual')
    return [
      segment(
        0,
        part('○ ', { dimColor: true }),
        { ...part('Routing '), priority: 1 },
        part('off', { backgroundColor: COLOR.off, color: COLOR.muted }),
        part(' '),
        button({ key: 'band-auto', label: 'Turn on', variant: 'primary', onPress: () => actions.mode('auto') }),
      ),
      segment(
        1,
        { ...part('every turn uses '), priority: 3 },
        part(modelName(view.nativeModel)),
        view.reason === 'model selected manually' ? { ...part(' (/model)', { dimColor: true }), priority: 2 } : null,
      ),
      view.reason === NOT_A_TIER_REASON
        ? segment(2, part(`${modelName(view.nativeModel)} is not a routing tier`, { dimColor: true }))
        : null,
    ].filter(Boolean);
  if (view.phase === 'choosing')
    return [
      segment(0, pendingMeter(), part(' choosing for this turn…', { dimColor: true })),
      segment(
        3,
        part(`${classifierLabel(config)} · ${activeClassifier(config).timeoutMs / 1000} s deadline`, {
          dimColor: true,
        }),
      ),
    ];
  const pin = view.pendingPin
    ? segment(
        0,
        part('⏵ next turn: ', { color: COLOR.accent }),
        part(view.pendingPin, { bold: true, color: TIER_COLOR[view.pendingPin] }),
        part(' '),
        button({ key: 'band-unpin', label: '✕', plain: true, onPress: actions.unpin }),
      )
    : null;
  if (!view.tier && view.phase === 'ready' && !view.actualModel)
    return [segment(0, meter(null, true), part(' Routing on · ready', { dimColor: true })), pin].filter(Boolean);
  const main = segment(
    0,
    view.tier ? [...meter(view.tier), pill(view.tier, TIER_COLOR[view.tier])] : part('○ '),
    activityPart(config, view),
    part(route(view)),
    served(view) ? part(' fallback', { color: 'yellow' }) : null,
  );
  // The warning leads and the route yields: when the band is narrow, what to fix matters more than the model kept,
  // and a long classifier label ("Clef Flash: no account ID") must not push the warning out.
  if (classifierWarns(view.error))
    return [
      segment(0, part(`⚠ ${classifierStatus(config, view.error)}`, { color: COLOR.warn })),
      view.error === 'missing-key' || view.error === 'missing-account'
        ? segment(0, button({ key: 'band-key', label: 'Set up', variant: 'primary', onPress: actions.key }))
        : segment(2, button({ key: 'band-fix', label: 'Details', onPress: actions.open })),
      { ...main, priority: 1 },
      pin,
      segment(3, part('keeping model', { color: COLOR.warn })),
    ].filter(Boolean);
  const metrics = usageMetrics(config, view, usage);
  const reading = (bar) => part(bar.percent === null ? '?' : `${bar.percent}%`, { color: bar.color });
  const support = supportText(config, view.estimate);
  return [
    main,
    pin,
    segment(1, part(shortReason(view.reason, reasonActivity(config, view)), { dimColor: true })),
    support ? segment(4, part(support, { dimColor: true })) : null,
    metrics.contextBar.percent === null && metrics.cacheBar.percent === null
      ? null
      : segment(3, part('ctx '), reading(metrics.contextBar), part(' · cache '), reading(metrics.cacheBar)),
  ].filter(Boolean);
}

// The session against your model, once it is past "too early": "vs your model −22% (−$1.84, list prices)", or the
// extra with what bought it, "+$2.48 (stronger models, list prices)". Null before that.
export function savingsParts(view) {
  const r = readout(view.savings ?? emptyTotals());
  if (r.early) return null;
  const share = differenceShare(r);
  const [shown, note] =
    r.differenceUsd < 0
      ? [share ?? signedUsd(r.differenceUsd), `${signedUsd(r.differenceUsd)}, list prices`]
      : r.differenceUsd > 0
        ? [
            signedUsd(r.differenceUsd),
            `${r.strongerUsd >= r.switchUsd ? 'stronger models' : 'switch cache writes'}, list prices`,
          ]
        : ['$0.00', 'list prices'];
  const color = r.differenceUsd < 0 ? SAVINGS_COLOR.less : r.differenceUsd > 0 ? SAVINGS_COLOR.more : undefined;
  return [part('vs your model '), part(shown, color ? { color } : {}), part(` (${note})`, { dimColor: true })];
}

// The second row of the detailed band: recent replies by tier, the session's switch economics, and the session
// against your model when the row has room for it.
function detailRow(config, view, usage, columns) {
  const tiers = (view.tiers ?? []).slice(-STRIP);
  if (!tiers.length) return [part('no replies yet', { dimColor: true })];
  const switches = switchCount(tiers);
  const metrics = usageMetrics(config, view, usage);
  const savings = savingsParts(view);
  const row = [
    part('replies ', { dimColor: true }),
    ...tiers.map((tier) => (tier ? part('█', { color: TIER_COLOR[tier] }) : part('·', { dimColor: true }))),
    part(
      `  ${switches} switch${switches === 1 ? '' : 'es'}` +
        `${Number.isFinite(view.estimate?.taxUsd) ? ` · tax ≈ $${view.estimate.taxUsd.toFixed(2)}` : ''}` +
        `${Number.isFinite(metrics.cacheBenefit) ? ` · cache saved ≈ $${metrics.cacheBenefit.toFixed(2)}` : ''}`,
      { dimColor: true },
    ),
  ];
  const tail = savings ? [part(SEPARATOR, { dimColor: true }), ...savings] : [];
  const width = (parts) => parts.reduce((n, p) => n + partWidth(p), 0);
  return width(row) + width(tail) <= columns ? [...row, ...tail] : row;
}

// The row revealed under the pointer: pins and the mode control while routing is on, and the one- or two-row choice.
// No digit hotkeys, since a bare digit in an empty prompt would press them. When the row is narrow, the routing on
// label goes first, then 2 rows, then the pin label, then the pins. Turn off stays, the band's one way to turn
// routing off, and so does 1 row, the only way back from a second row too wide for the band.
function hoverSegments(view, actions, routing) {
  const pins = TIERS.flatMap((tier, i) => [
    i ? part(' ') : null,
    button({ key: `band-pin-${tier}`, label: tier, onPress: () => actions.pin(tier) }),
  ]);
  return [
    routing ? segment(1, { ...part('pin next turn ', { dimColor: true }), priority: 2 }, pins) : null,
    // The state, then what a press does. The state goes first: the meter on the row above already says routing is on.
    routing
      ? segment(
          0,
          { ...part('routing on ', { dimColor: true }), priority: 4 },
          button({ key: 'band-manual', label: 'Turn off', onPress: () => actions.mode('manual') }),
        )
      : null,
    segment(
      view.bandDetail ? 0 : 3,
      button({ key: 'band-detail', label: view.bandDetail ? '1 row' : '2 rows', onPress: actions.toggleDetail }),
    ),
  ].filter(Boolean);
}

export function renderBand({ Box, Text, Button }, config, view, usage, { columns, agentId }, actions) {
  const draw = (p) => (p.button ? Button(p.button) : Text({ ...p.style, children: p.text }));
  const row = (parts) => Box({ children: parts.map(draw) });
  if (agentId) return row([part('○ Router · subagents keep their own model', { dimColor: true })]);
  const kept = fitSegments(bandSegments(config, view, usage, actions), Math.max(0, columns - ROUTER_BUTTON));
  const line = kept.flatMap((s, i) => (i ? [part(SEPARATOR, { dimColor: true }), ...s.parts] : s.parts));
  line.push(part('  '), button({ key: 'details', label: 'Router', plain: true, onPress: actions.open }));
  const routing = view.mode === 'auto' && view.phase !== 'unavailable';
  const hover = fitSegments(hoverSegments(view, actions, routing), columns, GAP);
  return Box({
    key: 'router-band',
    flexDirection: 'column',
    children: [
      row(line),
      view.bandDetail && routing ? row(detailRow(config, view, usage, columns)) : null,
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
  // An activity move names the activity: "Model changed: Sonnet 5.5 · medium → Haiku 5.5 · high · ops".
  const why = shortReason(next.reason, next.activity).replace(/^\W+\s*/, '');
  return `Model changed: ${label(previous)} → ${label(next)} · ${why}${support ? ` (${support})` : ''}`;
}
