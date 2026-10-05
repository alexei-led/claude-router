import { atom, read, update } from 'claude-code';
import { registerProbe } from './runtime-probe.mjs';

const MODEL_IDS = { haiku: 'claude-haiku-4-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5' };

const route = atom(
  { plugin: 'router-mod-probe', key: 'route' },
  {
    turnId: '',
    model: null,
    requested: null,
    actual: null,
  },
);

export function register(on, options) {
  on('tool.describe', { tool: 'mcp__router_probe__verification_marker' }, async ($, e, next) => {
    const result = await next(e);
    $.ui.log('DEFERRED_PROBE isDeferred=true', { to: 'debug' });
    return { ...result, isDeferred: true };
  });
  registerProbe(on, options);
  on('turn.start', async ($, e, next) => {
    const model = e.text.match(/^\[router-mod:(haiku|sonnet|opus)\]/)?.[1] ?? null;
    await update($, route, () => ({ turnId: e.turnId, model, requested: null, actual: null }));
    return next(e);
  });

  on('turn.step', async function* ($, e, next) {
    const chosen = await read($, route);
    // Keep the experiment out of subagents and unrelated turns.
    if (e.agentId || chosen.turnId !== e.turnId || !chosen.model) return yield* next(e);

    const request = { ...e, model: MODEL_IDS[chosen.model] };
    if (chosen.model !== 'haiku') request.effort = 'low';
    else delete request.effort;
    await update($, route, (current) => ({ ...current, requested: request.model }));
    $.ui.log(`router-mod-probe request: ${e.model} -> ${request.model}, step ${e.index}`, { to: 'debug' });
    const result = yield* next(request);
    if (result.usage) {
      await update($, route, (current) => ({ ...current, actual: result.usage.model }));
      $.ui.log(`router-mod-probe response: ${result.usage.model}`, { to: 'debug' });
    }
    return result;
  });

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const chosen = await read($, route);
    const { Box, Text } = $.ui.resolve(e);
    return Box({
      children: [
        await next(e),
        Text({
          color: 'cyan',
          children: `Router probe: ${chosen.actual ?? chosen.requested ?? chosen.model ?? 'passthrough'}`,
        }),
      ],
    });
  });
}
