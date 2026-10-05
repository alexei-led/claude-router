import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launchSession, startStub } from './cli-session.mjs';
import { prepareNativeCandidate } from './native-candidate.mjs';

const ROUTED = 'claude-opus-5-5';
const FALLBACK = 'claude-haiku-4-5';
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

const directory = await prepareNativeCandidate();
const stub = await startStub('./messages-stub.mjs', {
  STUB_OVERLOADED_MODEL: ROUTED,
  STUB_TOOL_FILE: join(process.cwd(), 'package.json'),
});
const session = launchSession(
  directory,
  ['--fallback-model', FALLBACK, '--allowedTools', 'Read'],
  { ANTHROPIC_BASE_URL: `http://127.0.0.1:${stub.port}`, ANTHROPIC_API_KEY: 'synthetic-key' },
  { tools: 'Read' },
);
try {
  await session.command('/router');
  await session.command('/router pin high');
  const turn = await session.raw('Read package.json, then reply OK.');
  const status = await session.command('/router');
  assert.equal(await session.finish(), 0);
  const sequence = stub.wire.filter((event) => event.event === 'messages');
  const models = sequence.map((event) => event.model);
  const firstServed = sequence.findIndex((event) => !event.overloaded);
  assert.ok(firstServed > 0, `the routed model must have been refused first: ${models.join(',')}`);
  const served = models.slice(firstServed);
  assert.ok(served.length >= 2, `a tool continuation must follow the fallback: ${models.join(',')}`);
  assert.ok(
    served.every((model) => model === served[0] && model !== ROUTED),
    `the router forced the routed model back over the fallback: ${models.join(',')}`,
  );
  assert.equal(turn.is_error, false);
  const summary = {
    scenario: 'native-fallback',
    claudeVersion: (await import('node:child_process'))
      .spawnSync('claude', ['--version'], { encoding: 'utf8' })
      .stdout.trim(),
    driver: 'node experiments/mod-router/scripts/fallback-acceptance.mjs',
    passed: true,
    scope:
      'Real Claude Code engine with --fallback-model against a loopback Messages stub that refuses the routed model with 529. The stub is a test double; no Anthropic model is called.',
    routedModel: ROUTED,
    fallbackModel: FALLBACK,
    requestModels: models,
    servedAfterFallback: served,
    statusMentionsFallback: /fallback/i.test(status),
    note: "On 2.1.289 the engine carries the fallback model into the continuation's turn.step model, so the controller from before the fallback fix also passed this run. Unit regressions in test/native-hook.test.mjs cover a billed substitute with an unchanged step model and the engine echoing the routed model.",
  };
  const text = JSON.stringify(summary, null, 2);
  assert.equal(text.match(UUID), null);
  await writeFile(new URL('../results/native-fallback-acceptance.json', import.meta.url), `${text}\n`);
  console.log(text);
} catch (error) {
  console.error(
    JSON.stringify({
      passed: false,
      error: error.message,
      models: stub.wire.filter((event) => event.event === 'messages').map((event) => event.model),
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
