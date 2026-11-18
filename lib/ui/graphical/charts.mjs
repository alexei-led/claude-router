// The graphical painter's figures: the shared bar row (meter), the session strip and a headline stat.
import { TIERS } from '../../config.mjs';
import { cellTier, stripNote, tierLabel } from '../model/format.mjs';
import { GRAPHICAL_TRACK, svgColor } from '../tokens.mjs';

// The shared bar row: a label column, a flexible bar on a quiet track, a right-aligned figure column, then a note.
const BAR_LABEL = 10;
const BAR_FIGURE = 7;
// A trend's Svg: real pixel sizes in the markup (a percent width draws as a blank block), stretched to its slot.
const TREND_WIDTH = 1200;
const TREND_HEIGHT = 48;

// A fraction as a whole percent of a bar, 0 to 100, and at least 1 for any value above zero so a small reading never
// reads as empty; anything unreadable is an empty bar.
const share = (value) =>
  `${Number.isFinite(value) && value > 0 ? Math.max(1, Math.round(Math.min(1, value) * 100)) : 0}%`;

// Whole percents for the parts that sum to exactly 100: each part's floor, then the points left over to the parts with
// the largest remainders; a part above zero never gets 0 while the largest can spare a point.
export function wholePercents(parts) {
  const total = parts.reduce((sum, n) => sum + n, 0);
  const exact = parts.map((n) => (total > 0 ? (n / total) * 100 : 0));
  const out = exact.map(Math.floor);
  let left = total > 0 ? 100 - out.reduce((sum, n) => sum + n, 0) : 0;
  for (const i of exact
    .map((x, i) => [x - Math.floor(x), i])
    .sort((a, b) => b[0] - a[0] || a[1] - b[1])
    .map(([, i]) => i)) {
    if (left <= 0) break;
    out[i] += 1;
    left -= 1;
  }
  // Every part above zero keeps at least 1, taken from the largest, while there are points to give.
  for (const i of out.keys()) {
    if (parts[i] <= 0 || out[i] > 0) continue;
    const largest = out.indexOf(Math.max(...out));
    if (out[largest] <= 1) break;
    out[largest] -= 1;
    out[i] = 1;
  }
  return out;
}

/**
 * @param {any} elements
 * @param {{ row: (children: object[], extra?: object) => object, caption: (children: string, extra?: object) => object, color: (tone: string) => string }} kit
 */
