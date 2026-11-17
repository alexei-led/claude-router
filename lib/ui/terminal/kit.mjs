import { TIERS } from '../../config.mjs';
import { gaugeCells, TIER_COLOR, tierBars } from '../../display.mjs';
import { cellTier, fittedStrip } from '../strip.mjs';
import { ACTIVITY_COLOR, toneColor } from '../tokens.mjs';

// Activity verbs are orange italic, as on the band.
const ACTIVITY_STYLE = { color: ACTIVITY_COLOR, italic: true };
const LABEL_WIDTH = 22;
const METER_CELLS = 8;

/** @param {any} elements */
export function kit({ Box, Text, Button, Select }) {
  const text = (children, style = {}) => Text({ ...style, children });
  const dim = (children) => text(children, { dimColor: true });
  const head = (children) => text(children, { bold: true, color: 'cyan' });
  const toPart = (part) => (typeof part === 'string' ? text(part) : part);
  // One row of mixed parts; strings become plain Text, nulls are dropped.
  const line = (...parts) => Box({ children: parts.filter((part) => part !== null && part !== '').map(toPart) });
  // A fixed-width column, so controls of different widths still line up; it never shrinks in a narrow pane.
  const cell = (width, part) => Box({ width, flexShrink: 0, children: [toPart(part)] });
  const column = (children) => Box({ flexDirection: 'column', children });
  const bars = (tier) => text(tierBars(tier), { color: TIER_COLOR[tier] });
  const tier = (name, children = name) => text(children, { bold: true, color: TIER_COLOR[name] });
  const base = {
    Box,
    Button,
    Select,
    text,
    dim,
    head,
    tier,
    // A tier as its bars, the way the band and Now draw it.
    bars,
    // The tier meter: its bars once a tier is lit, a dim ring before.
    tierMeter: (name, state, _opts = {}) => (state === 'lit' && name ? bars(name) : dim('○')),
    activity: (activity) => text(activity, ACTIVITY_STYLE),
    line,
    cell,
    gauge: (name, value, suffix) =>
      text(`${name}${value.text}${value.percent === null ? '' : ` ${String(value.percent).padStart(3)}%`}  ${suffix}`, {
        color: value.color,
      }),
  };
  return { ...base, ...painters(base, column, toPart) };
}

// The composite painters, built from the kit's own primitives.
function painters({ Select, text, dim, tier, bars, head, line, cell }, column, toPart) {
  const stripRows = (strip, { columns, now, since }) => {
    if (!strip?.cells?.length) return [];
    const fitted = fittedStrip(strip, Number.isFinite(columns) ? columns - 8 : columns, since, now);
    const counts = {};
    for (const reply of strip.cells) for (const [key, n] of Object.entries(reply)) counts[key] = (counts[key] ?? 0) + n;
    return [
      line(
        dim('  tiers '),
        ...fitted.cells.map((one) => {
          const name = cellTier(one);
          return name === 'none' ? dim('·') : tier(name, '█');
        }),
        fitted.note ? dim(`  ${fitted.note}`) : null,
      ),
      line(
        '        ',
        ...TIERS.filter((name) => counts[name]).flatMap((name) => [bars(name), dim(` ${counts[name]}   `)]),
        counts.none ? dim(`· not routed ${counts.none}`) : null,
      ),
    ];
  };
  return {
    // A heading with its hint beside it, the children, then a blank row.
    section: (title, /** @type {{ hint?: string, action?: object }} */ { hint, action } = {}, children = []) =>
      column([line(head(title), hint ? dim(` ${hint}`) : null, action ?? null), ...children, text(' ')]),
    // A label column and the row's parts, with a help line under them.
    field: (label, parts, /** @type {{ help?: string, dim?: boolean }} */ { help, dim: muted = false } = {}) => {
      const row = line(cell(LABEL_WIDTH, muted ? dim(label) : label), ...parts);
      return help ? column([row, line(cell(LABEL_WIDTH, ''), dim(help))]) : row;
    },
    // A named gauge: lit cells for the fraction, then its reading and caption, in the tone's colour.
    meter: ({ label = '', value, tone, text: reading, caption, cells = METER_CELLS }) => {
      const [lit, unlit] = gaugeCells(value, cells);
      return text(`${label}${lit}${unlit} ${reading}${caption ? `  ${caption}` : ''}`, {
        color: toneColor(tone, 'terminal'),
      });
    },
    // The session's replies as cells coloured by tier, then the replies per tier as their bars; `since` is when the
    // session's usage record starts, for the note after a restart.
    strip: (strip, opts) => column(stripRows(strip, opts)),
    stripRows,
    // A figure with its delta and caption beside it.
    stat: ({ value, caption, delta, tone = /** @type {import('../tokens.mjs').Tone} */ ('primary') }) =>
      line(
        text(value, { bold: true, color: toneColor(tone, 'terminal') }),
        delta ? dim(`  ${delta}`) : null,
        caption ? dim(`  ${caption}`) : null,
      ),
    // A Select where the surface has one, otherwise the chosen label as text.
    choice: ({ key, options, selected, onPick }) =>
      Select
        ? Select({
            key,
            value: selected,
            options: options.map(({ value, label }) => ({ value, label })),
            onSelect: onPick,
          })
        : text(options.find((option) => option.value === selected)?.label ?? ''),
    // A header row of dim labels, then one row per record; a column with a width is a fixed cell.
    table: (columns, rows) => {
      const draw = (column, part) => {
        const padded =
          column.width && typeof part === 'string'
            ? column.align === 'right'
              ? part.padStart(column.width)
              : part
            : part;
        return column.width ? cell(column.width, padded) : toPart(padded);
      };
      return column([
        line(...columns.map((one) => draw(one, dim(one.label)))),
        ...rows.map((row) => line(...columns.map((one) => draw(one, row[one.key] ?? '')))),
      ]);
    },
    // A one-line message in the tone's colour, with its action beside it.
    notice: (tone, message, action) => line(text(message, { color: toneColor(tone, 'terminal') }), action ?? null),
  };
}
