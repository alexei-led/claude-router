// Routing vs your model: what each main reply cost at configured list prices on the model that served it, against
// the same tokens on the session's own model and effort ("your model"). Counts and dollars only, never text. Pure:
// the hook feeds each reply and keeps the totals in the view and in $.store under SAVINGS_KEY.

import { ratesAt } from './cost.mjs';
import { HISTORY_SHRINK, isSameModel } from './route.mjs';

export const SAVINGS_KEY = 'savings:v1';
// Fewer replies than this read "too early": one switch and its cache write dominate a short run.
export const EARLY_REPLIES = 10;
const TTLS = ['5m', '1h'];

// The model entry an API model id runs on: its configured id, a dated snapshot of it, or the id with a context
// suffix such as `[1m]`. Null when no entry prices it.
export function modelSpec(config, id) {
  if (typeof id !== 'string') return null;
  const bare = id.replace(/\[[^\]]*\]$/, '');
  const dated = (model) => bare.startsWith(model.id) && /^-\d{8}$/.test(bare.slice(model.id.length));
  return Object.values(config.models).find((model) => isSameModel(model.id, bare) || dated(model)) ?? null;
}

// One request's list price in USD: `counts` are its uncached input, cache read, cache write and output tokens, the
// writes at `writeMultiplier` times input. Long-context rates follow the whole prompt.
export function requestUsd(model, { input, cacheRead, cacheWrite, output }, writeMultiplier) {
  const rates = ratesAt(model, input + cacheRead + cacheWrite);
  return (
    (rates.input * (input + cacheWrite * writeMultiplier) + rates.cacheRead * cacheRead + rates.output * output) / 1e6
  );
}

const truthy = (value) => /^(1|true|yes|on)$/i.test(String(value ?? '').trim());

// The prompt-cache lifetime Claude Code gives the main conversation, by its own rule as of 2.1.296: FORCE_PROMPT_CACHING_5M,
// then CLAUDE_CODE_PROMPT_CACHE_TTL, then the `promptCacheTtl` setting, then ENABLE_PROMPT_CACHING_1H, then one hour
// for a Claude plan subscriber and five minutes otherwise. Its usage reports carry no 5m/1h split, so this is how the
// writes are priced. Limit: a subscriber billed as overage gets five minutes, which this cannot see.
export function sessionCacheTtl({ force5m, envTtl, settingTtl, enable1h, subscriber }) {
  if (truthy(force5m)) return '5m';
  if (TTLS.includes(envTtl)) return envTtl;
  if (TTLS.includes(settingTtl)) return settingTtl;
  if (truthy(enable1h) || subscriber) return '1h';
  return '5m';
}

const isCount = (n) => Number.isFinite(n) && n >= 0;

// One main reply. `state` is your model's simulated cache: `{ total, at, onYours }` after a reply, or null at the
// session start and after a compaction, which counts as on your model with nothing cached. `served` is the route the
// reply ran on, `{ model, effort }` with the API's model id; `yours` the session's model and effort.
//
// Routed is the reply's usage on the served model. Yours is the same tokens on your model: while this reply and the
// one before it both ran on your route, the usage itself, so equal routes differ by exactly 0. Otherwise a single
// cache that never switched: it reads the previous prompt, up to this one less its uncached input, if that is inside
// the cache lifetime and no compaction shrank the history, and never less than the API actually read (a shared
// system-prompt cache, a lifetime longer than assumed); it writes the rest. Output tokens stay the same.
//
// The difference splits into the model price (the served model on your cache, against yours: cheaper models when
// negative, stronger than yours when positive) and the cache the switches cost (routed against the served model on
// your cache), never negative. The parts sum to the difference by construction. `reply` is null when a model has no
// price or `ttl` is not a known cache lifetime.
export function compareReply(config, state, { usage, served, yours, ttl, now }) {
  const counts = {
    input: usage?.input_tokens,
    cacheRead: usage?.cache_read_input_tokens,
    cacheWrite: usage?.cache_creation_input_tokens,
    output: usage?.output_tokens,
  };
  if (!Object.values(counts).every(isCount)) return { state, reply: null };
  const total = counts.input + counts.cacheRead + counts.cacheWrite;
  const [servedSpec, yoursSpec] = [modelSpec(config, served.model), modelSpec(config, yours.model)];
  const sameModel = servedSpec ? servedSpec === yoursSpec : served.model === yours.model;
  const onYours = sameModel && (served.effort ?? null) === (yours.effort ?? null);
  const next = { total, at: now, onYours };
  const write = config.cache.writeMultiplier[ttl];
  if (
    !servedSpec ||
    !yoursSpec ||
    !Number.isFinite(servedSpec.output) ||
    !Number.isFinite(yoursSpec.output) ||
    !Number.isFinite(write)
  )
    return { state: next, reply: null };
  const routedUsd = requestUsd(servedSpec, counts, write);
  let yoursUsd = routedUsd;
  let servedOnYoursUsd = routedUsd;
  if (!(onYours && (state?.onYours ?? true))) {
    const warm =
      state && now - state.at < config.cache.ttlMs[ttl] && total >= state.total * HISTORY_SHRINK && state.total > 0;
    const cacheRead = Math.max(counts.cacheRead, warm ? Math.min(state.total, total - counts.input) : 0);
    const single = { ...counts, cacheRead, cacheWrite: total - counts.input - cacheRead };
    yoursUsd = requestUsd(yoursSpec, single, write);
    servedOnYoursUsd = requestUsd(servedSpec, single, write);
  }
  const modelUsd = servedOnYoursUsd - yoursUsd;
  return {
    state: next,
    reply: {
      routedUsd,
      yoursUsd,
      cheaperUsd: Math.min(0, modelUsd),
      strongerUsd: Math.max(0, modelUsd),
      switchUsd: routedUsd - servedOnYoursUsd,
      // The model a stronger reply ran on, for "9 replies on Opus 5.5".
      strongerModel: modelUsd > 0 ? servedSpec.id : null,
    },
  };
}

