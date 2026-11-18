// The band drawn natively on desktop, VS Code and mobile: one row with the route on the left, which yields when the
// window narrows, and the readings, the pin and Router on the right, which stay. The segments are the terminal band's
// (bandSegments), so what shows and when is decided in one place; only how they are drawn differs.
import { agentParts, bandSegments, fitSegments, NO_PIN, pinOf, sessionSegments } from '../model/band.mjs';
import { toneColor } from '../tokens.mjs';
import { tierMeter } from './meter.mjs';

// Columns the right group keeps beyond the readings: the pin Select, and the Router button, which is its label in the
// `[ ` and ` ]` a Button draws (the terminal's Router is a plain label after a gap, narrower).
const PIN_SELECT = 20;
const ROUTER_BUTTON = 'Router'.length + 4;

function textProps(p, extra = {}) {
  const tone = p.tone ?? (p.dim ? 'muted' : undefined);
  return {
    ...(tone ? { color: toneColor(tone, 'graphical') } : {}),
    ...(p.weight ? { weight: p.weight } : {}),
    ...(p.italic ? { italic: true } : {}),
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
  if (trimmed.length === 1) return Text({ ...textProps(trimmed[0], extra), children: trimmed[0].text });
  return Text({
    ...extra,
    children: trimmed.map((p) => Text({ ...textProps(p), children: p.text })),
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

// A graphical row shows a gauge's figure alone. The space a gauge sat between closes up, so "plan 5h ▰▰▱ 37%" reads
// "plan 5h 37%". The tier meter is drawn as an Svg and stays.
function withoutGauge(seg) {
  const parts = [];
  for (const p of seg.parts) {
    if (p.gauge !== undefined) continue;
    const before = parts.at(-1);
    parts.push(
      before && !before.button && /\s$/.test(before.text) && !p.button ? { ...p, text: p.text.trimStart() } : p,
    );
  }
  return { ...seg, parts };
}

// "ctx 62%": muted until the figure asks for attention.
function reading(elements, seg) {
  const alert = seg.parts.find((p) => p.tone === 'warning' || p.tone === 'danger')?.tone;
  const text = seg.parts
    .map((p) => p.text)
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  return elements.Text({
    size: 'footnote',
    color: toneColor(alert ?? 'muted', 'graphical'),
    tabular: true,
    children: text,
  });
}

function pinSelect(elements, pin, actions) {
  return elements.Select({
    key: 'band-pin',
    options: pin.options,
    value: pin.value,
    onSelect: (value) => (value === NO_PIN ? actions.unpin() : actions.pin(value)),
  });
}

// A subagent's band: one row of what was chosen and how, with no control and no Router, since a subagent's model is
// fixed at spawn and the pane belongs to the main thread.
function renderAgent(elements, parts) {
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

/** @param {{ columns: number, agentId?: string, agent?: object | null, now: number, surface?: string }} opts */
export function renderGraphicalBand(elements, config, view, usage, opts, actions) {
  const { columns, agentId, agent, now, surface } = opts;
  if (agentId) return renderAgent(elements, agentParts(config, agent, columns));
  const { Box, Button } = elements;
  const pin = elements.Select ? pinOf(config, view) : null;
  // Room for the pin Select only where one is drawn.
  const reserved = ROUTER_BUTTON + (pin ? PIN_SELECT : 0);
  const width = Number.isFinite(columns) ? Math.max(0, columns - reserved) : columns;
  // The pin Select shows a pending pin, so its text and ✕ would say it twice; without the Select they are the only way
  // to cancel it. Mobile always hands a Select, but an app that did not name it in `draws` is sent an empty Box for
  // it, and a hook cannot tell which: there the text and ✕ stay beside the Select.
  const keepsUnpin = !pin || surface === 'mobile';
  const all = bandSegments(config, view, usage, actions)
    .filter((s) => keepsUnpin || !s.parts.some((p) => p.button?.key === 'band-unpin'))
    .map((s) => (s.right ? withoutGauge(s) : s));
  const segments = fitSegments(all, width);
  const left = [];
  const buttons = [];
  for (const seg of segments.filter((s) => !s.right)) {
    const drawn = draw(elements, seg.parts, { wrap: 'truncate-end' });
    left.push(...drawn.out);
    buttons.push(...drawn.buttons);
  }
  // A narrow band drops the pin's words; its ✕ stays, so the pin can still be cancelled.
  const unpin = all.flatMap((s) => s.parts).find((p) => p.button?.key === 'band-unpin')?.button;
  if (unpin && !buttons.some((b) => b.key === 'band-unpin')) buttons.push(unpin);
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
            pin ? pinSelect(elements, pin, actions) : null,
            Button({ key: 'details', label: 'Router', variant: 'secondary', onPress: actions.open }),
          ].filter(Boolean),
        }),
      ],
    });
  if (!view.bandDetail) return bandRow('router-band');
  // The session row: each reading one Text, set apart by the row's gap rather than the terminal's spaces.
  const readingsRow = fitSegments(sessionSegments(config, view, usage, now).map(withoutGauge), columns)
    .map((seg) => run(elements, seg.parts, { size: 'footnote', tabular: true, wrap: 'truncate-end' }))
    .filter(Boolean);
  return Box({
    key: 'router-band',
    flexDirection: 'column',
    children: [
      bandRow(),
      readingsRow.length ? Box({ ...main, gap: 'md', overflow: 'hidden', children: readingsRow }) : null,
    ].filter(Boolean),
  });
}
