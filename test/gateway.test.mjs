import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../lib/config.mjs';
import { createGateway } from '../lib/gateway.mjs';
import { Router } from '../lib/router.mjs';
import { body, user } from './helpers.mjs';

const SSE =
  'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-opus-5-5","usage":{"input_tokens":10,"cache_read_input_tokens":90,"output_tokens":1}}}\n\nevent: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":42}}\n\n';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// fetch keeps its sockets alive, and close() alone waits for them: the process would never exit.
function shutdown(...servers) {
  for (const server of servers) {
    server.closeAllConnections();
    server.close();
  }
}

test('routed requests are rewritten, headers forwarded, responses piped verbatim, usage recorded', async () => {
  const seen = [];
  const upstream = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ url: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString()) });
      res.writeHead(200, { 'content-type': 'text/event-stream', 'x-upstream': 'yes' });
      res.end(SSE);
    });
  });
  const upPort = await listen(upstream);
  const config = loadConfig({ env: { ROUTER_FORCE_TIER: 'medium' } });
  const router = new Router({
    config,
    fetchFn: async () => {
      throw new Error('no jev');
    },
    dataDir: mkdtempSync(join(tmpdir(), 'proxy-')),
    now: () => 5_000,
  });
  const gateway = createGateway({ router, upstream: `http://127.0.0.1:${upPort}` });
  const port = await listen(gateway);

  const res = await fetch(`http://127.0.0.1:${port}/v1/messages?beta=true`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer secret',
      'anthropic-beta': 'oauth-2025-04-20',
      'accept-encoding': 'gzip',
      'x-claude-code-session-id': 'sess-1',
      'x-claude-code-request-class': 'main',
    },
    body: JSON.stringify(body([user('hello')])),
  });
  const text = await res.text();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-upstream'), 'yes');
  assert.equal(text, SSE);
  assert.equal(seen[0].body.model, 'claude-opus-5-5');
  assert.equal(seen[0].body.output_config.effort, 'high');
  assert.equal(seen[0].headers.authorization, 'Bearer secret');
  assert.equal(seen[0].headers['anthropic-beta'], 'oauth-2025-04-20');
  assert.equal(seen[0].headers['accept-encoding'], undefined);
  assert.equal(seen[0].url, '/v1/messages?beta=true');
  await new Promise((r) => setTimeout(r, 20));
  const memory = router.memory('sess-1');
  assert.equal(memory.lastRoute, 'medium');
  assert.equal(memory.models['claude-opus-5-5'].prefixTokens, 142);

  const passthrough = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-haiku-4-5', messages: [] }),
  });
  await passthrough.text();
  assert.equal(seen[1].body.model, 'claude-haiku-4-5');

  const models = await (await fetch(`http://127.0.0.1:${port}/v1/models?limit=1000`)).json();
  assert.equal(models.data[0].id, 'router');
  shutdown(gateway, upstream);
});

test('an unreachable upstream answers 502', async () => {
  const config = loadConfig({});
  const router = new Router({ config, fetchFn: async () => null, dataDir: mkdtempSync(join(tmpdir(), 'proxy-')) });
  const gateway = createGateway({ router, upstream: 'http://127.0.0.1:1', onError: () => {} });
  const port = await listen(gateway);
  const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, { method: 'POST', body: '{}' });
  assert.equal(res.status, 502);
  shutdown(gateway);
});

test('auxiliary responses do not touch memory and a routing error falls back to the baseline', async () => {
  const seen = [];
  const upstream = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push(JSON.parse(Buffer.concat(chunks).toString()));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(SSE);
    });
  });
  const upPort = await listen(upstream);
  const config = loadConfig({ env: { TYPESAFE_API_KEY: 'k' } });
  const router = new Router({
    config,
    fetchFn: async () => {
      throw new Error('jev down');
    },
    dataDir: mkdtempSync(join(tmpdir(), 'proxy-')),
    now: () => 5_000,
  });
  const gateway = createGateway({ router, upstream: `http://127.0.0.1:${upPort}` });
  const port = await listen(gateway);
  const headers = { 'content-type': 'application/json', 'x-claude-code-session-id': 'sess-2' };
  await (
    await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { ...headers, 'x-claude-code-request-class': 'main' },
      body: JSON.stringify(body([user('hello')])),
    })
  ).text();
  await new Promise((r) => setTimeout(r, 20));
  const before = JSON.stringify(router.memory('sess-2'));
  await (
    await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { ...headers, 'x-claude-code-request-class': 'auxiliary' },
      body: JSON.stringify(body([user('title?')])),
    })
  ).text();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(JSON.stringify(router.memory('sess-2')), before);
  assert.equal(seen[1].model, 'claude-sonnet-4-6');

  router.route = async () => {
    throw new Error('boom');
  };
  await (
    await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body([user('x')])),
    })
  ).text();
  assert.equal(seen[2].model, 'claude-sonnet-4-6');
  shutdown(gateway, upstream);
});
