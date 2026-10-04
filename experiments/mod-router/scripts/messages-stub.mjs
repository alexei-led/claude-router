import { createServer } from 'node:http';

// Loopback Messages API stand-in for fallback acceptance. It reports request shape only: never headers or text.
const OVERLOADED = process.env.STUB_OVERLOADED_MODEL;
const TOOL_FILE = process.env.STUB_TOOL_FILE;
const report = (value) => process.stdout.write(`${JSON.stringify({ at: Date.now(), ...value })}\n`);

function sse(res, model, blocks, stopReason) {
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  send('message_start', {
    message: {
      id: 'msg_stub',
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      usage: { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 },
    },
  });
  blocks.forEach((block, index) => {
    send('content_block_start', { index, content_block: block.start });
    send('content_block_delta', { index, delta: block.delta });
    send('content_block_stop', { index });
  });
  send('message_delta', { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 8 } });
  send('message_stop', {});
  res.end();
}

const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    if (!req.url.startsWith('/v1/messages') || req.method !== 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"input_tokens":100}');
      return;
    }
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      res.writeHead(400).end();
      return;
    }
    const last = body.messages?.at(-1);
    const afterTool = Array.isArray(last?.content) && last.content.some((part) => part.type === 'tool_result');
    const offersTool = Array.isArray(body.tools) && body.tools.some((tool) => tool.name === 'Read');
    report({
      event: 'messages',
      model: body.model,
      stream: Boolean(body.stream),
      effort: body.output_config?.effort ?? null,
      afterTool,
      tools: Array.isArray(body.tools) ? body.tools.length : 0,
      maxTokens: body.max_tokens ?? null,
      overloaded: body.model === OVERLOADED,
    });
    if (body.model === OVERLOADED) {
      res.writeHead(529, { 'content-type': 'application/json' });
      res.end('{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}');
      return;
    }
    if (!afterTool && offersTool && TOOL_FILE) {
      sse(
        res,
        body.model,
        [
          {
            start: { type: 'tool_use', id: 'toolu_stub', name: 'Read', input: {} },
            delta: { type: 'input_json_delta', partial_json: JSON.stringify({ file_path: TOOL_FILE }) },
          },
        ],
        'tool_use',
      );
      return;
    }
    sse(
      res,
      body.model,
      [{ start: { type: 'text', text: '' }, delta: { type: 'text_delta', text: 'OK' } }],
      'end_turn',
    );
  });
});
server.listen(0, '127.0.0.1', () => report({ event: 'listening', port: server.address().port }));
process.on('SIGTERM', () => {
  server.closeAllConnections();
  server.close();
});
