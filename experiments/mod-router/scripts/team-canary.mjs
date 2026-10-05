import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { launchSession } from './cli-session.mjs';

const session = launchSession(join(homedir(), '.claude-team/mods/router'));
try {
  const before = await session.command('/router');
  assert.match(before, /Router — Auto/);
  const turn = await session.raw('Reply with the single word OK.');
  assert.equal(turn.is_error, false);
  const status = await session.command('/router');
  const init = session.events.find((event) => event.type === 'system' && event.subtype === 'init');
  const routers = init.plugins.filter((plugin) => plugin.name.includes('router'));
  assert.equal(routers.length, 1);
  const { version } = JSON.parse(await readFile(new URL('../../../package.json', import.meta.url), 'utf8'));
  assert.equal(routers[0].version, version);
  const actualModels = [
    ...new Set(
      session.events
        .filter((event) => event.type === 'assistant')
        .map((event) => event.message?.model)
        .filter((model) => model && model !== '<synthetic>'),
    ),
  ];
  const summary = {
    scenario: 'installed-team-canary',
    passed: true,
    nativeModel: init.model,
    routers: routers.map(({ name, source, version }) => ({ name, source, version })),
    actualModels,
    status,
    driver: 'node experiments/mod-router/scripts/team-canary.mjs',
  };
  await writeFile(new URL('../results/team-canary.json', import.meta.url), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary));
  assert.equal(await session.finish(), 0);
} finally {
  if (session.child.exitCode === null) {
    session.child.kill('SIGTERM');
    await session.closed;
  }
}
