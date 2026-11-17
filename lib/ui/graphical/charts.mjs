// The graphical painter's figures: the shared bar row (meter), the session strip and a headline stat.
import { TIERS } from '../../config.mjs';
import { cellTier, fittedStrip } from '../strip.mjs';
import { toneColor } from '../tokens.mjs';

// The shared bar row: a label column, a flexible bar on a quiet track, a right-aligned figure column, then a note.
const BAR_LABEL = 10;
const BAR_FIGURE = 7;
export const TRACK = 'rgba(127,127,127,0.18)';

const tone = (name) => toneColor(name, 'graphical');
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
 * @param {{ row: (children: object[], extra?: object) => object, caption: (children: string, extra?: object) => object }} kit
 */
export function charts({ Box, Text }, { row, caption }) {
  return {
    // The shared bar row: the label, the fill as a percent width of the track, and the figure beside it as text.
    meter: ({ label = '', value, tone: fill, text: figure, caption: note }) =>
      row(
        [
          Box({ width: BAR_LABEL, flexShrink: 0, children: [Text({ wrap: 'truncate-end', children: label })] }),
          Box({
            flexGrow: 1,
            flexShrink: 1,
            minWidth: 10,
            height: 1,
            backgroundColor: TRACK,
            flexDirection: 'row',
            children: [Box({ width: share(value), height: 1, backgroundColor: tone(fill) })],
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
      // Percent widths need no fitting to the pane, so no cells merge: only the restart note is kept.
      const fitted = fittedStrip(strip, Number.MAX_SAFE_INTEGER, since, now);
      const runs = [];
      for (const one of fitted.cells) {
        const name = cellTier(one);
        if (runs.at(-1)?.name === name) runs.at(-1).n += 1;
        else runs.push({ name, n: 1 });
      }
      const swatch = (name) => (name === 'none' ? tone('muted') : tone(`tier:${name}`));
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
              ...TIERS.filter((name) => counts[name]).map((name) => legend(name, `${name} ${counts[name]}`)),
              counts.none ? legend('none', `not routed ${counts.none}`) : null,
              fitted.note ? caption(fitted.note) : null,
            ],
            { flexWrap: 'wrap', gap: 'md' },
          ),
        ],
      });
    },
    // A headline figure, its delta in the tone's colour beside it, and its caption under it.
    stat: ({ value, caption: words, delta, tone: name = /** @type {import('../tokens.mjs').Tone} */ ('primary') }) =>
      Box({
        flexDirection: 'column',
        gap: 'xs',
        children: [
          row([
            Text({ size: 'title', weight: 'semibold', tabular: true, children: value }),
            delta ? Text({ tabular: true, color: tone(name), children: delta }) : null,
          ]),
          words ? caption(words, { wrap: 'truncate-end' }) : null,
        ].filter(Boolean),
      }),
  };
}
