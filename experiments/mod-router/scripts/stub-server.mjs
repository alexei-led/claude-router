import { createServer } from 'node:http';

let serial = 0;
let open = 0;
let pending = 0;
const attempts = new Map();
const answer = JSON.stringify({
  answers: {
    route: { type: 'choice', choice: 'medium', confidence: 0.95, probabilities: { medium: 0.95, high: 0.05 } },
    continuation: { type: 'noul', noul: 0 },
  },
});
const ids = new WeakMap();
const report = (value) => process.stdout.write(`${JSON.stringify({ at: Date.now(), ...value })}\n`);
const server = createServer((req, res) => {
  pending += 1;
  report({
    event: 'request',
    socket: ids.get(req.socket),
    path: req.url,
    bearerPresent: Boolean(req.headers.authorization),
    pending,
  });
  let finished = false;
  const complete = () => {
    if (finished) return;
    finished = true;
    pending -= 1;
    report({ event: 'request-end', socket: ids.get(req.socket), pending, responded: res.writableFinished });
  };
  res.once('finish', complete);
  res.once('close', complete);
  req.resume();
  if (req.url === '/hang') return;
  const attempt = (attempts.get(req.url) ?? 0) + 1;
  attempts.set(req.url, attempt);
  if ((['/retry', '/retry-after'].includes(req.url) && attempt === 1) || req.url === '/retry-later') {
    res.writeHead(
      503,
      req.url === '/retry-after' ? { 'retry-after': '0.1' } : req.url === '/retry-later' ? { 'retry-after': '5' } : {},
    );
    res.end('{}');
    return;
  }
  if (req.url === '/slow') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write(answer.slice(0, 1));
    setTimeout(() => res.end(answer.slice(1)), 5000).unref();
    return;
  }
  const finish = () => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(req.url === '/malformed' ? '{}' : answer);
  };
  if (req.url === '/delay') setTimeout(finish, 5000).unref();
  else finish();
});
server.on('connection', (socket) => {
  const id = ++serial;
  ids.set(socket, id);
  open += 1;
  report({ event: 'connect', socket: id, open });
  socket.on('close', () => {
    open -= 1;
    report({ event: 'close', socket: id, open });
  });
});
server.listen(0, '127.0.0.1', () => report({ event: 'listening', port: server.address().port }));
process.on('SIGTERM', () => {
  server.closeAllConnections();
  server.close();
});
