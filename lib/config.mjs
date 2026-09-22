// Defaults, user overrides and validation. Pure: callers pass env and the parsed user file.

export const TIERS = ['micro', 'low', 'medium', 'high'];
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

export const DEFAULTS = {
  gateway: { port: 43170, alias: 'router', baselineTier: 'low', auxiliaryTier: 'low' },
  routes: {
    high: { model: 'fable', effort: 'xhigh' },
    medium: { model: 'opus', effort: 'high' },
    low: { model: 'sonnet' },
    micro: { model: 'haiku' },
  },
  // `id` is sent upstream verbatim. List prices in USD per million tokens; `cacheRead` is absolute,
  // not a multiplier: Fable 5.1 reads are billed at 0.25 (Claude API reference, verify when prices move).
  // `efforts` lists what the model accepts; an empty list means no effort field and no adaptive thinking.
  models: {
    fable: {
      id: 'claude-fable-5-1',
      input: 10,
      cacheRead: 0.25,
      contextWindow: 1_000_000,
      billing: 'credits',
      efforts: EFFORTS,
    },
    opus: {
      id: 'claude-opus-5',
      input: 5,
      cacheRead: 0.5,
      contextWindow: 1_000_000,
      billing: 'plan',
      efforts: EFFORTS,
    },
    sonnet: {
      id: 'claude-sonnet-4-6',
      input: 3,
      cacheRead: 0.3,
      contextWindow: 1_000_000,
      billing: 'plan',
      efforts: ['low', 'medium', 'high', 'max'],
    },
    haiku: { id: 'claude-haiku-4-5', input: 1, cacheRead: 0.1, contextWindow: 200_000, billing: 'plan', efforts: [] },
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
    continuationMass: 0.7,
    escalationHoldTurns: 2,
    cashCapUsd: 2, // a Claude Code turn starts near 100k tokens (system prompt + tools): cold Fable is ~$1.25 before any history
  },
  jev: { endpoint: 'https://api.typesafe.ai/v1/systemone', model: 'jev-1.13.0', timeoutMs: 1500 },
  context: { recentTurns: 6, maxTextChars: 1200 },
  log: true,
};

const API_KEY_VAR = 'TYPESAFE_API_KEY';

export function loadConfig({ env = {}, userFile = null } = {}) {
  const config = merge(DEFAULTS, userFile ?? {});
  validate(config);
  const apiKey = env[API_KEY_VAR]?.trim() || null;
  const forcedTier = env.ROUTER_FORCE_TIER ?? null;
  if (forcedTier && !TIERS.includes(forcedTier))
    throw new Error(`ROUTER_FORCE_TIER must be one of ${TIERS.join(', ')}`);
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
      key in base && typeof value === 'object' && value !== null && !Array.isArray(value)
        ? merge(base[key], value)
        : value;
  }
  return out;
}

function validate(config) {
  for (const tier of TIERS) {
    const route = config.routes[tier];
    if (!route || typeof route.model !== 'string') throw new Error(`routes.${tier}.model is required`);
    const model = config.models[route.model];
    if (!model) throw new Error(`routes.${tier}.model "${route.model}" is not in models`);
    if (route.effort !== undefined && !EFFORTS.includes(route.effort))
      throw new Error(`routes.${tier}.effort "${route.effort}" is invalid`);
  }
  for (const [alias, model] of Object.entries(config.models)) {
    for (const field of ['input', 'cacheRead', 'contextWindow']) {
      if (!Number.isFinite(model[field]) || model[field] < 0)
        throw new Error(`models.${alias}.${field} must be a non-negative number`);
    }
    if (typeof model.id !== 'string' || !model.id) throw new Error(`models.${alias}.id is required`);
    if (!['plan', 'credits'].includes(model.billing))
      throw new Error(`models.${alias}.billing must be plan or credits`);
    if (!Array.isArray(model.efforts) || model.efforts.some((e) => !EFFORTS.includes(e)))
      throw new Error(`models.${alias}.efforts must list valid effort levels`);
  }
  for (const key of ['baselineTier', 'auxiliaryTier']) {
    if (!TIERS.includes(config.gateway[key])) throw new Error(`gateway.${key} must be one of ${TIERS.join(', ')}`);
  }
  if (!Number.isInteger(config.gateway.port) || config.gateway.port < 1 || config.gateway.port > 65535)
    throw new Error('gateway.port must be a port number');
  if (typeof config.gateway.alias !== 'string' || !config.gateway.alias) throw new Error('gateway.alias is required');
  const p = config.policy;
  for (const field of ['upgradeBase', 'jumpConfidence', 'downgradeMass', 'continuationMass']) {
    if (!(p[field] >= 0 && p[field] <= 1)) throw new Error(`policy.${field} must be between 0 and 1`);
  }
  for (const field of ['upgradeVotes', 'downgradeVotes', 'escalationHoldTurns']) {
    if (!Number.isInteger(p[field]) || p[field] < 1) throw new Error(`policy.${field} must be a positive integer`);
  }
  if (!(p.cashCapUsd >= 0)) throw new Error('policy.cashCapUsd must be a non-negative number');
  if (!(config.jev.timeoutMs > 0)) throw new Error('jev.timeoutMs must be positive');
}
