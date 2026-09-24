// C1: a project's env (ROUTER_CONFIG, HOME) must not redirect the gateway's config, key or spend.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { isRouterGateway, loadRuntime, resolveConfigPath, userHome } from '../lib/runtime.mjs';

function tmpHome() {
  return mkdtempSync(join(tmpdir(), 'router-home-'));
}

test('home comes from the OS user record; a UID without one (arbitrary container UID) falls back to $HOME', () => {
  const envHome = () => '/env/home';
  assert.equal(
    userHome(() => ({ homedir: '/os/home' }), envHome),
    '/os/home',
  );
  const noPasswdEntry = () => {
    throw Object.assign(new Error('uv_os_get_passwd returned ENOENT'), { code: 'ERR_SYSTEM_ERROR' });
  };
  assert.equal(userHome(noPasswdEntry, envHome), '/env/home');
});

test('without ROUTER_CONFIG, the default path is <home>/.claude/router.json', () => {
  const home = tmpHome();
  const { path, warning } = resolveConfigPath({}, { home });
  assert.equal(path, join(home, '.claude', 'router.json'));
  assert.equal(warning, null);
});

test('a ROUTER_CONFIG path inside <home>/.claude is honored', () => {
  const home = tmpHome();
  const configPath = join(home, '.claude', 'router.json');
  const { path, warning } = resolveConfigPath({ ROUTER_CONFIG: configPath }, { home });
  assert.equal(path, configPath);
  assert.equal(warning, null);
});

test('a ROUTER_CONFIG path outside <home>/.claude is ignored, with a warning naming the variable only', () => {
  const home = tmpHome();
  const canary = join(tmpdir(), 'router-canary', 'router.json');
  const { path, warning } = resolveConfigPath({ ROUTER_CONFIG: canary }, { home });
  assert.equal(path, join(home, '.claude', 'router.json'));
  assert.match(warning, /ROUTER_CONFIG/);
  assert.doesNotMatch(warning, /router-canary/); // never echoes the rejected path
});

test('a sibling directory that only starts with .claude is not "inside" it', () => {
  const home = tmpHome();
  const sneaky = join(home, '.claude-evil', 'router.json');
  const { path, warning } = resolveConfigPath({ ROUTER_CONFIG: sneaky }, { home });
  assert.equal(path, join(home, '.claude', 'router.json'));
  assert.ok(warning);
});

test('an explicit --config path is unrestricted', () => {
  const explicit = join(tmpdir(), 'router-explicit', 'router.json');
  const { path, warning } = resolveConfigPath({ ROUTER_CONFIG: 'ignored' }, { home: tmpHome(), configPath: explicit });
  assert.equal(path, explicit);
  assert.equal(warning, null);
});

// Path resolution only: loadRuntime({}) would read the real ~/.claude/router.json and depend on this machine.
test('the default home is the OS user home, never $HOME, even when the process env HOME is set', () => {
  const original = process.env.HOME;
  process.env.HOME = join(tmpdir(), 'router-fake-home-should-be-ignored');
  try {
    const { path } = resolveConfigPath({ HOME: process.env.HOME });
    assert.equal(path, join(userInfo().homedir, '.claude', 'router.json'));
  } finally {
    if (original === undefined) delete process.env.HOME;
    else process.env.HOME = original;
  }
});

test('ROUTER_FORCE_TIER from the environment is not honored; only an explicit forceTier is', () => {
  const home = tmpHome();
  const { config } = loadRuntime({ ROUTER_FORCE_TIER: 'high' }, { home });
  assert.equal(config.forcedTier, null);
  const forced = loadRuntime({ ROUTER_FORCE_TIER: 'high' }, { home, forceTier: 'high' });
  assert.equal(forced.config.forcedTier, 'high');
});

// H3: never `ps` or signal a pid that could mean a process group (0) or every process (-1).
test('isRouterGateway accepts only a live pid whose command runs scripts/gateway.mjs', () => {
  const calls = [];
  const ps = (command) => (_file, args) => {
    calls.push(args.at(-1));
    if (command instanceof Error) throw command;
    return command;
  };
  const gateway = ps('/usr/bin/node /x/plugins/router/scripts/gateway.mjs --config /y\n');
  assert.equal(isRouterGateway(4242, gateway), true);
  assert.equal(isRouterGateway(4242, ps('/usr/bin/node -e setInterval()\n')), false);
  assert.equal(isRouterGateway(4242, ps(new Error('ps: no such process'))), false);
  calls.length = 0;
  for (const pid of [-1, 0, 1, 1.5, '4242', null, undefined, Number.NaN])
    assert.equal(isRouterGateway(pid, gateway), false);
  assert.deepEqual(calls, []);
});

test('a bad --force-tier names the flag, not the config file', () => {
  assert.throws(
    () => loadRuntime({}, { home: tmpHome(), forceTier: 'ultra' }),
    (error) => /--force-tier/.test(error.message) && !/router\.json/.test(error.message),
  );
});
