// Router status: the snapshot the gateway serves at GET /router/status, and its text forms for the
// status line and /router:status. The snapshot never carries the API key, only whether one is set.
import { createRequire } from 'node:module';
import { TIERS } from './config.mjs';
import { clampEffort } from './rewrite.mjs';

const _require = createRequire(import.meta.url);
export const ROUTER_VERSION = _require('../package.json').version;

// True when `running` is older than `current`. Gateways before 0.3.0 report no version: they count as older.
export function isOlderVersion(running, current) {
  const parse = (v) => (/^\d+\.\d+\.\d+/.test(v ?? '') ? v.split('.').map((n) => Number.parseInt(n, 10)) : [0, 0, 0]);
  const [a, b] = [parse(running), parse(current)];
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}

export const STATUS_PATH = '/router/status';
// The name of the alias in the /model picker and in discovery.
export const ROUTER_DISPLAY_NAME = 'Jev Router (auto)';
const FETCH_TIMEOUT_MS = 300;

export function statusSnapshot(config, memory) {
  const { alias, port, baselineTier } = config.gateway;
  return {
    version: ROUTER_VERSION,
    alias,
    port,
    keySet: Boolean(config.apiKey),
    forcedTier: config.forcedTier ?? null,
    baselineTier,
    routes: TIERS.map((tier) => routeRow(config, tier)),
    session: memory?.lastRoute
      ? {
          tier: memory.lastRoute,
          reason: memory.lastReason ?? null,
          estimate: memory.lastEstimate ?? null,
          effort: memory.lastEffort ?? null,
          model: memory.lastRequest?.model ?? null,
          tokens: memory.lastRequest?.tokens ?? null,
          cacheReadTokens: memory.lastRequest?.cacheReadTokens ?? null,
          at: memory.lastRequest?.at ?? null,
        }
      : null,
  };
}

function routeRow(config, tier) {
  const route = config.routes[tier];
  const model = config.models[route.model];
  const effort = model.efforts.length === 0 ? 'none' : (clampEffort(route.effort, model.efforts) ?? 'as sent');
  return { tier, model: model.id, effort };
}

// Why the route of the last turn is what it is, for /router:status.
const REASONS = {
  upgrade: 'Jev voted above the current tier often enough, with enough mass for the switching tax',
  jump: 'Jev was confident enough to skip a tier and the vote delay',
  downgrade: 'Jev voted for a lower tier often enough, with enough mass',
  'upgrade-pending': 'Jev asked for a higher tier; the route stays until the votes and the mass are enough',
  'downgrade-pending': 'Jev asked for a lower tier; the route stays until the votes and the mass are enough',
  'same-tier': 'Jev agreed with the current tier',
  continuation: 'the prompt continues the task, so the route stays',
  uncertain: 'Jev abstained, so the route stays',
  'no-advice': 'no Jev answer (no key, a failure or a pause), so the route stays',
  escalation: 'the same error came back after an edit: one tier up',
  hold: 'the tier stays up for a few turns after an escalation',
  'cash-gate':
    'cold-write guard: the first cache write on a credits model would cost more than policy.cashCapUsd, so the strongest plan tier served',
  'context-fit': "the chosen model's window does not hold the context",
  forced: 'ROUTER_FORCE_TIER is set',
};

// One status-line segment, e.g. "router ▸ opus-5-5 · xhigh · upgrade".
export function statusSegment(status) {
  if (!status) return 'router: gateway off, the next prompt starts it';
  const last = status.session;
  if (!last) return `${status.alias}: no turn yet`;
  const model = shortModel(last.model ?? status.routes.find((r) => r.tier === last.tier)?.model);
  return [`${status.alias} ▸ ${model}`, last.effort, last.reason].filter(Boolean).join(' · ');
}

// Markdown for /router:status.
export function statusReport(status) {
  if (!status)
    return 'The router gateway is not running. The next prompt starts it. If it does not start, read `gateway.log` in the plugin data directory.';
  const lines = [
    `Router v${status.version}, gateway: http://127.0.0.1:${status.port}, alias \`${status.alias}\`.`,
    `Jev routing: ${jevState(status)}.`,
    `Default tier: ${status.baselineTier}.${status.forcedTier ? ` Forced tier: ${status.forcedTier}.` : ''}`,
    '',
    '| Tier | Model | Effort |',
    '| ---- | ----- | ------ |',
    ...status.routes.map((r) => `| ${r.tier} | ${r.model} | ${r.effort} |`),
    '',
  ];
  const last = status.session;
  if (!last) lines.push('No routed turn in this session yet.');
  else {
    const model = last.model ?? status.routes.find((r) => r.tier === last.tier)?.model;
    const effort = last.effort ? ` at ${last.effort}` : '';
    const context = last.tokens ? `, context ${last.tokens} tokens, cache reads ${last.cacheReadTokens}` : '';
    lines.push(`Last turn: ${last.tier} → ${model}${effort}, reason ${last.reason ?? 'unknown'}${context}.`);
    if (REASONS[last.reason]) lines.push(`Why: ${REASONS[last.reason]}.`);
    const estimate = describeEstimate(last.estimate);
    if (estimate) lines.push(`Estimate: ${estimate}.`);
  }
  return lines.join('\n');
}

// Dollars are list prices: for `plan` models a list-price equivalent, not a charge. `unknown` cache: no response for
// that cache since the session started or its history broke.
function describeEstimate(e) {
  if (!e) return null;
  const usd = (n) => `$${n.toFixed(2)}`;
  const parts = [];
  if (e.upgradeMass !== undefined)
    parts.push(
      `upgrade mass ${e.upgradeMass.toFixed(2)} against a bar of ${e.threshold.toFixed(2)}`,
      `switching tax ${usd(e.taxUsd)} at list prices`,
    );
  if (e.downgradeMass !== undefined) parts.push(`downgrade mass ${e.downgradeMass.toFixed(2)}`);
  if (e.coldUsd !== undefined) parts.push(`cold write ${usd(e.coldUsd)} against the cap of ${usd(e.cap)}`);
  if (e.streak !== undefined) parts.push(`${e.streak} vote(s) in a row`);
  if (e.cache?.candidate) parts.push(`cache: candidate ${e.cache.candidate}, current ${e.cache.incumbent}`);
  else if (typeof e.cache === 'string') parts.push(`cache ${e.cache}`);
  return parts.join(', ');
}

// null when the gateway does not answer in time.
export async function fetchStatus(port, sessionId) {
  const query = sessionId ? `?session=${encodeURIComponent(sessionId)}` : '';
  try {
    const res = await fetch(`http://127.0.0.1:${port}${STATUS_PATH}${query}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

function jevState(status) {
  if (!status.keySet) return 'inactive, no key: every turn runs on the default tier';
  if (status.jevPausedUntil) return `paused after repeated failures, next try at ${status.jevPausedUntil}`;
  return 'active';
}

function shortModel(id) {
  return id ? id.replace(/^claude-/, '') : 'unknown';
}
