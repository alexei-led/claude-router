// RECENT DECISIONS on the Now tab: one line per turn, saying what ran, on what work and why, with a note under it only
// for what a glance should not miss: a failure, a classifier error, a shadow proposal that differs, a move inside the
// turn. Every row stays in `/router decisions`, which prints them all.

import { TIERS } from '../../config.mjs';
import { percent, shortReason } from '../../display.mjs';
import { clockText } from './format.mjs';
import { routeText } from './usage-shared.mjs';

// The newest turns shown, and the most lines they may take with their notes: past it the oldest turns go, the newest
// always stays.
export const SHOWN_TURNS = 5;
export const MAX_LINES = 10;
const MAX_NOTES = 2;
const DECIDED = ['start', 'review', 'observed'];

/**
 * @typedef {object} DecisionNote a line under a turn, in priority order: failure, classifier error, shadow, move
 * @property {import('../tokens.mjs').Tone | null} tone
 * @property {string} lead `⚠`, `◇ shadow`, `↑ from`
 * @property {string | null} tier the tier whose bars follow the lead
 * @property {string} text
 *
 * @typedef {object} DecisionTurn one turn
 * @property {string} time when it started, `18:18`
 * @property {string} took how long it ran, `42m`; `…` while it runs, `—` for an earlier turn with no end
 * @property {string | null} tier the tier that ran last
 * @property {string} route `Opus 5.5 · xhigh`
 * @property {string | null} work the activity it ran for
 * @property {string} calls its routed requests, `172 req`; `…` while it runs
 * @property {string} why the band's words for the last reason, with the support against the bar where one was weighed
 * @property {import('../tokens.mjs').Tone | null} whyTone
 * @property {DecisionNote[]} notes
 *
 * @typedef {object} DecisionsModel
 * @property {string | null} summary how often shadow would have served the route that ran, over the rows kept
 * @property {DecisionTurn[]} turns oldest first
 * @property {number} earlier turns kept but not shown
 * @property {string} more where every row is
 */

const pad2 = (n) => String(n).padStart(2, '0');
const took = (ms) =>
  ms < 60_000
    ? `${Math.max(0, Math.round(ms / 1000))}s`
    : ms < 3_600_000
      ? `${Math.floor(ms / 60_000)}m`
      : `${Math.floor(ms / 3_600_000)}h${pad2(Math.floor((ms % 3_600_000) / 60_000))}`;
const rank = (tier) => TIERS.indexOf(tier);

// A route by model id: a shadow route names a models key, `opus@xhigh` → `claude-opus-5-5@xhigh`; a row's is an id.
function idRoute(config, route) {
  const at = route.lastIndexOf('@');
  return `${config.models[route.slice(0, at)]?.id ?? route.slice(0, at)}${route.slice(at)}`;
}
// `Opus 5.5 · xhigh`.
const routeName = (config, route) => routeText(idRoute(config, route));

// Whether shadow proposed the route that ran.
const proposes = (config, row) => idRoute(config, row.alt.route) === row.route;

// What a row's agreement compares: what auto would serve, past its move gates. A row from before that field has only
// the ungated target; a later row without it had nothing to serve, so it is not counted.
const comparedRoute = (alt) => alt.serve ?? (alt.move ? null : alt.route);

// A turn's rows: from its start to the next start. Rows before the first start (trimmed away) are a turn too, and a
// failure flushed after its turn ended stays with it.
function turnsOf(rows) {
  const turns = [];
  for (const row of rows) {
    if (row.kind === 'start' || !turns.length) turns.push([]);
    turns.at(-1).push(row);
  }
  return turns;
}

/** @returns {{ why: string, whyTone: import('../tokens.mjs').Tone | null }} */
function whyOf(row) {
  if (!row) return { why: '', whyTone: null };
  const words = shortReason(row.reason, row.activity);
  const weighed =
    Number.isFinite(row.mass) && Number.isFinite(row.bar) ? ` ${percent(row.mass)}/${percent(row.bar)}` : '';
  return { why: `${words}${weighed}`, whyTone: words.startsWith('!') ? 'warning' : null };
}

