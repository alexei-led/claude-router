import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { launchSession, startStub, until } from './cli-session.mjs';
import { prepareNativeCandidate } from './native-candidate.mjs';

const directory = await prepareNativeCandidate({ acceptance: true });
const stub = await startStub('./stub-server.mjs');
// Isolate the real main-turn controller from paid Jev traffic; never forward the user's key to the stub.
const configPath = join(directory, 'lib/config.mjs');
await writeFile(
  configPath,
  (await readFile(configPath, 'utf8')).replace(
    'https://api.typesafe.ai/v1/systemone',
    `http://127.0.0.1:${stub.port}/delay`,
  ),
);
await writeFile(
  join(directory, 'hooks/register.mjs'),
  "import { register as native } from './native-router.mjs';\nimport { registerAcceptance } from './acceptance.mjs';\nexport function register(on) { native(on, {typesafe_api_key:'synthetic-probe-key'}); registerAcceptance(on); }\n",
);
const session = launchSession(directory);
try {
  await session.inspect();
  const turn = session.raw('Reply with the single word OK.');
  await until('main-turn Jev request', () => stub.wire.some((event) => event.event === 'request'));
  session.child.stdin.write(
    `${JSON.stringify({ type: 'control_request', request_id: 'router-interrupt', request: { subtype: 'interrupt' } })}\n`,
  );
  const result = await turn;
  await until('interrupt acknowledgement', () =>
    session.events.some(
      (event) => event.type === 'control_response' && event.response?.request_id === 'router-interrupt',
    ),
  );
  const immediate = await session.inspect();
  assert.notEqual(immediate.phase, 'choosing');
  await wait(5200);
  const afterLateAdvice = await session.inspect();
  assert.equal(afterLateAdvice.phase, immediate.phase);
  assert.equal(afterLateAdvice.reason, immediate.reason);
  const request = stub.wire.find((event) => event.event === 'request');
  await until('interrupted request closes', () => stub.wire.some((event) => event.event === 'request-end'), 31_000);
  const end = stub.wire.find((event) => event.event === 'request-end');
  assert.ok(end.at - request.at <= 31_000);
  const summary = {
    scenario: 'main-turn-interrupt',
    passed: true,
    driver: 'node experiments/mod-router/scripts/interrupt-acceptance.mjs',
    scope: 'Real ce peer-team main-turn controller, SDK interrupt, synthetic delayed Jev on loopback.',
    interruptedResult: result.subtype,
    choosingCleared: true,
    lateAdviceDidNotChangeView: true,
    socketClosedMs: end.at - request.at,
    wireRequests: stub.wire.filter((event) => event.event === 'request').length,
  };
  await writeFile(
    new URL('../results/native-interrupt-acceptance.json', import.meta.url),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  console.log(JSON.stringify(summary));
} finally {
  if (session.child.exitCode === null) {
    session.child.kill('SIGTERM');
    await session.closed;
  }
  await stub.stop();
  await rm(directory, { recursive: true, force: true });
}
