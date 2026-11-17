// The band drawn natively on desktop, VS Code and mobile: one row with the route on the left, which yields when the
// window narrows, and the readings, the pin and Router on the right, which stay. The segments are the terminal band's
// (bandSegments), so what shows and when is decided in one place; only how they are drawn differs.
import { bandSegments, fitSegments, sessionRow } from '../../band-segments.mjs';
import { resolveRoute, TIERS } from '../../config.mjs';
import { classifierWarns, SAVINGS_COLOR, shortRoute, shownConfig, TIER_COLOR } from '../../display.mjs';
import { toneColor } from '../tokens.mjs';
import { tierMeter } from './meter.mjs';

// Columns the right group keeps beyond the readings: the pin Select and the Router button.
const PIN_SELECT = 20;
const ROUTER_BUTTON = 10;
const NO_PIN = 'none';

const TIER_OF = Object.fromEntries(Object.entries(TIER_COLOR).map(([tier, hex]) => [hex, tier]));
// What the terminal's raw colours mean, in the tone vocabulary. Anything not listed draws in the text colour.
/** @type {Record<string, import('../tokens.mjs').Tone>} */
const TONE_OF = {
  red: 'danger',
  yellow: 'warning',
  [SAVINGS_COLOR.more]: 'warning',
  green: 'success',
  [SAVINGS_COLOR.less]: 'success',
  '#87d787': 'success',
  '#7c9cff': 'accent',
  gray: 'muted',
  '#8b93a7': 'muted',
};

// A part's terminal style as the tone it means: dim is muted, the one italic colour is the activity, a tier hex is
// that tier. The terminal's background chips and dim-on-red do not carry over; only the foreground meaning does.
/**
 * @param {{ color?: string, dimColor?: boolean, italic?: boolean }} style
 * @returns {import('../tokens.mjs').Tone | undefined}
 */
function toneOf({ color, dimColor, italic }) {
  if (italic && color) return 'activity';
  if (color === undefined) return dimColor ? 'muted' : undefined;
  return TIER_OF[color] ? /** @type {import('../tokens.mjs').Tone} */ (`tier:${TIER_OF[color]}`) : TONE_OF[color];
}

function textProps(style, extra = {}) {
  const tone = toneOf(style);
  return {
    ...(tone ? { color: toneColor(tone, 'graphical') } : {}),
    ...(style.bold ? { weight: 'semibold' } : {}),
    ...(style.italic ? { italic: true } : {}),
    ...extra,
  };
}

// A run of text parts as one Text: the parts nested so each keeps its own colour, the run's edges trimmed because
// the row's gap, not spaces, sits between its items.
function run(elements, parts, extra) {
  const trimmed = parts.map((p) => ({ ...p }));
  for (const [end, trim, drop] of [
    [0, 'trimStart', 'shift'],
    [-1, 'trimEnd', 'pop'],
  ]) {
    while (trimmed.length) {
      const p = trimmed.at(end);
      p.text = p.text[trim]();
      if (p.text) break;
      trimmed[drop]();
    }
  }
  if (!trimmed.length) return null;
  const { Text } = elements;
  if (trimmed.length === 1) return Text({ ...textProps(trimmed[0].style, extra), children: trimmed[0].text });
  return Text({
    ...extra,
    children: trimmed.map((p) => Text({ ...textProps(p.style), children: p.text })),
  });
}

// A segment's parts as elements: its meter bars as one Svg, consecutive text as one Text, buttons set apart.
function draw(elements, parts, extra) {
  const out = [];
  const buttons = [];
  let text = [];
  const flush = () => {
    const el = run(elements, text, extra);
    if (el) out.push(el);
    text = [];
  };
  for (let i = 0; i < parts.length; i += 1) {
    const p = parts[i];
    if (p.meter) {
      flush();
      while (parts[i + 1]?.meter) i += 1;
      const lit = p.meter !== 'off' && p.meter !== 'pending';
      out.push(tierMeter(elements, lit ? p.meter : null, lit ? 'lit' : p.meter));
    } else if (p.button) {
      flush();
      buttons.push(p.button);
    } else text.push(p);
  }
  flush();
  return { out, buttons };
}

