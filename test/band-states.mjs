// The band views the golden and graphical band tests share.
import { GATEWAY_SETTINGS } from '../lib/display.mjs';
import { NOW, SESSION, STORE } from './usage-fixtures.mjs';

// Claude Code's own readings: context fill, the plan windows (the 5h one resets in an hour; the 7d one reports no
// reset) and its cost.
export const CLAUDE = {
  context: { tokens: 120_000 },
  rateLimits: [
    { kind: 'five_hour', percentUsed: 37, resetsAt: new Date(NOW + 3600e3).toISOString() },
    { kind: 'seven_day', percentUsed: 81 },
  ],
  cost: { usd: 18.003 },
};
export const ROUTED = {
  mode: 'auto',
  phase: 'routed',
  tier: 'high',
  selectedModel: 'claude-opus-5-5',
  actualModel: 'claude-opus-5-5',
  effort: 'xhigh',
  nativeModel: 'claude-opus-5-5',
  nativeEffort: 'xhigh',
  reason: 'jump',
};
export const SESSION_RECORDS = { usageSession: SESSION, usageStore: STORE };

export const BAND_STATES = {
  routed: { view: ROUTED },
  'routed-activity-estimate': {
    view: {
      ...ROUTED,
      tier: 'medium',
      selectedModel: 'claude-sonnet-5-5',
      actualModel: 'claude-sonnet-5-5',
      effort: 'high',
      reason: 'upgrade',
      activity: 'code',
      estimate: { threshold: 0.82, upgradeMass: 0.88, taxUsd: 0.476 },
      routingMode: { mode: 'cost', source: 'session' },
      contextTokens: 90_000,
      inputTokens: 1000,
      cacheRead: 900,
    },
    usage: CLAUDE,
  },
  'routed-goal': {
    view: { ...ROUTED, goal: 'ship', taskPhase: 'build', activity: 'code', reason: 'same-tier' },
    usage: CLAUDE,
  },
  ready: { view: { mode: 'auto', phase: 'ready', nativeModel: 'claude-opus-5-5', nativeEffort: 'xhigh' } },
  off: {
    view: {
      mode: 'manual',
      phase: 'manual',
      nativeModel: 'claude-sonnet-5-5',
      reason: 'model selected manually',
    },
  },
  unavailable: {
    view: {
      mode: 'auto',
      phase: 'unavailable',
      nativeModel: 'claude-opus-5-5',
      nativeEffort: 'xhigh',
      error: GATEWAY_SETTINGS,
    },
  },
  choosing: { view: { mode: 'auto', phase: 'choosing', nativeModel: 'claude-opus-5-5' } },
  'pending-pin': { view: { ...ROUTED, pendingPin: 'low' } },
  'native-fallback': { view: { ...ROUTED, actualModel: 'claude-sonnet-5-5', reason: 'native-fallback' } },
  'classifier-set-up': {
    view: { ...ROUTED, tier: 'medium', selectedModel: 'claude-opus-5-5', effort: 'medium', error: 'missing-key' },
  },
  'classifier-details': { view: { ...ROUTED, error: 'timeout', reason: 'no-advice' } },
  detail: { view: { ...ROUTED, ...SESSION_RECORDS, bandDetail: true }, usage: CLAUDE },
  'detail-off': {
    view: { mode: 'manual', phase: 'manual', nativeModel: 'claude-sonnet-5-5', bandDetail: true },
    usage: CLAUDE,
  },
};
