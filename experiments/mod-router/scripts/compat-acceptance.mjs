import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launchSession, startStub } from './cli-session.mjs';
import { prepareNativeCandidate } from './native-candidate.mjs';

// Each pinned turn reads a file, so every routed model gets a tool continuation over the previous model's history.
const PINS = ['high', 'micro', 'medium', 'low', 'micro'];

const directory = await prepareNativeCandidate();
const stub = await startStub('./messages-stub.mjs', { STUB_TOOL_FILE: join(process.cwd(), 'package.json') });
const session = launchSession(
  directory,
  ['--allowedTools', 'Read'],
  { ANTHROPIC_BASE_URL: `http://127.0.0.1:${stub.port}`, ANTHROPIC_API_KEY: 'synthetic-key' },
  { tools: 'Read' },
);
try {
  await session.command('/router');
  for (const tier of PINS) {
    await session.command(`/router pin ${tier}`);
    const turn = await session.raw('Read package.json, then reply OK.');
    assert.equal(turn.is_error, false, `${tier} turn failed`);
  }
  assert.equal(await session.finish(), 0);
  const requests = stub.wire
    .filter((event) => event.event === 'messages' && event.tools > 0)
    .map(({ model, effort, maxTokens, thinking, afterTool, gatewayWouldChange }) => ({
      model,
      effort,
      maxTokens,
      thinking,
      afterTool,
      gatewayWouldChange,
    }));
  const summary = {
    scenario: 'native-request-compatibility',
    claudeVersion: spawnSync('claude', ['--version'], { encoding: 'utf8' }).stdout.trim(),
    driver: 'node experiments/mod-router/scripts/compat-acceptance.mjs',
    scope:
      'Real Claude Code engine routed by the native Mod through pins, against a loopback Messages stub. For each main request the stub applies the 0.8.0 gateway rewrite rules and records which request parts they would still change. Names only; no content is recorded.',
    pins: PINS,
    requests,
    legacyRewriteDifferences: [...new Set(requests.flatMap((request) => request.gatewayWouldChange ?? []))],
    interpretation:
      'Differences from historical gateway rules are not API incompatibilities. Real API probes separately validate thinking, tools and output behavior.',
  };
  assert.equal(requests.filter((request) => request.afterTool).length, PINS.length);
  assert.equal(requests.filter((request) => !request.afterTool).length, PINS.length);
  const text = JSON.stringify(summary, null, 2);
  await writeFile(new URL('../results/native-compat-acceptance.json', import.meta.url), `${text}\n`);
  console.log(text);
} catch (error) {
  console.error(
    JSON.stringify({
      passed: false,
      error: error.message,
      requests: stub.wire.filter((event) => event.event === 'messages').slice(-4),
      events: session.events.slice(-10).map((event) => ({ type: event.type, subtype: event.subtype })),
    }),
  );
  process.exitCode = 1;
} finally {
  if (session.child.exitCode === null) {
    session.child.kill('SIGTERM');
    await session.closed;
  }
  await stub.stop();
  await rm(directory, { recursive: true, force: true });
}
