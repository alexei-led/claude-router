import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import { launchSession } from './cli-session.mjs';
import { prepareNativeCandidate } from './native-candidate.mjs';

// Billed Team requests: each pinned turn reads a file over the previous model's signed-thinking and tool history.
const PINS = ['high', 'micro', 'medium', 'low', 'micro'];
const EXPECTED = {
  high: 'claude-opus-5-5',
  medium: 'claude-opus-5-5',
  low: 'claude-haiku-5-5',
  micro: 'claude-haiku-5-5',
};

const directory = await prepareNativeCandidate();
const session = launchSession(directory, ['--allowedTools', 'Read'], {}, { tools: 'Read' });
try {
  await session.command('/router');
  const turns = [];
  for (const tier of PINS) {
    await session.command(`/router pin ${tier}`);
    const from = session.events.length;
    const turn = await session.raw('Read package.json with the Read tool, then reply with the single word OK.');
    const assistant = session.events.slice(from).filter((event) => event.type === 'assistant');
    const models = [...new Set(assistant.map((event) => event.message?.model).filter((m) => m && m !== '<synthetic>'))];
    const toolUses = assistant.flatMap((event) => event.message?.content ?? []).filter((b) => b.type === 'tool_use');
    const thinking = assistant.flatMap((event) => event.message?.content ?? []).some((b) => b.type === 'thinking');
    turns.push({ tier, ok: turn.is_error === false, models, toolUses: toolUses.length, thinking });
  }
  assert.equal(await session.finish(), 0);
  for (const turn of turns) {
    assert.ok(turn.ok, `${turn.tier} turn failed`);
    assert.ok(turn.toolUses > 0, `${turn.tier} turn used no tool`);
    assert.ok(
      turn.models.every((model) => model.startsWith(EXPECTED[turn.tier])),
      `${turn.tier}: ${turn.models}`,
    );
  }
  const summary = {
    scenario: 'native-live-compatibility',
    claudeVersion: spawnSync('claude', ['--version'], { encoding: 'utf8' }).stdout.trim(),
    driver: 'node experiments/mod-router/scripts/live-compat-acceptance.mjs',
    scope:
      'Real Team API through ce peer-team with the native Mod candidate. Each turn pins a tier and calls Read, so each model continues the previous models’ thinking and tool history. No content is recorded.',
    passed: true,
    turns,
  };
  const text = JSON.stringify(summary, null, 2);
  await writeFile(new URL('../results/native-live-compat-acceptance.json', import.meta.url), `${text}\n`);
  console.log(text);
} catch (error) {
  console.error(JSON.stringify({ passed: false, error: error.message }));
  process.exitCode = 1;
} finally {
  if (session.child.exitCode === null) {
    session.child.kill('SIGTERM');
    await session.closed;
  }
  await rm(directory, { recursive: true, force: true });
}
