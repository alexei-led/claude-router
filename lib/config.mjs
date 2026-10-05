// Defaults, user overrides and validation. Pure: callers pass env and the parsed user file.

export const TIERS = ['micro', 'low', 'medium', 'high'];
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
export const DEFAULTS = {
  baselineTier: 'low',
  // Sonnet 5.5 is the worker at `low`, at the effort the user picked. `medium` is Opus 5.5 at medium effort, a balance
  // of speed and cost per task; `high` is Opus 5.5 at xhigh, the strongest setting this router asks for.
  // These are routing defaults, not a claim of equal model quality.
  routes: {
    high: { model: 'opus', effort: 'xhigh' },
    medium: { model: 'opus', effort: 'medium' },
    low: { model: 'sonnet' },
    micro: { model: 'haiku' },
  },
  // `id` selects the native model. List prices in USD per million tokens; `cacheRead` is absolute,
  // not a multiplier (Opus 5.5 reads at 0.05x input, the rest at the standard 0.1x). A price change must also change
  // test/fixtures/list-prices.json, with its source and date. `output` feeds the shadow estimate and the downgrade tax.
  // `efforts` lists what the model accepts; an empty list means no effort field and no adaptive thinking. A change
  // must also change test/fixtures/effort-support.json, from a new probe against the real API.
  models: {
    opus: {
      id: 'claude-opus-5-5',
      input: 4,
      output: 20,
      cacheRead: 0.2,
      contextWindow: 1_000_000,
      billing: 'plan',
      efforts: EFFORTS,
    },
    sonnet: {
      id: 'claude-sonnet-5-5',
      input: 2,
      output: 10,
      cacheRead: 0.2,
      contextWindow: 1_000_000,
      billing: 'plan',
      efforts: EFFORTS,
    },
    haiku: {
      id: 'claude-haiku-4-5',
      input: 1,
      output: 5,
      cacheRead: 0.1,
      contextWindow: 200_000,
      billing: 'plan',
      efforts: [],
    },
  },
  cache: {
    writeMultiplier: { '5m': 1.25, '1h': 2 },
    ttlMs: { '5m': 300_000, '1h': 3_600_000 },
    warmMarginMs: 30_000,
  },
  policy: {
    upgradeVotes: 2,
    upgradeBase: 0.75,
    upgradeSlope: 0.15,
    upgradePivotUsd: 0.5, // tax at which half the slope applies: $0.20 of tax raises the bar to ~0.79, $4 to ~0.88
    jumpConfidence: 0.95,
    downgradeVotes: 2,
    downgradeMass: 0.9,
    downgradeSlope: 0.08, // a cold candidate raises the bar toward ~0.98, same shape as the upgrade bar
    downgradePivotUsd: 0.5,
    downgradeHorizonTurns: 5, // turns whose output and read savings offset a downgrade's cache write
    continuationMass: 0.7,
    escalationHoldTurns: 2,
    // Ceiling on a cold cache write to a `credits` model. No default model bills credits, so this is
    // inert until a user adds one in router.json; a Claude Code turn starts near 100k tokens.
    cashCapUsd: 2,
  },
  jev: { endpoint: 'https://api.typesafe.ai/v1/systemone', model: 'jev-1.13.0', timeoutMs: 1500 },
  context: { recentTurns: 6, maxTextChars: 1200 },
};

const API_KEY_VAR = 'TYPESAFE_API_KEY';

// Keys a route or a model entry may carry. The other closed sections take their key sets from DEFAULTS.
const ROUTE_KEYS = ['model', 'effort'];
const MODEL_KEYS = ['id', 'input', 'output', 'cacheRead', 'contextWindow', 'billing', 'efforts'];
// A JSON file can hold these as own keys; merged into a plain object they reach the prototype chain.
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function loadConfig({ env = {}, userFile = null } = {}) {
  if (userFile !== null) checkShape(userFile);
  const config = merge(DEFAULTS, userFile ?? {});
  validate(config);
  const apiKey = env[API_KEY_VAR]?.trim() || null;
  return { ...config, apiKey };
}

// The router.json `file` with its routes and baseline set to `draft`. Only differences from DEFAULTS are written,
// so a later change of a default still reaches tiers the user never edited; a route equal to the default is removed.
export function withRoutes(file, draft) {
  const { routes: _routes, baselineTier: _baseline, ...rest } = file;
  const routes = {};
  for (const tier of TIERS) {
    const { model, effort = null } = draft.routes[tier];
    const preset = DEFAULTS.routes[tier];
    if (model === preset.model && effort === (preset.effort ?? null)) continue;
    routes[tier] = effort !== null || preset.effort ? { model, effort } : { model };
  }
  return {
    ...rest,
    ...(Object.keys(routes).length ? { routes } : {}),
    ...(draft.baselineTier !== DEFAULTS.baselineTier ? { baselineTier: draft.baselineTier } : {}),
  };
}

export function rank(tier) {
  return TIERS.indexOf(tier);
}

function merge(base, override) {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return override;
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    out[key] =
      Object.hasOwn(base, key) && typeof value === 'object' && value !== null && !Array.isArray(value)
        ? merge(base[key], value)
        : value;
  }
  return out;
}

