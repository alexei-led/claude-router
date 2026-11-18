// Pure demand → target → move engine. No controller or host calls; table routing does not import this module.
import { TIERS } from './config.mjs';
import * as costs from './cost.mjs';
import { CONTEXT_FILL, sameTaskOf } from './policy.mjs';
import { canonicalModel } from './providers.mjs';
import { isModelAllowed } from './route.mjs';

const MODES = { cost: -0.5, balanced: 0, quality: 0.5 };
const clamp = (n) => Math.max(0, Math.min(3, n));
const sameRoute = (a, b) => a?.model === b?.model && a?.effort === b?.effort;
const samePhysical = (a, b) =>
  a.requestKey && b.requestKey ? a.requestKey === b.requestKey : sameRoute(a.route, b.route);
const validLevel = (n) => Number.isFinite(n) && n >= 0 && n <= 3 && Number.isInteger(n * 2);

export function initialAutoState({ demand = 2, routedDemand = demand, cause = 'classifier' } = {}) {
  if (!Number.isInteger(demand) || !validLevel(demand) || !validLevel(routedDemand))
    throw new RangeError('demand must be an integer 0..3; routedDemand must be a half-step 0..3');
  return {
    demand,
    routedDemand,
    routeCause: cause,
    demandCause: 'classifier',
    turn: 0,
    votes: [],
    holdUntilTurn: 0,
    escalatedSignature: null,
    escalatedIndex: null,
    headroom: false,
  };
}

const massAbove = (p, level) => TIERS.reduce((sum, tier, i) => sum + (i > level ? (p?.[tier] ?? 0) : 0), 0);
const massAtOrBelow = (p, level) => TIERS.reduce((sum, tier, i) => sum + (i <= level ? (p?.[tier] ?? 0) : 0), 0);
function trailing(votes, predicate) {
  let count = 0;
  for (let i = votes.length - 1; i >= 0 && predicate(votes[i]); i -= 1) count += 1;
  return count;
}

// Only vote/hold policy fields are read here: no route, cache, price, checkpoint or dwell evidence.
// Raw demand is integer; the accepted bounded execute discount never accumulates or discounts a pin/escalation.
export function advanceDemand({
  config,
  state,
  advice = /** @type {{ choice: string, probabilities: Record<string, number> } | null} */ (null),
  facts,
  pin = null,
  boundedExecute = false,
}) {
  const pinned = pin === null ? null : typeof pin === 'string' ? TIERS.indexOf(pin) : pin;
  if (pinned !== null && (!Number.isInteger(pinned) || !validLevel(pinned)))
    throw new RangeError('pin must name a tier or integer demand 0..3');
  if (pinned !== null)
    return { raw: pinned, level: pinned, reason: 'pinned', headroom: false, escalated: false, state };
  const next = { ...state, turn: state.turn + 1, votes: [...state.votes] };
  let reason = 'same-demand';
  let escalated = false;
  const failure = facts.failure;
  const freshFailure =
    failure && (failure.signature !== next.escalatedSignature || (failure.index ?? null) !== next.escalatedIndex);
  if (freshFailure) {
    next.escalatedSignature = failure.signature;
    next.escalatedIndex = failure.index ?? null;
    next.headroom = next.demand === 3;
    next.demand = Math.min(3, next.demand + 1);
    next.demandCause = 'escalation';
    next.holdUntilTurn = next.turn + config.policy.escalationHoldTurns;
    next.votes = [];
    reason = 'escalation';
    escalated = true;
  } else if (next.turn <= next.holdUntilTurn) {
    reason = 'hold';
  } else if (!advice || !TIERS.includes(advice.choice)) {
    reason = advice ? 'uncertain' : 'no-advice';
  } else {
    const choice = TIERS.indexOf(advice.choice);
    next.votes = [...next.votes, choice].slice(-Math.max(config.policy.upgradeVotes, config.policy.downgradeVotes));
    const fresh = facts.historyMeasured === false;
    if (choice > next.demand) {
      const mass = massAbove(advice.probabilities, next.demand);
      const jump = choice - next.demand >= 2 && mass >= config.policy.jumpConfidence;
      const votes = fresh ? 1 : config.policy.upgradeVotes;
      if (jump || (trailing(next.votes, (v) => v > next.demand) >= votes && mass >= config.policy.upgradeBase)) {
        next.demand = choice;
        next.demandCause = 'classifier';
        next.headroom = false;
        reason = jump ? 'jump' : 'upgrade';
      } else reason = 'upgrade-pending';
    } else if (choice < next.demand) {
      reason = 'downgrade-pending';
      for (let target = choice; target < next.demand; target += 1) {
        const votes = fresh ? 1 : config.policy.downgradeVotes;
        if (
          massAtOrBelow(advice.probabilities, target) < config.policy.downgradeMass ||
          trailing(next.votes, (v) => v <= target) < votes
        )
          continue;
        next.demand = target;
        next.demandCause = 'classifier';
        next.headroom = false;
        reason = 'downgrade';
        break;
      }
    }
  }
  const protectedDemand = escalated || next.turn <= next.holdUntilTurn || next.headroom;
  const discount = boundedExecute && !protectedDemand ? 0.5 : 0;
  return {
    raw: next.demand,
    level: clamp(next.demand - discount),
    reason,
    headroom: next.headroom,
    escalated,
    state: next,
  };
}