export function charts({ Box, Text, Svg }, { row, caption, color }) {
  return {
    // The shared bar row: the label, the fill as a percent width of the track, and the figure beside it as text. A
    // bar without a label (inline in a table) has no label column.
    meter: ({ label, value, tone: fill, text: figure, caption: note }) =>
      row(
        [
          label === undefined
            ? null
            : Box({ width: BAR_LABEL, flexShrink: 0, children: [Text({ wrap: 'truncate-end', children: label })] }),
          Box({
            flexGrow: 1,
            flexShrink: 1,
            minWidth: 10,
            height: 1,
            backgroundColor: GRAPHICAL_TRACK,
            flexDirection: 'row',
            children: [Box({ width: share(value), height: 1, backgroundColor: color(fill) })],
          }),
          Box({
            width: BAR_FIGURE,
            flexShrink: 0,
            justifyContent: 'flex-end',
            children: [Text({ tabular: true, children: figure })],
          }),
          note ? caption(note, { tabular: true, wrap: 'truncate-end' }) : null,
        ],
        { flexWrap: 'nowrap', gap: 'md' },
      ),
    // The session's replies in order as runs of tier-coloured cells, then the replies per tier as words beside a
    // swatch, so the colour is never the only signal.
    strip: (strip, { now, since }) => {
      if (!strip?.cells?.length) return null;
      // Percent widths need no fitting to the pane, so no cells merge: only the note is kept.
      const note = stripNote(strip, strip.per, since, now);
      const runs = [];
      for (const one of strip.cells) {
        const name = cellTier(one);
        if (runs.at(-1)?.name === name) runs.at(-1).n += 1;
        else runs.push({ name, n: 1 });
      }
      const swatch = (name) => (name === 'none' ? color('muted') : color(`tier:${name}`));
      const widths = wholePercents(runs.map(({ n }) => n));
      const cells = runs.map(({ name }, i) =>
        Box({ width: `${widths[i]}%`, height: 1, backgroundColor: swatch(name) }),
      );
      const counts = {};
      for (const reply of strip.cells)
        for (const [key, n] of Object.entries(reply)) counts[key] = (counts[key] ?? 0) + n;
      const legend = (name, words) =>
        row([Box({ width: 1, height: 1, backgroundColor: swatch(name) }), caption(words, { tabular: true })], {
          gap: 'xs',
        });
      return Box({
        flexDirection: 'column',
        gap: 'sm',
        children: [
          caption('Replies by tier'),
          Box({ flexDirection: 'row', height: 1, children: cells }),
          row(
            [
              ...TIERS.filter((name) => counts[name]).map((name) => legend(name, `${tierLabel(name)} ${counts[name]}`)),
              counts.none ? legend('none', `not routed ${counts.none}`) : null,
              note ? caption(note) : null,
            ],
            { flexWrap: 'wrap', gap: 'md' },
          ),
        ],
      });
    },
    trend: (opts) => trendChart({ Box, Svg }, { row, caption }, opts),
    // A headline figure, its delta in the tone's colour beside it, and its caption under it.
    stat: ({ value, caption: words, delta, tone: name = /** @type {import('../tokens.mjs').Tone} */ ('primary') }) =>
      Box({
        flexDirection: 'column',
        gap: 'xs',
        children: [
          row([
            Text({ size: 'title', weight: 'semibold', tabular: true, children: value }),
            delta ? Text({ tabular: true, color: color(name), children: delta }) : null,
          ]),
          words ? caption(words, { wrap: 'truncate-end' }) : null,
        ].filter(Boolean),
      }),
  };
}

// A trend as a line over a faint fill, stretched to the slot's width, with its first and last bucket under it; the
// alt states the numbers. A surface without Svg says the alt in words.
function trendChart({ Box, Svg }, { row, caption }, { points, labels, alt, tone: name }) {
  const values = (points.length ? points : [0]).map((v) => (Number.isFinite(v) && v > 0 ? v : 0));
  const max = Math.max(...values);
  const last = values.length - 1;
  const x = (i) => (last ? Math.round((i * TREND_WIDTH) / last) : TREND_WIDTH / 2);
  const y = (v) => Math.round((TREND_HEIGHT - 3 - (max > 0 ? v / max : 0) * (TREND_HEIGHT - 6)) * 10) / 10;
  const line = values.map((v, i) => `${x(i)},${y(v)}`).join(' ');
  const color = svgColor(name);
  const source =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${TREND_WIDTH}" height="${TREND_HEIGHT}" viewBox="0 0 ${TREND_WIDTH} ${TREND_HEIGHT}" preserveAspectRatio="none">` +
    `<polygon points="${x(0)},${TREND_HEIGHT} ${line} ${x(last)},${TREND_HEIGHT}" fill="${color}" fill-opacity="0.12"/>` +
    `<polyline points="${line}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" vector-effect="non-scaling-stroke"/></svg>`;
  return Box({
    flexDirection: 'column',
    gap: 'xs',
    children: [
      Svg
        ? Box({
            overflow: 'hidden',
            flexDirection: 'column',
            children: [Svg({ source, alt, height: TREND_HEIGHT })],
          })
        : caption(alt, { wrap: 'wrap' }),
      row([caption(labels[0], { tabular: true }), caption(labels.at(-1), { tabular: true })], {
        justifyContent: 'space-between',
      }),
    ],
  });
}