// The terminal's gauge glyphs: a graphical row shows the figure alone.
const GAUGE = /^[▰▱█░]+$/;
const withoutGauge = (seg) => (seg.right ? { ...seg, parts: seg.parts.filter((p) => !GAUGE.test(p.text)) } : seg);

// "ctx 62%": muted until the figure asks for attention.
function reading(elements, seg) {
  const words = seg.parts;
  const alert = seg.parts.find((p) => p.style?.color === 'red' || p.style?.color === 'yellow')?.style.color;
  const tone = alert ? toneOf({ color: alert }) : 'muted';
  const text = words
    .map((p) => p.text)
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  return elements.Text({ size: 'footnote', color: toneColor(tone, 'graphical'), tabular: true, children: text });
}

function pinSelect(elements, config, view, actions) {
  const shown = shownConfig(config, view);
  const pending = view.pendingPin;
  return elements.Select({
    key: 'band-pin',
    options: [
      { value: NO_PIN, label: pending ? 'No pin' : 'Pin next turn' },
      ...TIERS.map((tier) => ({ value: tier, label: shortRoute(config, resolveRoute(shown, tier)) })),
    ],
    value: pending ?? NO_PIN,
    onSelect: (value) => (value === NO_PIN ? actions.unpin() : actions.pin(value)),
  });
}

// A subagent's band: one row of what was chosen and how, with no control and no Router, since a subagent's model is
// fixed at spawn and the pane belongs to the main thread.
export function renderGraphicalAgent(elements, parts) {
  const text = run(elements, parts, { wrap: 'truncate-end' });
  return elements.Box({
    key: 'router-band',
    flexDirection: 'row',
    flexWrap: 'nowrap',
    alignItems: 'center',
    overflow: 'hidden',
    paddingX: 1,
    children: text ? [text] : [],
  });
}

/** @param {{ columns: number, now?: number }} opts */
export function renderGraphicalBand(elements, config, view, usage, opts, actions) {
  const { columns, now = Date.now() } = opts;
  const { Box, Button } = elements;
  const width = Number.isFinite(columns) ? Math.max(0, columns - PIN_SELECT - ROUTER_BUTTON) : columns;
  const routing = view.mode === 'auto' && view.phase !== 'unavailable';
  const pin = Boolean(elements.Select) && routing && view.phase !== 'choosing' && !classifierWarns(view.error);
  // The pin Select shows a pending pin, so its text and ✕ would say it twice; without the Select they are the only way
  // to cancel it.
  const segments = fitSegments(
    bandSegments(config, view, usage, actions)
      .filter((s) => !pin || !s.parts.some((p) => p.button?.key === 'band-unpin'))
      .map(withoutGauge),
    width,
  );
  const left = [];
  const buttons = [];
  for (const seg of segments.filter((s) => !s.right)) {
    const drawn = draw(elements, seg.parts, { wrap: 'truncate-end' });
    left.push(...drawn.out);
    buttons.push(...drawn.buttons);
  }
  const readings = segments.filter((s) => s.right).map((s) => reading(elements, s));
  const main = {
    flexDirection: 'row',
    flexWrap: 'nowrap',
    alignItems: 'center',
  };
  const bandRow = (key) =>
    Box({
      ...(key ? { key } : {}),
      ...main,
      justifyContent: 'space-between',
      gap: 'md',
      children: [
        Box({ ...main, gap: 'sm', flexShrink: 1, overflow: 'hidden', children: left }),
        Box({
          ...main,
          gap: 'md',
          flexShrink: 0,
          children: [
            ...readings,
            ...buttons.map(({ plain: _plain, ...props }) => Button(props)),
            pin ? pinSelect(elements, config, view, actions) : null,
            Button({ key: 'details', label: 'Router', variant: 'secondary', onPress: actions.open }),
          ].filter(Boolean),
        }),
      ],
    });
  if (!view.bandDetail) return bandRow('router-band');
  const second = sessionRow(config, view, usage, columns, now);
  const detail = run(elements, second, { size: 'footnote', wrap: 'truncate-end' });
  return Box({
    key: 'router-band',
    flexDirection: 'column',
    children: [bandRow(), detail ? Box({ ...main, overflow: 'hidden', children: [detail] }) : null].filter(Boolean),
  });
}