function effectiveIncumbent(config, incumbent, facts) {
  const model = config.models[incumbent.model];
  if (!model) return incumbent;
  // An unresolved native null effort is legal but unknown. Never silently clamp an unsupported explicit effort.
  if (incumbent.effort == null && (model.efforts.includes(facts.effort) || Number.isFinite(facts.effort)))
    return { ...incumbent, effort: facts.effort };
  return { ...incumbent, effort: incumbent.effort ?? null };
}

// cost.routeEffort represents native numeric effort through sentEffort, not the configured effort slot.
const pricedRoute = (route) => (typeof route.effort === 'number' ? { ...route, effort: null } : route);
const pricedFacts = (route, facts) => (typeof route.effort === 'number' ? { ...facts, effort: route.effort } : facts);

function capabilityOf(model, route) {
  const key = route.effort === null && model.efforts.length === 0 ? 'default' : route.effort;
  const value = key === null ? undefined : model.capability?.[key];
  return validLevel(value) ? value : null;
}

// Only the actual supported effort can establish accepted startup demand; unknown capability keeps the baseline.
export function initialIncumbentState({ config, incumbent, facts }) {
  const demand = TIERS.indexOf(config.baselineTier);
  const current = effectiveIncumbent(config, incumbent, facts);
  const model = config.models[current.model];
  const capability =
    model && (current.effort === null || model.efforts.includes(current.effort)) ? capabilityOf(model, current) : null;
  return initialAutoState({ demand, routedDemand: capability ?? demand });
}

// Each supported pair is assessed independently before any fallback. The incumbent is also assessed, even if its
// model/effort left the catalog; an unresolved native effort can only be retained, never nominated as a new candidate.
export function assessCandidates({
  config,
  facts,
  now,
  incumbent,
  contextKnown = Number.isFinite(facts.contextTokens),
  availableModels,
  nativeModel,
}) {
  const current = effectiveIncumbent(config, incumbent, facts);
  const currentSpec = config.models[current.model];
  const routes = Object.entries(config.models).flatMap(([model, spec]) =>
    (spec.efforts.length ? spec.efforts : [null]).map((effort) => ({ model, effort })),
  );
  const listed = routes.some((route) => sameRoute(route, current));
  if (!listed) routes.push(current);
  const tokens = costs.nextContextTokens(facts);
  return routes.map((route, index) => {
    const model = config.models[route.model];
    const reasons = [];
    const isIncumbent = sameRoute(route, current);
    const selectable = index < routes.length - (listed ? 0 : 1);
    if (!model)
      return {
        route,
        capability: null,
        eligible: false,
        reasons: ['model-missing'],
        incumbent: isIncumbent,
        selectable,
        cache: 'unknown',
        coldWriteUsd: null,
        estimate: null,
      };
    if (
      route.effort !== null &&
      !model.efforts.includes(route.effort) &&
      !(isIncumbent && Number.isFinite(route.effort))
    )
      reasons.push('effort-unsupported');
    if (
      !isModelAllowed(model.id, availableModels, nativeModel) ||
      (facts.ineligible ?? []).some((id) => canonicalModel(id) === canonicalModel(model.id))
    )
      reasons.push('unavailable');
    // A missing fresh estimate does not erase the observed transcript's token lower bound.
    if (tokens > model.contextWindow * CONTEXT_FILL) reasons.push('context-full');
    if (
      (!contextKnown || facts.historyMeasured === false) &&
      currentSpec &&
      model.contextWindow < currentSpec.contextWindow
    )
      reasons.push('context-unknown');
    if (facts.hasImages && model.imageInput === false) reasons.push('images');
    const pricingFacts = pricedFacts(route, facts);
    const pricingRoute = pricedRoute(route);
    const cache = costs.cacheState(
      facts.models[costs.routeCacheKey(config, pricingRoute, pricingFacts.effort)],
      now,
      config.cache,
    );
    const coldWriteUsd = costs.coldWriteUsd(config, route.model, tokens, now);
    if (model.billing === 'credits' && cache !== 'fresh' && coldWriteUsd > config.policy.cashCapUsd)
      reasons.push('cash-cap');
    const input = costs.inputBounds(config, pricingRoute, tokens, pricingFacts, now);
    const output = ((costs.ratesAt(model, tokens, now).output ?? 0) * (facts.lastRequest?.outputTokens ?? 0)) / 1e6;
    return {
      route,
      requestKey: JSON.stringify([canonicalModel(model.id), model.efforts.length ? route.effort : null]),
      capability: capabilityOf(model, route),
      eligible: reasons.length === 0,
      reasons,
      incumbent: isIncumbent,
      selectable,
      cache,
      coldWriteUsd,
      estimate: { minUsd: input.min + output, maxUsd: input.max + output },
    };
  });
}

