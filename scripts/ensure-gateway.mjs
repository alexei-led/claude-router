#!/usr/bin/env node
// Hook entry (SessionStart, UserPromptSubmit): make sure a gateway of this plugin version or newer answers on the port.
// Starts one on a free port and replaces an older one; leaves a newer one alone, so a session that still runs an older
// plugin never downgrades it. Detached, so the gateway outlives the session. After a crash, the next prompt restarts it.
// `--quiet` prints nothing: UserPromptSubmit output goes into the model's context.
import { spawn } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cliArg, isRouterGateway, loadRuntime } from '../lib/runtime.mjs';
import { isOlderVersion, ROUTER_VERSION, STATUS_PATH } from '../lib/status.mjs';
import { rotate } from '../lib/store.mjs';

const WAIT_STEP_MS = 100;
const WAIT_STEPS = 20;
const STATUS_TIMEOUT_MS = 500;

const env = process.env;
const quiet = process.argv.includes('--quiet');

function say(message) {
  if (!quiet) process.stdout.write(`router: ${message}\n`);
}

let config;
let dataDir;
let configPath;
let configWarning;
try {
  ({
    config,
    dataDir,
    configPath,
    warning: configWarning,
  } = loadRuntime(env, {
    configPath: cliArg(process.argv, '--config'),
  }));
} catch (error) {
  say(`invalid configuration (${error.message}); the next prompt tries again`);
  process.exit(0);
}
if (configWarning) say(configWarning);
const port = config.gateway.port;

function probe() {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

// Waits until the port answers (`true`) or is free (`false`).
async function waitFor(answering) {
  for (let i = 0; i < WAIT_STEPS; i += 1) {
    if ((await probe()) === answering) return true;
    await new Promise((resolve) => setTimeout(resolve, WAIT_STEP_MS));
  }
  return false;
}

async function runningGateway() {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${STATUS_PATH}`, {
      signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
    });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

// SIGTERM: the old gateway releases the port at once and finishes its open streams. Gateways from 0.4.0 on report
// their pid; older ones cannot be retired from here.
async function retire(running) {
  const from = running.version ?? 'before 0.3.0';
  if (!running.pid) {
    say(
      `gateway ${from} runs on port ${port}. Stop it once with \`pkill -f scripts/gateway.mjs\`; the next prompt starts ${ROUTER_VERSION}.`,
    );
    return false;
  }
  if (!isRouterGateway(running.pid)) {
    say(`port ${port} answers as gateway ${from}, but pid ${running.pid} is not a router gateway: left alone`);
    return false;
  }
  try {
    process.kill(running.pid, 'SIGTERM');
  } catch (error) {
    say(`cannot stop gateway ${from} (pid ${running.pid}): ${error.message}`);
    return false;
  }
  if (await waitFor(false)) return true;
  say(`gateway ${from} (pid ${running.pid}) did not release port ${port}`);
  return false;
}

async function start() {
  mkdirSync(dataDir, { recursive: true });
  const logPath = join(dataDir, 'gateway.log');
  try {
    rotate(logPath);
  } catch {
    // Rotation is housekeeping; a gateway that starts matters more.
  }
  const log = openSync(logPath, 'a');
  // Claude Code exports the plugin option as CLAUDE_PLUGIN_OPTION_<KEY>; the gateway reads one name only.
  const childEnv = {
    ...env,
    TYPESAFE_API_KEY: env.TYPESAFE_API_KEY || env.CLAUDE_PLUGIN_OPTION_TYPESAFE_API_KEY || '',
  };
  const child = spawn(
    process.execPath,
    [join(dirname(fileURLToPath(import.meta.url)), 'gateway.mjs'), '--config', configPath],
    {
      detached: true,
      stdio: ['ignore', log, log],
      env: childEnv,
    },
  );
  child.unref();
  // Wait for the listener so the session's first request finds it.
  return { pid: child.pid, up: await waitFor(true) };
}

if (!(env.ANTHROPIC_BASE_URL ?? '').includes(`127.0.0.1:${port}`))
  say('Claude Code does not use the gateway yet. Run /router:setup, then restart Claude Code.');

const running = await runningGateway();
if (running && !isOlderVersion(running.version, ROUTER_VERSION)) process.exit(0);
if (running && !(await retire(running))) process.exit(0);
if (!running && (await probe())) {
  say(`port ${port} answers, but not as the router gateway`);
  process.exit(0);
}
const { pid, up } = await start();
const verb = running ? `replaced ${running.version ?? 'an older gateway'} on` : 'started on';
say(`gateway ${ROUTER_VERSION} ${up ? verb : 'not answering yet on'} 127.0.0.1:${port} (pid ${pid})`);
process.exit(0);
