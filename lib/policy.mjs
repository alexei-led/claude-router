// Switching policy v0 (docs/design.md): stickiness, escalation floor, cost-gated votes.
import { rank, TIERS } from './config.mjs';
import { coldWriteUsd, isWarm, nextContextTokens, switchingTaxUsd } from './cost.mjs';

export function initialState() {
  return { turn: 0, votes: [], holdUntilTurn: 0, escalatedSignature: null };
}

// Returns { tier, reason, state, estimate }. `baseline` is the tier used when nothing argues otherwise.
export function decide({ config, facts, advice, state, baseline, now }) {
  const next = { ...state, turn: state.turn + 1, votes: [...state.votes] };
  const incumbent = facts.lastRoute && TIERS.includes(facts.lastRoute) ? facts.lastRoute : baseline;
  const stay = (reason, estimate = null) => result(incumbent, reason, next, estimate);

  if (facts.failure && facts.failure.signature !== next.escalatedSignature && rank(incumbent) < TIERS.length - 1) {
    next.escalatedSignature = facts.failure.signature;
    next.holdUntilTurn = next.turn + config.policy.escalationHoldTurns;
    next.votes = [];
    return result(TIERS[rank(incumbent) + 1], 'escalation', next);
  }
  if (next.turn <= next.holdUntilTurn) return stay('hold');
  if (!advice) return stay('no-advice');
  if (advice.continuation >= config.policy.continuationMass) return stay('continuation');
  if (advice.choice === 'uncertain') return stay('uncertain');

  const choice = advice.choice;
  next.votes = [...next.votes.slice(-2), { tier: choice, turn: next.turn }];
  if (rank(choice) === rank(incumbent)) return stay('same-tier');

  if (rank(choice) > rank(incumbent)) {
    const upgrade = massAbove(advice.probabilities, incumbent);
    const gated = cashGate(config, choice, facts, now);
    if (gated.blocked) {
      if (rank(gated.fallback) <= rank(incumbent)) return stay('cash-gate', gated.estimate);
      return result(gated.fallback, 'cash-gate', next, gated.estimate);
    }
    const tax = Math.max(
      0,
      switchingTaxUsd(config, config.routes[choice].model, config.routes[incumbent].model, facts, now),
    );
    const threshold =
      config.policy.upgradeBase + config.policy.upgradeSlope * (tax / (tax + config.policy.upgradePivotUsd));
    const jump = rank(choice) - rank(incumbent) >= 2 && upgrade >= config.policy.jumpConfidence;
    const streak = trailing(next.votes, (v) => rank(v.tier) > rank(incumbent));
    const estimate = { taxUsd: tax, threshold, upgradeMass: upgrade, streak };
    if (jump || (streak >= config.policy.upgradeVotes && upgrade >= threshold))
      return result(choice, jump ? 'jump' : 'upgrade', next, estimate);
    return stay('upgrade-pending', estimate);
  }

  const support = massAtOrBelow(advice.probabilities, choice);
  const streak = trailing(next.votes, (v) => rank(v.tier) <= rank(choice));
  const estimate = { downgradeMass: support, streak };
  if (support >= config.policy.downgradeMass && streak >= config.policy.downgradeVotes)
    return result(choice, 'downgrade', next, estimate);
  return stay('downgrade-pending', estimate);
}

// Automatic routing to a credits-billed model must fit the cash cap unless its cache is warm.
function cashGate(config, tier, facts, now) {
  const alias = config.routes[tier].model;
  const model = config.models[alias];
  if (model.billing !== 'credits') return { blocked: false };
  if (isWarm(facts.models[model.id], now, config.cache)) return { blocked: false };
  const cold = coldWriteUsd(config, alias, nextContextTokens(facts), facts);
  if (cold <= config.policy.cashCapUsd) return { blocked: false };
  const fallback = [...TIERS].reverse().find((t) => config.models[config.routes[t].model].billing === 'plan');
  return { blocked: true, fallback, estimate: { coldUsd: cold, cap: config.policy.cashCapUsd } };
}

function trailing(votes, predicate) {
  let count = 0;
  for (let i = votes.length - 1; i >= 0 && predicate(votes[i]); i -= 1) count += 1;
  return count;
}

function result(tier, reason, state, estimate = null) {
  return { tier, reason, state, estimate };
}

// Probability mass strictly above a tier; `uncertain` supports neither direction.
export function massAbove(probabilities, tier) {
  return TIERS.filter((t) => rank(t) > rank(tier)).reduce((sum, t) => sum + probabilities[t], 0);
}

export function massAtOrBelow(probabilities, tier) {
  return TIERS.filter((t) => rank(t) <= rank(tier)).reduce((sum, t) => sum + probabilities[t], 0);
}
