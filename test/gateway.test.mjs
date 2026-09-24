import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../lib/config.mjs';
import { createGateway } from '../lib/gateway.mjs';
import { IdleTracker } from '../lib/idle.mjs';
import { Router } from '../lib/router.mjs';
import { body, user } from './helpers.mjs';

const SSE =
  'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-opus-5-5","usage":{"input_tokens":10,"cache_read_input_tokens":90,"output_tokens":1}}}\n\nevent: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":42}}\n\n';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

function plainRouter() {
  return new Router({
    config: loadConfig({}),
    fetchFn: async () => {
      throw new Error('no jev');
    },
    dataDir: mkdtempSync(join(tmpdir(), 'proxy-')),
  });
}

// An upstream that answers every request with `respond(req, res)` after reading the body.
async function upstreamWith(respond) {
  const upstream = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => respond(JSON.parse(Buffer.concat(chunks).toString() || 'null'), res));
  });
  return { upstream, url: `http://127.0.0.1:${await listen(upstream)}` };
}

test('routed requests are rewritten, headers forwarded, responses piped verbatim, usage recorded', async (t) => {
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
  t.after(() => shutdown(gateway, upstream));

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
  // The cache is keyed by the model and the effort the gateway sent.
  assert.equal(memory.models['claude-opus-5-5@high'].prefixTokens, 142);

  const passthrough = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-haiku-4-5', messages: [] }),
  });
  await passthrough.text();
  assert.equal(seen[1].body.model, 'claude-haiku-4-5');

  const models = await (await fetch(`http://127.0.0.1:${port}/v1/models?limit=1000`)).json();
  assert.equal(models.data[0].id, 'jev-router');
  assert.equal(models.data[0].display_name, 'Jev Router (auto)');
  assert.match(models.data[0].description, /claude-opus-5-5 \/ claude-sonnet-5 \/ claude-haiku-4-5/);

  const status = await (await fetch(`http://127.0.0.1:${port}/router/status?session=sess-1`)).json();
  assert.equal(status.keySet, false);
  assert.equal(status.pid, process.pid);
  assert.equal(status.jevPausedUntil, null);
  const fresh = await (await fetch(`http://127.0.0.1:${port}/router/status?session=other`)).json();
  assert.equal(fresh.session, null);
});

test('an unreachable upstream answers 502', async (t) => {
  const config = loadConfig({});
  const router = new Router({ config, fetchFn: async () => null, dataDir: mkdtempSync(join(tmpdir(), 'proxy-')) });
  const gateway = createGateway({ router, upstream: 'http://127.0.0.1:1', onError: () => {} });
  const port = await listen(gateway);
  t.after(() => shutdown(gateway));
  const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, { method: 'POST', body: '{}' });
  assert.equal(res.status, 502);
});

test('auxiliary responses do not touch memory and a routing error falls back to the baseline', async (t) => {
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
  t.after(() => shutdown(gateway, upstream));
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
  assert.equal(seen[1].model, 'claude-sonnet-5');

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
  assert.equal(seen[2].model, 'claude-sonnet-5');
});

test('an upstream reset mid-stream reaches the client as an error, not a hang', async (t) => {
  const { upstream, url } = await upstreamWith((_body, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`${SSE.split('\n\n')[0]}\n\n`);
    setTimeout(() => res.socket.destroy(), 20);
  });
  const errors = [];
  const gateway = createGateway({ router: plainRouter(), upstream: url, onError: (e) => errors.push(e.message) });
  const port = await listen(gateway);
  t.after(() => shutdown(gateway, upstream));
  const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    body: JSON.stringify(body([user('x')])),
  });
  const outcome = await Promise.race([
    res.text().then(
      () => 'ended',
      () => 'errored',
    ),
    sleep(2_000).then(() => 'hung'),
  ]);
  assert.equal(outcome, 'errored');
  await sleep(50); // the gateway logs after both sides have closed, the client can see its error first
  assert.deepEqual(errors, ['upstream stream: aborted']);
});

test('a client that leaves mid-stream stops the upstream response', async (t) => {
  const TOTAL = 100;
  let upstreamClosed;
  const closed = new Promise((resolve) => {
    upstreamClosed = resolve;
  });
  const { upstream, url } = await upstreamWith((_body, res) => {
    let written = 0;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const timer = setInterval(() => {
      res.write('event: ping\ndata: {"type":"ping"}\n\n');
      written += 1;
      if (written === TOTAL) res.end();
    }, 10);
    res.on('close', () => {
      clearInterval(timer);
      upstreamClosed(written);
    });
  });
  const errors = [];
  const gateway = createGateway({ router: plainRouter(), upstream: url, onError: (e) => errors.push(e.message) });
  const port = await listen(gateway);
  t.after(() => shutdown(gateway, upstream));
  const req = request({ host: '127.0.0.1', port, path: '/v1/messages', method: 'POST' }, (res) => {
    res.once('data', () => req.destroy());
  });
  req.on('error', () => {});
  req.end(JSON.stringify(body([user('x')])));
  const written = await closed;
  assert.ok(written < TOTAL, `upstream wrote ${written} of ${TOTAL} events after the client left`);
  await sleep(20);
  assert.deepEqual(errors, []);
});

