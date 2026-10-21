// Routing modes (docs/plans/2026-10-21-routing-modes.md): one setting that trades cost against answer quality. The
// classifier and the configured routes stay as they are; the mode moves each tier's route by one fixed step. Pure.
import { ACTIVITIES, DEFAULTS, EFFORTS, ROUTING_MODES, rank, resolveRoute, sameRoute, TIERS } from './config.mjs';
import { clampEffort } from './cost.mjs';

// `wanted` on a model that lists `supported`: itself, else the next higher listed, else the highest lower one.
export function projectEffort(supported, wanted) {
  if (supported.includes(wanted)) return wanted;
  const at = EFFORTS.indexOf(wanted);
  return (
    EFFORTS.slice(at + 1).find((e) => supported.includes(e)) ??
    EFFORTS.slice(0, at)
      .reverse()
      .find((e) => supported.includes(e)) ??
    null
  );
}

// The route's effort one level up (`step` 1) or down (-1), on what the model lists; null when it cannot move that
// way: a null effort (the session's), a model without efforts, or no listed level in that direction. The model's
// lowest listed level is the floor, so a route never loses its effort.
function steppedEffort(config, route, step) {
  const supported = config.models[route.model].efforts;
  const from = clampEffort(route.effort, supported);
  if (!from) return null;
  const wanted = EFFORTS[EFFORTS.indexOf(from) + step];
  const effort = wanted ? projectEffort(supported, wanted) : null;
  return effort && Math.sign(EFFORTS.indexOf(effort) - EFFORTS.indexOf(from)) === step ? effort : null;
}

// The route `mode` runs for tier and activity, always from the configured routes. `cost` takes the tier below (never
// below `low`) when it runs a model with a lower input price, else one effort level less; `quality` one effort level
// more, else the tier above. One lever per decision: cost pays mostly for input and cache tokens, which effort does
// not lower, and quality keeps the model and its cache. `micro` and `balanced` keep the configured route.
export function modeRoute(config, mode, tier, activity = null) {
  const routeAt = (t) => resolveRoute(config, t, activity);
  const route = routeAt(tier);
  if (mode === 'balanced' || tier === 'micro') return route;
  if (mode === 'cost') {
    const below = routeAt(TIERS[Math.max(rank('low'), rank(tier) - 1)]);
    if (below.model !== route.model && config.models[below.model].input < config.models[route.model].input)
      return below;
    const effort = steppedEffort(config, route, -1);
    return effort ? { model: route.model, effort } : route;
  }
  const effort = steppedEffort(config, route, 1);
  return effort ? { model: route.model, effort } : routeAt(TIERS[Math.min(TIERS.length - 1, rank(tier) + 1)]);
}

// The config a turn routes on in `routingMode` ({ mode, source }): every tier's and activity's route as modeRoute
// gives it, and the mode's policy fields over `policy`. `config` must be the configured one (router.config), never a
// result of this function: the transform starts from the configured routes, so repeated turns never step twice.
// `balanced` keeps the routes object as configured.
export function applyMode(config, routingMode) {
  const { mode } = routingMode;
  const policy = { ...config.policy, ...config.modes[mode]?.policy };
  if (mode === 'balanced') return { ...config, policy, routingMode };
  const routes = Object.fromEntries(TIERS.map((tier) => [tier, modeRoute(config, mode, tier)]));
  const activities = {};
  for (const activity of ACTIVITIES)
    for (const tier of TIERS) {
      const route = modeRoute(config, mode, tier, activity);
      if (!sameRoute(route, routes[tier])) activities[activity] = { ...activities[activity], [tier]: route };
    }
  return { ...config, routes, activities, policy, routingMode };
}

// The active mode and its source: a session override, then the project file, then the profile router.json.
export function resolveRoutingMode({ session = null, project = null, profile = DEFAULTS.mode } = {}) {
  if (ROUTING_MODES.includes(session)) return { mode: session, source: 'session' };
  if (ROUTING_MODES.includes(project)) return { mode: project, source: 'project' };
  if (profile !== DEFAULTS.mode) return { mode: profile, source: 'profile' };
  return { mode: DEFAULTS.mode, source: 'default' };
}

// `cost (session)`.
export const modeLabel = ({ mode, source }) => `${mode} (${source})`;

// A project's `.claude/router.json`, which may hold only `mode`: the repo chooses among routes the user configured,
// never the routes, models or classifier. Returns { mode, error }: a file that does not read is ignored, with a reason
// that names the key, never its value. No file: { mode: null, error: null }.
export function readProjectMode(text) {
  if (text === null) return { mode: null, error: null };
  let file;
  try {
    file = JSON.parse(text);
  } catch {
    return { mode: null, error: 'project .claude/router.json is not valid JSON' };
  }
  if (typeof file !== 'object' || file === null || Array.isArray(file))
    return { mode: null, error: 'project .claude/router.json must be an object' };
  const other = Object.keys(file).find((key) => key !== 'mode');
  if (other !== undefined) return { mode: null, error: `project .claude/router.json may only set mode, not ${other}` };
  if (!Object.hasOwn(file, 'mode')) return { mode: null, error: null };
  if (!ROUTING_MODES.includes(file.mode))
    return { mode: null, error: `project .claude/router.json mode must be one of ${ROUTING_MODES.join(', ')}` };
  return { mode: file.mode, error: null };
}
