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

// One status-line segment, e.g. "router ▸ opus-5-5 · xhigh".
export function statusSegment(status) {
  if (!status) return 'router: gateway off, the next prompt starts it';
  const last = status.session;
  if (!last) return `${status.alias}: no turn yet`;
  const model = shortModel(last.model ?? status.routes.find((r) => r.tier === last.tier)?.model);
  const effort = last.effort ? ` · ${last.effort}` : '';
  return `${status.alias} ▸ ${model}${effort}`;
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
  }
  return lines.join('\n');
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
