#!/usr/bin/env node
// /router:status: routes, key state and the last routed turn of a session, as markdown.
import { loadRuntime } from '../lib/runtime.mjs';
import { fetchStatus, statusReport } from '../lib/status.mjs';

const { config } = loadRuntime(process.env);
process.stdout.write(`${statusReport(await fetchStatus(config.gateway.port, process.argv[2]))}\n`);
