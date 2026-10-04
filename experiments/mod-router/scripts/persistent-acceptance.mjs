import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { appendFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { nativeLaunchPlan, prepareNativeCandidate } from './native-candidate.mjs';

const SCENARIOS = ['clear', 'circuit', 'reload', 'replace', 'unload', 'resume'];
const scenario = process.argv[2] ?? 'clear';
assert.ok(SCENARIOS.includes(scenario), `Use ${SCENARIOS.join(', ')}`);
const OPUS = 'claude-opus-5-5';
// Measured: the host leaves an abandoned loopback request open for about 30 s after a reload.
const HOST_SOCKET_LIMIT_MS = 40_000;
const UNFINISHED_BOUND = 1;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

const directory = await prepareNativeCandidate({ acceptance: true });
const server = spawn(process.execPath, [fileURLToPath(new URL('./stub-server.mjs', import.meta.url))], {
  stdio: ['ignore', 'pipe', 'pipe'],
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

const unfinished = () =>
  wire.filter((event) => event.event === 'request').length -
  wire.filter((event) => event.event === 'request-end').length;
const maxPending = () =>
  Math.max(0, ...wire.filter((event) => event.event === 'request').map((event) => event.pending));

async function until(label, check, ms = 5000) {
  const limit = Date.now() + ms;
  while (!check()) {
    assert.ok(Date.now() < limit, `Timed out: ${label}`);
    await wait(25);
  }
}

function launch(argv = [], { acceptance = true } = {}) {
  const plan = nativeLaunchPlan(argv);
  plan.settings.env.ROUTER_PROBE_URL = `http://127.0.0.1:${port}`;
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
    if (/error|failed|unknown command/i.test(line)) errors.push(line.slice(0, 300));
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
  return { child, raw, command, inspect, finish, closed, events, initModel, acceptance };
}

async function closeSockets() {
  await until(
    'HTTP connections closed after CLI exit',
    () =>
      wire.filter((event) => event.event === 'close').length >=
      wire.filter((event) => event.event === 'connect').length,
    2000,
  );
}

const checks = {};
const open = [];
const track = (session) => {
  open.push(session);
  return session;
};

try {
  if (scenario === 'resume') {
    const turnOn = async (argv, mode) => {
      const session = track(launch(argv));
      await session.inspect();
      if (mode) await session.command(`/router ${mode}`);
      const turn = await session.raw('Reply with the single word OK.');
      assert.equal(turn.is_error, false, 'turn failed');
      const model = await session.initModel();
      assert.equal(await session.finish(), 0);
      return { sessionId: turn.session_id, model };
    };
    const inspectOn = async (argv) => {
      const session = track(launch(argv));
      const view = await session.inspect();
      const model = await session.initModel();
      assert.equal(await session.finish(), 0);
      return { ...view, model };
    };
    const baseline = await turnOn([], 'off');
    const resumed = await inspectOn(['--resume', baseline.sessionId]);
    assert.equal(resumed.session, baseline.sessionId, 'resume must keep the session id');
    assert.equal(resumed.mode, 'manual', 'resume must restore a Manual choice made on the baseline model');
    assert.equal(resumed.model, baseline.model);
    const fork = await inspectOn(['--resume', baseline.sessionId, '--fork-session']);
    assert.notEqual(fork.session, baseline.sessionId, 'fork must get a new session id');
    assert.equal(fork.mode, 'auto', 'a fork is a new session id and starts Auto');
    const explicit = await turnOn(['--model', OPUS], null);
    const resumedExplicit = await inspectOn(['--resume', explicit.sessionId]);
    assert.equal(resumedExplicit.model, OPUS, 'resume must keep an explicit native model selection');
    assert.equal(resumedExplicit.mode, 'manual', 'an explicit non-baseline model starts and resumes Manual');
    await closeSockets();
    assert.equal(unfinished(), 0);
    Object.assign(checks, {
      baselineModel: baseline.model,
      resumeKeepsSessionId: true,
      resumeRestoredManualOnBaseline: true,
      resumeKeepsModel: resumed.model === baseline.model,
      forkNewSessionId: true,
      forkMode: fork.mode,
      explicitModel: OPUS,
      resumeKeepsExplicitModel: resumedExplicit.model === OPUS,
      resumeExplicitMode: resumedExplicit.mode,
    });
  } else {
    const session = track(launch());
    const initial = await session.inspect();
    assert.equal(typeof initial.session, 'string');
    await session.command('/router off');
    const manual = await session.inspect();
    assert.equal(manual.mode, 'manual');
    if (scenario === 'clear') {
      const timeout = await session.command('/router-accept ask hang');
      assert.equal(timeout.error, 'timeout');
      assert.ok(timeout.elapsedMs <= 1650, `Advice deadline was ${timeout.elapsedMs}ms`);
      const busy = await session.command('/router-accept ask hang');
      assert.equal(busy.error, 'busy');
      await session.command('/clear');
      const cleared = await session.inspect();
      assert.notEqual(cleared.session, initial.session);
      assert.equal(cleared.mode, 'auto');
      assert.ok(cleared.lifecycle.some((event) => event.event === 'end' && event.reason === 'clear'));
      const afterClear = await session.command('/router-accept ask hang');
      assert.ok(['timeout', 'busy'].includes(afterClear.error));
      Object.assign(checks, {
        adviceTimeoutMs: timeout.elapsedMs,
        repeatedCall: busy.error,
        sessionIdChangedOnClear: true,
        modeAfterClear: cleared.mode,
        callAfterClear: afterClear.error,
        requestsOnWire: wire.filter((event) => event.event === 'request').length,
      });
    } else if (scenario === 'circuit') {
      let failure;
      for (let count = 1; count <= 3; count += 1) {
        failure = await session.command('/router-accept ask malformed');
        assert.equal(failure.error, 'malformed');
        assert.equal(failure.health.failures, count);
      }
      const requestCount = wire.filter((event) => event.event === 'request').length;
      const paused = await session.command('/router-accept ask retry');
      assert.equal(paused.error, 'paused');
      assert.equal(wire.filter((event) => event.event === 'request').length, requestCount);
      await wait(Math.max(0, failure.health.pausedUntil - Date.now() + 50));
      const recovered = await session.command('/router-accept ask retry');
      assert.equal(recovered.error, null);
      assert.equal(recovered.choice, 'medium');
      assert.equal(recovered.health.failures, 0);
      assert.equal(recovered.health.pausedUntil, 0);
      Object.assign(checks, { failuresToPause: 3, pausedWithoutHttp: true, recoveredAfter503: true });
    } else {
      const hung = await session.command('/router-accept ask hang');
      assert.equal(hung.error, 'timeout');
      assert.equal(unfinished(), 1, 'the hung request must still be open before the reload');
      if (scenario === 'unload') await writeFile(join(directory, 'hooks/hooks.json'), '{"modules":[]}\n');
      if (scenario === 'replace') await appendFile(join(directory, 'hooks/register.mjs'), '\n// replaced\n');
      const started = Date.now();
      checks.reloadOutput = String(await session.command('/reload-plugins')).slice(0, 80);
      if (scenario === 'reload') {
        const reloaded = await session.inspect();
        assert.equal(reloaded.pending, true, 'an unchanged module keeps its request guard across a reload');
        const again = await session.command('/router-accept ask hang');
        assert.equal(again.error, 'busy', 'the guard must refuse a second request');
        checks.askAfterReload = again.error;
      } else if (scenario === 'replace') {
        const replaced = await session.inspect();
        assert.equal(replaced.pending, false, 'a replaced module starts without a pending request');
        await until('host cancels the replaced module request', () => unfinished() === 0, 5000);
        checks.replacedModuleRequestClosedMs = Date.now() - started;
        const again = await session.command('/router-accept ask hang');
        assert.equal(again.error, 'timeout', 'the replaced module may ask again');
        checks.askAfterReplace = again.error;
      } else {
        const status = await session.raw('/router status');
        assert.ok(!/Jev Router — /.test(status.result ?? ''), 'router controls must be gone after unload');
        checks.routerControlsGone = true;
      }
      await until('host closes the orphaned request', () => unfinished() === 0, HOST_SOCKET_LIMIT_MS);
      checks.orphanClosedMsAfterReload = Date.now() - started;
    }
    assert.equal(await session.finish(), 0);
    await closeSockets();
  }
  assert.ok(maxPending() <= UNFINISHED_BOUND, `more than ${UNFINISHED_BOUND} unfinished request(s)`);
  const requests = wire.filter((event) => event.event === 'request');
  const summary = {
    scenario: `persistent-${scenario}`,
    claudeVersion: spawnSync('claude', ['--version'], { encoding: 'utf8' }).stdout.trim(),
    profile: 'ce peer-team, Team credentials, isolated native plugin directory, synthetic Jev stub on loopback',
    driver: `node experiments/mod-router/scripts/persistent-acceptance.mjs ${scenario}`,
    passed: true,
    checks,
    wire: {
      requests: requests.length,
      maxUnfinished: maxPending(),
      unfinishedAtEnd: unfinished(),
      connects: wire.filter((event) => event.event === 'connect').length,
      closes: wire.filter((event) => event.event === 'close').length,
      secretsOnWire: requests.some((event) => 'authorization' in event),
    },
  };
  const text = JSON.stringify(summary, null, 2);
  assert.equal(text.match(UUID), null, 'summary must not contain session ids');
  const out = new URL(`../results/persistent-${scenario}-acceptance.json`, import.meta.url);
  await mkdir(dirname(fileURLToPath(out)), { recursive: true });
  await writeFile(out, `${text}\n`);
  console.log(text);
} catch (error) {
  console.error(JSON.stringify({ scenario: `persistent-${scenario}`, passed: false, error: error.message, checks }));
  process.exitCode = 1;
} finally {
  for (const session of open) {
    if (session.child.exitCode === null) {
      session.child.kill('SIGTERM');
      await session.closed;
    }
  }
  server.kill('SIGTERM');
  await once(server, 'close');
  await rm(directory, { recursive: true, force: true });
}
