// What the Usage model's parts share: a difference in its tone, a chart's data, a route in words, a period's span.
import { routeLabel, signedUsd } from '../../display.mjs';
import { periodRange } from '../../usage.mjs';
import { savingTone } from '../tokens.mjs';
import { dayLabel } from './format.mjs';

/** @typedef {import('../tokens.mjs').Tone} Tone */
/** @typedef {{ text: string, tone: Tone }} Toned */

export const PERIOD_PHRASE = {
  session: 'this session',
  today: 'today',
  '7d': 'in the last 7 days',
  '30d': 'in the last 30 days',
  month: 'this month',
  all: 'yet',
};
/** @returns {Toned} A difference against no routing, signed, in its savings tone. */
export const saving = (value) => ({ text: signedUsd(value), tone: savingTone(value) });
// A comparison that is not available.
/** @type {Toned} */
export const NO_DIFF = { text: '—', tone: 'muted' };
// A cents difference, so a row never reads "+$0.00" for a fraction of a cent.
export const cents = (value) => Math.round(value * 100) / 100;
// A figure that is never NaN on a chart.
export const finite = (value) => (Number.isFinite(value) ? value : 0);

// "Opus 5.5 · high" for a cell's `id@effort`.
export function routeText(route) {
  const at = route.lastIndexOf('@');
  const effort = route.slice(at + 1);
  return routeLabel(route.slice(0, at), effort === 'session' ? null : effort);
}

// "Oct 7 – Oct 13" for a period's span, or "since Oct 10", its `first` day, for one without a range; null without one.
export function spanText(period, now, first) {
  const { from, to } = periodRange(period, now);
  if (period === 'today') return `today, ${dayLabel(to)}`;
  if (from) return `${dayLabel(from)} – ${dayLabel(to)}`;
  return first ? `since ${dayLabel(first)}` : null;
}

// A chart of `points`, its first and last bucket labels, and an alt that states the first, last and peak values.
export function chartOf(title, points, labels, money, at = 'on') {
  const values = points.map(finite);
  const peak = Math.max(...values);
  const when = labels.all[values.indexOf(peak)];
  return {
    points: values,
    labels: [labels.all[0], labels.all.at(-1)],
    alt: `${title}, ${labels.all[0]} to ${labels.all.at(-1)}: first ${money(values[0])}, last ${money(values.at(-1))}, peak ${money(peak)} ${at} ${when}`,
    tone: /** @type {Tone} */ ('accent'),
  };
}

// Prices summed over the priced requests, and how many were not priced (a model without a price in router.json).
export const pricedText = (text, counts) =>
  counts.pricedRequests < counts.requests ? `${text} (${counts.requests - counts.pricedRequests} unpriced)` : text;
