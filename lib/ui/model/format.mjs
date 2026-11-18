// Words and dates the tab models share: a count with its noun, the capital a card starts a sentence with, a day and a
// time, and the session strip's note.
import { TIERS } from '../../config.mjs';
import { dayKey } from '../../usage.mjs';

/**
 * A sentence the terminal and a graphical surface word alike (a string) or each their own way.
 * @typedef {string | { terminal: string, graphical: string }} Words
 */

// "1 reply", "3 replies".
export const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

// The model's words start lower case, as the terminal writes them; a card starts them with a capital.
export const sentence = (words) => words.charAt(0).toUpperCase() + words.slice(1);

// A tier as a card labels it: "Micro", "High". Activity and effort words stay lower case.
export const tierLabel = (tier) => sentence(tier);

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

// The note beside the session strip: how many replies a cell holds once cells have merged (`per`), and since when the
// strip runs when Claude Code restarted after the session's first reply.
export function stripNote(strip, per, since, now) {
  const restarted = Number.isFinite(strip.from) && Number.isFinite(since) && strip.from > since;
  return [per > 1 ? `${per} replies per cell` : null, restarted ? `since ${sinceText(strip.from, now)}` : null]
    .filter(Boolean)
    .join(' · ');
}
