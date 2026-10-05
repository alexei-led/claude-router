// Historical v0.8.0 reference for local acceptance probes; excluded from the published plugin.
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
  // Sonnet 5.5 is the worker: `low` at the effort the user picked, `medium` at xhigh, so an escalation from `low`
  // stays on Sonnet's cache instead of a cold write to Opus. `high` is Opus 5.5 at xhigh, the strongest setting this
  // router asks for: Anthropic keeps Opus for open-ended, long-horizon work. xhigh on Sonnet is not yet measured
  // against Opus at high; the `observed` lines in decisions.jsonl are the input for that.
  routes: {
    high: { model: 'opus', effort: 'xhigh' },
    medium: { model: 'sonnet', effort: 'xhigh' },
    low: { model: 'sonnet' },
    micro: { model: 'haiku' },
  },
  // `id` is sent upstream verbatim. List prices in USD per million tokens; `cacheRead` is absolute,
  // not a multiplier (Opus 5.5 reads at 0.05x input, the rest at the standard 0.1x). A price change must also change
  // test/fixtures/list-prices.json, with its source and date. `output` feeds the shadow estimate and the downgrade tax.
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
      id: 'claude-sonnet-5-5',
      input: 2,
      output: 10,
      cacheRead: 0.2,
      contextWindow: 1_000_000,
      billing: 'plan',
      efforts: EFFORTS,
      features: FEATURES,
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
    downgradeHorizonTurns: 5, // turns whose output and read savings offset a downgrade's cache write
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
