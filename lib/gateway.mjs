// Local Anthropic Messages gateway: byte-for-byte passthrough, except a routed request gets its
// model, effort and thinking rewritten. Never re-serializes responses; reads usage on a tee.
// Upstream errors (429, 529, 5xx) pass through unchanged: Claude Code owns retries and backoff.
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { pipeline } from 'node:stream';
import { IdleTracker } from './idle.mjs';
import { UsageReader } from './sse.mjs';
import { ROUTER_DISPLAY_NAME, STATUS_PATH, statusSnapshot } from './status.mjs';

const HOP_BY_HOP = new Set(['host', 'connection', 'content-length', 'accept-encoding', 'transfer-encoding']);
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const MESSAGES_PATH = '/v1/messages';
const LONG_CONTEXT_BETA = /^context-1m-/;
const LONG_CONTEXT_WINDOW = 1_000_000;

// `jev-router[1m]` makes Claude Code send the 1M context beta on every request; a model with a smaller
// window answers it with 400 ("The long context beta is not yet available"), so drop it for those.
function withoutLongContextBeta(headers, modelId, config) {
  const model = Object.values(config.models).find((m) => m.id === modelId);
  const beta = headers['anthropic-beta'];
  if (!model || model.contextWindow >= LONG_CONTEXT_WINDOW || typeof beta !== 'string') return;
  const kept = beta.split(',').filter((flag) => !LONG_CONTEXT_BETA.test(flag.trim()));
  if (kept.length) headers['anthropic-beta'] = kept.join(',');
  else delete headers['anthropic-beta'];
}

export function createGateway({
  router,
  upstream = 'https://api.anthropic.com',
  onError = () => {},
  activity = new IdleTracker(),
}) {
  const target = new URL(upstream);
  const send = target.protocol === 'https:' ? httpsRequest : httpRequest;

  return createServer((req, res) => {
    activity.requestStarted();
    res.once('close', () => activity.requestEnded());
    if (!isLocalClient(req))
      return reply(res, 403, errorBody('permission_error', 'router: the gateway serves local clients only'));
    if (req.method === 'GET' && req.url.startsWith('/v1/models')) return discovery(router, res);
    if (req.method === 'GET' && req.url.startsWith(STATUS_PATH)) return status(router, req, res);
    let up = null;
    let closedEarly = false;
    // The client left before its response was complete (Esc in Claude Code, a client timeout). Before the upstream
    // answers, abort the upstream request here; after, pipeline() below does it. Either way the model stops generating.
    res.on('close', () => {
      if (res.writableFinished) return;
      closedEarly = true;
      if (!res.headersSent) up?.destroy();
    });
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      try {
        let body = Buffer.concat(chunks);
        const parsed = parseJson(body);
        const session = sessionKey(req, parsed);
        const turn = isMessagesCall(req);
        if (turn) activity.turnResumed(session);
        let routed = null;
        if (parsed && router.isRouted(parsed)) {
          if (turn) {
            try {
              routed = await router.route(parsed, { sessionId: session, ...routingHints(req) });
            } catch (error) {
              onError(error);
              routed = router.fallback(parsed); // never forward the alias upstream
            }
          } else routed = router.resolveModel(parsed, session);
          body = Buffer.from(JSON.stringify(routed.body));
        }
        if (closedEarly) return; // the client left while the route was decided
        const headers = {};
        for (const [name, value] of Object.entries(req.headers)) if (!HOP_BY_HOP.has(name)) headers[name] = value;
        headers.host = target.host;
        headers['content-length'] = String(body.length);
        if (routed) withoutLongContextBeta(headers, routed.body.model, router.config);
        up = send(
          { host: target.hostname, port: target.port || undefined, path: req.url, method: req.method, headers },
          (upRes) => relay(upRes, res, { routed, session, turn, clientLeft: () => closedEarly }),
        );
        up.on('error', (error) => {
          if (closedEarly) return; // aborted above because the client left
          fail(res, new Error(`upstream: ${error.message}`));
        });
        up.end(body);
      } catch (error) {
        fail(res, error);
      }
    });
  });

  function relay(upRes, res, { routed, session, turn, clientLeft }) {
    const reader = turn ? new UsageReader() : null;
    // pipeline() reports ECONNRESET for both kinds of failure; only the side that closed first says whose it was.
    let upstreamBroke = false;
    upRes.once('close', () => {
      upstreamBroke = !upRes.complete && !clientLeft();
    });
    res.writeHead(upRes.statusCode, upRes.headers);
    if (reader) upRes.on('data', (c) => reader.feed(c.toString('utf8')));
    // pipeline() tears down both sides on failure. An upstream reset reaches the client as a reset it retries at once,
    // where pipe() left it waiting for bytes that never came; a client that leaves stops the upstream response.
    pipeline(upRes, res, (error) => {
      if (error) {
        if (upstreamBroke) onError(new Error(`upstream stream: ${error.message}`));
        return;
      }
      if (!reader || upRes.statusCode >= 300) return;
      const usage = reader.end();
      if (reader.stopReason === 'tool_use') activity.turnPaused(session);
      if (!routed || routed.auxiliary) return;
      try {
        router.recordResponse(session, routed.tier, usage, routed.effort);
      } catch (recordError) {
        onError(recordError);
      }
    });
  }

  function fail(res, error) {
    onError(error);
    if (!res.headersSent) res.writeHead(502);
    res.end();
  }
}

