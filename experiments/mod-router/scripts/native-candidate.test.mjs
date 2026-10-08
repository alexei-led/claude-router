import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeLaunchPlan } from './native-candidate.mjs';

const pinsModel = (plan) =>
  plan.args.includes('--model') || 'model' in plan.settings || 'ANTHROPIC_MODEL' in plan.settings.env;

test('launch plan keeps the native model of a resumed or explicitly modelled session', () => {
  for (const [argv, pinned] of [
    [[], true],
    [['--resume', 'abc'], false],
    [['-r'], false],
    [['--continue'], false],
    [['-c'], false],
    [['--resume=abc'], false],
    [['--model', 'claude-opus-5-5'], false],
    [['--model=claude-opus-5-5'], false],
    [['--fork-session'], true],
  ]) {
    assert.equal(pinsModel(nativeLaunchPlan(argv)), pinned, argv.join(' '));
  }
});

test('launch plan always disables the gateway plugin and uses the direct Anthropic URL', () => {
  const { settings } = nativeLaunchPlan(['--resume']);
  assert.equal(settings.enabledPlugins['router@alexei-led-claude-router'], false);
  assert.equal(settings.env.ANTHROPIC_BASE_URL, 'https://api.anthropic.com');
});
