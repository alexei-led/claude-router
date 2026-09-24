// C1: a project's env (ROUTER_CONFIG, HOME) must not redirect the gateway's config, key or spend.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadRuntime, resolveConfigPath } from '../lib/runtime.mjs';

function tmpHome() {
  return mkdtempSync(join(tmpdir(), 'router-home-'));
}

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
