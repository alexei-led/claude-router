// Turn a request for the router alias into a request for a concrete model. Only `model`,
// `output_config.effort`, `thinking` and thinking edits in `context_management` change;
// system, tools and messages are never touched.
import { EFFORTS } from './config.mjs';

export function rewriteRequest(body, tier, config) {
  const route = config.routes[tier];
  const model = config.models[route.model];
  const out = { ...body, model: model.id };
  if (model.efforts.length === 0) return withoutThinking(out, body.output_config);
  const effort = clampEffort(route.effort ?? body.output_config?.effort, model.efforts);
  if (effort) out.output_config = { ...(body.output_config ?? {}), effort };
  return out;
}

// Highest supported level at or below the wanted one, as Claude Code does for its own models.
export function clampEffort(wanted, supported) {
  if (!wanted || supported.length === 0) return null;
  if (supported.includes(wanted)) return wanted;
  for (let i = EFFORTS.indexOf(wanted); i >= 0; i -= 1) if (supported.includes(EFFORTS[i])) return EFFORTS[i];
  return supported[0];
}

// A family with no effort control has no adaptive thinking either: omit both and run without thinking.
// The API rejects a clear_thinking edit without thinking, so drop those edits too.
function withoutThinking(out, outputConfig) {
  delete out.thinking;
  const edits = out.context_management?.edits;
  if (edits) {
    const kept = edits.filter((e) => !e.type?.startsWith('clear_thinking'));
    if (kept.length) out.context_management = { ...out.context_management, edits: kept };
    else delete out.context_management;
  }
  if (!outputConfig) return out;
  const { effort: _dropped, ...rest } = outputConfig;
  if (Object.keys(rest).length) out.output_config = rest;
  else delete out.output_config;
  return out;
}
