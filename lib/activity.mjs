// Activity routing (docs/plans/2026-10-09-activity-routing-plan.md §5): which activity a turn applies, how two routes
// compare, and when a route change inside one tier is worth it. Pure.
import { ACTIVITIES, EFFORTS, resolveRoute, routeSpec } from './config.mjs';
import { cashGate } from './policy.mjs';

// The classifier's activity when it names one with at least `policy.activityMass`, else null: uncertain, a weak
// label, or no answer resolve to the tier's base route.
export function acceptActivity(config, advice) {
  const answer = advice?.activity;
  if (!answer || !ACTIVITIES.includes(answer.choice)) return null;
  return answer.probabilities?.[answer.choice] >= config.policy.activityMass ? answer.choice : null;
}

// 1 when route `a` is stronger than `b`, -1 when cheaper, 0 when equal in strength, null when they cannot be ordered.
// Models order by configured output price, then effort. A null effort is the session's, equal only to another null;
// a missing output price orders only against the same model.
export function compareRoutes(config, a, b) {
  if (a.model !== b.model) {
    const [pa, pb] = [routeSpec(config, a).output, routeSpec(config, b).output];
    if (!Number.isFinite(pa) || !Number.isFinite(pb)) return null;
    if (pa !== pb) return Math.sign(pa - pb);
  }
  const [ea, eb] = [a.effort ?? null, b.effort ?? null];
  if (ea === eb) return 0;
  if (ea === null || eb === null) return null;
  return Math.sign(EFFORTS.indexOf(ea) - EFFORTS.indexOf(eb));
}

// The activity a turn runs with, given the incumbent cell `{ tier, activity }` and its resolved `route`. Without
// advice the incumbent's activity stays. A tool continuation keeps one route per task, but may move up (explore, then
// code): a weaker label never takes over mid-task.
export function chooseActivity(config, advice, incumbent) {
  if (!advice) return incumbent.activity;
  if (advice.continuation >= config.policy.continuationMass) {
    const label = advice.activity?.choice;
    const stronger =
      ACTIVITIES.includes(label) &&
      compareRoutes(config, resolveRoute(config, incumbent.tier, label), incumbent.route) > 0;
    return stronger ? label : incumbent.activity;
  }
  return acceptActivity(config, advice);
}

// A route change inside the incumbent's tier, `from` → `to`. Up on evidence: `mass`, the label's probability (1 for
// the base route), must clear the tier upgrade bar for this switching tax. Down on economics: the move must pay back
// its cache write within the downgrade horizon. Labels alone never switch, so one vote is enough. During an
// escalation hold only a stronger route may be taken. Returns { move, reason, estimate }.
export function lateralMove({ config, from, to, mass, hold, facts, now, costs }) {
  const order = compareRoutes(config, to, from);
  if (hold && !(order > 0)) return { move: false, reason: 'hold', estimate: null };
  const p = config.policy;
  let estimate;
  if (order > 0) {
    const tax = Math.max(0, costs.switchingTaxUsd(config, to, from, facts, now));
    const threshold = p.upgradeBase + p.upgradeSlope * (tax / (tax + p.upgradePivotUsd));
    estimate = { taxUsd: tax, threshold, upgradeMass: mass };
    if (mass < threshold) return { move: false, reason: 'activity-pending', estimate };
  } else if (order < 0) {
    estimate = { taxUsd: costs.downgradeTaxUsd(config, to, from, facts, now, p.downgradeHorizonTurns) };
    if (estimate.taxUsd > 0) return { move: false, reason: 'activity-pending', estimate };
  } else {
    return { move: false, reason: 'activity-pending', estimate: null };
  }
  const gated = cashGate(config, to, facts, now, costs);
  if (gated.blocked) return { move: false, reason: 'cash-gate', estimate: gated.estimate };
  return { move: true, reason: order > 0 ? 'activity-up' : 'activity-down', estimate };
}
