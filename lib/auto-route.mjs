// Stateful main-turn adapter. Table/shadow never enter this path.
import { acceptActivity, acceptPhase, routingActivity } from './activity.mjs';
import {
  advanceDemand,
  assessCandidates,
  decideMove,
  initialIncumbentState,
  proposeAutoRoute,
  selectTarget,
} from './auto-engine.mjs';
import { TIERS } from './config.mjs';
import { KEYWORDS, keywordEffort, keywordTier } from './keywords.mjs';
import { economicConfig, hasRoutedDecision, isModelAllowed, isSameModel } from './route.mjs';

const aliasRoute = (config, model, effort) => ({
  model:
    Object.keys(config.models).find(
      (key) => isSameModel(config.models[key].id, model) || isSameModel(model, config.models[key].id),
    ) ?? model,
  effort: effort ?? null,
});
// What new advice sets on an auto state (`activity`, `boundedExecute`): the routing activity when its mass clears
// `activityMass`, else the accepted goal; a bounded execute phase only with an accepted goal. The live adapter and the
// replay share it, so a replay takes advice as the hook did.
export function takeAutoAdvice(config, state, advice) {
  const accepted = config.activityRouting === 'on' ? acceptActivity(config, advice) : null;
  const signal = routingActivity(config, advice);
  if (accepted)
    state.activity = signal !== null && signal.mass >= config.policy.activityMass ? signal.choice : accepted;
  state.boundedExecute = accepted !== null && acceptPhase(config, advice) === 'execute';
}

// What the turn's tool calls set on an auto state: work that edits or runs is its activity, and an edit ends a bounded
// execute.
export function takeObservedActivity(state, observed) {
  if (['code', 'docs', 'ops'].includes(observed)) state.activity = observed;
  if (['code', 'docs'].includes(observed)) state.boundedExecute = false;
}

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
  value == null ||
  (TIERS.includes(value.pin) &&
    (value.keyword === undefined || Object.hasOwn(KEYWORDS, value.keyword)) &&
    (value.discount === undefined || value.discount === 0.5) &&
    validSwitch(value.switchedAt) &&
    validServed(value.servedRoute));
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

function stateFor(projected, loop, input, mode, catalog) {
  const valid = validAuto(loop.auto);
  if (valid && loop.auto.generation === loop.generation) return { ...loop.auto };
  // A history reset preserves a running pin's underlying incumbent, not its temporary request.
  const restore = valid && loop.auto.savedPin;
  const model = loop.decision?.model ?? input.engineModel ?? input.nativeModel;
  const incumbent = restore
    ? loop.auto.incumbent
    : aliasRoute(projected, model, loop.decision?.effort ?? input.facts.effort);
  return {
    version: 1,
    generation: loop.generation,
    state: initialIncumbentState({ config: projected, incumbent, facts: input.facts }),
    incumbent,
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

// `pin` is a person's pin; a keyword turn runs as a pin to the keyword's tier but keeps its activity and the mode. A
// keyword turn's route is the one selected, and only the effort sent moves: the turn's continuations select from that
// route, so the move applies once.
function decisionFor(config, auto, input, proposal, pin, keyword) {
  const { demand, target, move } = proposal;
  const route = move.route;
  const model = route ? (config.models[route.model]?.id ?? route.model) : (input.engineModel ?? input.nativeModel);
  // Candidate effort is already native: do not clamp numeric effort or invent a declaration for null.
  const selected = route
    ? (route.effort ?? (config.models[route.model]?.efforts.length ? (input.facts.effort ?? null) : null))
    : (input.facts.effort ?? null);
  const effort =
    keyword && typeof route?.effort === 'string' ? keywordEffort(config, keyword, route.model, route.effort) : selected;
  const reason = route ? (keyword ?? move.reason) : 'no-route-native';
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
    ...(keyword ? { keyword } : {}),
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
export function autoRoute(
  config,
  previous,
  input,
  { continuation = false, observed = /** @type {string | null} */ (null) } = {},
) {
  const { facts, now, nativeModel, availableModels, contextKnown } = input;
  const mode = config.routingMode?.mode ?? config.mode ?? 'balanced';
  const projected = economicConfig(config, previous);
  const catalog = autoCatalogKey(config, { availableModels, nativeModel, models: projected.models });
  const auto = stateFor(projected, previous, input, mode, catalog);
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
  // A keyword turn runs as a pin to the tier the keyword moves this turn's demand to; its steps keep it.
  const keyword = continuation ? (auto.savedPin?.keyword ?? null) : input.pin ? null : (input.keyword ?? null);
  let pin = continuation ? (auto.savedPin?.pin ?? null) : input.pin;
  if (!pin && !continuation) {
    auto.advice = input.advice;
    takeAutoAdvice(config, auto, input.advice);
  }
  // A keyword moves the demand this turn's advice gives, the bounded-execute discount included; top and bottom do not
  // take the discount.
  let pinDiscount = continuation ? (auto.savedPin?.discount ?? 0) : 0;
  if (keyword && !continuation) {
    const { boundedExecute, state } = auto;
    const demand = advanceDemand({ config: projected, state, advice: input.advice, facts, boundedExecute });
    pin = keywordTier(keyword, TIERS[demand.raw]);
    pinDiscount = typeof KEYWORDS[keyword].tier === 'number' ? demand.raw - demand.level : 0;
  }
  if (!pin) takeObservedActivity(auto, observed);
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
    incumbent:
      continuation && pin
        ? keyword && loop.decision.route
          ? loop.decision.route
          : aliasRoute(projected, loop.decision.model, loop.decision.effort)
        : auto.incumbent,
    state: auto.state,
    advice: auto.advice,
    mode,
    changeCause,
    startup: !hasRoutedDecision(previous),
    pin,
    keyword,
    pinDiscount,
    boundedExecute: auto.boundedExecute,
    incumbentOrigin: !continuation && !facts.midTurn ? auto.incumbentOrigin : null,
  };
  const proposal = !continuation || pin ? proposeAutoRoute(args) : continueProposal(args, auto);
  const { demand, move } = proposal;
  if (pin)
    auto.savedPin ??= {
      pin,
      ...(keyword ? { keyword } : {}),
      ...(pinDiscount ? { discount: pinDiscount } : {}),
      switchedAt: loop.switchedAt,
      servedRoute: loop.servedRoute,
    };
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
    hasRoutedDecision: true,
    auto,
    turnId: facts.turnKey,
    suspended: false,
    route: auto.incumbent,
    lastRoute: pin ? loop.lastRoute : TIERS[auto.state.demand],
    lastActivity: pin ? loop.lastActivity : auto.activity,
    reviewedAt: continuation ? loop.reviewedAt : loop.requests,
    decision: decisionFor(config, auto, input, proposal, keyword ? null : pin, keyword),
  };
}
