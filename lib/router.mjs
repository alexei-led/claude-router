// Per-request orchestration: facts -> advice -> policy -> rewritten body. Knows nothing about HTTP.
import { factsFromRequest } from './facts.mjs';
import { askJev } from './jev.mjs';
import { decide, initialState } from './policy.mjs';
import { rewriteRequest } from './rewrite.mjs';
import { appendLog, loadMemory, saveMemory } from './store.mjs';

const COMPACTION_SHRINK = 0.8;

export function emptyMemory() {
  return { lastRoute: null, lastRequest: null, models: {}, state: null };
}

export class Router {
  constructor({ config, fetchFn, dataDir, now = Date.now }) {
    this.config = config;
    this.fetchFn = fetchFn;
    this.dataDir = dataDir;
    this.now = now;
    this.memories = new Map();
  }

  isRouted(body) {
    return body?.model === this.config.gateway.alias;
  }

  // Returns { body, tier, reason, auxiliary }. The caller forwards `body` and records the response
  // usage only when `auxiliary` is false: side requests carry their own context sizes.
  async route(body, { sessionId, requestClass }) {
    const memory = this.memory(sessionId);
    const facts = factsFromRequest(body, memory, this.config.context);
    const auxiliary = requestClass ? requestClass !== 'main' : isAuxiliaryShape(body);
    let decision;
    if (auxiliary) decision = { tier: this.config.gateway.auxiliaryTier, reason: 'auxiliary', state: memory.state };
    else if (facts.continuation && memory.lastRoute)
      decision = { tier: memory.lastRoute, reason: 'tool-continuation', state: memory.state };
    else decision = await this.decideTurn(facts, memory);
    if (!auxiliary) {
      memory.lastRoute = decision.tier;
      memory.state = decision.state;
      this.persist(sessionId, memory);
    }
    this.log({
      session: sessionId,
      requestClass,
      tier: decision.tier,
      reason: decision.reason,
      estimate: decision.estimate ?? null,
      advice: decision.advice ?? null,
      adviceError: decision.adviceError ?? null,
      contextTokens: memory.lastRequest?.tokens ?? 0,
    });
    return {
      body: rewriteRequest(body, decision.tier, this.config),
      tier: decision.tier,
      reason: decision.reason,
      auxiliary,
    };
  }

  // Used when routing itself failed: the alias must never reach Anthropic.
  fallback(body) {
    const tier = this.config.gateway.baselineTier;
    return { body: rewriteRequest(body, tier, this.config), tier, reason: 'error', auxiliary: true };
  }

  async decideTurn(facts, memory) {
    const state = memory.state ?? initialState();
    const { forcedTier, apiKey, gateway } = this.config;
    if (forcedTier) return { tier: forcedTier, reason: 'forced', state: { ...state, turn: state.turn + 1 } };
    let advice = null;
    let adviceError = null;
    if (apiKey && facts.prompt) {
      try {
        advice = await askJev({
          fetchFn: this.fetchFn,
          config: this.config,
          apiKey,
          prompt: facts.prompt,
          turns: facts.turns,
          now: this.now,
        });
      } catch (error) {
        adviceError = error.message;
      }
    }
    const decision = decide({
      config: this.config,
      facts,
      advice,
      state,
      baseline: gateway.baselineTier,
      now: this.now(),
    });
    return { ...decision, advice, adviceError };
  }

  // Called with the usage the gateway read from a forwarded main-conversation response.
  recordResponse(sessionId, tier, usage) {
    if (!usage) return;
    const memory = this.memory(sessionId);
    const modelId = usage.model ?? this.config.models[this.config.routes[tier].model].id;
    const at = this.now();
    // A context that shrank is a compaction: every model's cached prefix is gone.
    if (memory.lastRequest && usage.tokens < memory.lastRequest.tokens * COMPACTION_SHRINK) memory.models = {};
    memory.lastRequest = {
      model: modelId,
      tokens: usage.tokens,
      cacheReadTokens: usage.cacheReadTokens,
      outputTokens: usage.outputTokens,
      ttl: usage.ttl,
      at,
    };
    memory.models[modelId] = { lastAt: at, prefixTokens: usage.tokens + usage.outputTokens, ttl: usage.ttl };
    this.persist(sessionId, memory);
    this.log({ session: sessionId, observed: { ...usage, model: modelId, tier } });
  }

  memory(sessionId) {
    if (!this.memories.has(sessionId)) this.memories.set(sessionId, loadMemory(this.dataDir, sessionId, emptyMemory()));
    return this.memories.get(sessionId);
  }

  persist(sessionId, memory) {
    saveMemory(this.dataDir, sessionId, memory);
  }

  log(entry) {
    if (this.config.log) appendLog(this.dataDir, { at: new Date(this.now()).toISOString(), ...entry });
  }
}

// Without the request-class hint header: side requests (titles, classifiers) turn thinking off and ask for a schema.
function isAuxiliaryShape(body) {
  return body.thinking?.type === 'disabled' || Boolean(body.output_config?.format);
}
