// Stateful main-turn adapter. Table/shadow never enter this path.
import { acceptActivity, acceptPhase, routingActivity } from './activity.mjs';
import { assessCandidates, decideMove, initialAutoState, proposeAutoRoute, selectTarget } from './auto-engine.mjs';
import { TIERS } from './config.mjs';
import { economicConfig, isModelAllowed, isSameModel } from './route.mjs';

const aliasRoute = (config, model, effort) => ({
  model:
    Object.keys(config.models).find(
      (key) => isSameModel(config.models[key].id, model) || isSameModel(model, config.models[key].id),
    ) ?? model,
  effort: effort ?? null,
});
// An external response owns physical incumbent identity, but never changes demand evidence.
// A substituted response does not report the actual effort; null is unknown, not an inferred preset.
export function externalIncumbent(config, { requestedModel, effort, usage }) {
  const served = usage?.model ?? requestedModel;
  const actualEffort = isSameModel(requestedModel, served) ? (effort ?? null) : null;
  return {
    incumbent: aliasRoute(config, served, actualEffort),
    incumbentId: served,
    incumbentOrigin: 'external-fallback',
  };
}

export function observeAutoFallback(config, loop, response) {
  if (!loop.auto) return loop;
  const external = externalIncumbent(config, response);
  return {
    ...loop,
    auto: loop.auto.savedPin
      ? { ...loop.auto, fallback: { ...external, switchedAt: loop.switchedAt, servedRoute: loop.servedRoute } }
      : { ...loop.auto, ...external },
  };
}

// Availability is operator catalog evidence; cache warmth, failures and the clock are not.
// Fingerprint allowed aliases, not raw allowlist order or routine response-ID resolutions.
export function autoCatalogKey(config, { availableModels, nativeModel, models = config.models }) {
  const allowed = Object.keys(models).filter((alias) => isModelAllowed(models[alias].id, availableModels, nativeModel));
  return JSON.stringify([config.models, config.policy, config.cache, config.activityRouting, allowed]);
}
const level = (n) => Number.isFinite(n) && n >= 0 && n <= 3 && Number.isInteger(n * 2);

const validSwitch = (value) =>
  value === null ||
  (Number.isSafeInteger(value?.requests) &&
    value.requests >= 0 &&
    Number.isSafeInteger(value.messageCount) &&
    value.messageCount >= 0);
const validServed = (value) => value === null || typeof value === 'string';
const validPin = (value) =>
  value == null || (TIERS.includes(value.pin) && validSwitch(value.switchedAt) && validServed(value.servedRoute));
const validFallback = (value) =>
  value == null ||
  (typeof value.incumbent?.model === 'string' &&
    typeof value.incumbentId === 'string' &&
    value.incumbentOrigin === 'external-fallback' &&
    validSwitch(value.switchedAt) &&
    validServed(value.servedRoute));

function validAuto(saved) {
  const s = saved?.state;
  return (
    saved?.version === 1 &&
    level(s?.demand) &&
    Number.isInteger(s.demand) &&
    level(s.routedDemand) &&
    Number.isSafeInteger(s.turn) &&
    s.turn >= 0 &&
    Number.isSafeInteger(s.holdUntilTurn) &&
    Array.isArray(s.votes) &&
    s.votes.every((n) => level(n) && Number.isInteger(n)) &&
    typeof saved.incumbent?.model === 'string' &&
    typeof saved.incumbentId === 'string' &&
    validPin(saved.savedPin) &&
    validFallback(saved.fallback)
  );
}

function stateFor(config, projected, loop, input, mode, catalog) {
  const valid = validAuto(loop.auto);
  if (valid && loop.auto.generation === loop.generation) return { ...loop.auto };
  // A history reset preserves a running pin's underlying incumbent, not its temporary request.
  const restore = valid && loop.auto.savedPin;
  const model = loop.decision?.model ?? input.engineModel ?? input.nativeModel;
  return {
    version: 1,
    generation: loop.generation,
    state: initialAutoState({ demand: TIERS.indexOf(config.baselineTier) }),
    incumbent: restore
      ? loop.auto.incumbent
      : aliasRoute(projected, model, loop.decision?.effort ?? input.facts.effort),
    incumbentId: restore ? loop.auto.incumbentId : model,
    advice: null,
    boundedExecute: false,
    activity: null,
    demandResult: null,
    savedPin: restore ? loop.auto.savedPin : null,
    fallback: restore ? loop.auto.fallback : null,
    mode,
    catalog,
  };
}

function continueProposal(args, auto) {
  const { state } = auto;
  const discount = auto.boundedExecute && !state.headroom && state.turn > state.holdUntilTurn ? 0.5 : 0;
  const demand = {
    ...auto.demandResult,
    level: Math.max(0, state.demand - discount),
    state,
    escalated: false,
    headroom: state.headroom,
  };
  const candidates = assessCandidates(args);
  const target = selectTarget({ candidates, demand: demand.level, mode: args.mode, headroom: state.headroom });
  const next = state.headroom ? { ...state, headroom: target.headroom } : state;
  const move = decideMove({ ...args, state: next, demandResult: demand, candidates, target });
  return { demand, target, move, state: move.state };
}

