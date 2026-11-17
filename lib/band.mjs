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
import { isGraphical } from './ui/tokens.mjs';

export { bandSegments, COLOR, fitSegments, sessionRow, sessionSegments } from './band-segments.mjs';

// The hover row's controls sit closer: they are buttons, not readings.
const GAP = '  ';
// Space the band keeps for the trailing Router button.
const ROUTER_BUTTON = 8;

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
  if (isGraphical(surface)) return renderGraphicalBand(elements, config, view, usage, { columns, now }, actions);
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
