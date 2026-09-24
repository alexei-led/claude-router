#!/usr/bin/env node
// /router:status: routes, key state and the last routed turn of a session, as markdown.
// Usage: status.mjs [session id] [--config <path>]. It reads the configuration and starts nothing, so it is also
// the way to see why a router.json does not load.
import { cliArg, loadRuntime } from '../lib/runtime.mjs';
import { fetchStatus, statusReport } from '../lib/status.mjs';

const argv = process.argv.slice(2);
const configPath = cliArg(argv, '--config');
const session = argv.find((arg, i) => !arg.startsWith('--') && argv[i - 1] !== '--config');

let config;
try {
  ({ config } = loadRuntime(process.env, { configPath }));
} catch (error) {
  // Exit 0: /router:status injects this output into a skill, and Claude Code drops a skill whose command fails.
  process.stdout.write(`router: invalid configuration: ${error.message}\n`);
  process.exit(0);
}
process.stdout.write(`${statusReport(await fetchStatus(config.gateway.port, session))}\n`);
