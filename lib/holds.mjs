// What is held out of routing, as the pane, the band, the toast and `/router holds` say it. Pure: the hook reads the
// holds (`{ accounts, models }`: account name and model id to hold, lib/failover.mjs) and passes them in with the clock.

import { accountOf, PLAN_ACCOUNT } from './config.mjs';
import { resetText } from './costs.mjs';
import { modelName } from './display.mjs';
import { holdCause, holdWords, isActive } from './failover.mjs';
import { canonicalModel } from './providers.mjs';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
// A time further away than this reads as a date: "Thu 19:00" would be ambiguous.
const WEEKDAY_SPAN = 6 * DAY;
const NOTHING = 'Nothing is held out of routing.';

/** @typedef {{ accounts?: Record<string, import('./failover.mjs').Hold>, models?: Record<string, import('./failover.mjs').Hold> }} HoldSet Account name and model id to hold. */

/**
 * @typedef {object} HeldRow one hold that is running
 * @property {'account' | 'model'} scope
 * @property {string} key what the store or the loop keeps it under: the account name or the model id
 * @property {string} word what `/router release` takes: the account name, or the model's key in router.json
 * @property {string} name who is held: "Claude plan", an account, or a model's name
 * @property {string} cause "5h limit", "no balance", "overloaded ×2"
 * @property {string} back "back 19:00" or "until released"
 * @property {string} text cause and back, as one phrase
 * @property {string | null} probe "next try 14:00" for a held account that is probed, else null
 * @property {string[]} covers the names of the models an account holds out; none for a model
 * @property {string[]} aliases the models keys in router.json it holds out
 * @property {import('./failover.mjs').Hold} hold
 */

const sameModel = (a, b) => canonicalModel(a) === canonicalModel(b);

/** When a hold ends: "back 19:00", "back Thu 19:00", "back Dec 1", or "until released". */
export function backText(until, now) {
  if (until === null) return 'until released';
  if (until - now > WEEKDAY_SPAN)
    return `back ${new Date(until).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
  return `back ${resetText(until, now) ?? 'now'}`;
}

/** "next try 14:00": when a held account is next tried, in local time, or null for a hold that is not probed. */
export const probeText = (hold, now) =>
  hold.probeAt === undefined ? null : `next try ${resetText(hold.probeAt, now) ?? 'now'}`;

const duration = (ms) => {
  const minutes = Math.max(1, Math.ceil(ms / MINUTE));
  return minutes < 120 ? `${minutes} min` : `${Math.ceil(minutes / 60)} h`;
};

/** "overloaded, 5 min": why a model or account is held out and for how long, rounded up, and its next try. */
export function holdText(hold, now) {
  const end = hold.until === null ? 'until released' : duration(hold.until - now);
  return [holdWords(hold), end, probeText(hold, now)].filter(Boolean).join(', ');
}

/**
 * The holds running at `now`, accounts first. An account's row names the models it holds out; a model's row only itself.
 * @param {Parameters<typeof accountOf>[0]} config
 * @param {HoldSet | null | undefined} holds null before the first read
 * @param {number} now
 * @returns {HeldRow[]}
 */
export function heldRows(config, holds, now) {
  const keys = Object.keys(config.models);
  const running = (/** @type {Record<string, import('./failover.mjs').Hold> | undefined} */ byKey) =>
    Object.entries(byKey ?? {}).filter(([, hold]) => isActive(hold, now));
  const row = (scope, key, word, name, hold, aliases) => ({
    scope,
    key,
    word,
    name,
    cause: holdCause(hold),
    back: backText(hold.until, now),
    text: `${holdCause(hold)} · ${backText(hold.until, now)}`,
    probe: probeText(hold, now),
    covers: scope === 'account' ? [...new Set(aliases.map((alias) => modelName(config.models[alias].id)))] : [],
    aliases,
    hold,
  });
  // A credits model's account is named after it, so the two share a word; the model's row then takes its id.
  const accountWords = new Set(running(holds?.accounts).map(([key]) => key));
  return [
    ...running(holds?.accounts).map(([key, hold]) =>
      row(
        'account',
        key,
        key,
        key === PLAN_ACCOUNT ? 'Claude plan' : key,
        hold,
        keys.filter((alias) => accountOf(config, alias) === key),
      ),
    ),
    ...running(holds?.models).map(([key, hold]) => {
      const aliases = keys.filter((alias) => sameModel(config.models[alias].id, key));
      const word = aliases[0] ?? key;
      return row('model', key, accountWords.has(word) ? key : word, modelName(key), hold, aliases);
    }),
  ];
}

/**
 * Who holds `view.fallback.from`'s model out, with the cause and the end: "Claude plan 5h limit · back 19:00". Without a
 * chain step to name the model, the one hold running is the cause; null when none or several could be.
 */
export function heldCause(config, view, now) {
  const rows = heldRows(config, view.holds, now);
  const from = view.fallback?.from;
  const row = from ? rows.find((one) => one.aliases.includes(from)) : rows.length === 1 ? rows[0] : undefined;
  return row ? `${row.name} ${row.text}` : null;
}

/** The Now tab's why for a turn a chain's target runs: "↷ Opus 5.5 held · fallback 1 of 2". Null for any other turn. */
export function heldWhy(config, view) {
  const { fallback } = view;
  if (view.reason !== 'model-held' || !fallback || !Object.hasOwn(config.models, fallback.from)) return null;
  return `↷ ${modelName(config.models[fallback.from].id)} held · fallback ${fallback.step} of ${fallback.of}`;
}

/** The row `word` names for `/router release`: an account, a model's key or id; else the words that say why not. */
export function releaseRow(config, holds, word, now) {
  const rows = heldRows(config, holds, now);
  if (!word) return { text: rows.length ? `Name what to release: ${rows.map((r) => r.word).join(', ')}.` : NOTHING };
  const own = rows.find((row) => row.word === word || row.key === word);
  if (own) return { row: own };
  const via = rows.find((row) => row.aliases.includes(word));
  if (via)
    return {
      text: `${word} is held through ${via.name}, not on its own: /router release ${via.word}`,
    };
  return { text: rows.length ? `Nothing held under that name. Held: ${rows.map((r) => r.word).join(', ')}.` : NOTHING };
}

/** `/router holds`: one line per hold with its scope, kind, cause and end. */
export function holdsText(config, holds, now) {
  const rows = heldRows(config, holds, now);
  if (!rows.length) return NOTHING;
  return [
    'Held out of routing:',
    ...rows.map(
      (row) =>
        `  ${row.word} (${row.scope}) · ${row.hold.kind}: ${row.text}${row.probe ? ` · ${row.probe}` : ''}${row.covers.length ? ` · holds out ${row.covers.join(', ')}` : ''}`,
    ),
    'End one early with /router release <model|account>.',
  ].join('\n');
}
