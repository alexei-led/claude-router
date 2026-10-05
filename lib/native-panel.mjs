import { TIERS } from './config.mjs';
import { bar, formatTokens, REASONS, sparkline, usageMetrics } from './native-display.mjs';

function label(id) {
  return id ? id.replace(/^claude-/, '').replace(/-([0-9])-([0-9])/, ' $1.$2') : 'no response yet';
}

export function renderPanel({ Box, Text, Button, Select }, config, view, usage, actions) {
  const metrics = usageMetrics(config, view, usage);
  const heading = (text) => Text({ bold: true, color: 'cyan', children: text });
  const row = (name, value) => Text({ children: `${name}: ${value}` });
  const gauge = (name, value, suffix) =>
    Text({
      color: value.color,
      children: `${name}  ${value.text}${value.percent === null ? '' : ` ${value.percent}%`} ${suffix}`,
    });
  const dollars = (value) => (Number.isFinite(value) ? `$${value.toFixed(3)}` : 'not reported');
  const difference = (value) => `${value < 0 ? '−' : '+'}$${Math.abs(value).toFixed(3)}`;
  const tuning = view.tuning ?? {
    timeoutMs: config.jev.timeoutMs,
    downgradeVotes: config.policy.downgradeVotes,
    horizon: config.policy.downgradeHorizonTurns,
  };
  const select = (key, name, values, value) =>
    Select({
      key,
      label: name,
      value: String(value),
      options: values.map((n) => ({ value: String(n), label: String(n) })),
      onSelect: (picked) => {
        if (values.includes(Number(picked))) actions.tune(key, Number(picked));
      },
    });
  return Box({
    flexDirection: 'column',
    children: [
      heading(`MODEL ROUTING · ${view.mode === 'auto' ? 'Auto' : 'Manual'}`),
      row('Last reply', label(view.actualModel)),
      row('Selected', label(view.selectedModel)),
      row('Requested effort', view.effort ?? 'native default'),
      row('Why', REASONS[view.reason] ?? view.reason),
      view.pendingPin ? row('Next turn only', view.pendingPin) : null,
      heading('USAGE · Claude readings'),
      row('API cost reported by Claude', dollars(metrics.cost)),
      gauge('Context', metrics.contextBar, `~${formatTokens(metrics.nextContext)} / ${formatTokens(metrics.window)}`),
      row('Observed / estimated input', `${formatTokens(metrics.observed)} / ${formatTokens(view.contextTokens)}`),
      Text({ dimColor: true, children: '20% window reserve. The bar uses the routed model’s window.' }),
      gauge('Cache reuse', metrics.cacheBar, 'last response'),
      row('Cache read / written', `${formatTokens(view.cacheRead)} / ${formatTokens(view.cacheWrite)} tokens`),
      row('Output', `${formatTokens(view.outputTokens)} tokens`),
      row('Input trend', sparkline(view.history ?? [])),
      ...(usage?.rateLimits ?? [])
        .filter((limit) => Number.isFinite(limit.percentUsed))
        .map((limit) => gauge(limit.kind.replaceAll('_', ' '), bar(limit.percentUsed, 100), 'quota used')),
      heading('JEV & SWITCH ESTIMATE'),
      row('Jev', view.error ?? (view.keySet ? 'ready' : 'key not set')),
      row(
        'Last classification',
        view.adviceMs === null || view.adviceMs === undefined ? 'not attempted' : `${view.adviceMs} ms`,
      ),
      view.adviceChoice ? row('Suggested tier', view.adviceChoice) : null,
      Number.isFinite(view.estimate?.threshold)
        ? row('Policy support required', `${Math.round(view.estimate.threshold * 100)}%`)
        : null,
      Number.isFinite(view.estimate?.taxUsd) ? row('Estimated switching tax', dollars(view.estimate.taxUsd)) : null,
      ...(view.comparison
        ? [
            row('Compared tiers', `${view.comparison.incumbent} → ${view.comparison.candidate}`),
            row(
              'Next-turn difference',
              `${difference(view.comparison.minUsd)} to ${difference(view.comparison.maxUsd)}`,
            ),
            row(
              'Conservative payback',
              view.comparison.paybackTurns === null
                ? 'no projected payback'
                : `${view.comparison.paybackTurns} later turns`,
            ),
            Text({
              dimColor: true,
              children: `Cache scenarios use 5m–1h writes and ${formatTokens(view.comparison.outputTokens)} output tokens. Minus means cheaper.`,
            }),
          ]
        : []),
      row('Cache read benefit', dollars(metrics.cacheBenefit)),
      Text({
        dimColor: true,
        children: 'Cache benefit: configured-price estimate vs uncached reads, before write costs.',
      }),
      Text({
        dimColor: true,
        children: 'Routing savings are not measured. Plan prices are equivalents, not cash charges.',
      }),
      heading('CONTROLS'),
      Box({
        children: [
          Button({
            key: 'auto',
            label: 'Auto routing',
            hotkey: 'a',
            variant: view.mode === 'auto' ? 'primary' : 'secondary',
            onPress: () => actions.mode('auto'),
          }),
          Text({ children: ' ' }),
          Button({
            key: 'manual',
            label: 'Manual model',
            hotkey: 'm',
            variant: view.mode === 'manual' ? 'primary' : 'secondary',
            onPress: () => actions.mode('manual'),
          }),
        ],
      }),
      Text({ dimColor: true, children: 'Pins affect the next turn only. Enable Auto first.' }),
      ...tierLabels(config).map(({ tier, name }) =>
        Button({ key: `pin-${tier}`, label: name, onPress: () => actions.pin(tier) }),
      ),
      Button({
        key: 'key',
        label: view.keySet ? 'Jev key configured · edit' : 'Set Jev API key',
        hotkey: 'k',
        onPress: actions.key,
      }),
      heading('TUNING · future turns'),
      ...(Select
        ? [
            select('timeoutMs', 'Jev deadline (ms)', [500, 1000, 1500, 3000], tuning.timeoutMs),
            select('downgradeVotes', 'Votes before cheaper tier', [1, 2, 3], tuning.downgradeVotes),
            select('horizon', 'Payback horizon (turns)', [1, 3, 5, 10], tuning.horizon),
            Button({ key: 'save-tuning', label: 'Save tuning', onPress: actions.save }),
          ]
        : []),
      row('Credits cold-write cap', `$${config.policy.cashCapUsd.toFixed(2)} · excludes output/session spend`),
      Text({ dimColor: true, children: `Advanced: ${view.configPath ?? 'active profile router.json'}` }),
      Text({ dimColor: true, children: 'Main conversation routing. Subagents keep Claude’s model selection.' }),
      view.notice ? Text({ color: 'yellow', children: view.notice }) : null,
      Button({ key: 'close', label: 'Close', hotkey: 'q', role: 'dismiss', onPress: actions.close }),
    ],
  });
}

function tierLabels(config) {
  return TIERS.map((tier) => {
    const route = config.routes[tier];
    return {
      tier,
      name: `${tier}: ${label(config.models[route.model].id)}${route.effort ? ` · ${route.effort}` : ''}`,
    };
  });
}
