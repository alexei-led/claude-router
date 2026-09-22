#!/usr/bin/env node
// SessionStart hook: start the gateway daemon when nothing answers on its port. Detached, so it outlives the session.
import { spawn } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRuntime } from '../lib/runtime.mjs';

const env = process.env;
const { config, dataDir } = loadRuntime(env);
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

const configured = (env.ANTHROPIC_BASE_URL ?? '').includes(`127.0.0.1:${port}`);
if (!configured)
  process.stdout.write(
    'router: Claude Code does not use the gateway yet. Run /router:setup, then restart Claude Code.\n',
  );

if (!(await probe())) {
  mkdirSync(dataDir, { recursive: true });
  const log = openSync(join(dataDir, 'gateway.log'), 'a');
  // Claude Code exports the plugin option as CLAUDE_PLUGIN_OPTION_<KEY>; the gateway reads one name only.
  const childEnv = {
    ...env,
    TYPESAFE_API_KEY: env.TYPESAFE_API_KEY || env.CLAUDE_PLUGIN_OPTION_TYPESAFE_API_KEY || '',
  };
  const child = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'gateway.mjs')], {
    detached: true,
    stdio: ['ignore', log, log],
    env: childEnv,
  });
  child.unref();
  // Wait for the listener so the session's first request finds it.
  let up = false;
  for (let i = 0; i < 20 && !up; i += 1) {
    await new Promise((r) => setTimeout(r, 100));
    up = await probe();
  }
  process.stdout.write(
    `router: gateway on 127.0.0.1:${port} ${up ? 'started' : 'not answering yet'} (pid ${child.pid})\n`,
  );
}
process.exit(0);