// Uniform ordering is essential: mode changes only the required capability, never the incumbent tie preference.
export function selectTarget({ candidates, demand, mode = 'balanced', headroom = false, escalation = false }) {
  if (!validLevel(demand)) throw new RangeError('demand must be a half-step 0..3');
  if (!Object.hasOwn(MODES, mode)) throw new RangeError('unknown automatic routing mode');
  const requirement = clamp(demand + MODES[mode]);
  const eligible = candidates.filter(
    (candidate) => candidate.eligible && (candidate.selectable || candidate.incumbent),
  );
  const current = candidates.find((candidate) => candidate.incumbent);
  const escalating = (escalation || headroom) && current?.eligible;
  const choices = escalating ? eligible.filter((candidate) => !samePhysical(candidate, current)) : eligible;
  const declared = choices.filter(
    (candidate) =>
      candidate.capability !== null &&
      (!escalating ||
        (current.capability === null
          ? candidate.capability >= requirement
          : candidate.capability > current.capability)),
  );
  let pool = declared.filter((candidate) => candidate.capability >= requirement);
  let outcome = 'meets-demand';
  let reason = escalating ? 'escalation' : null;
  if (!pool.length) {
    if (declared.length) {
      const highest = Math.max(...declared.map((candidate) => candidate.capability));
      pool = declared.filter((candidate) => candidate.capability === highest);
      outcome = highest >= requirement ? 'meets-demand' : 'declared-below-demand';
    } else {
      pool = choices.filter((candidate) => candidate.capability === null);
      outcome = 'unknown-only';
      if (escalating) reason = pool.length ? 'escalation-unknown' : 'escalation-exhausted';
    }
  }
  pool = [...pool].sort(
    (a, b) =>
      a.estimate.maxUsd - b.estimate.maxUsd ||
      Number(b.incumbent) - Number(a.incumbent) ||
      (a.capability ?? -1) - (b.capability ?? -1),
  );
  const winner = pool[0] ?? (current?.eligible ? current : null);
  if (!winner)
    return {
      outcome: 'no-route',
      route: null,
      capability: null,
      requirement,
      estimate: null,
      reason: null,
      headroom: false,
    };
  if (!pool.length) outcome = 'incumbent';
  return {
    outcome,
    route: winner.route,
    capability: winner.capability,
    requirement,
    estimate: winner.estimate,
    reason,
    headroom: reason === 'escalation-exhausted',
  };
}

function bar(base, slope, tax, pivot) {
  return base + slope * (tax / (tax + pivot));
}

