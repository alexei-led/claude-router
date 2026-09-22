#!/usr/bin/env node
// Daemon entry: local gateway on 127.0.0.1:<gateway.port>. Started by the SessionStart hook or by hand.
import { createGateway } from '../lib/gateway.mjs';
import { Router } from '../lib/router.mjs';
import { loadRuntime } from '../lib/runtime.mjs';

const { config, dataDir } = loadRuntime(process.env);
const router = new Router({ config, fetchFn: globalThis.fetch, dataDir });
const server = createGateway({ router, onError: (error) => process.stderr.write(`router: ${error.message}\n`) });
server.listen(config.gateway.port, '127.0.0.1', () =>
  process.stdout.write(`router: listening on http://127.0.0.1:${config.gateway.port} as ${config.gateway.alias}\n`),
);
