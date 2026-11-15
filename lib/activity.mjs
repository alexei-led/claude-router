// Activity routing (docs/plans/2026-10-09-activity-routing-plan.md §5): which activity a turn applies, how two routes
// compare, and when a route change inside one tier is worth it. Pure.

import { PHASE_VALUES } from './classifier-contract.mjs';
import { ACTIVITIES, EFFORTS, resolveRoute, routeSpec } from './config.mjs';
import { routeEffort } from './cost.mjs';
import { cashGate, sameTaskOf } from './policy.mjs';

// The classifier's activity when it names one with at least `policy.activityMass`, else null: uncertain, a weak
// label, or no answer resolve to the tier's base route.
export function acceptActivity(config, advice) {
  const answer = advice?.activity;
  if (!answer || !ACTIVITIES.includes(answer.choice)) return null;
  return answer.probabilities?.[answer.choice] >= config.policy.activityMass ? answer.choice : null;
}

export function acceptPhase(config, advice) {
  const answer = advice?.phase;
  if (!answer || answer.choice === 'uncertain' || !PHASE_VALUES.includes(answer.choice)) return null;
  return answer.probabilities?.[answer.choice] >= config.policy.activityMass ? answer.choice : null;
}

// Phase chooses a work preference, never a new durable goal. Ops discounts require positive bounded evidence;
// adaptive ops uses the profile's same-tier engineering floor, not its potentially weaker generic row.
// The minimum is a conservative support floor, not a multiplied or calibrated joint probability.
export function routingActivity(config, advice) {
  const answer = advice?.activity;
  if (!answer) return null;
  const phase = acceptPhase(config, advice);
  const mass = answer.probabilities?.[answer.choice] ?? 0;
  const goal = acceptActivity(config, advice);
  const supported = phase ? Math.min(mass, advice.phase.probabilities[phase]) : mass;
  if (goal && (phase === 'verify' || phase === 'execute')) return { choice: 'ops', mass: supported };
  if (goal === 'ops') {
    if (phase === 'reason') return { choice: 'debug', mass: supported };
    if (phase === 'produce') return { choice: 'code', mass: supported };
    return null;
  }
  return { choice: answer.choice, mass };
}

const acceptRoutingActivity = (config, advice) => {
  const signal = routingActivity(config, advice);
  return ACTIVITIES.includes(signal?.choice) && signal.mass >= config.policy.activityMass ? signal.choice : null;
};

// 1 when route `a` is stronger than `b`, -1 when weaker, 0 when equal in declared strength, null when unordered.
// Different models require declared strength ranks; tariffs are economics, not capability evidence. Equal declared
// ranks compare by effort. A null effort is the one handed to Claude Code; absent or numeric efforts do not order.
export function compareRoutes(config, a, b, sentEffort) {
  if (a.model !== b.model) {
    const [sa, sb] = [routeSpec(config, a).strength, routeSpec(config, b).strength];
    if (!Number.isFinite(sa) || !Number.isFinite(sb)) return null;
    if (sa !== sb) return Math.sign(sa - sb);
  }
  const [ea, eb] = [routeEffort(config, a, sentEffort), routeEffort(config, b, sentEffort)];
  if (ea === eb) return 0;
  if (!EFFORTS.includes(ea) || !EFFORTS.includes(eb)) return null;
  return Math.sign(EFFORTS.indexOf(ea) - EFFORTS.indexOf(eb));
}

// Whether two routes send the same request: the same model at the same effort once a session effort is resolved.
export const sameRequest = (config, a, b, sentEffort) =>
  a.model === b.model && routeEffort(config, a, sentEffort) === routeEffort(config, b, sentEffort);

