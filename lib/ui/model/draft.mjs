// The route draft the Routes and Policy tabs edit, and what it changed against the saved config. Routes and Policy edit
// one draft and save together; Classifier saves each pick at once.

import {
  ACTIVITIES,
  effectiveActivities,
  effectiveRoutes,
  sameCell,
  sameRoute,
  TIERS,
  tuningOf,
} from '../../config.mjs';
import { percent } from '../../display.mjs';
import { plural } from './format.mjs';

// The route draft the Routes and Policy tabs edit: the saved routes, activity overrides and mode until the person
// changes one.
export function routeDraftOf(config, view) {
  if (view.routeDraft) return view.routeDraft;
  const base = structuredClone({
    ...(config.provider && config.provider !== 'anthropic' ? { provider: config.provider } : {}),
    routes: config.routes,
    baselineTier: config.baselineTier,
    activities: config.activities,
    activityRouting: config.activityRouting,
  });
  return { ...structuredClone(base), base };
}

/** @typedef {'downgradeVotes' | 'horizon' | 'cashCapUsd' | 'activityMass'} TuneKey */

// Rows: [key, label, format, router.json field]. Typed as tuples so tsc keeps each position's type.
/** @type {[TuneKey, string, (value: number) => string, string][]} */
export const POLICY_ROWS = [
  ['downgradeVotes', 'Votes to go down', String, 'policy.downgradeVotes'],
  ['horizon', 'Payback horizon', (v) => plural(v, 'turn'), 'policy.downgradeHorizonTurns'],
  ['cashCapUsd', 'Credits cap', (v) => `$${v.toFixed(2)}`, 'policy.cashCapUsd'],
  ['activityMass', 'Activity threshold', percent, 'policy.activityMass'],
];

// What Routes and Policy changed and have not saved: tiers, baseline, activity cells and mode against the saved config,
// policy values against the values the draft started from. `cells` lists [activity, tier] pairs.
export function routingChanges(config, view) {
  const raw = routeDraftOf(config, view);
  const draft = { ...effectiveRoutes(raw, config), ...effectiveActivities(raw, config) };
  const saved = tuningOf(config);
  const base = view.tuningBase ?? saved;
  const tuning = { ...saved, ...view.tuning };
  const tiers = TIERS.filter((tier) => !sameRoute(draft.routes[tier], config.routes[tier]));
  const baseline = draft.baselineTier !== config.baselineTier;
  const cells = ACTIVITIES.flatMap((activity) =>
    TIERS.filter((tier) => !sameCell(draft.activities[activity]?.[tier], config.activities[activity]?.[tier])).map(
      (tier) => [activity, tier],
    ),
  );
  const mode = draft.activityRouting !== config.activityRouting;
  const policy = POLICY_ROWS.map(([key]) => key).filter(
    (key) => Object.hasOwn(view.tuning ?? {}, key) && view.tuning[key] !== base[key],
  );
  const count = tiers.length + Number(baseline) + cells.length + Number(mode) + policy.length;
  return { draft, saved, tuning, tiers, baseline, cells, mode, policy, count };
}
