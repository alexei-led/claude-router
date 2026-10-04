import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { nativeLaunchSettings, prepareNativeCandidate } from './native-candidate.mjs';

function messages(child) {
  const queue = [];
  let waiting = null;
  const stream = createInterface({ input: child.stdout });
  stream.on('line', (line) => {
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      return;
    }
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve(value);
    } else queue.push(value);
  });
  return async () =>
    queue.shift() ??
    (await new Promise((resolve) => {
      waiting = resolve;
    }));
}

const scenario = process.argv[2] ?? 'clear';
assert.ok(['clear', 'circuit'].includes(scenario), 'Use clear or circuit');
const directory = await prepareNativeCandidate({ acceptance: true });
const server = spawn(process.execPath, [fileURLToPath(new URL('./stub-server.mjs', import.meta.url))], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
const wire = [];
let listen;
const listening = new Promise((resolve) => {
  listen = resolve;
});
createInterface({ input: server.stdout }).on('line', (line) => {
  const value = JSON.parse(line);
  wire.push(value);
  if (value.event === 'listening') listen(value.port);
});
server.stderr.resume();
const port = await listening;
const settings = nativeLaunchSettings();
settings.env.ROUTER_PROBE_URL = `http://127.0.0.1:${port}`;
const child = spawn(
  join(homedir(), '.claude/scripts/ce'),
  [
    'peer-team',
    '--plugin-dir',
    directory,
    '--model',
    'claude-sonnet-5-5',
    '--settings',
    JSON.stringify(settings),
    '--tools',
    '',
    '--strict-mcp-config',
    '--mcp-config',
    '{"mcpServers":{}}',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '-p',
  ],
  { stdio: ['pipe', 'pipe', 'pipe'] },
);
const nextMessage = messages(child);
const errors = [];
createInterface({ input: child.stderr }).on('line', (line) => {
  if (/error|failed|unknown command/i.test(line)) errors.push(line.slice(0, 300));
});
const closed = once(child, 'close');
const deadline = setTimeout(() => child.kill('SIGTERM'), 120_000);
const observations = [];

async function command(text) {
  child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`);
  while (true) {
    const event = await Promise.race([
      nextMessage(),
      closed.then(() => {
        throw new Error(`CLI closed before ${text}; ${errors.join('; ')}`);
      }),
    ]);
    if (event.type !== 'result') continue;
    assert.equal(event.is_error, false, `${text}: ${event.subtype}`);
    let result = event.result;
    try {
      result = JSON.parse(result.startsWith('router: ') ? result.slice(8) : result);
    } catch {
      /* Native command output may be plain text. */
    }
    observations.push({ command: text, result });
    return result;
  }
}

async function inspect() {
  const status = await command('/router status');
  const mode = /Jev Router — (Auto|Manual)\b/.exec(status)?.[1];
  assert.ok(mode, 'Native router status unavailable');
  return { ...(await command('/router-accept inspect')), mode: mode.toLowerCase() };
}

try {
  const initial = await inspect();
  assert.equal(typeof initial.session, 'string');
  await command('/router off');
  const manual = await inspect();
  assert.equal(manual.mode, 'manual');
  if (scenario === 'clear') {
    const timeout = await command('/router-accept ask hang');
    assert.equal(timeout.error, 'timeout');
    assert.ok(timeout.elapsedMs <= 1650, `Advice deadline was ${timeout.elapsedMs}ms`);
    const busy = await command('/router-accept ask hang');
    assert.equal(busy.error, 'busy');
    await command('/clear');
    const cleared = await inspect();
    assert.notEqual(cleared.session, initial.session);
    assert.equal(cleared.mode, 'auto');
    assert.ok(cleared.lifecycle.some((event) => event.event === 'end' && event.reason === 'clear'));
    const afterClear = await command('/router-accept ask hang');
    assert.ok(['timeout', 'busy'].includes(afterClear.error));
    assert.equal(wire.filter((event) => event.event === 'request').length, cleared.pending ? 1 : 2);
  } else {
    let failure;
    for (let count = 1; count <= 3; count += 1) {
      failure = await command('/router-accept ask malformed');
      assert.equal(failure.error, 'malformed');
      assert.equal(failure.health.failures, count);
    }
    const requestCount = wire.filter((event) => event.event === 'request').length;
    const paused = await command('/router-accept ask retry');
    assert.equal(paused.error, 'paused');
    assert.equal(wire.filter((event) => event.event === 'request').length, requestCount);
    await wait(Math.max(0, failure.health.pausedUntil - Date.now() + 50));
    const recovered = await command('/router-accept ask retry');
    assert.equal(recovered.error, null);
    assert.equal(recovered.choice, 'medium');
    assert.equal(recovered.health.failures, 0);
    assert.equal(recovered.health.pausedUntil, 0);
  }
  assert.ok(Math.max(...wire.filter((event) => event.event === 'request').map((event) => event.pending)) <= 1);
  child.stdin.end();
  const [code] = await closed;
  assert.equal(code, 0);
  const closeDeadline = Date.now() + 2000;
  while (
    wire.filter((event) => event.event === 'close').length < wire.filter((event) => event.event === 'connect').length
  ) {
    assert.ok(Date.now() < closeDeadline, 'HTTP connection survived CLI exit');
    await wait(25);
  }
  console.log(JSON.stringify({ scenario: `persistent-${scenario}`, passed: true, observations, wire }));
} catch (error) {
  console.error(
    JSON.stringify({ scenario: `persistent-${scenario}`, passed: false, error: error.message, observations, wire }),
  );
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  if (child.exitCode === null) {
    child.kill('SIGTERM');
    await closed;
  }
  server.kill('SIGTERM');
  await once(server, 'close');
  await rm(directory, { recursive: true, force: true });
}
