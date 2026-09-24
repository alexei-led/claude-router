// The daemon and the hook as processes, each on a free port of its own: never the live gateway's port.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ROUTER_VERSION } from '../lib/status.mjs';

const SCRIPTS = fileURLToPath(new URL('../scripts/', import.meta.url));

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

// Every spawn passes `--config`: the scripts resolve their default config from the OS user's home, so without the
// flag a test would read the real ~/.claude/router.json and touch the live gateway's port.
function environment(port, gateway = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'router-daemon-'));
  const configPath = join(dir, 'router.json');
  writeFileSync(configPath, JSON.stringify({ gateway: { port, ...gateway } }));
  const env = {
    ...process.env,
    CLAUDE_PLUGIN_DATA: dir,
    TYPESAFE_API_KEY: '',
    CLAUDE_PLUGIN_OPTION_TYPESAFE_API_KEY: '',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
  };
  delete env.ROUTER_CONFIG;
  return { dir, env, config: ['--config', configPath] };
}

function run(script, args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(SCRIPTS, script), ...args], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => {
      stdout += c;
    });
    child.stderr.on('data', (c) => {
      stderr += c;
    });
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

async function statusOf(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/router/status`, { signal: AbortSignal.timeout(500) });
    return await res.json();
  } catch {
    return null;
  }
}

async function until(check, ms = 4_000) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) {
    const value = await check();
    if (value) return value;
  }
  return null;
}

function stop(pid) {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // already gone
  }
}

test('the daemon answers, a second one on the same port exits quietly, SIGTERM stops it cleanly', async () => {
  const port = await freePort();
  const { env, config } = environment(port);
  const daemon = spawn(process.execPath, [join(SCRIPTS, 'gateway.mjs'), ...config], { env });
  let log = '';
  daemon.stderr.on('data', (c) => {
    log += c;
  });
  const exited = new Promise((resolve) => daemon.on('exit', resolve));
  try {
    const status = await until(() => statusOf(port));
    assert.equal(status.version, ROUTER_VERSION);
    assert.equal(status.pid, daemon.pid);
    const second = await run('gateway.mjs', config, env);
    assert.equal(second.code, 0);
    assert.match(second.stderr, /port \d+ is in use, another gateway serves it/);
    daemon.kill('SIGTERM');
    assert.equal(await exited, 0);
    assert.match(log, /^\d{4}-\d\d-\d\dT\S+ router: \S+ listening on/m);
    assert.match(log, /SIGTERM: no new connections, finishing open streams/);
  } finally {
    daemon.kill('SIGKILL');
  }
});

test('ensure-gateway replaces an older gateway and leaves a current one alone', async () => {
  const port = await freePort();
  const { dir, env, config } = environment(port);
  // An older gateway: reports an old version and its pid, and releases the port on SIGTERM.
  const old = spawn(process.execPath, [
    '-e',
    `const server = require('node:http').createServer((req, res) =>
       res.end(JSON.stringify({ version: '0.0.1', pid: process.pid })));
     server.listen(${port}, '127.0.0.1');
     process.on('SIGTERM', () => { server.close(); server.closeAllConnections(); process.exit(0); });`,
  ]);
  const oldExited = new Promise((resolve) => old.on('exit', resolve));
  let current = null;
  try {
    assert.ok(await until(async () => (await statusOf(port))?.version === '0.0.1'));
    const replaced = await run('ensure-gateway.mjs', config, env);
    assert.equal(replaced.code, 0);
    assert.match(
      replaced.stdout,
      new RegExp(`gateway ${ROUTER_VERSION} replaced 0\\.0\\.1 on 127\\.0\\.0\\.1:${port}`),
    );
    assert.equal(await oldExited, 0);
    current = await until(() => statusOf(port));
    assert.equal(current.version, ROUTER_VERSION);

    const again = await run('ensure-gateway.mjs', ['--quiet', ...config], env);
    assert.deepEqual([again.code, again.stdout], [0, '']);
    assert.equal((await statusOf(port)).pid, current.pid);
    assert.match(readFileSync(join(dir, 'gateway.log'), 'utf8'), /listening on/);
  } finally {
    old.kill('SIGKILL');
    if (current) stop(current.pid);
  }
});

test('ensure-gateway starts a gateway on a free port and restarts it after it dies', async () => {
  const port = await freePort();
  const { env, config } = environment(port);
  let pid = null;
  try {
    const started = await run('ensure-gateway.mjs', config, env);
    assert.match(started.stdout, new RegExp(`gateway ${ROUTER_VERSION} started on 127\\.0\\.0\\.1:${port}`));
    ({ pid } = await until(() => statusOf(port)));
    process.kill(pid, 'SIGKILL'); // a crash: no drain
    assert.ok(await until(async () => (await statusOf(port)) === null));
    const restarted = await run('ensure-gateway.mjs', ['--quiet', ...config], env);
    assert.deepEqual([restarted.code, restarted.stdout], [0, '']);
    const status = await until(() => statusOf(port));
    assert.notEqual(status.pid, pid);
    pid = status.pid;
  } finally {
    if (pid) stop(pid);
  }
});

test('the daemon exits by itself after the idle time', async () => {
  const port = await freePort();
  const { env, config } = environment(port, { idleShutdownMs: 300 });
  const daemon = spawn(process.execPath, [join(SCRIPTS, 'gateway.mjs'), ...config], { env });
  let log = '';
  daemon.stderr.on('data', (c) => {
    log += c;
  });
  const exited = new Promise((resolve) => daemon.on('exit', resolve));
  try {
    assert.ok(await until(() => statusOf(port)));
    const outcome = await Promise.race([exited, new Promise((r) => setTimeout(() => r('still running'), 3_000))]);
    assert.equal(outcome, 0);
    assert.match(log, /idle for \d+ min, no turn waits for a tool: no new connections/);
  } finally {
    daemon.kill('SIGKILL');
  }
});

// C1: a project's `.claude/settings.json` sets env for the hooks. ROUTER_CONFIG outside ~/.claude must not choose
// the config (and so the port, the Jev endpoint and where the key goes). The canary has no key to leak and an
// endpoint that cannot answer, in case this test ever runs against a gateway that still honors the variable.
test('ensure-gateway ignores a ROUTER_CONFIG outside ~/.claude and follows --config', async (t) => {
  const port = await freePort();
  const canaryPort = await freePort();
  const { dir, env, config } = environment(port);
  const canaryPath = join(dir, 'canary.json');
  writeFileSync(canaryPath, JSON.stringify({ gateway: { port: canaryPort }, jev: { endpoint: 'http://127.0.0.1:1' } }));
  t.after(async () => {
    for (const p of [port, canaryPort]) {
      const status = await statusOf(p);
      if (status?.pid) stop(status.pid);
    }
  });
  const started = await run('ensure-gateway.mjs', config, { ...env, ROUTER_CONFIG: canaryPath });
  assert.equal(started.code, 0);
  assert.ok(await until(() => statusOf(port)), 'the gateway answers on the --config port');
  assert.equal(await statusOf(canaryPort), null, 'nothing answers on the canary port');
});
