import { TIERS } from '../config.mjs';
import { dayKey } from '../usage.mjs';
import { mergePairs, STRIP_CELLS } from '../view.mjs';

export const dayLabel = (key) => {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};

// "13:41", or "Oct 12 13:41" for another day than `now`'s.
const clockText = (ms) => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
export const sinceText = (ms, now) =>
  dayKey(ms) === dayKey(now) ? clockText(ms) : `${dayLabel(dayKey(ms))} ${clockText(ms)}`;

// The strip cell's tier: the one with most replies, the stronger on a tie; `none` where routing served none.
const STRIP_ORDER = [...TIERS].reverse().concat('none');
export const cellTier = (cell) => STRIP_ORDER.reduce((top, key) => ((cell[key] ?? 0) > (cell[top] ?? 0) ? key : top));

// The session strip fitted to the pane beside its note: pairs of cells merge until both fit. The note says how many
// replies a cell holds, and since when the strip runs when Claude Code restarted after the session's first reply.
export function fittedStrip(strip, columns, since, now) {
  let { per, cells } = strip;
  const restarted = Number.isFinite(strip.from) && Number.isFinite(since) && strip.from > since;
  const note = () =>
    [per > 1 ? `${per} replies per cell` : null, restarted ? `since ${sinceText(strip.from, now)}` : null]
      .filter(Boolean)
      .join(' · ');
  const room = () => (Number.isFinite(columns) ? Math.max(8, columns - 4 - note().length) : STRIP_CELLS);
  while (cells.length > room()) {
    cells = mergePairs(cells);
    per *= 2;
  }
  return { cells, note: note() };
}
