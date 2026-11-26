// API failover: a model whose request ended a turn on an API error is held out of routing for a while, so the next
// turn runs another model. Pure: the hook passes the error Claude Code classified (`StopFailure`'s `error`), its
// optional text, the plan readings, the model and the clock.
//
// A failure is one of four kinds (docs/plans/2026-11-19-fallback-chains.md). `availability` holds the model alone, for
// a time that doubles with each failed retry. `window`, `calendar` and `balance` are used-up quota: they hold every
// model of the account until the quota comes back, so a retry would only lose another turn. A spend cap or a balance
// can be raised or recharged before that, so those holds also let one main turn try again on a backoff (a probe).

import { accountOf, PLAN_ACCOUNT } from './config.mjs';
import { canonicalModel } from './providers.mjs';
import { isRecord } from './records.mjs';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
// The wait for a quota hold's first probe, doubled by each failed one, and its longest.
const PROBE_MS = 60 * MINUTE;
const PROBE_CAP_MS = DAY;

// How long each error holds the model out on its first failure. Only errors that are the model's: busy, limited or
// failing on the provider's side, or not served at all. Claude Code does not report a retry-after, so the times are
// fixed. A model that is not found does not come back by itself; an hour bounds the hold in case it was a provider's
// outage. A rejected key or request, a cut-off answer and an unknown error are not the model's, so another model would
// not help.
export const HOLD_MS = {
  rate_limit: 5 * MINUTE,
  overloaded: 5 * MINUTE,
  server_error: 2 * MINUTE,
  model_not_found: 60 * MINUTE,
};

// Each failed retry of a model with the same error doubles its hold, up to an hour.
export const HOLD_CAP_MS = 60 * MINUTE;
// The plan reports a window's reset to the minute; a request a minute later finds it open.
const WINDOW_LAG_MS = MINUTE;
const WINDOW_CAP_MS = 7 * DAY;
// A calendar limit on an account with no configured reset is retried the next day.
const CALENDAR_DEFAULT_MS = DAY;

// The store key of an account's hold: `holds/<account>`. Account holds outlive a session, so every session sees them.
export const HOLDS_PREFIX = 'holds/';
export const HOLD_KINDS = ['availability', 'window', 'calendar', 'balance'];

// The words a notice uses for each error, and for each quota kind.
const ERROR_WORDS = {
  rate_limit: 'rate limited',
  overloaded: 'overloaded',
  server_error: 'server error',
  model_not_found: 'model not found',
};
const KIND_WORDS = { window: 'usage limit', calendar: 'spend limit', balance: 'no balance' };

/** How long `error` holds the failed model out on its first failure, in milliseconds, or null when it holds nothing. */
export const holdMs = (error) => (Object.hasOwn(HOLD_MS, error) ? HOLD_MS[error] : null);

const PLAN_WINDOWS = ['five_hour', 'seven_day'];
// Only these errors can be a used-up quota. Any other error with a "credit" in its text is not one: a rejected key
// names no balance.
const QUOTA_ERRORS = ['rate_limit', 'billing_error'];
// A plan window comes back by itself, so the text of one is read as no spend cap or balance, whatever else it says: the
// window is what blocks ("monthly spend limit · … your 5-hour limit resets 12:40am"). A billing error naming one stays
// a balance.
const WINDOW_TEXT = /\b(?:session|5-hour|weekly) limit\b/i;
// Tested before BALANCE: a spend cap's text can name credits ("run /usage-credits").
const SPEND_CAP = /spend limit|individual usage limit|usage credit limit|pooled group budget|usage is paused/i;
const BALANCE = /balance|recharge|credit|out of (?:extra )?usage|add funds/i;

/** @typedef {{ kind: 'availability' | 'window' | 'calendar' | 'balance' | null, scope: 'model' | 'account', until: number | null, window?: string }} Failure A `window` failure names the plan window that ended last. */

// The wall clock of instant `ms` in time zone `tz`.
function zoneParts(ms, tz) {
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  });
  const parts = { year: 1970, month: 1, day: 1, hour: 0, minute: 0, second: 0 };
  for (const { type, value } of format.formatToParts(ms)) if (type in parts) parts[type] = Number(value);
  return parts;
}

