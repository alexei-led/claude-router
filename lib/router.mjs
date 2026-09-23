// Per-request orchestration: facts -> advice -> policy -> rewritten body. Knows nothing about HTTP.
import { nextContextTokens } from './cost.mjs';
import { factsFromRequest } from './facts.mjs';
import { askJev } from './jev.mjs';
import { decide, fitTier, initialState } from './policy.mjs';
import { rewriteRequest } from './rewrite.mjs';
import { appendLog, loadMemory, saveMemory } from './store.mjs';

const COMPACTION_SHRINK = 0.8;
// Jev down: after this many failures in a row, new turns skip it for the cooldown instead of waiting out its timeout.
export const JEV_FAILURES_TO_PAUSE = 3;
export const JEV_PAUSE_MS = 60_000;
// Reasons that reuse the route of the turn and must not replace the reason that chose it.
const REUSED_ROUTE = new Set(['tool-continuation', 'retry']);

export function emptyMemory() {
  return {
    lastRoute: null,
    lastReason: null,
    lastEffort: null,
    lastRequest: null,
    lastTurnKey: null,
    models: {},
    state: null,
  };
}

export class Router {
  constructor({ config, fetchFn, dataDir, now = Date.now, onError = () => {} }) {
    this.config = config;
    this.fetchFn = fetchFn;
    this.dataDir = dataDir;
    this.now = now;
    this.onError = onError;
    this.memories = new Map();
    this.jevFailures = 0;
    this.jevPausedUntil = 0;
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
    else if (facts.turnKey && facts.turnKey === memory.lastTurnKey && memory.lastRoute)
      decision = { tier: memory.lastRoute, reason: 'retry', state: memory.state };
    else decision = await this.decideTurn(facts, memory);
    // Main turns and compaction carry the main conversation; other side requests have their own, unknown size.
    if (!auxiliary || requestClass === 'compaction') {
      const tier = fitTier(this.config, decision.tier, nextContextTokens(facts));
      if (tier !== decision.tier) decision = { ...decision, tier, reason: 'context-fit' };
    }
    const rewritten = rewriteRequest(body, decision.tier, this.config);
    if (!auxiliary) {
      memory.lastRoute = decision.tier;
      memory.lastEffort = rewritten.output_config?.effort ?? null;
      memory.lastTurnKey = facts.turnKey;
      if (!REUSED_ROUTE.has(decision.reason)) memory.lastReason = decision.reason;
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
      body: rewritten,
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

  // Side endpoints (count_tokens) name the alias too. They get the session's current model: no Jev call, no vote.
  resolveModel(body, sessionId) {
    const tier = this.memory(sessionId).lastRoute ?? this.config.gateway.baselineTier;
    return { body: rewriteRequest(body, tier, this.config), tier, reason: 'side-endpoint', auxiliary: true };
  }

  async decideTurn(facts, memory) {
    const state = memory.state ?? initialState();
    const { forcedTier, apiKey, gateway } = this.config;
    if (forcedTier) return { tier: forcedTier, reason: 'forced', state: { ...state, turn: state.turn + 1 } };
    let advice = null;
    let adviceError = null;
    if (apiKey && facts.prompt) {
      if (this.now() < this.jevPausedUntil) adviceError = 'jev paused after repeated failures';
      else {
        try {
          advice = await askJev({
            fetchFn: this.fetchFn,
            config: this.config,
            apiKey,
            prompt: facts.prompt,
            turns: facts.turns,
            now: this.now,
          });
          this.jevSucceeded();
        } catch (error) {
          adviceError = error.message;
          this.jevFailed(error);
        }
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

  jevSucceeded() {
    if (this.jevFailures >= JEV_FAILURES_TO_PAUSE) this.onError(new Error('jev answers again, routing resumed'));
    this.jevFailures = 0;
    this.jevPausedUntil = 0;
  }

  // The count stays at or above the threshold while Jev keeps failing: after a pause, one failed try pauses again.
  jevFailed(error) {
    this.jevFailures += 1;
    if (this.jevFailures < JEV_FAILURES_TO_PAUSE) return;
    this.jevPausedUntil = this.now() + JEV_PAUSE_MS;
    if (this.jevFailures === JEV_FAILURES_TO_PAUSE)
      this.onError(
        new Error(
          `jev failed ${JEV_FAILURES_TO_PAUSE} times in a row (${error.message}): new turns use the baseline, one try every ${JEV_PAUSE_MS / 1000}s`,
        ),
      );
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

  // Disk trouble (full, read-only) must not cost the routing decision: the in-memory state stays authoritative.
  persist(sessionId, memory) {
    try {
      saveMemory(this.dataDir, sessionId, memory);
    } catch (error) {
      this.onError(error);
    }
  }

  log(entry) {
    if (!this.config.log) return;
    try {
      appendLog(this.dataDir, { at: new Date(this.now()).toISOString(), ...entry });
    } catch (error) {
      this.onError(error);
    }
  }
}

// Without the request-class hint header: side requests (titles, classifiers) turn thinking off and ask for a schema.
function isAuxiliaryShape(body) {
  return body.thinking?.type === 'disabled' || Boolean(body.output_config?.format);
}
