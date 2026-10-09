// Historical v0.8.0 reference for local acceptance probes; excluded from the published plugin.
// Cache-aware cost of the next request. Pure arithmetic over configured prices and the gateway's memory.
import { clampEffort } from './legacy-rewrite.mjs';

// The prompt cache belongs to a model, and its messages part to the effort too: a top-level effort change rewrites
// the messages cache. Sonnet at `high` and Sonnet at `xhigh` are two caches, not one.
export function cacheKey(modelId, effort) {
  return effort ? `${modelId}@${effort}` : modelId;
}

// The cache a request on `route` uses. `sentEffort` is what Claude Code sent, for a route that keeps it.
export function routeCacheKey(config, route, sentEffort) {
  const model = modelOf(config, route);
  return cacheKey(model.id, clampEffort(route.effort ?? sentEffort, model.efforts));
}

export function isWarm(modelState, now, cache) {
  if (!modelState) return false;
  return now < modelState.lastAt + cache.ttlMs[modelState.ttl] - cache.warmMarginMs;
}

// For the logs: `unknown` means no response for this cache since the session started or its history broke. The cost
// arithmetic treats `unknown` and `expired` alike, as a full write.
export function cacheState(modelState, now, cache) {
  if (!modelState) return 'unknown';
  return isWarm(modelState, now, cache) ? 'warm' : 'expired';
}

function modelOf(config, route) {
  return config.models[route.model];
}

function ttlFor(config, alias, facts) {
  if (config.models[alias].billing === 'credits') return '5m';
  return facts.lastRequest?.ttl ?? '5m';
}

// USD for the input side of one request on `route` with `tokens` of context.
export function inputCostUsd(config, route, tokens, facts, now) {
  const alias = route.model;
  const model = config.models[alias];
  const state = facts.models[routeCacheKey(config, route, facts.effort)];
  const reusable = isWarm(state, now, config.cache) ? Math.min(state.prefixTokens, tokens) : 0;
  const write = model.input * config.cache.writeMultiplier[ttlFor(config, alias, facts)];
  return (model.cacheRead * reusable + write * (tokens - reusable)) / 1e6;
}

export function coldWriteUsd(config, alias, tokens, facts) {
  const model = config.models[alias];
  return (model.input * config.cache.writeMultiplier[ttlFor(config, alias, facts)] * tokens) / 1e6;
}

// Estimated context of the next request: last request plus its output. Tool results and the new prompt are not counted.
export function nextContextTokens(facts) {
  const last = facts.lastRequest;
  return last ? last.tokens + last.outputTokens : 0;
}

export function switchingTaxUsd(config, candidateRoute, incumbentRoute, facts, now) {
  const tokens = nextContextTokens(facts);
  return (
    inputCostUsd(config, candidateRoute, tokens, facts, now) - inputCostUsd(config, incumbentRoute, tokens, facts, now)
  );
}

// Shadow estimate for the decision log; the downgrade tax nets it over a horizon. At list prices, so for `plan` models
// it is a list-price equivalent, not a charge. Output uses the last observed output size for both routes, although
// effort changes how much a model writes.
// - nextTurnUsd: candidate minus incumbent for the next request, input at the current cache state plus output.
// - laterTurnUsd: the same difference for each later turn, once both caches are warm.
// - paybackTurns: 0 when the switch is cheaper at once, n when later turns repay it after n turns, null when never.
export function shadowEconomics(config, candidateRoute, incumbentRoute, facts, now) {
  const candidate = modelOf(config, candidateRoute);
  const incumbent = modelOf(config, incumbentRoute);
  if (candidate.output === undefined || incumbent.output === undefined) return null;
  const tokens = nextContextTokens(facts);
  const outputTokens = facts.lastRequest?.outputTokens ?? 0;
  const outputUsd = ((candidate.output - incumbent.output) * outputTokens) / 1e6;
  const nextTurnUsd = switchingTaxUsd(config, candidateRoute, incumbentRoute, facts, now) + outputUsd;
  const laterTurnUsd = ((candidate.cacheRead - incumbent.cacheRead) * tokens) / 1e6 + outputUsd;
  let paybackTurns = null;
  if (nextTurnUsd <= 0 && laterTurnUsd <= 0) paybackTurns = 0;
  else if (nextTurnUsd > 0 && laterTurnUsd < 0) paybackTurns = Math.ceil(nextTurnUsd / -laterTurnUsd);
  return { nextTurnUsd, laterTurnUsd, paybackTurns, outputTokens };
}

// A downgrade's tax over `turns` turns: the next one plus the later ones, output included. A missing or zero output
// price is unknown, not free, so the tax then falls back to the next request's input alone.
export function downgradeTaxUsd(config, candidateRoute, incumbentRoute, facts, now, turns) {
  const priced = [candidateRoute, incumbentRoute].every((route) => modelOf(config, route).output > 0);
  if (!priced) return Math.max(0, switchingTaxUsd(config, candidateRoute, incumbentRoute, facts, now));
  const { nextTurnUsd, laterTurnUsd } = shadowEconomics(config, candidateRoute, incumbentRoute, facts, now);
  return Math.max(0, nextTurnUsd + (turns - 1) * laterTurnUsd);
}
