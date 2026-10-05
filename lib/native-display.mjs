import { tierForModel } from './native-router.mjs';

export const REASONS = {
  ready: 'ready for the next turn',
  'same-tier': 'the task fits the current tier',
  'no-advice': 'keeping the current model without Jev advice',
  continuation: 'continuing the previous task',
  uncertain: 'Jev could not justify a change',
  upgrade: 'enough support for a stronger model',
  jump: 'clear need for a stronger model',
  downgrade: 'enough support for a cheaper model',
  'upgrade-pending': 'waiting before upgrading',
  'downgrade-pending': 'switching is not justified yet',
  hold: 'staying after an escalation',
  escalation: 'repeated tool failures need a stronger model',
  'cash-gate': 'estimated cold cache write exceeds the cap',
  'context-fit': 'a larger context window is needed',
  'context-unknown': 'context is not measured reliably',
  'model-unavailable': 'the requested model is not available',
  pinned: 'one-turn model pin',
};

export function formatTokens(value) {
  if (!Number.isFinite(value)) return 'unknown';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}K`;
  return String(Math.round(value));
}

export function bar(value, maximum, width = 16) {
  if (!Number.isFinite(value) || !(maximum > 0)) return { text: 'unknown', percent: null, color: 'gray' };
  const fraction = Math.max(0, value / maximum);
  const filled = Math.min(width, Math.round(fraction * width));
  return {
    text: `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`,
    percent: Math.round(fraction * 100),
    color: fraction > 0.8 ? 'red' : fraction > 0.6 ? 'yellow' : 'green',
  };
}

export function usageMetrics(config, view, usage) {
  const model = view.actualModel ?? view.selectedModel ?? view.nativeModel;
  const tier = tierForModel(config, model);
  const spec = tier ? config.models[config.routes[tier].model] : null;
  const window = spec?.contextWindow ?? null;
  const observed = Number.isFinite(usage?.context?.tokens) ? usage.context.tokens : null;
  const candidates = [view.contextTokens, observed === null ? null : observed + (view.outputTokens ?? 0)].filter(
    (value) => Number.isFinite(value),
  );
  const nextContext = candidates.length ? Math.max(...candidates) : null;
  const reuse = view.inputTokens > 0 && Number.isFinite(view.cacheRead) ? view.cacheRead / view.inputTokens : null;
  const cost = Number.isFinite(usage?.cost?.usd) ? usage.cost.usd : null;
  const cacheBenefit =
    spec && Number.isFinite(view.cacheRead) ? ((spec.input - spec.cacheRead) * view.cacheRead) / 1e6 : null;
  return {
    window,
    observed,
    nextContext,
    reuse,
    cost,
    cacheBenefit,
    contextBar: bar(nextContext, window),
    cacheBar: {
      ...bar(reuse, 1),
      color: reuse === null ? 'gray' : reuse >= 0.6 ? 'green' : reuse >= 0.2 ? 'yellow' : 'gray',
    },
  };
}

export function sparkline(values) {
  if (!values.length || !values.every(Number.isFinite)) return 'no history yet';
  const symbols = '▁▂▃▄▅▆▇█';
  const maximum = Math.max(...values);
  return values.map((value) => symbols[maximum > 0 ? Math.round((value / maximum) * 7) : 0]).join('');
}