function decisionFor(config, auto, input, proposal, pin) {
  const { demand, target, move } = proposal;
  const route = move.route;
  const model = route ? (config.models[route.model]?.id ?? route.model) : (input.engineModel ?? input.nativeModel);
  // Candidate effort is already native: do not clamp numeric effort or invent a declaration for null.
  const effort = route
    ? (route.effort ?? (config.models[route.model]?.efforts.length ? (input.facts.effort ?? null) : null))
    : (input.facts.effort ?? null);
  const reason = route ? move.reason : 'no-route-native';
  return {
    tier: TIERS[demand.raw ?? auto.state.demand],
    route,
    model,
    effort,
    reason,
    pinned: Boolean(pin),
    requestedPin: pin ?? null,
    escalated: !pin && (demand.escalated || (move.move && ['escalation', 'escalation-unknown'].includes(move.reason))),
    activity: pin ? null : auto.activity,
    goal: pin ? null : acceptActivity(config, auto.advice),
    taskPhase: pin ? null : acceptPhase(config, auto.advice),
    comparison: null,
    estimate: null,
    auto: {
      demand: demand.level,
      reason: demand.reason,
      headroom: target.headroom,
      targetReason: target.reason,
      requirement: target.requirement,
      outcome: target.outcome,
      route: target.route ? `${target.route.model}@${target.route.effort ?? 'session'}` : null,
      capability: target.capability,
      minUsd: target.estimate?.minUsd,
      maxUsd: target.estimate?.maxUsd,
      move: reason,
    },
  };
}

// Only versioned state is authoritative; resets never restore old demand votes or pending moves.
// Cache and resolution observations belong to the shared physical loop, not the engine state.
export function autoRoute(config, previous, input, { continuation = false, observed = null } = {}) {
  const { facts, now, nativeModel, availableModels, contextKnown } = input;
  const mode = config.routingMode?.mode ?? config.mode ?? 'balanced';
  const projected = economicConfig(config, previous);
  const catalog = autoCatalogKey(config, { availableModels, nativeModel, models: projected.models });
  const auto = stateFor(config, projected, previous, input, mode, catalog);
  let loop = previous;
  if (!continuation && loop.turnId !== facts.turnKey && auto.savedPin) {
    loop = { ...loop, switchedAt: auto.savedPin.switchedAt, servedRoute: auto.savedPin.servedRoute };
    auto.savedPin = null;
    if (auto.fallback) {
      const { switchedAt, servedRoute, ...external } = auto.fallback;
      loop = { ...loop, switchedAt, servedRoute };
      Object.assign(auto, external);
      auto.fallback = null;
    }
  }
  // An alias edit must not silently replace the incumbent with the alias's newly assigned model.
  const id = projected.models[auto.incumbent.model]?.id;
  if (!isSameModel(id, auto.incumbentId) && !isSameModel(auto.incumbentId, id))
    auto.incumbent = aliasRoute(projected, auto.incumbentId, auto.incumbent.effort);
  const changeCause = mode !== auto.mode ? 'mode' : catalog !== auto.catalog ? 'catalog' : (auto.changeCause ?? null);
  const pin = continuation ? (auto.savedPin?.pin ?? null) : input.pin;
  if (!pin && !continuation) {
    auto.advice = input.advice;
    const accepted = config.activityRouting === 'on' ? acceptActivity(config, input.advice) : null;
    const signal = routingActivity(config, input.advice);
    if (accepted) auto.activity = signal?.mass >= config.policy.activityMass ? signal.choice : accepted;
    auto.boundedExecute = accepted !== null && acceptPhase(config, input.advice) === 'execute';
  }
  if (!pin && ['code', 'docs', 'ops'].includes(observed)) auto.activity = observed;
  if (!pin && ['code', 'docs'].includes(observed)) auto.boundedExecute = false;
  const args = {
    config: projected,
    facts: {
      ...facts,
      ...(auto.incumbentOrigin === 'external-fallback' && auto.incumbent.effort === null ? { effort: null } : {}),
      ineligible: loop.ineligible.map((model) => loop.resolutions[model] ?? model),
      dwellAllowed: !loop.switchedAt || loop.requests - loop.switchedAt.requests >= config.policy.minDwellRequests,
    },
    now,
    nativeModel,
    availableModels,
    contextKnown,
    incumbent: continuation && pin ? aliasRoute(projected, loop.decision.model, loop.decision.effort) : auto.incumbent,
    state: auto.state,
    advice: auto.advice,
    mode,
    changeCause,
    pin,
    boundedExecute: auto.boundedExecute,
    incumbentOrigin: !continuation && !facts.midTurn ? auto.incumbentOrigin : null,
  };
  const proposal = !continuation || pin ? proposeAutoRoute(args) : continueProposal(args, auto);
  const { demand, move } = proposal;
  if (pin) auto.savedPin ??= { pin, switchedAt: loop.switchedAt, servedRoute: loop.servedRoute };
  else {
    auto.state = proposal.state;
    auto.demandResult = demand;
    if (['reentry', 'same-route'].includes(move.reason) && args.incumbentOrigin) auto.incumbentOrigin = null;
    if (move.route) {
      auto.incumbent = move.route;
      auto.incumbentId = projected.models[move.route.model]?.id ?? move.route.model;
    }
    auto.mode = mode;
    auto.catalog = catalog;
    auto.changeCause =
      !move.move && move.reason !== 'same-route' && demand.level === auto.state.routedDemand ? changeCause : null;
  }
  return {
    ...loop,
    auto,
    turnId: facts.turnKey,
    suspended: false,
    route: auto.incumbent,
    lastRoute: pin ? loop.lastRoute : TIERS[auto.state.demand],
    lastActivity: pin ? loop.lastActivity : auto.activity,
    reviewedAt: continuation ? loop.reviewedAt : loop.requests,
    decision: decisionFor(config, auto, input, proposal, pin),
  };
}
