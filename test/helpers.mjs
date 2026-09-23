// Builders for Messages request bodies, router memory and Jev advice.
export const T0 = Date.parse('2026-09-22T10:00:00Z');

export function user(text) {
  return { role: 'user', content: [{ type: 'text', text }] };
}

export function toolResult(text, { isError = false } = {}) {
  return {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 't', is_error: isError, content: [{ type: 'text', text }] },
      { type: 'text', text: '<system-reminder>ignored</system-reminder>' },
    ],
  };
}

export function assistant(text, tools = []) {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }, ...tools.map((name) => ({ type: 'tool_use', id: 't', name, input: {} }))],
  };
}

export function body(messages, extra = {}) {
  return {
    model: 'jev-router',
    max_tokens: 1000,
    stream: true,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'high' },
    system: [],
    tools: [],
    messages,
    ...extra,
  };
}

export function memory({ lastRoute = null, models = {}, lastRequest = null, state = null } = {}) {
  return { lastRoute, models, lastRequest, state };
}

export function served(modelId, { tokens = 20_000, output = 500, ttl = '1h', at = T0 } = {}) {
  return {
    lastRequest: { model: modelId, tokens, outputTokens: output, cacheReadTokens: tokens, ttl, at },
    models: { [modelId]: { lastAt: at, prefixTokens: tokens + output, ttl } },
  };
}

export function advice(choice, probabilities, { continuation = 0, confidence = 0.9 } = {}) {
  const p = { micro: 0, low: 0, medium: 0, high: 0, uncertain: 0, ...probabilities };
  return { choice, confidence, probabilities: p, continuation };
}

export function jevResponse(choice, probabilities, continuation = 0) {
  return {
    answers: {
      route: { type: 'choice', choice, confidence: 0.9, probabilities },
      continuation: { type: 'noul', noul: continuation },
    },
  };
}
