// Turn a request for the router alias into a request for a concrete model. `model`, `max_tokens`,
// `output_config.effort`, `thinking` and thinking edits in `context_management` change. For a model without a
// request feature that Claude Code uses (config FEATURES), the messages and the beta header lose that feature,
// as Claude Code itself does when the model answers 400; system prompt and tools are never touched.
import { EFFORTS } from './config.mjs';

const TOOL_CHANGE_BLOCKS = new Set(['tool_addition', 'tool_removal']);
const LONG_CONTEXT_BETA = /^context-1m-/;
const LONG_CONTEXT_WINDOW = 1_000_000;
// Each feature is a beta; a model without the feature answers the beta with 400.
const FEATURE_BETAS = {
  'mid-conversation-system': /^mid-conversation-system-/,
  'per-turn-control': /^per-turn-control-/,
  'mid-conversation-tool-changes': /^mid-conversation-tool-changes-/,
};

export function rewriteRequest(body, tier, config) {
  const route = config.routes[tier];
  const model = config.models[route.model];
  const out = { ...body, model: model.id };
  if (Array.isArray(body.messages)) out.messages = adaptMessages(body.messages, model.features ?? []);
  if (model.maxOutput && out.max_tokens > model.maxOutput) out.max_tokens = model.maxOutput;
  if (model.efforts.length === 0) return withoutThinking(out, body.output_config);
  const effort = clampEffort(route.effort ?? body.output_config?.effort, model.efforts);
  if (effort) out.output_config = { ...(body.output_config ?? {}), effort };
  return out;
}

// The `anthropic-beta` header for the routed model, or null when nothing is left. `jev-router[1m]` makes Claude Code
// send the 1M context beta on every request; a model with a smaller window answers it with 400.
export function adaptBetas(beta, modelId, config) {
  const model = Object.values(config.models).find((m) => m.id === modelId);
  if (!model) return beta;
  const features = model.features ?? [];
  const dropped = Object.entries(FEATURE_BETAS)
    .filter(([feature]) => !features.includes(feature))
    .map(([, pattern]) => pattern);
  if (model.contextWindow < LONG_CONTEXT_WINDOW) dropped.push(LONG_CONTEXT_BETA);
  const kept = beta.split(',').filter((flag) => !dropped.some((pattern) => pattern.test(flag.trim())));
  return kept.length ? kept.join(',') : null;
}

// Pure and deterministic: the same history adapts the same way on every turn, so the cached prefix holds.
function adaptMessages(messages, features) {
  let out = messages;
  if (!features.includes('mid-conversation-tool-changes')) out = out.map(withoutToolChanges).filter(Boolean);
  if (!features.includes('mid-conversation-system')) out = foldSystemMessages(out);
  return out;
}

// Drops tool_addition and tool_removal blocks. A dropped block's cache breakpoint moves to the block before it, or the
// turn loses its last breakpoint; a message left empty is dropped.
function withoutToolChanges(message) {
  if (!Array.isArray(message.content) || !message.content.some((b) => TOOL_CHANGE_BLOCKS.has(b?.type))) return message;
  const content = [];
  for (const block of message.content) {
    if (!TOOL_CHANGE_BLOCKS.has(block?.type)) content.push(block);
    else if (block.cache_control && content.length && !content.at(-1).cache_control)
      content[content.length - 1] = { ...content.at(-1), cache_control: block.cache_control };
  }
  return content.length ? { ...message, content } : null;
}

// A `system` message becomes text in the user message next to it, wrapped as a system reminder: the form Claude Code
// uses for hook output when the model takes no system messages.
function foldSystemMessages(messages) {
  const out = [];
  let lastFolded = false;
  for (const message of messages) {
    const folded = message.role === 'system';
    const next = folded ? { role: 'user', content: blocks(message.content).map(asReminder) } : message;
    const prev = out.at(-1);
    if (prev?.role === 'user' && next.role === 'user' && (folded || lastFolded))
      out[out.length - 1] = { ...prev, content: [...blocks(prev.content), ...next.content] };
    else out.push(next);
    lastFolded = folded;
  }
  return out;
}

function blocks(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? content : [];
}

function asReminder(block) {
  return block?.type === 'text' ? { ...block, text: `<system-reminder>\n${block.text}\n</system-reminder>` } : block;
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