const zoneOffset = (ms, tz) => {
  const p = zoneParts(ms, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
};

// Midnight of `day` in `month` (0-based, may run into the next year) of `year` in `tz`, as an instant. The zone's
// offset is read at the guess and again at the result, so a change of offset between them (daylight saving) still lands
// on midnight. A zone with no midnight that day lands an hour off; resets fall on days 1 to 28, where that is rare, and
// a request an hour early or late is only a retry.
function zoneMidnight(year, month, day, tz) {
  const guess = Date.UTC(year, month, day);
  return guess - zoneOffset(guess - zoneOffset(guess, tz), tz);
}

/** The next instant after `now` at which `reset` (`{ monthly, tz }`) starts a new month of the account's quota. */
export function nextReset(reset, now) {
  const { year, month } = zoneParts(now, reset.tz);
  const thisMonth = zoneMidnight(year, month - 1, reset.monthly, reset.tz);
  return thisMonth > now ? thisMonth : zoneMidnight(year, month, reset.monthly, reset.tz);
}

/**
 * Why a main request failed, and what to hold. `limits` are the plan windows as planLimits reads them (`resetsAt` in
 * ms), `billing` how the session pays (billingOf), `planAccounts` the accounts of the plan-billed models, `account` the
 * failed model's account (null when no configured model ran it), `accounts` the configured accounts. Only the Claude plan
 * reports window readings, so a full window is the failed model's only when every plan-billed model is in the plan
 * account; with plan models in two accounts the reading cannot say which one it is. A session that also pays credits
 * still has the plan's windows. The evidence is tried in order: the plan readings, the text Claude Code
 * gave (absent on some builds), then the error word. Reset times come only from readings or config, never from text.
 * `until` is when an account's hold ends; a model hold's end depends on its retries (failureHold), and a balance has
 * none, so both read null.
 * @returns {Failure}
 */
export function classifyFailure({ error, details, limits, billing, planAccounts, account, accounts, now }) {
  /** @type {Failure} */
  const none = { kind: null, scope: 'model', until: null };
  const isPlan = (name) => name === PLAN_ACCOUNT;
  /** @returns {Failure} */
  const quota = (kind, until) => (account === null ? none : { kind, scope: 'account', until });
  // The failed model ran on the Claude plan, whose quota comes back at a window's reset: not a balance to recharge.
  const onPlan = account === PLAN_ACCOUNT && billing !== 'billed';
  if (error === 'rate_limit' && onPlan && planAccounts.every(isPlan)) {
    const used = (limits ?? []).filter(
      (limit) => PLAN_WINDOWS.includes(limit.kind) && limit.percent >= 100 && limit.resetsAt > now,
    );
    const last = used.reduce((a, b) => (b.resetsAt > a.resetsAt ? b : a), used[0]);
    if (last)
      return {
        ...quota('window', Math.min(last.resetsAt + WINDOW_LAG_MS, now + WINDOW_CAP_MS)),
        window: last.kind,
      };
  }
  const text = QUOTA_ERRORS.includes(error) && typeof details === 'string' ? details : '';
  const namesWindow = WINDOW_TEXT.test(text);
  if (!namesWindow && SPEND_CAP.test(text)) {
    const reset = account === null ? undefined : accounts?.[account]?.reset;
    return quota('calendar', reset ? nextReset(reset, now) : now + CALENDAR_DEFAULT_MS);
  }
  // A plan's rate limit can name its extra usage credits; held until released, the plan would never come back.
  if (!namesWindow && BALANCE.test(text) && !(error === 'rate_limit' && onPlan)) return quota('balance', null);
  if (error === 'billing_error') return quota('balance', null);
  if (holdMs(error) !== null) return { kind: 'availability', scope: 'model', until: null };
  return none;
}

/**
 * @typedef {{ kind: string, error: string, since: number, until: number | null, streak: number, window?: string, probeAt?: number }} Hold
 * A hold: why, since when, until when (null: until released) and how many failures in a row (a quota hold starts at one
 * and counts its failed probes). A window hold also names the plan window it waits for; a calendar or balance hold, the
 * time from which one main turn may try the account again.
 */

// A hold with no `until` never ends by itself.
const endOf = (hold) => hold.until ?? Number.POSITIVE_INFINITY;
export const isActive = (hold, now) => hold.until === null || hold.until > now;

// A window's reset is read from the plan; only these quota holds can end earlier than they say.
const isProbed = (hold) => hold.kind === 'calendar' || hold.kind === 'balance';
const probeWait = (streak) => Math.min(PROBE_MS * 2 ** (streak - 1), PROBE_CAP_MS);

// `hold` with its next probe at `at`, or with none when the hold ends no later than that.
/**
 * @param {Hold} hold
 * @param {number} at
 * @returns {Hold}
 */
function withProbe({ probeAt: _, ...hold }, at) {
  return at < endOf(hold) ? { ...hold, probeAt: at } : hold;
}

/** The quota hold after its probe at `now` got no reply: the next one waits twice as long. */
export function probeFailed(hold, now) {
  const streak = hold.streak + 1;
  return withProbe({ ...hold, streak }, now + probeWait(streak));
}

/**
 * The accounts whose hold is still running at `now` and is due a probe.
 * @param {Record<string, Hold> | undefined} accountHolds
 * @returns {string[]}
 */
export function dueProbes(accountHolds, now) {
  return Object.entries(activeHolds(accountHolds, now))
    .filter(([, hold]) => hold.probeAt !== undefined && hold.probeAt <= now)
    .map(([account]) => account);
}

/**
 * The hold a failure puts on its scope, given the hold `running` there (active or not), or null when it holds nothing.
 * A model that fails again after its hold ended with the same error doubles the time, up to an hour; a failure during a
 * hold is not a retry and leaves it. A quota hold's length is never doubled. A hold already running that ends later
 * stays, and one that replaces a running quota hold keeps the backoff its probes reached. A failure never counts as a
 * failed probe, even once one is due: any request can fail then, and only the main request that tried the probe puts
 * the next one off (probeFailed).
 * @param {Failure} failure
 * @param {Hold | undefined} running
 * @returns {Hold | null}
 */
export function failureHold(failure, error, running, now) {
  if (failure.kind === null) return null;
  const active = running && isActive(running, now) ? running : null;
  /** @type {Hold} */
  let hold;
  if (failure.kind === 'availability') {
    const base = holdMs(error);
    if (base === null) return null;
    const retry = running?.kind === 'availability' && running.error === error;
    if (active && retry) return active;
    const streak = retry ? running.streak + 1 : 1;
    hold = {
      kind: 'availability',
      error,
      since: now,
      until: now + Math.min(base * 2 ** (streak - 1), HOLD_CAP_MS),
      streak,
    };
  } else
    hold = {
      kind: failure.kind,
      error,
      since: now,
      until: failure.until,
      streak: 1,
      ...(failure.window ? { window: failure.window } : {}),
    };
  const probed = active && isProbed(active) ? active : null;
  if (active && endOf(active) >= endOf(hold)) return active;
  if (!isProbed(hold)) return hold;
  const streak = probed?.streak ?? 1;
  return withProbe({ ...hold, streak }, probed?.probeAt ?? now + probeWait(streak));
}

/**
 * The holds still running at `now`.
 * @param {Record<string, Hold> | undefined} held
 */
export function activeHolds(held, now) {
  return Object.fromEntries(Object.entries(held ?? {}).filter(([, hold]) => isActive(hold, now)));
}

/** The model ids held out at `now`. */
export const heldModels = (held, now) => Object.keys(activeHolds(held, now));

/**
 * The model holds after `model` failed with `error` at `now`. A hold that ended stays, as the memory of how many
 * retries failed, until the model answers (clearedModel). A failure that holds nothing changes no hold.
 * @param {Record<string, Hold> | undefined} held
 * @param {Failure} failure
 * @returns {Record<string, Hold>}
 */
export function holdModel(held, model, failure, error, now) {
  if (typeof model !== 'string' || !model) return held ?? {};
  // A hold under another spelling of the id is this model's: it keeps its key, so its streak carries on.
  const key = heldKey(held, model) ?? model;
  const hold = failureHold(failure, error, held?.[key], now);
  return hold ? { ...held, [key]: hold } : (held ?? {});
}

const sameKey = (a, b) => canonicalModel(a) === canonicalModel(b);

/** The key under which `held` holds `model`, as routing matches ids, or undefined when it holds none. */
export const heldKey = (held, model) => Object.keys(held ?? {}).find((key) => sameKey(key, model));

/** The model holds without `model`'s, which answered: its streak starts over. The same object when it had none. */
export function clearedModel(held, model) {
  if (!held || !Object.keys(held).some((key) => sameKey(key, model))) return held;
  return Object.fromEntries(Object.entries(held).filter(([key]) => !sameKey(key, model)));
}

/**
 * The model holds after `model` answered at `at`: its hold ends, unless it was set after that reply (a failure that
 * followed the answer). The same object when there is nothing to clear.
 * @param {Record<string, Hold> | undefined} held
 * @param {string} model
 * @param {number} at
 */
export function clearedSince(held, model, at) {
  const key = heldKey(held, model);
  if (key === undefined) return held;
  if (held?.[key] && held[key].since > at) return held;
  return Object.fromEntries(Object.entries(held ?? {}).filter(([name]) => name !== key));
}

/** The holds without `key`: a release of a model or an account. The same object when it held nothing. */
export function releaseHold(holds, key) {
  if (!holds || !Object.hasOwn(holds, key)) return holds;
  return Object.fromEntries(Object.entries(holds).filter(([name]) => name !== key));
}

/** The account of the configured model that `id` names, or null when none does. */
export function accountOfModel(config, id) {
  if (typeof id !== 'string') return null;
  const alias = Object.keys(config.models).find((key) => sameKey(config.models[key].id, id));
  return alias === undefined ? null : accountOf(config, alias);
}

/** The distinct accounts of the models billed to a plan, in the order of the models. */
export const planAccountsOf = (config) => [
  ...new Set(
    Object.keys(config.models)
      .filter((alias) => config.models[alias].billing === 'plan')
      .map((alias) => accountOf(config, alias)),
  ),
];

/** Every account some configured model belongs to, in the order of the models. */
export const accountNames = (config) => [
  ...new Set(Object.keys(config.models).map((alias) => accountOf(config, alias))),
];

/** The stored value as a hold, or null when it does not read as one: a hand edit never breaks a turn. */
export function readHold(value) {
  if (!isRecord(value) || !HOLD_KINDS.includes(value.kind) || typeof value.error !== 'string') return null;
  const { since, until, streak, probeAt } = value;
  if (!Number.isFinite(since) || !(until === null || Number.isFinite(until)) || !Number.isSafeInteger(streak))
    return null;
  return {
    kind: value.kind,
    error: value.error,
    since,
    until,
    streak,
    ...(PLAN_WINDOWS.includes(value.window) ? { window: value.window } : {}),
    ...(Number.isFinite(probeAt) ? { probeAt } : {}),
  };
}

/**
 * The ids of the configured models held out at `now`: those with a model hold in `held`, and every model of an account
 * with a hold in `accountHolds` (account name to hold). What routing skips.
 */
export function heldIds(config, held, accountHolds, now) {
  const covered = Object.keys(config.models)
    .filter((alias) => {
      const hold = accountHolds?.[accountOf(config, alias)];
      return hold && isActive(hold, now);
    })
    .map((alias) => config.models[alias].id);
  return [...new Set([...heldModels(held, now), ...covered])];
}

/**
 * The held ids as candidates name them: each id plus the snapshot a reply resolved it to. A hold is written under the
 * requested id, while a candidate priced with a resolution (economicConfig) carries the served, often dated id.
 * @param {string[]} held
 * @param {Record<string, string> | undefined} resolutions
 */
export function heldAsSeen(held, resolutions) {
  /** @type {string[]} */
  const seen = [];
  for (const id of held) {
    const resolved = resolutions?.[id];
    if (typeof resolved === 'string' && resolved !== '') seen.push(resolved);
  }
  return seen.length ? [...new Set([...held, ...seen])] : held;
}

const WINDOW_WORDS = { five_hour: '5h limit', seven_day: '7d limit' };

/** Why a hold holds, as the pane says it: "5h limit", "spend limit", "no balance", "overloaded ×2". */
export function holdCause(hold) {
  if (hold.kind === 'window') return WINDOW_WORDS[hold.window] ?? KIND_WORDS.window;
  if (hold.kind !== 'availability') return KIND_WORDS[hold.kind];
  const words = ERROR_WORDS[hold.error] ?? hold.error;
  return hold.streak > 1 ? `${words} ×${hold.streak}` : words;
}

/** The words a notice uses for a hold: its error for a model's, its quota kind for an account's. */
export const holdWords = (hold) =>
  hold.kind === 'availability' ? (ERROR_WORDS[hold.error] ?? hold.error) : KIND_WORDS[hold.kind];