test('a failure while recording usage keeps the gateway serving', async (t) => {
  const { upstream, url } = await upstreamWith((_body, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(SSE);
  });
  const router = plainRouter();
  router.recordResponse = () => {
    throw new Error('ENOSPC: no space left on device');
  };
  const errors = [];
  const gateway = createGateway({ router, upstream: url, onError: (e) => errors.push(e.message) });
  const port = await listen(gateway);
  t.after(() => shutdown(gateway, upstream));
  const send = () =>
    fetch(`http://127.0.0.1:${port}/v1/messages`, { method: 'POST', body: JSON.stringify(body([user('x')])) });
  assert.equal(await (await send()).text(), SSE);
  await sleep(20);
  assert.equal(await (await send()).text(), SSE);
  assert.ok(errors.includes('ENOSPC: no space left on device'));
});

test('count_tokens gets the session model without a Jev call or a policy turn', async (t) => {
  const seen = [];
  const { upstream, url } = await upstreamWith((received, res) => {
    seen.push(received);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"input_tokens":12}');
  });
  let jevCalls = 0;
  const router = new Router({
    config: loadConfig({ env: { TYPESAFE_API_KEY: 'k' } }),
    fetchFn: async () => {
      jevCalls += 1;
      throw new Error('no jev');
    },
    dataDir: mkdtempSync(join(tmpdir(), 'proxy-')),
  });
  const gateway = createGateway({ router, upstream: url });
  const port = await listen(gateway);
  t.after(() => shutdown(gateway, upstream));
  const res = await fetch(`http://127.0.0.1:${port}/v1/messages/count_tokens?beta=true`, {
    method: 'POST',
    headers: { 'x-claude-code-session-id': 'ct' },
    body: JSON.stringify({ model: 'router', messages: [user('how big is this')] }),
  });
  assert.equal(await res.text(), '{"input_tokens":12}');
  assert.equal(seen[0].model, 'claude-sonnet-5');
  assert.equal(jevCalls, 0);
  assert.equal(router.memory('ct').state, null);
  assert.equal(router.memory('ct').lastRoute, null);
});

test('requests from a foreign host or a web origin are refused', async (t) => {
  const gateway = createGateway({ router: plainRouter(), upstream: 'http://127.0.0.1:1' });
  const port = await listen(gateway);
  t.after(() => shutdown(gateway));
  const statusCode = (headers) =>
    new Promise((resolve) => {
      request({ host: '127.0.0.1', port, path: '/router/status', headers }, (res) => {
        res.resume();
        resolve(res.statusCode);
      }).end();
    });
  assert.equal(await statusCode({ host: 'attacker.example' }), 403);
  assert.equal(await statusCode({ origin: 'https://attacker.example' }), 403);
  assert.equal(await statusCode({ origin: 'null' }), 403);
  assert.equal(await statusCode({}), 200);
  assert.equal(await statusCode({ host: `localhost:${port}` }), 200);
  // Claude Code sends no Origin. A page on another loopback port could still fire blind POSTs that spend Jev quota.
  assert.equal(await statusCode({ host: `localhost:${port}`, origin: 'http://localhost:3000' }), 403);
  assert.equal(await statusCode({ origin: `http://127.0.0.1:${port}` }), 403);
});

test('a turn that waits for a tool result is tracked until the session sends its next request', async (t) => {
  const TOOL_USE =
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":3}}\n\n';
  let answer = TOOL_USE;
  const { upstream, url } = await upstreamWith((_body, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(answer);
  });
  const activity = new IdleTracker();
  const gateway = createGateway({ router: plainRouter(), upstream: url, activity });
  const port = await listen(gateway);
  t.after(() => shutdown(gateway, upstream));
  const send = async (model) => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'x-claude-code-session-id': 'w' },
      body: JSON.stringify(body([user('x')], { model })),
    });
    await res.text();
    await sleep(20);
  };
  await send('router');
  assert.equal(activity.waiting.has('w'), true);
  await (await fetch(`http://127.0.0.1:${port}/router/status?session=w`)).text();
  assert.equal(activity.waiting.has('w'), true);
  answer = SSE;
  await send('router');
  assert.equal(activity.waiting.has('w'), false);
  answer = TOOL_USE;
  await send('claude-opus-5-5'); // a pinned model passes through and is tracked too
  assert.equal(activity.waiting.has('w'), true);
  assert.equal(activity.inFlight, 0);
});

