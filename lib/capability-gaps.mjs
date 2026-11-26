// The routed cells the auto engine cannot rank, for the pane to name: an unrated pair is passed over while a rated one
// is eligible, with nothing else to say why. Pure.
import { resolveRoute, TIERS } from './config.mjs';
import { clampEffort } from './cost.mjs';
import { applyMode } from './modes.mjs';

// The engine's lookup (auto-engine.mjs capabilityOf): a number is the model's one value; an activity map gives the
// activity, else its `default` column.
function isRated(model, effort, activity) {
  const value = model.capability?.[effort];
  if (typeof value !== 'object' || value === null) return typeof value === 'number';
  return typeof ((activity === null ? undefined : value[activity]) ?? value.default) === 'number';
}

// Every tier's route, and each activity cell while activity routing runs them.
function routedCells(config) {
  const tiers = TIERS.map((tier) => ({ tier, activity: null }));
  if (config.activityRouting !== 'on') return tiers;
  const cells = Object.entries(config.activities).flatMap(([activity, byTier]) =>
    Object.keys(byTier).map((tier) => ({ tier, activity })),
  );
  return [...tiers, ...cells];
}

/**
 * The distinct routed cells with unknown capability, as `alias@effort`, or the alias alone where no effort is named:
 * a model without efforts, or a session-effort route on a model rated at none of its efforts. The configured routes
 * come first. Shadow compares against what the table sends, so there the routing mode's moved routes count too; auto
 * never runs them. Subagent routes and fallbacks are not the auto engine's and are not read.
 * @param {any} config the configured routes, never a result of applyMode
 * @param {{ mode: string, source: string } | null} [routingMode] the active mode
 * @returns {string[]}
 */
export function capabilityGaps(config, routingMode = null) {
  const configs = [config];
  if (config.routingEngine === 'shadow' && routingMode) configs.push(applyMode(config, routingMode));
  /** @type {Set<string>} */
  const gaps = new Set();
  for (const routed of configs)
    for (const { tier, activity } of routedCells(routed)) {
      const route = resolveRoute(routed, tier, activity);
      const model = routed.models[route.model];
      const effort = clampEffort(route.effort, model.efforts);
      const efforts = effort ? [effort] : model.efforts.length ? model.efforts : ['default'];
      if (!efforts.some((e) => isRated(model, e, activity)))
        gaps.add(effort ? `${route.model}@${effort}` : route.model);
    }
  return [...gaps];
}