const SUMS = ['routedUsd', 'yoursUsd', 'cheaperUsd', 'strongerUsd', 'switchUsd'];

// A session's totals: replies, the five sums, and per tier (`none`: not chosen by routing) the replies and their
// routed cost, which the pane's bar and share line draw. `stronger` counts replies by the stronger model they ran on.
export function emptyTotals() {
  return {
    replies: 0,
    routedUsd: 0,
    yoursUsd: 0,
    cheaperUsd: 0,
    strongerUsd: 0,
    switchUsd: 0,
    tiers: {},
    tierUsd: {},
    stronger: {},
  };
}

export function addReply(totals, reply, tier) {
  const key = tier ?? 'none';
  const next = { ...totals, replies: totals.replies + 1 };
  for (const sum of SUMS) next[sum] = totals[sum] + reply[sum];
  next.tiers = { ...totals.tiers, [key]: (totals.tiers[key] ?? 0) + 1 };
  next.tierUsd = { ...totals.tierUsd, [key]: (totals.tierUsd[key] ?? 0) + reply.routedUsd };
  if (reply.strongerModel)
    next.stronger = { ...totals.stronger, [reply.strongerModel]: (totals.stronger[reply.strongerModel] ?? 0) + 1 };
  return next;
}

// The totals kept across sessions: replies and the five sums since `since` (ms), the first reply after a reset.
export function emptySavingsStore() {
  return {
    version: 1,
    since: null,
    replies: 0,
    routedUsd: 0,
    yoursUsd: 0,
    cheaperUsd: 0,
    strongerUsd: 0,
    switchUsd: 0,
  };
}

const STORE_KEYS = Object.keys(emptySavingsStore());

// The stored value if it has the known shape, else an empty store: a missing, hand-edited or unknown value must not
// break a turn or the pane.
export function readSavingsStore(value) {
  const ok =
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === STORE_KEYS.length &&
    STORE_KEYS.every((key) => Object.hasOwn(value, key)) &&
    value.version === 1 &&
    (value.since === null || Number.isFinite(value.since)) &&
    Number.isSafeInteger(value.replies) &&
    value.replies >= 0 &&
    SUMS.every((sum) => Number.isFinite(value[sum]));
  return ok ? { ...value } : emptySavingsStore();
}

// A finished turn's totals added to the store at `now`.
export function recordSavingsStore(store, totals, now) {
  if (!totals.replies) return store;
  const next = { ...store, since: store.since ?? now, replies: store.replies + totals.replies };
  for (const sum of SUMS) next[sum] = store[sum] + totals[sum];
  return next;
}

const cents = (usd) => Math.round(usd * 100);

// What the UI shows for a set of totals, in whole cents so the shown parts add up: the difference is routed less
// yours as shown, and the switch part takes the rounding remainder. A surplus goes to the switch part if the totals
// have one, else to the stronger part if they have one, else to the cheaper part toward 0. A shortfall comes off the
// stronger part down to 0, then the cheaper part. So no part changes sign or appears from rounding alone. `early`
// below EARLY_REPLIES replies. `share` is the difference against yours; `ratio` routed over yours.
export function readout(totals) {
  const [routed, yours, cheaper, stronger] = [
    totals.routedUsd,
    totals.yoursUsd,
    totals.cheaperUsd,
    totals.strongerUsd,
  ].map(cents);
  const difference = routed - yours;
  const rest = difference - cheaper - stronger;
  const switches = totals.switchUsd ? Math.max(0, rest) : 0;
  const surplus = !totals.switchUsd && totals.strongerUsd ? Math.max(0, rest) : 0;
  const strongerShown = Math.max(0, stronger + Math.min(0, rest)) + surplus;
  return {
    replies: totals.replies,
    early: totals.replies < EARLY_REPLIES,
    routedUsd: routed / 100,
    yoursUsd: yours / 100,
    differenceUsd: difference / 100,
    cheaperUsd: (difference - strongerShown - switches) / 100,
    strongerUsd: strongerShown / 100,
    switchUsd: switches / 100,
    share: yours > 0 ? difference / yours : null,
    ratio: yours > 0 ? routed / yours : null,
  };
}