// The activity a turn runs with, given the incumbent cell `{ tier, activity }` and its resolved `route`. Without
// advice, or without an activity answer (a skipped, failed or malformed activity step), the incumbent's activity
// stays: a flaky step must not move the route every turn. On the same task (sameTaskOf: a review inside a turn, a turn
// with a progress origin, or a continuation prompt) a stronger label is taken at once (explore, then code), and a weaker
// one only with at least `downgradeMass` probability once facts.downAllowed holds: the dwell has passed and a checkpoint
// (completedSince) since the last model change. An unclear label keeps the running activity.
export function chooseActivity(config, advice, incumbent, sentEffort, facts = {}) {
  if (!advice?.activity) return incumbent.activity;
  if (!sameTaskOf(config, advice, facts)) return acceptRoutingActivity(config, advice);
  const signal = routingActivity(config, advice);
  const label = signal?.choice;
  if (!ACTIVITIES.includes(label)) return incumbent.activity;
  const order = compareRoutes(config, resolveRoute(config, incumbent.tier, label), incumbent.route, sentEffort);
  if (order > 0) return label;
  // An explicitly declared ops work floor may be nominated without inventing a physical-model ranking.
  // The lateral confidence/cache/hold/cash gates still decide; inherited generic cells get no exception.
  const phase = acceptPhase(config, advice);
  const floor = phase === 'reason' ? 'debug' : phase === 'produce' ? 'code' : null;
  const declared = config.configuredActivities ?? config.activities;
  if (
    order === null &&
    acceptActivity(config, advice) === 'ops' &&
    label === floor &&
    declared[label]?.[incumbent.tier]
  )
    return label;
  const mass = signal.mass;
  if (order < 0 && facts.downAllowed && mass >= config.policy.downgradeMass) return label;
  return incumbent.activity;
}

// A route change inside the incumbent's tier, `from` → `to`. Up on evidence: `mass`, the label's probability (1 for
// the base route), must clear the tier upgrade bar for this switching tax. Down on economics: the move must pay back
// its cache write within the downgrade horizon. A pair that does not order (unknown strength or a numeric effort)
// counts as up: it needs evidence, and the base route is always reachable. Labels alone never
// switch, so one vote is enough. During an escalation hold only a stronger route may be taken. A cheaper route on the
// same task (`sameTask`) waits for facts.downAllowed, as a tier downgrade does: a routing mode changes the route
// without a new label, and a free switch must still wait out the dwell. A model with a lower input price also counts
// as cheaper there, whatever its output price: that is the order the cost mode picks by. Returns
// { move, reason, estimate }.
export function lateralMove({ config, from, to, mass, hold, sameTask = false, facts, now, costs }) {
  const order = compareRoutes(config, to, from, facts.effort);
  if (hold && !(order > 0)) return { move: false, reason: 'hold', estimate: null };
  const p = config.policy;
  let estimate;
  if (order !== -1 && sameTask && !facts.downAllowed && routeSpec(config, to).input < routeSpec(config, from).input)
    return { move: false, reason: 'downgrade-held', estimate: null };
  if (order === -1) {
    estimate = { taxUsd: costs.downgradeTaxUsd(config, to, from, facts, now, p.downgradeHorizonTurns) };
    if (sameTask && !facts.downAllowed) return { move: false, reason: 'downgrade-held', estimate };
    // Before the first measured reply no cache of this history exists, though the tax prices an unknown one as warm:
    // staying protects nothing.
    const fresh = facts.historyMeasured === false;
    if (estimate.taxUsd > 0 && !fresh) return { move: false, reason: 'activity-pending', estimate };
  } else {
    const tax = Math.max(0, costs.switchingTaxUsd(config, to, from, facts, now));
    const threshold = p.upgradeBase + p.upgradeSlope * (tax / (tax + p.upgradePivotUsd));
    estimate = { taxUsd: tax, threshold, upgradeMass: mass };
    if (mass < threshold) return { move: false, reason: 'activity-pending', estimate };
  }
  const gated = cashGate(config, to, facts, now, costs);
  if (gated.blocked) return { move: false, reason: 'cash-gate', estimate: gated.estimate };
  return { move: true, reason: order === -1 ? 'activity-down' : 'activity-up', estimate };
}
