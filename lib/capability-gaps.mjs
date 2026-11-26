// The routed cells the auto engine cannot rank, for the pane to name: an unrated pair is passed over while a rated one
// is eligible, with nothing else to say why. Pure.
import { capabilityOf } from './auto-engine.mjs';
import { resolveRoute, routeSpec, TIERS } from './config.mjs';
import { clampEffort } from './cost.mjs';
import { applyMode } from './modes.mjs';

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
 * The config fields read here and by resolveRoute and applyMode.
 * @typedef {{ model: string, effort?: string | null }} Route
 * @typedef {{ routingEngine: string, activityRouting: string, routes: Record<string, Route>,
 *   activities: Record<string, Record<string, Partial<Route> | null>>,
 *   models: Record<string, { efforts: string[], capability?: unknown }>,
 *   policy: object, modes: Record<string, { policy?: object }> }} GapConfig
 */

/**
 * The distinct routed cells with unknown capability, as `alias@effort`, or the alias alone where no effort is named:
 * a model without efforts, or a session-effort route on a model rated at none of its efforts. The configured routes
 * come first. Shadow compares against what the table sends, so there the routing mode's moved routes count too; auto
 * never runs them. Subagent routes and fallbacks are not the auto engine's and are not read.
 * @param {GapConfig} config the configured routes, never a result of applyMode
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
      const model = routeSpec(routed, route);
      const effort = clampEffort(route.effort, model.efforts);
      const efforts = effort ? [effort] : model.efforts.length ? model.efforts : [null];
      if (efforts.every((e) => capabilityOf(model, { effort: e }, activity) === null))
        gaps.add(effort ? `${route.model}@${effort}` : route.model);
    }
  return [...gaps];
}
