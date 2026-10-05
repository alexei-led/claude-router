import { createInterface } from 'node:readline';

const tool = 'verification_marker';
const send = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  if (request.id === undefined) return;
  if (request.method === 'initialize') {
    send(request.id, {
      protocolVersion: request.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'router-gates', version: '1.0.0' },
    });
  } else if (request.method === 'tools/list') {
    send(request.id, {
      tools: [
        {
          name: tool,
          description: 'Get the local routing verification marker. The marker must be retrieved, never guessed.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          annotations: { readOnlyHint: true, destructiveHint: false },
        },
      ],
    });
  } else if (request.method === 'tools/call' && request.params.name === tool) {
    process.stderr.write('MCP_PROBE tool-called\n');
    send(request.id, { content: [{ type: 'text', text: 'ROUTER_DEFERRED_4C2A' }] });
  } else if (request.method === 'ping') send(request.id, {});
  else
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Unsupported fixture method' } })}\n`,
    );
});