// Demand votes are NOT read here. Pending moves compare against the demand accepted by the incumbent.
export function decideMove({
  config,
  state,
  demandResult,
  target,
  candidates,
  advice = /** @type {{ choice: string, probabilities: Record<string, number> } | null} */ (null),
  facts,
  now,
  changeCause = /** @type {string | null} */ (null),
  startup = false,
  incumbentOrigin = null,
}) {
  const current = candidates.find((candidate) => candidate.incumbent);
  const proposed = candidates.find((candidate) => sameRoute(candidate.route, target.route));
  const stay = (reason, evidence = /** @type {object | null} */ (null)) => ({
    move: false,
    route: current?.eligible ? current.route : null,
    reason,
    evidence,
    estimate: target.estimate,
    // The selected physical request can accept new demand without a switch or new route provenance.
    state: reason === 'same-route' ? { ...state, routedDemand: demandResult.level } : state,
  });
  const move = (reason, cause, evidence = /** @type {object | null} */ (null)) => ({
    move: true,
    route: target.route,
    reason,
    evidence,
    estimate: target.estimate,
    state: { ...state, routedDemand: demandResult.level, routeCause: cause },
  });
  if (!target.route || !proposed?.eligible) return stay('no-route');
  if (incumbentOrigin === 'external-fallback')
    return current && samePhysical(current, proposed) ? stay('same-route') : move('reentry', 'reentry');
  if (!current?.eligible) return move('forced', 'forced');
  if (target.reason === 'escalation-exhausted') return stay('escalation-exhausted');
  if (samePhysical(current, proposed)) return stay('same-route');
  if (
    demandResult.escalated ||
    demandResult.headroom ||
    target.reason === 'escalation' ||
    target.reason === 'escalation-unknown'
  )
    return move(target.reason === 'escalation-unknown' ? 'escalation-unknown' : 'escalation', 'escalation');
  const p = config.policy;
  const from = pricedRoute(current.route);
  const to = pricedRoute(target.route);
  const pricingFacts = pricedFacts(current.route, facts);
  const stronger =
    target.capability !== null && (current.capability === null || target.capability > current.capability);
  const upgrade = (mass, reason, cause) => {
    const taxUsd = Math.max(0, costs.switchingTaxUsd(config, to, from, pricingFacts, now));
    const threshold = bar(p.upgradeBase, p.upgradeSlope, taxUsd, p.upgradePivotUsd);
    const evidence = { mass, threshold, taxUsd };
    return mass >= threshold ? move(reason, cause, evidence) : stay('upgrade-pending', evidence);
  };
  // Startup fits a native route the user never selected, before classifier move evidence; demand votes are unchanged.
  if (
    startup &&
    current.capability !== null &&
    current.capability < target.requirement &&
    target.capability !== null &&
    target.capability >= target.requirement
  )
    return upgrade(1, 'startup', 'startup');
  if (demandResult.level > state.routedDemand)
    return upgrade(massAbove(advice?.probabilities, state.routedDemand), 'upgrade', 'classifier');
  if (demandResult.level < state.routedDemand) {
    const taxUsd = costs.downgradeTaxUsd(config, to, from, pricingFacts, now, p.downgradeHorizonTurns);
    const threshold = bar(p.downgradeMass, p.downgradeSlope, taxUsd, p.downgradePivotUsd);
    const mass = massAtOrBelow(advice?.probabilities, demandResult.level);
    const evidence = { mass, threshold, taxUsd };
    if (mass < threshold) return stay('downgrade-pending', evidence);
    if (!facts.dwellAllowed) return stay('dwell-held', evidence);
    if (sameTaskOf(config, advice, facts) && !facts.downAllowed) return stay('downgrade-held', evidence);
    return move('downgrade', 'classifier', evidence);
  }
  if (stronger || (target.capability === null && current.capability !== null)) {
    if (changeCause !== 'mode' && changeCause !== 'catalog') return stay('no-evidence');
    return upgrade(1, 'explicit-up', changeCause);
  }
  if (target.estimate.maxUsd < current.estimate.maxUsd) {
    if (state.turn <= state.holdUntilTurn) return stay('hold');
    const taxUsd = costs.downgradeTaxUsd(config, to, from, pricingFacts, now, p.downgradeHorizonTurns);
    const evidence = { taxUsd };
    if (!facts.dwellAllowed) return stay('dwell-held', evidence);
    if (sameTaskOf(config, advice, facts) && !facts.downAllowed) return stay('downgrade-held', evidence);
    if (taxUsd > 0 && facts.historyMeasured !== false) return stay('economics-pending', evidence);
    return move('cheaper', changeCause ?? 'classifier', evidence);
  }
  return stay('no-evidence');
}

// Shadow uses demand/filter/target helpers only and retains demand.state (not proposal route history). Stateful
// replay/auto consumes accepted same-route demand too, without counting a move. Pins are one-turn overrides;
// the caller restores both pre-pin incumbent and state afterwards. This function never performs a physical move.
export function proposeAutoRoute(input) {
  const state = input.state ?? initialIncumbentState(input);
  const demand = advanceDemand({ ...input, state });
  const candidates = assessCandidates(input);
  const pinned = input.pin != null;
  const target = selectTarget({
    candidates,
    demand: demand.level,
    mode: pinned ? 'balanced' : input.mode,
    headroom: demand.headroom,
    escalation: demand.escalated,
  });
  if (!pinned && (demand.escalated || demand.headroom)) {
    demand.headroom = target.headroom;
    demand.state = { ...demand.state, headroom: target.headroom };
  }
  const move = pinned
    ? { move: false, route: target.route, reason: 'pinned', evidence: null, estimate: target.estimate, state }
    : decideMove({ ...input, state: demand.state, demandResult: demand, target, candidates });
  return { state: move.state, demand, candidates, target, move };
}
