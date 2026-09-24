// Defaults, user overrides and validation. Pure: callers pass env and the parsed user file.

export const TIERS = ['micro', 'low', 'medium', 'high'];
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
// Request features that Claude Code uses with its own models and that only some models accept (a beta each):
// `system` messages after the prompt, per-turn control, and tool additions or removals in the history.
export const FEATURES = ['mid-conversation-system', 'per-turn-control', 'mid-conversation-tool-changes'];

// The alias before 0.4.2. Settings written by an older /router:setup still send it; drop it once they are rare.
export const LEGACY_ALIAS = 'router';

export const DEFAULTS = {
  // `idleShutdownMs`: the gateway exits after this long without requests while no turn waits for a tool result;
  // the hooks start it again before the next prompt. Two hours outlast /loop wakeups and Monitor waits (up to one
  // hour), which reach the gateway without a prompt. 0 keeps it running.
  gateway: { port: 43170, alias: 'jev-router', baselineTier: 'low', auxiliaryTier: 'low', idleShutdownMs: 7_200_000 },
  // `high` and `medium` share one model and differ by effort: Opus 5.5 at xhigh is the strongest
  // setting this router can ask for, and the tier ladder stays four wide for the policy.
  routes: {
    high: { model: 'opus', effort: 'xhigh' },
    medium: { model: 'opus', effort: 'high' },
    low: { model: 'sonnet' },
    micro: { model: 'haiku' },
  },
  // `id` is sent upstream verbatim. List prices in USD per million tokens; `cacheRead` is absolute,
  // not a multiplier (Opus 5.5 reads at 0.05x input, the rest at the standard 0.1x). A price change must also change
  // test/fixtures/list-prices.json, with its source and date. `output` feeds only the shadow estimate in the log.
  // `efforts` lists what the model accepts; an empty list means no effort field and no adaptive thinking. A change
  // must also change test/fixtures/effort-support.json, from a new probe against the real API.
  // `features` lists the FEATURES the model accepts; the gateway removes the others from the request. A model
  // without the field gets none: a removed feature is lost, a feature the model rejects fails the turn. A change
  // must also change test/fixtures/model-features.json, from a new probe.
  models: {
    opus: {
      id: 'claude-opus-5-5',
      input: 4,
      output: 20,
      cacheRead: 0.2,
      contextWindow: 1_000_000,
      billing: 'plan',
      efforts: EFFORTS,
      features: FEATURES,
    },
    sonnet: {
      id: 'claude-sonnet-5',
      input: 2,
      output: 10,
      cacheRead: 0.2,
      contextWindow: 1_000_000,
      billing: 'plan',
      efforts: EFFORTS,
      features: ['mid-conversation-system'],
    },
    // `maxOutput` caps `max_tokens`: Claude Code asks for 128K, Haiku 4.5 answers more than 64K with 400.
    haiku: {
      id: 'claude-haiku-4-5',
      input: 1,
      output: 5,
      cacheRead: 0.1,
      contextWindow: 200_000,
      maxOutput: 64_000,
      billing: 'plan',
      efforts: [],
      features: [],
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
    continuationMass: 0.7,
    escalationHoldTurns: 2,
    // Ceiling on a cold cache write to a `credits` model. No default model bills credits, so this is
    // inert until a user adds one in router.json; a Claude Code turn starts near 100k tokens.
    cashCapUsd: 2,
  },
  jev: { endpoint: 'https://api.typesafe.ai/v1/systemone', model: 'jev-1.13.0', timeoutMs: 1500 },
  context: { recentTurns: 6, maxTextChars: 1200 },
  log: true,
};

const API_KEY_VAR = 'TYPESAFE_API_KEY';

// Keys a route or a model entry may carry. The other closed sections take their key sets from DEFAULTS.
const ROUTE_KEYS = ['model', 'effort'];
const MODEL_KEYS = [
  'id',
  'input',
  'output',
  'cacheRead',
  'contextWindow',
  'maxOutput',
  'billing',
  'efforts',
  'features',
];
// A JSON file can hold these as own keys; merged into a plain object they reach the prototype chain.
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// `forcedTier` skips Jev and the policy. It comes from the daemon's --force-tier flag, never from env: a project's
// settings can set a hook's env, and a forced tier changes spend.
export function loadConfig({ env = {}, userFile = null, forcedTier = null } = {}) {
  if (userFile !== null) checkShape(userFile);
  const config = merge(DEFAULTS, userFile ?? {});
  validate(config);
  const apiKey = env[API_KEY_VAR]?.trim() || null;
  if (forcedTier !== null && !TIERS.includes(forcedTier))
    throw new Error(`the forced tier must be one of ${TIERS.join(', ')}`);
  return { ...config, apiKey, forcedTier };
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
  checkObject(file, 'router.json', Object.keys(DEFAULTS));
  const { gateway, routes, models, cache, policy, jev, context } = file;
  if (gateway !== undefined) checkObject(gateway, 'gateway', Object.keys(DEFAULTS.gateway));
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
    if (route.effort !== undefined && !EFFORTS.includes(route.effort))
      throw new Error(`routes.${tier}.effort must be one of ${EFFORTS.join(', ')}`);
  }
  for (const [alias, model] of Object.entries(config.models)) {
    for (const field of ['input', 'cacheRead', 'contextWindow']) {
      if (!Number.isFinite(model[field]) || model[field] < 0)
        throw new Error(`models.${alias}.${field} must be a non-negative number`);
    }
    if (model.output !== undefined && !(Number.isFinite(model.output) && model.output >= 0))
      throw new Error(`models.${alias}.output must be a non-negative number`);
    if (typeof model.id !== 'string' || !model.id) throw new Error(`models.${alias}.id is required`);
    if (model.maxOutput !== undefined && !(Number.isInteger(model.maxOutput) && model.maxOutput > 0))
      throw new Error(`models.${alias}.maxOutput must be a positive integer`);
    if (!['plan', 'credits'].includes(model.billing))
      throw new Error(`models.${alias}.billing must be plan or credits`);
    if (!Array.isArray(model.efforts) || model.efforts.some((e) => !EFFORTS.includes(e)))
      throw new Error(`models.${alias}.efforts must list valid effort levels`);
    if (
      model.features !== undefined &&
      !(Array.isArray(model.features) && model.features.every((f) => FEATURES.includes(f)))
    )
      throw new Error(`models.${alias}.features must list known features (${FEATURES.join(', ')})`);
  }
  for (const key of ['baselineTier', 'auxiliaryTier']) {
    if (!TIERS.includes(config.gateway[key])) throw new Error(`gateway.${key} must be one of ${TIERS.join(', ')}`);
  }
  if (!Number.isInteger(config.gateway.port) || config.gateway.port < 1 || config.gateway.port > 65535)
    throw new Error('gateway.port must be a port number');
  if (typeof config.gateway.alias !== 'string' || !config.gateway.alias) throw new Error('gateway.alias is required');
  if (!(Number.isFinite(config.gateway.idleShutdownMs) && config.gateway.idleShutdownMs >= 0))
    throw new Error('gateway.idleShutdownMs must be a non-negative number (0 keeps the gateway running)');
  const p = config.policy;
  for (const field of ['upgradeBase', 'jumpConfidence', 'downgradeMass', 'continuationMass']) {
    if (!(isNumber(p[field], 0) && p[field] <= 1)) throw new Error(`policy.${field} must be between 0 and 1`);
  }
  for (const field of ['upgradeVotes', 'downgradeVotes', 'escalationHoldTurns']) {
    if (!isNumber(p[field], 1, { integer: true })) throw new Error(`policy.${field} must be a positive integer`);
  }
  if (!isNumber(p.upgradeSlope, 0)) throw new Error('policy.upgradeSlope must be a non-negative number');
  // The pivot divides: tax / (tax + pivot). Zero makes a free switch NaN and silently stops upgrades.
  if (!isNumber(p.upgradePivotUsd, 0, { above: true })) throw new Error('policy.upgradePivotUsd must be positive');
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
  if (typeof config.log !== 'boolean') throw new Error('log must be true or false');
}
