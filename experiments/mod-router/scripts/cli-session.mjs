import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { nativeLaunchPlan } from './native-candidate.mjs';

export async function until(label, check, ms = 5000) {
  const limit = Date.now() + ms;
  while (!check()) {
    assert.ok(Date.now() < limit, `Timed out: ${label}`);
    await wait(25);
  }
}

// Starts a loopback stub that reports JSON lines; resolves once it announces its port.
export async function startStub(script, env = {}) {
  const server = spawn(process.execPath, [fileURLToPath(new URL(script, import.meta.url))], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });
  const wire = [];
  const listening = new Promise((resolve) => {
    createInterface({ input: server.stdout }).on('line', (line) => {
      const value = JSON.parse(line);
      wire.push(value);
      if (value.event === 'listening') resolve(value.port);
    });
  });
  server.stderr.resume();
  const port = await listening;
  const stop = async () => {
    server.kill('SIGTERM');
    await once(server, 'close');
  };
  return { port, wire, stop };
}

export function launchSession(directory, argv = [], env = {}, { tools = '' } = {}) {
  const plan = nativeLaunchPlan(argv);
  Object.assign(plan.settings.env, env);
  const child = spawn(
    join(homedir(), '.claude/scripts/ce'),
    [
      'peer-team',
      '--plugin-dir',
      directory,
      ...plan.args,
      '--settings',
      JSON.stringify(plan.settings),
      '--tools',
      tools,
      '--strict-mcp-config',
      '--mcp-config',
      '{"mcpServers":{}}',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '-p',
      ...argv,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const queue = [];
  let waiting = null;
  const events = [];
  createInterface({ input: child.stdout }).on('line', (line) => {
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      return;
    }
    events.push(value);
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve(value);
    } else queue.push(value);
  });
  const errors = [];
  createInterface({ input: child.stderr }).on('line', (line) => {
    if (/error|failed|unknown command|invalid|auth/i.test(line)) errors.push(line.slice(0, 300));
  });
  const closed = once(child, 'close');
  const guard = setTimeout(() => child.kill('SIGTERM'), 180_000);
  closed.then(() => clearTimeout(guard));
  const next = async () =>
    queue.shift() ??
    (await new Promise((resolve) => {
      waiting = resolve;
    }));
  async function raw(text) {
    child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`);
    while (true) {
      const event = await Promise.race([
        next(),
        closed.then(() => {
          throw new Error(`CLI closed before ${text.slice(0, 40)}; ${errors.join('; ')}`);
        }),
      ]);
      if (event.type === 'result') return event;
    }
  }
  async function command(text) {
    const event = await raw(text);
    assert.equal(event.is_error, false, `${text}: ${event.subtype}`);
    let result = event.result;
    try {
      result = JSON.parse(result.startsWith('router: ') ? result.slice(8) : result);
    } catch {
      /* Native command output may be plain text. */
    }
    return result;
  }
  async function inspect() {
    const status = await command('/router status');
    const mode = /Jev Router — (Auto|Manual)\b/.exec(status)?.[1];
    assert.ok(mode, 'Native router status unavailable');
    return { ...(await command('/router-accept inspect')), mode: mode.toLowerCase() };
  }
  async function finish() {
    child.stdin.end();
    const [code] = await closed;
    return code;
  }
  const initModel = async () => {
    await until('init event', () => events.some((event) => event.type === 'system' && event.subtype === 'init'));
    return events.find((event) => event.type === 'system' && event.subtype === 'init').model;
  };
  return { child, raw, command, inspect, finish, closed, events, initModel };
}
