import { TIERS } from './config.mjs';
import { cacheKey } from './cost.mjs';
import { clip, extractFacts } from './facts-pure.mjs';
import * as costs from './native-cost.mjs';
import { decide, fitTier, initialState } from './policy.mjs';

// Exact observed API snapshot, not a rule that merges different dated versions.
export const SNAPSHOTS = { 'claude-haiku-4-5': 'claude-haiku-4-5-20251001' };

export function tierForModel(config, id) {
  const order = [config.gateway.baselineTier, ...TIERS.filter((tier) => tier !== config.gateway.baselineTier)];
  return (
    order.find((tier) => {
      const model = config.models[config.routes[tier].model];
      return model.id === id || SNAPSHOTS[model.id] === id;
    }) ?? null
  );
}

export function emptyLoop(config, model) {
  return {
    lastRoute: tierForModel(config, model) ?? config.gateway.baselineTier,
    state: initialState(),
    models: {},
    resolutions: {},
    lastRequest: null,
    historyMeasured: false,
    lastMessageCount: null,
    generation: 0,
    turnId: null,
    decision: null,
    ineligible: [],
  };
}

export function resetHistory(loop) {
  return {
    ...loop,
    generation: loop.generation + 1,
    models: {},
    resolutions: {},
    historyMeasured: false,
    state: { ...loop.state, votes: [], holdUntilTurn: 0, escalatedSignature: null },
    turnId: null,
    decision: null,
    ineligible: [],
    suspended: false,
  };
}

export function prepareLoop(loop, messageCount) {
  const next = loop.lastMessageCount !== null && messageCount < loop.lastMessageCount ? resetHistory(loop) : loop;
  return { ...next, lastMessageCount: messageCount };
}

export function nativeFacts(config, loop, { messages, prompt, effort, turnId, contextTokens }) {
  const facts = extractFacts({ messages, output_config: { effort } }, loop, config.context, () => turnId);
  if (typeof prompt === 'string') facts.prompt = clip(prompt, config.context.maxTextChars);
  return { ...facts, pin: null, contextTokens, turnKey: turnId };
}

export function isModelAllowed(id, available, nativeModel) {
  if (available === undefined) return true;
  if (!Array.isArray(available) || !available.every((v) => typeof v === 'string')) return false;
  if (available.includes('default') && id === nativeModel) return true;
  const family = /^claude-(opus|sonnet|haiku)-/.exec(id)?.[1];
  const specific = available.filter((v) => family && v.startsWith(`claude-${family}-`));
  if (specific.length) return specific.some((v) => id === v || id.startsWith(`${v}-`));
  return available.some((v) => id === v || id.startsWith(`${v}-`) || (family && v === family));
}

function economicConfig(config, loop) {
  const models = Object.fromEntries(
    Object.entries(config.models).map(([alias, model]) => [
      alias,
      { ...model, id: Object.hasOwn(loop.resolutions, model.id) ? loop.resolutions[model.id] : model.id },
    ]),
  );
  return { ...config, models };
}