// The raw file, before the merge: only known keys, and every section an object. Messages name the path, never the
// value. An open map (model aliases, cache TTL labels) takes any key but the forbidden ones.
function checkShape(file) {
  if (
    file &&
    typeof file === 'object' &&
    (Object.hasOwn(file, 'gateway') ||
      Object.hasOwn(file, 'log') ||
      Object.values(file.models ?? {}).some(
        (model) => model && (Object.hasOwn(model, 'features') || Object.hasOwn(model, 'maxOutput')),
      ))
  )
    throw new Error(
      'router.json uses gateway settings; run node scripts/migrate-config.mjs /path/to/router.json from the router plugin directory',
    );
  checkObject(file, 'router.json', Object.keys(DEFAULTS));
  const { routes, models, cache, policy, jev, context } = file;
  if (routes !== undefined) {
    checkObject(routes, 'routes', TIERS);
    for (const [tier, route] of Object.entries(routes)) checkObject(route, `routes.${tier}`, ROUTE_KEYS);
  }
  if (models !== undefined) {
    checkObject(models, 'models');
    for (const [alias, model] of Object.entries(models)) checkObject(model, `models.${alias}`, MODEL_KEYS);
  }
  if (cache !== undefined) {
    checkObject(cache, 'cache', Object.keys(DEFAULTS.cache));
    for (const map of ['writeMultiplier', 'ttlMs'])
      if (cache[map] !== undefined) checkObject(cache[map], `cache.${map}`);
  }
  if (policy !== undefined) checkObject(policy, 'policy', Object.keys(DEFAULTS.policy));
  if (jev !== undefined) checkObject(jev, 'jev', Object.keys(DEFAULTS.jev));
  if (context !== undefined) checkObject(context, 'context', Object.keys(DEFAULTS.context));
}

// `allowed` null: an open map.
function checkObject(value, path, allowed = null) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${path} must be an object`);
  for (const key of Object.keys(value)) {
    const at = path === 'router.json' ? key : `${path}.${key}`;
    if (FORBIDDEN_KEYS.has(key)) throw new Error(`${at} is not allowed`);
    if (allowed && !allowed.includes(key)) throw new Error(`${at} is not a known key`);
  }
}

const isNumber = (value, min, { above = false, integer = false } = {}) =>
  Number.isFinite(value) && (above ? value > min : value >= min) && (!integer || Number.isInteger(value));

function validate(config) {
  for (const tier of TIERS) {
    const route = config.routes[tier];
    if (!route || typeof route.model !== 'string') throw new Error(`routes.${tier}.model is required`);
    if (!Object.hasOwn(config.models, route.model)) throw new Error(`routes.${tier}.model is not in models`);
    // null keeps the session effort; it is how a file overrides a default route that names one.
    if (route.effort != null && !EFFORTS.includes(route.effort))
      throw new Error(`routes.${tier}.effort must be one of ${EFFORTS.join(', ')} or null`);
  }
  for (const [alias, model] of Object.entries(config.models)) {
    for (const field of ['input', 'cacheRead', 'contextWindow']) {
      if (!Number.isFinite(model[field]) || model[field] < 0)
        throw new Error(`models.${alias}.${field} must be a non-negative number`);
    }
    if (model.output !== undefined && !(Number.isFinite(model.output) && model.output >= 0))
      throw new Error(`models.${alias}.output must be a non-negative number`);
    if (typeof model.id !== 'string' || !model.id) throw new Error(`models.${alias}.id is required`);
    if (!['plan', 'credits'].includes(model.billing))
      throw new Error(`models.${alias}.billing must be plan or credits`);
    if (!Array.isArray(model.efforts) || model.efforts.some((e) => !EFFORTS.includes(e)))
      throw new Error(`models.${alias}.efforts must list valid effort levels`);
  }
  if (!TIERS.includes(config.baselineTier)) throw new Error(`baselineTier must be one of ${TIERS.join(', ')}`);
  const p = config.policy;
  for (const field of ['upgradeBase', 'jumpConfidence', 'downgradeMass', 'continuationMass']) {
    if (!(isNumber(p[field], 0) && p[field] <= 1)) throw new Error(`policy.${field} must be between 0 and 1`);
  }
  for (const field of ['upgradeVotes', 'downgradeVotes', 'downgradeHorizonTurns', 'escalationHoldTurns']) {
    if (!isNumber(p[field], 1, { integer: true })) throw new Error(`policy.${field} must be a positive integer`);
  }
  // The pivot divides: tax / (tax + pivot). Zero makes a free switch NaN and silently stops that switch.
  for (const side of ['upgrade', 'downgrade']) {
    if (!isNumber(p[`${side}Slope`], 0)) throw new Error(`policy.${side}Slope must be a non-negative number`);
    if (!isNumber(p[`${side}PivotUsd`], 0, { above: true })) throw new Error(`policy.${side}PivotUsd must be positive`);
  }
  if (!isNumber(p.cashCapUsd, 0)) throw new Error('policy.cashCapUsd must be a non-negative number');
  const { cache, jev, context } = config;
  for (const map of ['writeMultiplier', 'ttlMs']) {
    for (const [ttl, value] of Object.entries(cache[map]))
      if (!isNumber(value, 0, { above: true })) throw new Error(`cache.${map}.${ttl} must be positive`);
  }
  if (!isNumber(cache.warmMarginMs, 0)) throw new Error('cache.warmMarginMs must be a non-negative number');
  if (!isNumber(jev.timeoutMs, 0, { above: true })) throw new Error('jev.timeoutMs must be positive');
  for (const field of ['endpoint', 'model']) {
    if (typeof jev[field] !== 'string' || !jev[field]) throw new Error(`jev.${field} is required`);
  }
  for (const field of ['recentTurns', 'maxTextChars']) {
    if (!isNumber(context[field], 1, { integer: true })) throw new Error(`context.${field} must be a positive integer`);
  }
}
