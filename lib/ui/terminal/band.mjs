// The band as the terminal draws it: one row of the segments the model fits to the width, the Router button after
// them, a second row under the session's readings, and the hover controls drawn on the row itself so the pointer moves
// nothing.
import { resolveRoute, TIERS } from '../../config.mjs';
import { gaugeCells, shortRoute, shownConfig, tierBars } from '../../display.mjs';
import { isRouting } from '../../view.mjs';
import {
  agentParts,
  agentSegments,
  BACK_CELLS,
  BACK_LABEL,
  bandSegments,
  button,
  dim,
  fitSegments,
  lineWidth,
  part,
  partsWidth,
  routeLineSegments,
  SEPARATOR,
  segment,
  sessionSegments,
} from '../model/band.mjs';
import { CHIP_BACKGROUND, TIER_COLOR, toneColor } from '../tokens.mjs';

// The hover row's controls sit closer: they are buttons, not readings.
const GAP = '  ';
// What follows the readings: a gap, then Router as a plain label. The graphical band draws Router as a bordered Button,
// which is its label and the Button's own `[ ` and ` ]` wide, with no gap before it.
const ROUTER_TAIL = 2 + 'Router'.length;
// The fewest columns the hover controls are drawn in: Turn off and a gap.
const OVERLAY_MIN = 12;
// The tier meter's glyphs, one per bar.
const BARS = '▂▄▆█';

// A part's glyphs: what it takes on the terminal.
export function partGlyphs(p) {
  if (p.button) return `[ ${p.button.label} ]`;
  if (p.meter) return BARS;
  if (p.gauge !== undefined) return gaugeCells(p.gauge / 100, p.cells).join('');
  return p.text;
}

// A text part's props on the terminal: its tone's colour, dim for secondary text, a chip's ground.
function textStyle(p) {
  const color = p.tone ? toneColor(p.tone, 'terminal') : undefined;
  return {
    ...(p.chip ? { backgroundColor: CHIP_BACKGROUND } : {}),
    ...(color ? { color } : {}),
    ...(p.dim ? { dimColor: true } : {}),
    ...(p.weight ? { weight: p.weight } : {}),
    ...(p.italic ? { italic: true } : {}),
  };
}

// A part as elements: a Button, a meter or gauge as its glyphs in single Texts, or one Text.
function drawPart({ Text, Button }, p) {
  if (p.button) return [Button(p.button)];
  if (p.meter) {
    const lit = p.meter === 'off' || p.meter === 'pending' ? -1 : TIERS.indexOf(p.meter);
    return [...BARS].map((bar, i) =>
      Text(
        p.meter === 'pending'
          ? { color: toneColor('accent', 'terminal'), children: bar }
          : i <= lit
            ? { color: TIER_COLOR[p.meter], children: bar }
            : { dimColor: true, children: bar },
      ),
    );
  }
  if (p.gauge !== undefined) {
    const [filled, empty] = gaugeCells(p.gauge / 100, p.cells);
    return [
      Text({ color: toneColor(p.tone, 'terminal'), children: filled }),
      Text({ dimColor: true, children: empty }),
    ];
  }
  return [Text({ ...textStyle(p), children: p.text })];
}

const joinSegments = (segments) => segments.flatMap((s, i) => (i ? [part(SEPARATOR), ...s.parts] : s.parts));

// The second row's parts at `columns`.
export const sessionRow = (config, view, usage, columns, now = Date.now()) =>
  joinSegments(fitSegments(sessionSegments(config, view, usage, now), columns));

// The controls revealed under the pointer: a pin per tier, low to high, each named by what it runs ("▂▄ Haiku·high"), then
// Turn off and the one- or two-row choice. No digit hotkeys, since a bare digit in an empty prompt would press them.
// When there is little room the pins lose their model names first, then 2 rows and the pins go and Turn off stays;
// while two rows show, the pins and then Turn off go and 1 row stays.
function hoverSegments(config, view, actions, columns) {
  const shown = shownConfig(config, view);
  // While two rows show, 1 row is the band's way back and outranks Turn off, which /router off and the pane's f also do.
  const two = Boolean(view.bandDetail);
  const pins = (withNames) =>
    segment(
      two ? 2 : 1,
      dim('pin '),
      TIERS.flatMap((tier, i) => [
        i ? part(' ') : null,
        button({
          key: `band-pin-${tier}`,
          label: `${tierBars(tier)}${withNames ? ` ${shortRoute(config, resolveRoute(shown, tier))}` : ''}`,
          onPress: () => actions.pin(tier),
        }),
      ]),
    );
  const rest = [
    isRouting(view)
      ? segment(two ? 1 : 0, button({ key: 'band-manual', label: 'Turn off', onPress: () => actions.mode('manual') }))
      : null,
    segment(
      two ? 0 : 3,
      button({ key: 'band-detail', label: two ? '1 row' : '2 rows', onPress: actions.toggleDetail }),
    ),
  ].filter(Boolean);
  if (!isRouting(view)) return rest;
  const named = [pins(true), ...rest];
  return Number.isFinite(columns) && lineWidth(named, GAP) > columns ? [pins(false), ...rest] : named;
}