export function chooseRoute(config, loop, { facts, advice, pin, nativeModel, contextKnown, availableModels, now }) {
  const projected = economicConfig(config, loop);
  let result =
    pin && TIERS.includes(pin)
      ? { tier: pin, reason: 'pinned', state: { ...loop.state, turn: loop.state.turn + 1 } }
      : decide({
          config: projected,
          facts,
          advice,
          state: loop.state,
          baseline: config.gateway.baselineTier,
          now,
          costs,
        });
  const fits = (tier) => {
    const model = config.models[config.routes[tier].model];
    if (
      (!contextKnown || !loop.historyMeasured) &&
      model.contextWindow < config.models[config.routes[loop.lastRoute].model].contextWindow
    )
      return false;
    return (
      isModelAllowed(model.id, availableModels, nativeModel) &&
      !loop.ineligible.includes(model.id) &&
      (!contextKnown || costs.nextContextTokens(facts) <= model.contextWindow * 0.8)
    );
  };
  if (contextKnown) {
    const fitted = fitTier(config, result.tier, costs.nextContextTokens(facts));
    if (fitted !== result.tier) result = { ...result, tier: fitted, reason: 'context-fit' };
  }
  if (
    (!contextKnown || !loop.historyMeasured) &&
    config.models[config.routes[result.tier].model].contextWindow <
      config.models[config.routes[loop.lastRoute].model].contextWindow
  ) {
    result = { ...result, tier: loop.lastRoute, reason: 'context-unknown' };
  }
  if (!fits(result.tier)) {
    const fallback = [loop.lastRoute, tierForModel(config, nativeModel), ...TIERS].find((tier) => tier && fits(tier));
    result = { ...result, tier: fallback ?? null, reason: 'model-unavailable' };
  }
  const model = result.tier ? config.models[config.routes[result.tier].model].id : nativeModel;
  const effort = result.tier ? costs.routeEffort(config, result.tier, facts.effort) : facts.effort;
  let comparison = null;
  const candidate = pin ?? advice?.choice;
  if (contextKnown && loop.lastRequest && TIERS.includes(candidate) && candidate !== loop.lastRoute) {
    const tokens = costs.nextContextTokens(facts);
    const proposed = costs.inputBounds(projected, candidate, tokens, facts, now);
    const incumbent = costs.inputBounds(projected, loop.lastRoute, tokens, facts, now);
    const forecast = costs.shadowEconomics(projected, candidate, loop.lastRoute, facts, now);
    const output =
      ((projected.models[projected.routes[candidate].model].output -
        projected.models[projected.routes[loop.lastRoute].model].output) *
        loop.lastRequest.outputTokens) /
      1e6;
    comparison = {
      candidate,
      incumbent: loop.lastRoute,
      minUsd: proposed.min - incumbent.max + output,
      maxUsd: proposed.max - incumbent.min + output,
      paybackTurns: forecast?.paybackTurns ?? null,
      outputTokens: loop.lastRequest.outputTokens,
    };
  }
  const decision = { ...result, model, effort, comparison, pinned: Boolean(pin), requestedPin: pin ?? null };
  return {
    ...loop,
    state: result.state,
    lastRoute: pin ? loop.lastRoute : (result.tier ?? loop.lastRoute),
    turnId: facts.turnKey,
    decision,
    suspended: false,
  };
}

export function continueRoute(config, loop, { nativeModel, contextTokens, contextKnown, availableModels, effort }) {
  if (!loop.decision) return loop;
  let decision = loop.decision;
  if (contextKnown && decision.tier) {
    const fitted = fitTier(config, decision.tier, contextTokens);
    if (fitted !== decision.tier)
      decision = {
        ...decision,
        tier: fitted,
        model: config.models[config.routes[fitted].model].id,
        effort: costs.routeEffort(config, fitted, effort),
        reason: 'context-fit',
      };
  }
  if (!isModelAllowed(decision.model, availableModels, nativeModel) || loop.ineligible.includes(decision.model)) {
    decision = { ...decision, tier: null, model: nativeModel, effort, reason: 'model-unavailable' };
  }
  return { ...loop, decision };
}

export function observeResponse(_config, loop, { usage, requestedModel, effort, stopReason, now }) {
  let next = loop;
  if (stopReason === 'model_context_window_exceeded') {
    next = { ...next, ineligible: [...new Set([...next.ineligible, requestedModel])] };
  }
  if (!usage?.model) return next;
  const sameModel = requestedModel === usage.model || SNAPSHOTS[requestedModel] === usage.model;
  if (!sameModel) next = { ...next, suspended: true };
  const counts = ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'output_tokens'];
  if (!counts.every((key) => Number.isFinite(usage[key]) && usage[key] >= 0)) return next;
  const tokens = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens;
  if (tokens === 0) return next;
  const resolutions = sameModel ? { ...next.resolutions, [requestedModel]: usage.model } : { ...next.resolutions };
  if (!sameModel) delete resolutions[requestedModel];
  let models = next.models;
  if (next.lastRequest && tokens < next.lastRequest.tokens * 0.8) models = {};
  // A substituted model's effort is not reported, so do not credit its estimated cache.
  if (sameModel)
    models = {
      ...models,
      [cacheKey(usage.model, effort)]: {
        lastAt: now,
        prefixTokens: usage.cache_read_input_tokens + usage.cache_creation_input_tokens,
      },
    };
  return {
    ...next,
    historyMeasured: true,
    models,
    resolutions,
    lastRequest: {
      model: usage.model,
      tokens,
      outputTokens: usage.output_tokens,
      cacheReadTokens: usage.cache_read_input_tokens,
      cacheWriteTokens: usage.cache_creation_input_tokens,
      at: now,
    },
  };
}