/** @returns {DecisionNote[]} */
function notesOf(config, rows, decided) {
  const notes = [];
  for (const row of rows.filter((one) => one.kind === 'failure'))
    notes.push({
      tone: 'warning',
      lead: '⚠',
      tier: null,
      text: `${row.err ?? 'API error'} · ${row.fail ? `held ${row.held ?? row.scope ?? row.fail}` : 'held nothing'}`,
    });
  const unanswered = decided.find((row) => row.err);
  if (unanswered) notes.push({ tone: 'warning', lead: '⚠ classifier', tier: null, text: unanswered.err });
  const differs = decided.find(
    (row) => row.engine === 'shadow' && row.alt?.route && row.route && !proposes(config, row),
  );
  if (differs) {
    const { minUsd, maxUsd } = differs.alt;
    const estimate =
      Number.isFinite(minUsd) && Number.isFinite(maxUsd) ? `est $${minUsd.toFixed(2)}–${maxUsd.toFixed(2)}` : null;
    notes.push({
      tone: 'accent',
      lead: '◇ shadow',
      tier: null,
      text: [routeName(config, differs.alt.route), estimate].filter(Boolean).join(' · '),
    });
  }
  const moved = decided.findLastIndex(
    (row, i) => i > 0 && row.route && decided[i - 1].route && row.route !== decided[i - 1].route,
  );
  if (moved > 0) {
    const [before, after] = [decided[moved - 1], decided[moved]];
    const arrow = rank(after.tier) > rank(before.tier) ? '↑' : rank(after.tier) < rank(before.tier) ? '↓' : '→';
    notes.push({
      tone: null,
      lead: `${arrow} from`,
      tier: TIERS.includes(before.tier) ? before.tier : null,
      text: `${routeName(config, before.route)} at ${clockText(after.at)}`,
    });
  }
  return notes.slice(0, MAX_NOTES);
}

// A turn with no end row runs while it is the newest; an earlier one lost its end (an interrupted session).
/** @returns {DecisionTurn} */
function turnOf(config, rows, newest) {
  const decided = rows.filter((row) => DECIDED.includes(row.kind));
  const last = decided.at(-1) ?? null;
  const end = rows.find((row) => row.kind === 'end') ?? null;
  const open = newest ? '…' : '—';
  return {
    time: clockText(rows[0].at),
    took: end ? took(end.at - rows[0].at) : open,
    tier: TIERS.includes(last?.tier) ? last.tier : null,
    route: last?.route ? routeName(config, last.route) : '—',
    work: last?.activity ?? end?.observed ?? null,
    calls: end ? `${end.requests} req` : open,
    ...whyOf(last),
    notes: notesOf(config, rows, decided),
  };
}

/**
 * The block for `rows` (this session's decision rows, oldest first), or null when there are none.
 * @returns {DecisionsModel | null}
 */
export function decisionsOf(config, rows) {
  if (!rows?.length) return null;
  const grouped = turnsOf(rows);
  const all = grouped.map((turn, i) => turnOf(config, turn, i === grouped.length - 1));
  let turns = all.slice(-SHOWN_TURNS);
  const lines = (shown) => shown.reduce((n, turn) => n + 1 + turn.notes.length, 0);
  while (turns.length > 1 && lines(turns) > MAX_LINES) turns = turns.slice(1);
  const checked = rows.filter(
    (row) => DECIDED.includes(row.kind) && row.engine === 'shadow' && row.alt && comparedRoute(row.alt) && row.route,
  );
  const weight = (row) => row.n ?? 1;
  const total = checked.reduce((n, row) => n + weight(row), 0);
  const agreed = checked
    .filter((row) => idRoute(config, comparedRoute(row.alt)) === row.route)
    .reduce((n, row) => n + weight(row), 0);
  return {
    summary: total ? `shadow agrees ${agreed}/${total}` : null,
    turns,
    earlier: all.length - turns.length,
    more: '/router decisions',
  };
}
