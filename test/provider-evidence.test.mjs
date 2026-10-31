import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { loadConfig } from '../lib/config.mjs';
import { canonicalModel } from '../lib/providers.mjs';
import { matchesTask, probeCases, run, TASKS, usageUsd } from '../scripts/probe-provider-routes.mjs';

const result = (name) =>
  JSON.parse(readFileSync(new URL(`../experiments/mod-router/results/${name}.json`, import.meta.url), 'utf8'));

test('live microcheck artifacts retain exact answers, costs and all configured mode cells', () => {
  for (const provider of ['minimax', 'mimo', 'kimi']) {
    const config = loadConfig({ provider });
    const report = result(`provider-routes-${provider}`);
    assert.equal(report.provider, provider);
    assert.equal(report.stopped, undefined);
    assert.equal(report.rows.length, probeCases(config).length);
    for (const row of report.rows) {
      const expected = probeCases(config).find(
        (c) => c.activity === row.activity && c.model === row.model && c.effort === row.effort,
      );
      assert.deepEqual(row.cells, expected.cells);
      assert.equal(row.status, 200);
      assert.equal(row.requested, canonicalModel(config.models[row.model].id));
      assert.equal(row.served, row.requested);
      assert.equal(row.passed, matchesTask(row.text, TASKS.find((t) => t.activity === row.activity).expected));
      assert.equal(row.estimatedUsd, usageUsd(config.models[row.model], row.usage));
    }
    assert.ok(report.accountedUsd <= report.budgetUsd);
  }
});

test('native live artifacts prove configured models and effort through successful Read continuations', () => {
  for (const provider of ['minimax', 'mimo', 'kimi']) {
    const config = loadConfig({ provider });
    const report = result(`provider-native-${provider}`);
    assert.equal(report.passed, true);
    assert.equal(report.exitCode, 0);
    assert.equal(report.turns.length, 4);
    for (const index of [1, 3]) {
      assert.ok(report.turns[index].reads > 0);
      assert.equal(report.turns[index].text.trim(), 'NATIVE_PROVIDER_TOOL_OK');
    }
    for (const row of report.requests) {
      const route = row.turn === 1 ? config.routes.high : config.routes.micro;
      assert.equal(row.model, canonicalModel(config.models[route.model].id));
      assert.equal(row.served, row.model);
      assert.equal(row.status, 200);
      if (route.effort !== null) assert.equal(row.effort, route.effort);
    }
    assert.ok(report.requests.some((r) => r.afterTool));
    assert.ok(report.accountedUsd <= report.budgetUsd);
  }
});

test('the experiment spend record includes superseded calls within the authorized aggregate', () => {
  const spend = result('provider-experiment-spend');
  const retained = spend.artifacts.reduce((total, file) => {
    const report = result(file.replace(/\.json$/, ''));
    return total + (report.accountedUsd ?? report.estimatedUsd);
  }, 0);
  const superseded = Object.values(spend.supersededNativePass).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(retained + superseded - spend.totalEstimatedUsd) < 1e-12);
  assert.ok(spend.totalEstimatedUsd < spend.authorizedUsd);
});

test('a paid probe refuses invalid provider or budget before accessing credentials', async () => {
  for (const [provider, budget] of [
    ['unknown', 1],
    ['kimi', 0],
    ['mimo', NaN],
    ['minimax', 6],
  ])
    await assert.rejects(run(provider, budget), /Expected/);
});
