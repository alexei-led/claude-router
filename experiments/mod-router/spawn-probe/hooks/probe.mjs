// Records each agent.spawn input and result, and the first turn.step model of each agent loop, to $OUT.
const rows = [];
const seen = new Set();
async function flush($) {
  const out = await $.env.get('SPAWN_PROBE_OUT');
  if (out) await $.fs.write(out, JSON.stringify(rows, null, 2));
}
export function register(on) {
  on('agent.spawn', async ($, e, next) => {
    const started = Date.now();
    const m = /OVR:(\S+)/.exec(e.description) ?? /OVR:(\S+)/.exec(e.prompt);
    const input = { ...e, prompt: e.prompt.slice(0, 120) };
    const sent = m ? { ...e, model: m[1] } : e;
    const result = await next(sent);
    rows.push({ event: 'agent.spawn', input, override: m?.[1] ?? null, result, nextMs: Date.now() - started, budget: next.budget?.ms });
    await flush($);
    return result;
  });
  on('turn.step', async function* ($, e, next) {
    if (e.agentId && !seen.has(e.agentId)) {
      seen.add(e.agentId);
      rows.push({ event: 'turn.step', agentId: e.agentId, model: e.model, effort: e.effort ?? null });
      await flush($);
    }
    return yield* next(e);
  });
}
