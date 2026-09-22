// Local Anthropic Messages gateway: byte-for-byte passthrough, except a routed request gets its
// model, effort and thinking rewritten. Never re-serializes responses; reads usage on a tee.
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { UsageReader } from './sse.mjs';

const HOP_BY_HOP = new Set(['host', 'connection', 'content-length', 'accept-encoding', 'transfer-encoding']);

export function createGateway({ router, upstream = 'https://api.anthropic.com', onError = () => {} }) {
  const target = new URL(upstream);
  const send = target.protocol === 'https:' ? httpsRequest : httpRequest;

  return createServer((req, res) => {
    if (req.method === 'GET' && req.url.startsWith('/v1/models')) return discovery(router, res);
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      let body = Buffer.concat(chunks);
      let parsed = null;
      try {
        parsed = body.length ? JSON.parse(body.toString('utf8')) : null;
      } catch {
        parsed = null;
      }
      const session = sessionKey(req, parsed);
      let routed = null;
      if (parsed && router.isRouted(parsed)) {
        try {
          routed = await router.route(parsed, {
            sessionId: session,
            requestClass: req.headers['x-claude-code-request-class'] ?? null,
          });
        } catch (error) {
          onError(error);
          routed = router.fallback(parsed); // never forward the alias upstream
        }
        body = Buffer.from(JSON.stringify(routed.body));
      }
      const headers = {};
      for (const [name, value] of Object.entries(req.headers)) if (!HOP_BY_HOP.has(name)) headers[name] = value;
      headers.host = target.host;
      headers['content-length'] = String(body.length);
      const up = send(
        { host: target.hostname, port: target.port || undefined, path: req.url, method: req.method, headers },
        (upRes) => {
          const reader = routed && !routed.auxiliary ? new UsageReader() : null;
          res.writeHead(upRes.statusCode, upRes.headers);
          upRes.on('data', (c) => {
            if (reader) reader.feed(c.toString('utf8'));
          });
          upRes.on('end', () => {
            if (reader && upRes.statusCode < 300) router.recordResponse(session, routed.tier, reader.end());
          });
          upRes.pipe(res);
        },
      );
      up.on('error', (error) => {
        onError(error);
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      up.end(body);
    });
  });
}

// Claude Code sends its session id as a header; the metadata field is the fallback.
export function sessionKey(req, body) {
  const header = req.headers['x-claude-code-session-id'];
  if (header) return String(header);
  try {
    return JSON.parse(body?.metadata?.user_id ?? '{}').session_id ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function discovery(router, res) {
  const { alias } = router.config.gateway;
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({
      data: [
        {
          id: alias,
          display_name: 'Model Router',
          description: 'A tier for each turn, selected with TypeSafe Jev',
        },
      ],
    }),
  );
}
