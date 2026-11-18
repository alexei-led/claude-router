// API failover: a model whose request ended a turn on an API error is held out of routing for a while, so the next
// turn runs another model. Pure: the hook passes the error Claude Code classified (`StopFailure`'s `error`), the model
// and the clock.

const MINUTE = 60_000;

// How long each error holds the model out. Only errors that are the model's: busy, limited or failing on the provider's
// side, or not served at all. Claude Code does not report a retry-after, so the times are fixed. A model that is not
// found does not come back by itself; an hour bounds the hold in case it was a provider's outage. A billing error, a
// rejected key or request, a cut-off answer and an unknown error are not the model's, so another model would not help.
export const HOLD_MS = {
  rate_limit: 5 * MINUTE,
  overloaded: 5 * MINUTE,
  server_error: 2 * MINUTE,
  model_not_found: 60 * MINUTE,
};

// The words a notice uses for each error.
const ERROR_WORDS = {
  rate_limit: 'rate limited',
  overloaded: 'overloaded',
  server_error: 'server error',
  model_not_found: 'model not found',
};

/** How long `error` holds the failed model out, in milliseconds, or null when it holds nothing. */
export const holdMs = (error) => (Object.hasOwn(HOLD_MS, error) ? HOLD_MS[error] : null);

/** The holds still running at `now`: a hold ends at its `until`. */
export function activeHolds(held, now) {
  return Object.fromEntries(Object.entries(held ?? {}).filter(([, hold]) => hold.until > now));
}

/** The model ids held out at `now`. */
export const heldModels = (held, now) => Object.keys(activeHolds(held, now));

/**
 * The holds after `model` failed with `error` at `now`: expired holds dropped, and the model held for the error's time.
 * A longer hold already running stays. An error that holds nothing changes no hold.
 * @returns {Record<string, { error: string, until: number }>}
 */
export function holdModel(held, model, error, now) {
  const kept = activeHolds(held, now);
  const ms = holdMs(error);
  if (ms === null || typeof model !== 'string' || !model) return kept;
  const running = kept[model];
  if (running && running.until >= now + ms) return kept;
  return { ...kept, [model]: { error, until: now + ms } };
}

/** "overloaded, 5 min": why a model is held out and for how long, rounded up to a minute. */
export function holdText(hold, now) {
  const minutes = Math.max(1, Math.ceil((hold.until - now) / MINUTE));
  return `${ERROR_WORDS[hold.error] ?? hold.error}, ${minutes} min`;
}
