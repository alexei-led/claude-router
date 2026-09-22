// Cache-aware input cost of the next request. Pure arithmetic over configured prices and the gateway's memory.

export function isWarm(modelState, now, cache) {
  if (!modelState) return false;
  return now < modelState.lastAt + cache.ttlMs[modelState.ttl] - cache.warmMarginMs;
}

function ttlFor(config, alias, facts) {
  if (config.models[alias].billing === 'credits') return '5m';
  return facts.lastRequest?.ttl ?? '5m';
}

// USD for the input side of one request on `alias` with `tokens` of context.
export function inputCostUsd(config, alias, tokens, facts, now) {
  const model = config.models[alias];
  const state = facts.models[model.id];
  const reusable = isWarm(state, now, config.cache) ? Math.min(state.prefixTokens, tokens) : 0;
  const ttl = ttlFor(config, alias, facts);
  const write = model.input * config.cache.writeMultiplier[ttl];
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

export function switchingTaxUsd(config, candidateAlias, incumbentAlias, facts, now) {
  const tokens = nextContextTokens(facts);
  return (
    inputCostUsd(config, candidateAlias, tokens, facts, now) - inputCostUsd(config, incumbentAlias, tokens, facts, now)
  );
}
