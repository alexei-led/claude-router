#!/usr/bin/env node
// Status line: prints the model and effort that served the last routed turn.
// Usage in settings.json: "statusLine": { "command": "node <plugin>/scripts/statusline.mjs [wrapped command ...]" }.
// A wrapped command (for example claude-powerline) gets the same stdin; its output comes first.
import { spawn } from 'node:child_process';
import { text } from 'node:stream/consumers';
import { LEGACY_ALIAS } from '../lib/config.mjs';
import { loadRuntime } from '../lib/runtime.mjs';
import { fetchStatus, ROUTER_DISPLAY_NAME, statusSegment } from '../lib/status.mjs';

const input = await text(process.stdin);
const [command, ...args] = process.argv.slice(2);
const { config } = loadRuntime(process.env);
let payload = {};
try {
  payload = JSON.parse(input);
} catch {}

const names = [config.gateway.alias, LEGACY_ALIAS, ROUTER_DISPLAY_NAME];
// `jev-router[1m]`: the suffix only tells Claude Code the window size.
const routed = [payload.model?.id, payload.model?.display_name].some((name) =>
  names.includes(name?.replace(/\[1m\]$/, '')),
);
const [status] = await Promise.all([
  routed ? fetchStatus(config.gateway.port, payload.session_id) : null,
  command ? runWrapped(command, args, input) : null,
]);
if (routed) process.stdout.write(`${statusSegment(status)}\n`);

function runWrapped(cmd, argv, stdin) {
  return new Promise((resolve) => {
    const child = spawn(cmd, argv, { stdio: ['pipe', 'inherit', 'inherit'] });
    child.on('error', (error) => {
      process.stdout.write(`statusline: ${cmd}: ${error.message}\n`);
      resolve();
    });
    child.on('close', resolve);
    child.stdin.on('error', () => {}); // the wrapped command may exit without reading stdin
    child.stdin.end(stdin);
  });
}
