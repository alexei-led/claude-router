// Incremental usage reader for a Messages response: streaming SSE or a plain JSON body.
export class UsageReader {
  constructor() {
    this.buffer = '';
    this.usage = null;
    this.model = null;
  }

  feed(chunk) {
    this.buffer += chunk;
    for (let at = this.buffer.indexOf('\n'); at >= 0; at = this.buffer.indexOf('\n')) {
      const line = this.buffer.slice(0, at).trim();
      this.buffer = this.buffer.slice(at + 1);
      if (line.startsWith('data:')) this.take(line.slice(5).trim());
    }
  }

  end() {
    const rest = this.buffer.trim();
    if (rest.startsWith('{')) this.take(rest);
    this.buffer = '';
    return this.result();
  }

  take(json) {
    let event;
    try {
      event = JSON.parse(json);
    } catch {
      return;
    }
    const message = event.type === 'message_start' ? event.message : event.type === 'message' ? event : null;
    if (message?.usage) {
      this.model = message.model ?? this.model;
      this.usage = { ...(this.usage ?? {}), ...message.usage };
    }
    if (event.type === 'message_delta' && event.usage) this.usage = { ...(this.usage ?? {}), ...event.usage };
  }

  result() {
    if (!this.usage) return null;
    const u = this.usage;
    const tokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    return {
      model: this.model,
      tokens,
      cacheReadTokens: u.cache_read_input_tokens ?? 0,
      outputTokens: u.output_tokens ?? 0,
      ttl: (u.cache_creation?.ephemeral_1h_input_tokens ?? 0) > 0 ? '1h' : '5m',
    };
  }
}
