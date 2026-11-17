import {
  bandSegments,
  button,
  dim,
  fitSegments,
  lineWidth,
  part,
  partsWidth,
  SEPARATOR,
  segment,
  sessionRow,
  supportText,
} from './band-segments.mjs';
import { resolveRoute, TIERS } from './config.mjs';
import { modelColor, modelName, routeLabel, shortReason, shortRoute, shownConfig, tierBars } from './display.mjs';
import { PASS_WHY } from './subagents.mjs';
import { renderGraphicalAgent, renderGraphicalBand } from './ui/graphical/band.mjs';
import { orTerminal } from './ui/painter.mjs';
import { isGraphical } from './ui/tokens.mjs';

export { bandSegments, COLOR, fitSegments, sessionRow, sessionSegments } from './band-segments.mjs';

// The hover row's controls sit closer: they are buttons, not readings.
const GAP = '  ';
// Space the band keeps for the trailing Router button.
const ROUTER_BUTTON = 8;
// The fewest columns the hover controls are drawn in: Turn off and a gap.
const OVERLAY_MIN = 12;

// The controls revealed under the pointer: a pin per tier, low to high, each named by what it runs ("▂▄ Haiku·high"), then
// Turn off and the one- or two-row choice. No digit hotkeys, since a bare digit in an empty prompt would press them.
// When there is little room the pins lose their model names first, then 2 rows and the pins go and Turn off stays;
// while two rows show, the pins and then Turn off go and 1 row stays.
function hoverSegments(config, view, actions, routing, columns) {
  const shown = shownConfig(config, view);
  // While two rows show, 1 row is the band's way back and outranks Turn off, which /router off and the pane's f also do.
  const two = Boolean(view.bandDetail);
  const pins = (named) =>
    segment(
      two ? 2 : 1,
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
      ? segment(two ? 1 : 0, button({ key: 'band-manual', label: 'Turn off', onPress: () => actions.mode('manual') }))
      : null,
    segment(
      two ? 0 : 3,
      button({ key: 'band-detail', label: two ? '1 row' : '2 rows', onPress: actions.toggleDetail }),
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

export function renderBand(elements, config, view, usage, opts, actions) {
  return orTerminal(opts.surface, (surface) => drawBand(elements, config, view, usage, { ...opts, surface }, actions));
}

function drawBand(
  elements,
  config,
  view,
  usage,
  { columns, agentId, agent = null, now = Date.now(), surface },
  actions,
) {
  const { Box, Text, Button } = elements;
  const draw = (p) => (p.button ? Button(p.button) : Text({ ...p.style, children: p.text }));
  const row = (parts) => Box({ children: parts.map(draw) });
  // A subagent's model is chosen once, at spawn, and never changes between its steps. Without its record (routing
  // off, or the router reloaded since the spawn) only the mode is known.
  if (agentId) {
    const parts = agent
      ? agentParts(agent, columns)
      : [
          dim(
            config.subagentRouting === 'on'
              ? 'agent · model chosen at spawn'
              : 'agent · keeps its own model (subagent routing off)',
          ),
        ];
    return isGraphical(surface) ? renderGraphicalAgent(elements, parts) : row(parts);
  }
  if (isGraphical(surface))
    return renderGraphicalBand(elements, config, view, usage, { columns, now, surface }, actions);
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
  return Box({
    key: 'router-band',
    flexDirection: 'column',
    children: [
      Box({
        children: [...line.map(draw), ...hoverOverlays(elements, config, view, actions, routing, kept, line, columns)],
      }),
      second.length ? row(second) : null,
    ],
  });
}

// The hover controls, drawn on the row rather than on a row of their own, so the pointer moves nothing. The row has two
// free stretches: over the readings, from after the leading segments up to the last one holding a control (the meter
// and model, a warning with Set up, a pin with its ✕) to the gap before Router; and after Router, to the band's end.
// With readings at the row's end Router sits at the band's end, and the first is all there is. The controls fill the
// wider stretch, and what does not fit goes to the other; each is padded with spaces to blank what is beneath, so no
// Button of the row is covered. A stretch under OVERLAY_MIN columns holds none.
function hoverOverlays(elements, config, view, actions, routing, kept, line, columns) {
  const { Box, Text, Button } = elements;
  const draw = (p) => (p.button ? Button(p.button) : Text({ ...p.style, children: p.text }));
  const lead = kept.filter((s) => !s.right);
  const last = lead.findLastIndex((s) => s.parts.some((p) => p.button));
  const over = lineWidth(lead.slice(0, Math.max(0, last) + 1), SEPARATOR) + SEPARATOR.length;
  const after = partsWidth(line) + GAP.length;
  const stretches = [
    { left: over, width: partsWidth(line) - ROUTER_BUTTON - over },
    { left: after, width: Number.isFinite(columns) ? columns - after : Number.POSITIVE_INFINITY },
  ]
    .filter((stretch) => stretch.width >= OVERLAY_MIN)
    .sort((a, b) => b.width - a.width);
  if (!stretches.length) return [];
  // A fit that is still too wide (one segment of Buttons, which cannot be cut) is dropped.
  const fit = (segments, width) => {
    const fitted = fitSegments(segments, width, GAP);
    return lineWidth(fitted, GAP) <= width ? fitted : [];
  };
  const segments = hoverSegments(config, view, actions, routing, stretches[0].width).map((s, n) => ({ ...s, n }));
  const first = fit(segments, stretches[0].width);
  const rest = segments.filter((s) => !first.some((kept) => kept.n === s.n));
  const second = stretches[1] && rest.length ? fit(rest, stretches[1].width) : [];
  const overlay = ({ left, width }, fitted) => {
    const controls = fitted.flatMap((s, i) => (i ? [part(GAP), ...s.parts] : s.parts));
    const pad = Number.isFinite(width) ? width - partsWidth(controls) : 0;
    return Box({
      position: 'absolute',
      top: 0,
      left,
      display: 'none',
      hover: { display: 'flex' },
      children: [...controls, ...(pad > 0 ? [part(' '.repeat(pad))] : [])].map(draw),
    });
  };
  return [
    ...(first.length ? [overlay(stretches[0], first)] : []),
    ...(second.length ? [overlay(stretches[1], second)] : []),
  ];
}

export function switchToast(config, previous, next, estimate) {
  const label = (decision) => routeLabel(decision.model, decision.effort);
  const support = supportText(config, estimate);
  // "Model changed: Sonnet 5.5 · medium → Haiku 5.5 · high · ↓ ops"
  const why = shortReason(next.reason, next.activity);
  return `Model changed: ${label(previous)} → ${label(next)} · ${why}${support ? ` (${support})` : ''}`;
}
