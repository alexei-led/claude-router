// Per-request orchestration: facts -> advice -> policy -> rewritten body. Knows nothing about HTTP.
import { LEGACY_ALIAS, TIERS } from './config.mjs';
import { cacheKey, nextContextTokens, shadowEconomics } from './cost.mjs';
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
// `x-claude-code-request-class` values that are side requests. `main`, `subagent` and `workflow` carry a conversation.
const SIDE_REQUEST_CLASSES = new Set(['auxiliary', 'compaction']);

export function emptyMemory() {
  return {
    lastRoute: null,
    lastReason: null,
    lastEstimate: null,
    lastEffort: null,
    lastRequest: null,
    lastTurnKey: null,
    lastMessageCount: null,
    models: {},
    state: null,
  };
}

// The history the gateway saw is gone: a compaction or a rewind. The cached prefixes are unknown, and the votes and
// the escalation hold were about turns that are no longer in it. The route stays until the next decision.
// `lastRequest` stays: until the next response it is the only size there is, and as an upper bound it errs safe.
// A rewind can keep most of a long context, and a size of zero would let context-fit send it to a small window.
function restartHistory(memory) {
  memory.models = {};
  if (memory.state) memory.state = { ...memory.state, votes: [], holdUntilTurn: 0, escalatedSignature: null };
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
    return body?.model === this.config.gateway.alias || body?.model === LEGACY_ALIAS;
  }

  // Returns { body, tier, reason, auxiliary }. The caller forwards `body` and records the response
  // usage only when `auxiliary` is false: side requests carry their own context sizes.
  // The hints come from Claude Code's gateway headers (CLAUDE_CODE_GATEWAY_HINT_HEADERS=1); each may be missing.
  async route(body, { sessionId, requestClass = null, agentType = null, contextCompacted = null }) {
    const memory = this.memory(sessionId);
    const auxiliary = isSideRequest(body, requestClass);
    // Messages only grow within one history. Fewer than the last main request: Claude Code compacted the conversation
    // or the user rewound it. Context editing clears tool results but keeps the messages, so it is not a break.
    const messageCount = Array.isArray(body.messages) ? body.messages.length : 0;
    const rewound = !auxiliary && memory.lastMessageCount !== null && messageCount < memory.lastMessageCount;
    if (contextCompacted || rewound) {
      restartHistory(memory);
      this.log({ session: sessionId, historyBreak: contextCompacted ? 'compaction' : 'shorter-history' });
    }
    const facts = factsFromRequest(body, memory, this.config.context);
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
    const effort = rewritten.output_config?.effort ?? null;
    if (!auxiliary) {
      memory.lastRoute = decision.tier;
      memory.lastEffort = effort;
      memory.lastTurnKey = facts.turnKey;
      memory.lastMessageCount = messageCount;
      if (!REUSED_ROUTE.has(decision.reason)) {
        memory.lastReason = decision.reason;
        memory.lastEstimate = decision.estimate ?? null;
      }
      memory.state = decision.state;
      this.persist(sessionId, memory);
    }
    this.log({
      session: sessionId,
      requestClass,
      agentType,
      tier: decision.tier,
      model: rewritten.model,
      effort,
      reason: decision.reason,
      estimate: decision.estimate ?? null,
      shadow: decision.shadow ?? null,
      advice: decision.advice ?? null,
      adviceError: decision.adviceError ?? null,
      contextTokens: memory.lastRequest?.tokens ?? 0,
    });
    return {
      body: rewritten,
      tier: decision.tier,
      effort,
      reason: decision.reason,
      auxiliary,
    };
  }

  // Used when routing itself failed: the alias must never reach Anthropic. The log line has the reason only: an
  // error message can quote the request.
  fallback(body, sessionId, { requestClass = null } = {}) {
    const tier = this.config.gateway.baselineTier;
    const rewritten = rewriteRequest(body, tier, this.config);
    const effort = rewritten.output_config?.effort ?? null;
    this.log({ session: sessionId, requestClass, tier, model: rewritten.model, effort, reason: 'error' });
    return { body: rewritten, tier, effort, reason: 'error', auxiliary: true };
  }

  // A routed turn that Anthropic answered with an error status: no usage to record, but the turn is visible.
  recordFailure(sessionId, routed, status) {
    this.log({
      session: sessionId,
      failed: { status, tier: routed.tier, model: routed.body.model, effort: routed.effort ?? null },
    });
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
    const now = this.now();
    const decision = decide({ config: this.config, facts, advice, state, baseline: gateway.baselineTier, now });
    // Shadow only: what following Jev's choice instead of staying would cost at list prices. The policy ignores it.
    const incumbent = TIERS.includes(facts.lastRoute) ? facts.lastRoute : gateway.baselineTier;
    const shadow =
      TIERS.includes(advice?.choice) && advice.choice !== incumbent
        ? shadowEconomics(this.config, advice.choice, incumbent, facts, now)
        : null;
    return { ...decision, advice, adviceError, shadow };
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

  // Called with the usage the gateway read from a forwarded main-conversation response, and the effort the gateway
  // sent with that request: the cache is keyed by both.
  recordResponse(sessionId, tier, usage, effort = null) {
    if (!usage) return;
    const memory = this.memory(sessionId);
    const modelId = usage.model ?? this.config.models[this.config.routes[tier].model].id;
    const at = this.now();
    // A context that shrank by more than a fifth: a compaction, or context editing that cleared old tool results.
    // Either way the cached prefixes no longer match. The votes stay: a shorter history in messages resets them.
    if (memory.lastRequest && usage.tokens < memory.lastRequest.tokens * COMPACTION_SHRINK) {
      memory.models = {};
      this.log({ session: sessionId, cacheReset: 'context-shrink' });
    }
    memory.lastRequest = {
      model: modelId,
      tokens: usage.tokens,
      cacheReadTokens: usage.cacheReadTokens,
      outputTokens: usage.outputTokens,
      ttl: usage.ttl,
      at,
    };
    memory.models[cacheKey(modelId, effort)] = {
      lastAt: at,
      prefixTokens: usage.tokens + usage.outputTokens,
      ttl: usage.ttl,
    };
    this.persist(sessionId, memory);
    this.log({ session: sessionId, observed: { ...usage, model: modelId, tier, effort } });
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

// A request outside the conversation (title, classifier, compaction), by the request-class hint header. Without the
// header: side requests turn thinking off or ask for a schema.
export function isSideRequest(body, requestClass) {
  if (requestClass) return SIDE_REQUEST_CLASSES.has(requestClass);
  return body.thinking?.type === 'disabled' || Boolean(body.output_config?.format);
}