// Claude Code sends its session id as a header; the metadata field is the fallback. A subagent's requests carry
// its agent id too: it gets its own routing memory, so its turns do not mix with the main conversation's.
export function sessionKey(req, body) {
  const agent = req.headers['x-claude-code-agent-id'];
  const session = sessionOf(req, body);
  return agent ? `${session}.${agent}` : session;
}

function sessionOf(req, body) {
  const header = req.headers['x-claude-code-session-id'];
  if (header) return String(header);
  try {
    return JSON.parse(body?.metadata?.user_id ?? '{}').session_id ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

// Gateway hint headers, sent when CLAUDE_CODE_GATEWAY_HINT_HEADERS=1. Without them the router falls back to the body.
function routingHints(req) {
  return {
    requestClass: req.headers['x-claude-code-request-class'] ?? null,
    agentType: req.headers['x-claude-code-agent-type'] ?? null,
    contextCompacted: req.headers['x-claude-code-context-compacted'] ?? null,
  };
}

// A web page can reach a loopback port too: by DNS rebinding (a foreign Host) or by a request from a page, which
// always carries an Origin, even one served from another loopback port. Claude Code sends a loopback Host and no Origin.
function isLocalClient(req) {
  return LOOPBACK.has(hostOf(req.headers.host)) && req.headers.origin === undefined;
}

function hostOf(host = '') {
  return host.replace(/:\d+$/, '').toLowerCase();
}

// Only a Messages call is a turn. Side endpoints such as count_tokens carry the alias too, but no decision.
function isMessagesCall(req) {
  return req.method === 'POST' && req.url.split('?')[0] === MESSAGES_PATH;
}

function parseJson(buffer) {
  if (!buffer.length) return null;
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    return null;
  }
}

function discovery(router, res) {
  const { alias } = router.config.gateway;
  reply(res, 200, {
    data: [{ id: alias, display_name: ROUTER_DISPLAY_NAME, description: routesDescription(router.config) }],
  });
}

function status(router, req, res) {
  const session = new URL(req.url, 'http://localhost').searchParams.get('session');
  const pausedUntil = router.jevPausedUntil > router.now() ? new Date(router.jevPausedUntil).toISOString() : null;
  reply(res, 200, {
    ...statusSnapshot(router.config, session ? router.memory(session) : null),
    pid: process.pid,
    jevPausedUntil: pausedUntil,
  });
}

function reply(res, statusCode, payload) {
  res.writeHead(statusCode, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function errorBody(type, message) {
  return { type: 'error', error: { type, message } };
}

// "Picks claude-opus-5-5 / claude-sonnet-5 / claude-haiku-4-5 and the effort for each turn"
export function routesDescription(config) {
  const ids = [...new Set(Object.values(config.routes).map((r) => config.models[r.model].id))];
  return `Picks ${ids.join(' / ')} and the effort for each turn`;
}
