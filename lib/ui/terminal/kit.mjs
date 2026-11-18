import { TIERS } from '../../config.mjs';
import { tierBars } from '../../display.mjs';
import { mergePairs, STRIP_CELLS } from '../../view.mjs';
import { cellTier, stripNote } from '../model/format.mjs';
import { TIER_COLOR, toneColor } from '../tokens.mjs';

// Activity verbs are orange italic, as on the band.
const ACTIVITY_STYLE = { color: toneColor('activity', 'terminal'), italic: true };
// A trend's blocks, lowest to highest; a bucket without anything is a dot.
const SPARK = '▁▂▃▄▅▆▇█';
// The narrowest pane that draws a section in a box: Now's widest fixed row, the main/agents cost bar with its `vs` note
// (61-64 cells), still fits inside. Narrower panes, every narrow pane under 64 among them, keep the plain sections.
export const PANEL_COLUMNS = 72;
// What a box takes across: its border and one cell of padding on each side.
export const PANEL_CHROME = 4;

/** Whether a pane `columns` wide draws its sections in boxes: from PANEL_COLUMNS, or with no width. */
export const boxed = (columns) => !Number.isFinite(columns) || columns >= PANEL_COLUMNS;
/** The columns a section's lines have: the pane's, less the box around them where there is one. */
export const inner = (columns) => (boxed(columns) && Number.isFinite(columns) ? columns - PANEL_CHROME : columns);

// The session strip fitted to the pane beside its note: pairs of cells merge until both fit.
function fittedStrip(strip, columns, since, now) {
  let { per, cells } = strip;
  const room = () =>
    Number.isFinite(columns) ? Math.max(8, columns - 4 - stripNote(strip, per, since, now).length) : STRIP_CELLS;
  while (cells.length > room()) {
    cells = mergePairs(cells);
    per *= 2;
  }
  return { cells, note: stripNote(strip, per, since, now) };
}

/** @param {any} elements */
export function kit({ Box, Text, Button, Select }) {
  const text = (children, style = {}) => Text({ ...style, children });
  const dim = (children) => text(children, { dimColor: true });
  const head = (children) => text(children, { weight: 'semibold', color: toneColor('accent', 'terminal') });
  const toPart = (part) => (typeof part === 'string' ? text(part) : part);
  // One row of mixed parts; strings become plain Text, nulls are dropped.
  const line = (...parts) => Box({ children: parts.filter((part) => part !== null && part !== '').map(toPart) });
  // A fixed-width column, so controls of different widths still line up; it never shrinks in a narrow pane.
  const cell = (width, part) => Box({ width, flexShrink: 0, children: [toPart(part)] });
  const bars = (level) => text(tierBars(level), { color: TIER_COLOR[level] });
  const tier = (name, children = name) => text(children, { weight: 'semibold', color: TIER_COLOR[name] });
  const base = {
    Box,
    Button,
    Select,
    text,
    // A sentence in this surface's wording.
    say: (words) => (typeof words === 'string' ? words : words.terminal),
    // A tone's colour on the terminal: a theme key, or a hex for a tier, a model and an activity.
    color: (tone) => toneColor(tone, 'terminal'),
    dim,
    head,
    tier,
    // A tier as its bars, the way the band and Now draw it.
    bars,
    // The tier meter: its bars once a tier is lit, a dim ring before.
    tierMeter: (name, state) => (state === 'lit' && name ? bars(name) : dim('○')),
    activity: (activity) => text(activity, ACTIVITY_STYLE),
    line,
    cell,
    boxed,
    inner,
    // A section: its lines in a single-line box from PANEL_COLUMNS, with its title as the first line inside, since the
    // terminal draws no title in a border. Narrower, the lines as they are, then a blank line to part them from the
    // next section unless `spaced` is false.
    panel: (columns, lines, spaced = true) =>
      boxed(columns)
        ? [
            Box({
              flexDirection: 'column',
              borderStyle: 'single',
              borderColor: toneColor('muted', 'terminal'),
              paddingX: 1,
              children: lines.filter(Boolean),
            }),
          ]
        : spaced
          ? [...lines, text(' ')]
          : lines,
  };
  return { ...base, ...painters(base), ...forms(base) };
}

// The composite helpers the terminal renderers draw with, built from the kit's own primitives. The graphical kit draws
// its own section, meter, strip, stat, choice and table.
function painters({ text, dim, tier, bars, line }) {
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
    // The session's replies as cells coloured by tier, then the replies per tier as their bars; `since` is when the
    // session's usage record starts, for the note after a restart.
    stripRows,
    // A trend as one row of blocks scaled from zero to its peak, a dot for an empty bucket, in the tone's colour.
    trend: ({ points, tone }) => {
      const max = Math.max(...points);
      const glyphs = points.map((v) => (v > 0 ? SPARK[Math.min(7, Math.floor((v / max) * 8))] : '·')).join('');
      return text(glyphs, { color: toneColor(tone, 'terminal') });
    },
    // A one-line message in the tone's colour, with its action beside it.
    notice: (tone, message, action) => line(text(message, { color: toneColor(tone, 'terminal') }), action ?? null),
  };
}

// What the terminal tabs share when they lay out a control: a labelled field, its help, a Select, the unsaved mark and
// the line that sends you to Policy. The graphical kit draws its own.
function forms({ Box, Button, Select, text, line, cell, say, color }) {
  return {
    // A field: its label in a fixed column, then its lines stacked in a column of their own, so a line that wraps in a
    // narrow pane stays inside that column instead of falling back to the pane's edge.
    field: (width, label, lines) =>
      Box({
        children: [
          cell(width, label),
          Box({ flexDirection: 'column', flexGrow: 1, flexShrink: 1, children: lines.filter(Boolean) }),
        ],
      }),
    // A line of help under a control, wrapping inside its field's column; dim unless given a style.
    help: (words, style = { dimColor: true }) => text(words, { ...style, wrap: 'wrap' }),
    // A Select over the control's options, or its value as text on a surface without Select.
    select: (control) =>
      Select
        ? Select({
            key: control.key,
            value: control.value,
            options: control.options.map(({ value, label }) => ({ value, label: say(label) })),
            onSelect: control.pick,
          })
        : control.text,
    // A two-cell column holding the model's unsaved mark where a value changed, so the rows beside it line up whether
    // or not it shows.
    marker: (mark) => cell(2, mark ? text(mark.glyph, { color: color(mark.tone) }) : ''),
    // Cache rebuilds cost more than the cheaper models saved: the policy's switch weight is the lever.
    lostLine: (onPress) =>
      line(
        text('  ▲ switches cost more than they saved  ', { color: color('warning') }),
        Button({ key: 'session-policy', label: 'Policy', onPress }),
      ),
  };
}
