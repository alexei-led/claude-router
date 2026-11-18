import { TIERS } from '../../config.mjs';
import { TIER_COLOR, tierBars } from '../../display.mjs';
import { mergePairs, STRIP_CELLS } from '../../view.mjs';
import { cellTier, stripNote } from '../model/format.mjs';
import { ACTIVITY_COLOR, toneColor } from '../tokens.mjs';

// Activity verbs are orange italic, as on the band.
const ACTIVITY_STYLE = { color: ACTIVITY_COLOR, italic: true };
// A trend's blocks, lowest to highest; a bucket without anything is a dot.
const SPARK = '▁▂▃▄▅▆▇█';
// A trend's colour: the accent is the heading's cyan, as the pane's charts have always been.
const TREND_COLOR = { accent: 'cyan' };

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
export function kit({ Box, Text, Button, Select, Svg, Code }) {
  const text = (children, style = {}) => Text({ ...style, children });
  const dim = (children) => text(children, { dimColor: true });
  const head = (children) => text(children, { bold: true, color: 'cyan' });
  const toPart = (part) => (typeof part === 'string' ? text(part) : part);
  // One row of mixed parts; strings become plain Text, nulls are dropped.
  const line = (...parts) => Box({ children: parts.filter((part) => part !== null && part !== '').map(toPart) });
  // A fixed-width column, so controls of different widths still line up; it never shrinks in a narrow pane.
  const cell = (width, part) => Box({ width, flexShrink: 0, children: [toPart(part)] });
  const bars = (tier) => text(tierBars(tier), { color: TIER_COLOR[tier] });
  const tier = (name, children = name) => text(children, { bold: true, color: TIER_COLOR[name] });
  const base = {
    Box,
    Button,
    Select,
    Svg,
    // Drawn only by the graphical painters, and absent where the surface has none.
    Code,
    text,
    // A sentence in this surface's wording.
    say: (words) => (typeof words === 'string' ? words : words.terminal),
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
  };
  return { ...base, ...painters(base) };
}

// The composite painters the terminal renderers draw with, built from the kit's own primitives. The graphical painter
// draws its own section, field, meter, strip, stat, choice and table.
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
      return text(glyphs, { color: TREND_COLOR[tone] ?? toneColor(tone, 'terminal') });
    },
    // A one-line message in the tone's colour, with its action beside it.
    notice: (tone, message, action) => line(text(message, { color: toneColor(tone, 'terminal') }), action ?? null),
  };
}