/**
 * The terminal band: a subagent's row with its way back, or the main thread's segments and Router, the running agents
 * under them and the session row when asked.
 * @param {any} elements
 */
export function terminalBand(elements, config, view, usage, { columns, agentId, agent, agents, back, now }, actions) {
  const { Box } = elements;
  const row = (parts) => Box({ children: parts.flatMap((p) => drawPart(elements, p)) });
  if (agentId) {
    const room = Number.isFinite(columns) ? Math.max(0, columns - BACK_CELLS) : columns;
    return row([
      ...(back
        ? [button({ key: 'band-back', label: BACK_LABEL, plain: true, onPress: actions.back }), part(SEPARATOR)]
        : []),
      ...agentParts(config, agent, back ? room : columns),
    ]);
  }
  const width = Number.isFinite(columns) ? Math.max(0, columns - ROUTER_TAIL) : columns;
  const kept = fitSegments(bandSegments(config, view, usage, actions), width);
  const left = joinSegments(kept.filter((s) => !s.right));
  const end = joinSegments(kept.filter((s) => s.right));
  const pad = end.length
    ? Number.isFinite(width)
      ? Math.max(SEPARATOR.length, width - partsWidth(left) - partsWidth(end))
      : SEPARATOR.length
    : 0;
  const line = [...left, ...(pad ? [part(' '.repeat(pad))] : []), ...end];
  line.push(part('  '), button({ key: 'details', label: 'Router', plain: true, onPress: actions.open }));
  const running = joinSegments(agentSegments(agents ?? [], columns, actions));
  const second = view.bandDetail ? sessionRow(config, view, usage, columns, now) : [];
  return Box({
    key: 'router-band',
    flexDirection: 'column',
    children: [
      Box({
        children: [
          ...line.flatMap((p) => drawPart(elements, p)),
          ...hoverOverlays(elements, config, view, actions, kept, line, columns),
        ],
      }),
      running.length ? row(running) : null,
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
function hoverOverlays(elements, config, view, actions, kept, line, columns) {
  const { Box } = elements;
  const lead = kept.filter((s) => !s.right);
  const last = lead.findLastIndex((s) => s.parts.some((p) => p.button));
  const over = lineWidth(lead.slice(0, Math.max(0, last) + 1), SEPARATOR) + SEPARATOR.length;
  const after = partsWidth(line) + GAP.length;
  const stretches = [
    { left: over, width: partsWidth(line) - ROUTER_TAIL - over },
    { left: after, width: Number.isFinite(columns) ? columns - after : Number.POSITIVE_INFINITY },
  ]
    .filter((stretch) => stretch.width >= OVERLAY_MIN)
    .sort((a, b) => b.width - a.width);
  const [widest, narrower] = stretches;
  if (!widest) return [];
  // A fit that is still too wide (one segment of Buttons, which cannot be cut) is dropped.
  const fit = (candidates, room) => {
    const fitted = fitSegments(candidates, room, GAP);
    return lineWidth(fitted, GAP) <= room ? fitted : [];
  };
  const segments = hoverSegments(config, view, actions, widest.width).map((s, n) => ({ ...s, n }));
  const first = fit(segments, widest.width);
  const rest = segments.filter((s) => !first.some((placed) => placed.n === s.n));
  const second = narrower && rest.length ? fit(rest, narrower.width) : [];
  const overlay = ({ left, width }, fitted) => {
    const controls = fitted.flatMap((s, i) => (i ? [part(GAP), ...s.parts] : s.parts));
    const pad = Number.isFinite(width) ? width - partsWidth(controls) : 0;
    return Box({
      position: 'absolute',
      top: 0,
      left,
      display: 'none',
      hover: { display: 'flex' },
      children: [...controls, ...(pad > 0 ? [part(' '.repeat(pad))] : [])].flatMap((p) => drawPart(elements, p)),
    });
  };
  return [
    ...(first.length ? [overlay(widest, first)] : []),
    ...(narrower && second.length ? [overlay(narrower, second)] : []),
  ];
}

// The route line the terminal places under a turn: the band's words, indented like the transcript's own dim lines.
export function terminalRouteLine(elements, config, line, { columns }) {
  const indent = '  ';
  const room = Number.isFinite(columns) ? Math.max(0, columns - indent.length) : columns;
  const parts = joinSegments(fitSegments(routeLineSegments(config, line), room));
  return elements.Box({ children: [part(indent), ...parts].flatMap((p) => drawPart(elements, p)) });
}
