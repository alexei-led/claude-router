import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UsageReader } from '../lib/sse.mjs';

const START =
  'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-opus-5","usage":{"input_tokens":10,"cache_read_input_tokens":990,"cache_creation_input_tokens":100,"output_tokens":1,"cache_creation":{"ephemeral_1h_input_tokens":100,"ephemeral_5m_input_tokens":0}}}}\n\n';
const DELTA =
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":321}}\n\n';

test('reads usage across split SSE chunks', () => {
  const reader = new UsageReader();
  const text = `${START}data: {"type":"content_block_delta"}\n\n${DELTA}`;
  for (let i = 0; i < text.length; i += 7) reader.feed(text.slice(i, i + 7));
  const usage = reader.end();
  assert.equal(usage.model, 'claude-opus-5');
  assert.equal(usage.tokens, 1100);
  assert.equal(usage.outputTokens, 321);
  assert.equal(usage.ttl, '1h');
});

test('reads a non-streaming JSON body', () => {
  const reader = new UsageReader();
  reader.feed(
    JSON.stringify({
      type: 'message',
      role: 'assistant',
      model: 'claude-haiku-4-5',
      usage: { input_tokens: 5, output_tokens: 7 },
    }),
  );
  const usage = reader.end();
  assert.equal(usage.model, 'claude-haiku-4-5');
  assert.equal(usage.tokens, 5);
  assert.equal(usage.ttl, '5m');
});

test('returns null without usage', () => {
  const reader = new UsageReader();
  reader.feed('data: {"type":"error"}\n');
  assert.equal(reader.end(), null);
});
