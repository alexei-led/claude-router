// Cache-aware cost of the next request. Pure arithmetic over configured prices and the gateway's memory.
import { clampEffort } from './rewrite.mjs';

// The prompt cache belongs to a model, and its messages part to the effort too: a top-level effort change rewrites
// the messages cache. Opus at `high` and Opus at `xhigh` are two caches, not one.
export function cacheKey(modelId, effort) {
  return effort ? `${modelId}@${effort}` : modelId;
}

// The cache a request routed to `tier` uses. `sentEffort` is what Claude Code sent, for a route that keeps it.
export function routeCacheKey(config, tier, sentEffort) {
  const model = modelOf(config, tier);
  return cacheKey(model.id, clampEffort(config.routes[tier].effort ?? sentEffort, model.efforts));
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

function modelOf(config, tier) {
  return config.models[config.routes[tier].model];
}

function ttlFor(config, alias, facts) {
  if (config.models[alias].billing === 'credits') return '5m';
  return facts.lastRequest?.ttl ?? '5m';
}

// USD for the input side of one request routed to `tier` with `tokens` of context.
export function inputCostUsd(config, tier, tokens, facts, now) {
  const alias = config.routes[tier].model;
  const model = config.models[alias];
  const state = facts.models[routeCacheKey(config, tier, facts.effort)];
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

export function switchingTaxUsd(config, candidateTier, incumbentTier, facts, now) {
  const tokens = nextContextTokens(facts);
  return (
    inputCostUsd(config, candidateTier, tokens, facts, now) - inputCostUsd(config, incumbentTier, tokens, facts, now)
  );
}

// Shadow estimate for the decision log; the policy does not read it. At list prices, so for `plan` models it is a
// list-price equivalent, not a charge. Output uses the last observed output size for both routes, although effort
// changes how much a model writes.
// - nextTurnUsd: candidate minus incumbent for the next request, input at the current cache state plus output.
// - laterTurnUsd: the same difference for each later turn, once both caches are warm.
// - paybackTurns: 0 when the switch is cheaper at once, n when later turns repay it after n turns, null when never.
export function shadowEconomics(config, candidateTier, incumbentTier, facts, now) {
  const candidate = modelOf(config, candidateTier);
  const incumbent = modelOf(config, incumbentTier);
  if (candidate.output === undefined || incumbent.output === undefined) return null;
  const tokens = nextContextTokens(facts);
  const outputTokens = facts.lastRequest?.outputTokens ?? 0;
  const outputUsd = ((candidate.output - incumbent.output) * outputTokens) / 1e6;
  const nextTurnUsd = switchingTaxUsd(config, candidateTier, incumbentTier, facts, now) + outputUsd;
  const laterTurnUsd = ((candidate.cacheRead - incumbent.cacheRead) * tokens) / 1e6 + outputUsd;
  let paybackTurns = null;
  if (nextTurnUsd <= 0 && laterTurnUsd <= 0) paybackTurns = 0;
  else if (nextTurnUsd > 0 && laterTurnUsd < 0) paybackTurns = Math.ceil(nextTurnUsd / -laterTurnUsd);
  return { nextTurnUsd, laterTurnUsd, paybackTurns, outputTokens };
}
