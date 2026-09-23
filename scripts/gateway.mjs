#!/usr/bin/env node
// Daemon entry: local gateway on 127.0.0.1:<gateway.port>. Started by the plugin hooks or by hand.
import { createGateway } from '../lib/gateway.mjs';
import { IdleTracker } from '../lib/idle.mjs';
import { Router } from '../lib/router.mjs';
import { loadRuntime } from '../lib/runtime.mjs';
import { ROUTER_VERSION } from '../lib/status.mjs';
import { housekeeping } from '../lib/store.mjs';

// On stop the port is released at once; open streams get this long to finish (Claude Code's request timeout).
const DRAIN_MS = 600_000;
const HOUSEKEEPING_MS = 3_600_000;
const IDLE_CHECK_MS = 60_000;

process.stderr.on('error', () => {}); // a full disk must not turn a log line into a crash
const log = (message) => process.stderr.write(`${new Date().toISOString()} router: ${message}\n`);
const onError = (error) => log(error.message);

// Every Claude Code session on the machine goes through this process, so a stray exception is logged, not fatal.
// Request state is per request and per session; the worst case after such an error is one misrouted turn.
process.on('uncaughtException', (error) => log(`uncaught exception: ${error.stack ?? error.message}`));
process.on('unhandledRejection', (reason) => log(`unhandled rejection: ${reason?.stack ?? reason}`));

const { config, dataDir } = loadRuntime(process.env);
const { port, alias, idleShutdownMs } = config.gateway;
const router = new Router({ config, fetchFn: globalThis.fetch, dataDir, onError });
const activity = new IdleTracker();
const server = createGateway({ router, onError, activity });

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    log(`port ${port} is in use, another gateway serves it: exiting`);
    process.exit(0);
  }
  log(`server error: ${error.message}`);
  process.exit(1);
});

let stopping = false;
function stop(reason) {
  if (stopping) return;
  stopping = true;
  log(`${reason}: no new connections, finishing open streams`);
  server.close(() => process.exit(0));
  server.closeIdleConnections();
  setTimeout(() => process.exit(0), DRAIN_MS).unref();
}
process.once('SIGTERM', () => stop('SIGTERM'));
process.once('SIGINT', () => stop('SIGINT'));

if (idleShutdownMs > 0) {
  const minutes = Math.round(idleShutdownMs / 60_000);
  const check = () => {
    if (activity.idle(idleShutdownMs)) stop(`idle for ${minutes} min, no turn waits for a tool`);
  };
  setInterval(check, Math.min(idleShutdownMs, IDLE_CHECK_MS)).unref();
}

function tidy() {
  try {
    housekeeping(dataDir);
  } catch (error) {
    onError(error);
  }
}
tidy();
setInterval(tidy, HOUSEKEEPING_MS).unref();

server.listen(port, '127.0.0.1', () =>
  log(`${ROUTER_VERSION} listening on http://127.0.0.1:${port} as ${alias} (pid ${process.pid})`),
);
