import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULTS, loadConfig } from '../lib/config.mjs';

test('defaults load without a user file and resolve no key', () => {
  const config = loadConfig({ env: {} });
  assert.equal(config.apiKey, null);
  assert.equal(config.routes.low.model, 'sonnet');
  assert.equal(config.gateway.alias, 'router');
});

test('user file overrides merge deeply and keep the rest', () => {
  const config = loadConfig({
    userFile: {
      policy: { cashCapUsd: 2 },
      routes: { medium: { model: 'sonnet', effort: 'max' } },
      gateway: { port: 5000 },
    },
  });
  assert.equal(config.policy.cashCapUsd, 2);
  assert.equal(config.policy.upgradeVotes, DEFAULTS.policy.upgradeVotes);
  assert.deepEqual(config.routes.medium, { model: 'sonnet', effort: 'max' });
  assert.equal(config.gateway.port, 5000);
  assert.equal(config.gateway.alias, 'router');
  assert.equal(config.gateway.idleShutdownMs, 2 * 3_600_000);
  assert.equal(loadConfig({ userFile: { gateway: { idleShutdownMs: 0 } } }).gateway.idleShutdownMs, 0);
});

test('api key comes from TYPESAFE_API_KEY only', () => {
  assert.equal(loadConfig({ env: { CLAUDE_PLUGIN_OPTION_TYPESAFE_API_KEY: 'a' } }).apiKey, null);
  assert.equal(loadConfig({ env: { TYPESAFE_API_KEY: 'b' } }).apiKey, 'b');
  assert.equal(loadConfig({ env: { TYPESAFE_API_KEY: '  ' } }).apiKey, null);
});

for (const [name, userFile, message] of [
  ['unknown route model', { routes: { high: { model: 'gpt' } } }, /not in models/],
  ['bad effort', { routes: { high: { model: 'opus', effort: 'ultra' } } }, /effort/],
  ['negative price', { models: { opus: { input: -1 } } }, /input/],
  ['bad efforts list', { models: { opus: { efforts: ['huge'] } } }, /efforts/],
  ['mass above 1', { policy: { downgradeMass: 1.5 } }, /downgradeMass/],
  ['zero votes', { policy: { upgradeVotes: 0 } }, /upgradeVotes/],
  ['bad baseline', { gateway: { baselineTier: 'ultra' } }, /baselineTier/],
  ['bad port', { gateway: { port: 70000 } }, /port/],
  ['negative idle shutdown', { gateway: { idleShutdownMs: -1 } }, /idleShutdownMs/],
]) {
  test(`rejects ${name}`, () => {
    assert.throws(() => loadConfig({ userFile }), message);
  });
}

test('rejects an unknown forced tier', () => {
  assert.throws(() => loadConfig({ env: { ROUTER_FORCE_TIER: 'ultra' } }), /ROUTER_FORCE_TIER/);
});