// H1: a side request (session title, classifier, compaction) shares the session key. By its hint header it does not
// answer a pending tool wait, or the gateway could idle out under a permission prompt. Without the header the body
// cannot tell a side request from a turn with thinking off, so the wait bookkeeping fails safe: any tool_use stop
// starts a wait, and any request without a side-request header ends it.
test('side requests on a session keep its tool wait; a tool_use stop always starts one', async (t) => {
  const TOOL_USE =
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":3}}\n\n';
  let answer = TOOL_USE;
  const { upstream, url } = await upstreamWith((_body, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(answer);
  });
  const activity = new IdleTracker();
  const gateway = createGateway({ router: plainRouter(), upstream: url, activity });
  const port = await listen(gateway);
  t.after(() => shutdown(gateway, upstream));
  const send = async (session, requestClass = null, extra = {}) => {
    const headers = { 'x-claude-code-session-id': session };
    if (requestClass) headers['x-claude-code-request-class'] = requestClass;
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body([user('x')], extra)),
    });
    await res.text();
    await sleep(20);
  };
  await send('w', 'main');
  assert.equal(activity.waiting.has('w'), true);
  answer = SSE;
  await send('w', 'auxiliary');
  await send('w', 'compaction');
  assert.equal(activity.waiting.has('w'), true);
  answer = SSE;
  await send('w', 'main');
  assert.equal(activity.waiting.has('w'), false);
  // No header, thinking off: a main turn with thinking disabled looks like a side request by shape. It must still
  // start the wait when it stops for a tool.
  answer = TOOL_USE;
  await send('v', null, { thinking: { type: 'disabled' } });
  assert.equal(activity.waiting.has('v'), true);
});

test('a routed turn that fails upstream leaves a failed line and no prompt text in the log', async (t) => {
  const { upstream, url } = await upstreamWith((_body, res) => {
    res.writeHead(529, { 'content-type': 'application/json' });
    res.end('{"type":"error","error":{"type":"overloaded_error"}}');
  });
  const router = plainRouter();
  const gateway = createGateway({ router, upstream: url });
  const port = await listen(gateway);
  t.after(() => shutdown(gateway, upstream));
  const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'x-claude-code-session-id': 'f', 'x-claude-code-request-class': 'main' },
    body: JSON.stringify(body([user('CANARY-PROMPT fix it')])),
  });
  assert.equal(res.status, 529);
  await res.text();
  await sleep(20);
  const text = readFileSync(join(router.dataDir, 'decisions.jsonl'), 'utf8');
  const failed = text
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
    .find((e) => e.failed);
  assert.deepEqual(failed.failed, { status: 529, tier: 'low', model: 'claude-sonnet-5', effort: 'high' });
  assert.doesNotMatch(text, /CANARY/);
});

test('the 1M context beta reaches only models with a 1M window', async (t) => {
  const seen = [];
  const upstream = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      seen.push(req.headers['anthropic-beta']);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(SSE);
    });
  });
  const upPort = await listen(upstream);
  const cases = [
    ['micro', 'oauth-2025-04-20'],
    ['medium', 'oauth-2025-04-20,context-1m-2025-08-07'],
  ];
  for (const [tier] of cases) {
    const router = new Router({
      config: loadConfig({ env: { ROUTER_FORCE_TIER: tier } }),
      fetchFn: async () => {
        throw new Error('no jev');
      },
      dataDir: mkdtempSync(join(tmpdir(), 'proxy-')),
    });
    const gateway = createGateway({ router, upstream: `http://127.0.0.1:${upPort}` });
    t.after(() => shutdown(gateway));
    const port = await listen(gateway);
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'anthropic-beta': 'oauth-2025-04-20,context-1m-2025-08-07' },
      body: JSON.stringify(body([user('hello')])),
    });
    await res.text();
  }
  t.after(() => shutdown(upstream));
  assert.deepEqual(
    seen,
    cases.map(([, beta]) => beta),
  );
});

test('a subagent keeps its own routing memory; hint headers reach the router', async (t) => {
  const { upstream, url } = await upstreamWith((_body, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(SSE);
  });
  const router = plainRouter();
  const seen = [];
  const route = router.route.bind(router);
  router.route = (body, hints) => {
    seen.push(hints);
    return route(body, hints);
  };
  const gateway = createGateway({ router, upstream: url });
  t.after(() => shutdown(gateway, upstream));
  const port = await listen(gateway);
  const send = (headers) =>
    fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-claude-code-session-id': 'sess-1', ...headers },
      body: JSON.stringify(body([user('hello')])),
    }).then((res) => res.text());

  await send({ 'x-claude-code-request-class': 'main' });
  await send({
    'x-claude-code-request-class': 'subagent',
    'x-claude-code-agent-id': 'agent-7',
    'x-claude-code-agent-type': 'Explore',
    'x-claude-code-context-compacted': 'auto',
  });

  assert.deepEqual(
    seen.map((h) => h.sessionId),
    ['sess-1', 'sess-1.agent-7'],
  );
  assert.deepEqual(seen[1], {
    sessionId: 'sess-1.agent-7',
    requestClass: 'subagent',
    agentType: 'Explore',
    contextCompacted: 'auto',
  });
  assert.equal(seen[0].agentType, null);
});
