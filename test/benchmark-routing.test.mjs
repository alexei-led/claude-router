import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  casesFor,
  checkAnswer,
  cli,
  estimate,
  executeCases,
  hash,
  MANIFEST,
  parseResult,
  report,
  restoreActiveEnv,
  runProcess,
  smokeArgs,
  validateManifest,
  verifyProfile,
} from '../scripts/benchmark-routing.mjs';

const manifest = validateManifest(JSON.parse(await readFile(MANIFEST, 'utf8')));
const result = (answer, cost = 0.1) =>
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: answer,
    total_cost_usd: cost,
    modelUsage: { 'served-model': { costUSD: cost, inputTokens: 100, outputTokens: 10 } },
  });

test('fixed proposed split and full paired matrix', () => {
  const cases = casesFor(manifest.tasks);
  assert.equal(manifest.tasks.length, 24);
  assert.equal(cases.length, 288);
  assert.equal(cases.filter((c) => c.engine === 'auto').length, 144);
  assert.deepEqual(
    casesFor(manifest.tasks, { smoke: true }).map((c) => [c.task.id, c.engine, c.mode, c.repeat]),
    [
      ['json-sort', 'table', 'balanced', 1],
      ['empty-sum', 'table', 'balanced', 1],
      ['dedupe', 'table', 'balanced', 1],
    ],
  );
  assert.throws(() => validateManifest({ ...manifest, tasks: manifest.tasks.map((t) => ({ ...t, smoke: true })) }));
});

test('strict JSON checks reject malformed and wrong outputs', () => {
  const task = manifest.tasks[0];
  assert.equal(checkAnswer(task, '[1,2,3]'), true);
  assert.equal(checkAnswer(task, '[3,2,1]'), false);
  assert.equal(checkAnswer(task, '```json\n[1,2,3]\n```'), false);
});

test('estimates require positive bounded assumptions', () => {
  assert.equal(
    estimate(3, { inputTokens: 10000, outputTokens: 256, inputRate: 4, outputRate: 20, inputMultiplier: 2 }),
    0.25536,
  );
  assert.throws(() => estimate(1, { inputTokens: 0, outputTokens: 256, inputRate: 4, outputRate: 20 }));
});

test('machine-readable cost and result validation fail closed', () => {
  assert.equal(parseResult(result('[]'), 0).ok, true);
  for (const text of ['garbage', result('[]', 0), result('[]', -1), JSON.stringify({ total_cost_usd: 1 })])
    assert.equal(parseResult(text, 0).ok, false);
  assert.equal(parseResult(result('[]'), 1).ok, false);
});

test('discordances paired per repeat, split and mode; failures remain unpriced', () => {
  const rows = [
    { taskId: 'a', split: 'heldout', mode: 'cost', repeat: 1, engine: 'table', passed: true, cost: 0.1, wallMs: 1 },
    { taskId: 'a', split: 'heldout', mode: 'cost', repeat: 1, engine: 'auto', passed: false, cost: 0.2, wallMs: 2 },
    { taskId: 'a', split: 'heldout', mode: 'quality', repeat: 1, engine: 'table', passed: null, cost: null, wallMs: 3 },
  ];
  const summary = report(rows);
  assert.deepEqual(summary.discordances, [
    { taskId: 'a', split: 'heldout', mode: 'cost', repeat: 1, table: true, auto: false },
  ]);
  assert.equal(summary.incompletePairs, 1);
  assert.equal(summary.reportedTotalCostUsd, null);
  assert.equal(summary.unpricedRuns, 1);
  assert.equal(summary.runWallMs, 6);
});

test('system boundary executes separately, accounts failures and refuses overspend', async () => {
  const root = await mkdtemp(join(tmpdir(), 'routing-bench-test-'));
  try {
    const cases = casesFor(manifest.tasks, { smoke: true });
    const launch = async (item, cwd, timeoutMs) =>
      runProcess(
        process.execPath,
        ['-e', 'process.stdout.write(process.argv[1])', result(JSON.stringify(item.task.check.expected))],
        { cwd, timeoutMs },
      );
    await assert.rejects(
      executeCases(cases, { launcher: launch, root, budgetUsd: 0.2, reservationUsd: 0.1, timeoutMs: 3000 }),
    );
    const actual = await executeCases(cases, {
      launcher: launch,
      root,
      budgetUsd: 0.3,
      reservationUsd: 0.1,
      timeoutMs: 3000,
    });
    assert.equal(actual.rows.length, 3);
    assert.ok(actual.rows.every((row) => row.passed));
    const unpriced = await executeCases(cases, {
      root,
      budgetUsd: 1,
      reservationUsd: 0.2,
      timeoutMs: 3000,
      launcher: async () => ({ exitCode: 1, stdout: result('[]', 0), wallMs: 1 }),
    });
    assert.equal(unpriced.rows.length, 1);
    assert.equal(unpriced.accountedUsd, 0.2);
    assert.equal(unpriced.report.reportedTotalCostUsd, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('deadline kills unresponsive subprocess', async () => {
  const child = await runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 100 });
  assert.equal(child.reason, 'deadline');
});

test('active environment restores exact bytes and absence after success, errors and subprocess timeout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'routing-env-test-'));
  const path = join(root, 'active-env.json');
  const original = '{ "env": "original" }\n';
  try {
    await writeFile(path, original);
    await restoreActiveEnv(path, async () => {
      await writeFile(path, '{}');
    });
    assert.equal(await readFile(path, 'utf8'), original);
    await assert.rejects(
      restoreActiveEnv(path, async () => {
        await writeFile(path, '{}');
        throw new Error('launch');
      }),
    );
    assert.equal(await readFile(path, 'utf8'), original);
    await restoreActiveEnv(path, async () => {
      await writeFile(path, '{}');
      const child = await runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 100 });
      assert.equal(child.reason, 'deadline');
    });
    assert.equal(await readFile(path, 'utf8'), original);
    await rm(path);
    await assert.rejects(
      restoreActiveEnv(path, async () => {
        await writeFile(path, '{}');
        throw new Error('launch');
      }),
    );
    await assert.rejects(readFile(path), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('smoke argv preserves prompt literally, has narrow tools and bounded turns/budget', () => {
  const prompt = '$(touch /tmp/not-executed)';
  const args = smokeArgs(prompt);
  assert.equal(args[1], prompt);
  assert.equal(args[args.indexOf('--max-turns') + 1], '1');
  assert.equal(args[args.indexOf('--tools') + 1], '');
  assert.equal(args.includes('--plugin-dir'), false);
  assert.equal(args.includes('--dangerously-skip-permissions'), false);
});

test('inspector failure, malformed metadata and interrupt restore active environment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'routing-inspector-test-'));
  const path = join(root, 'active-env.json');
  try {
    const original = 'original bytes\n';
    await writeFile(path, original);
    await restoreActiveEnv(path, async () => {
      await writeFile(path, 'changed');
      const child = await runProcess(process.execPath, ['-e', 'console.log("init");setInterval(() => {}, 1000)'], {
        timeoutMs: 1000,
        inspectLine: () => {
          throw new Error('bad inspector');
        },
      });
      assert.equal(child.reason, 'inspection-error');
    });
    assert.equal(await readFile(path, 'utf8'), original);
    assert.equal(parseResult(JSON.stringify({ type: 'result', modelUsage: { bad: null } }), 0).ok, false);
    await restoreActiveEnv(path, async () => {
      await writeFile(path, 'changed');
      const child = await runProcess(process.execPath, ['-e', 'console.log("ready");setInterval(() => {}, 1000)'], {
        timeoutMs: 1000,
        inspectLine: () => {
          process.emit('SIGINT');
          return null;
        },
      });
      assert.equal(child.reason, 'interrupted');
    });
    assert.equal(await readFile(path, 'utf8'), original);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('UTF-8 chunks survive decoding, oversized output and spawn errors fail closed', async () => {
  const child = await runProcess(
    process.execPath,
    [
      '-e',
      'const b=Buffer.from("é🙂");process.stdout.write(b.subarray(0,1));setTimeout(()=>process.stdout.write(b.subarray(1)),10);',
    ],
    { timeoutMs: 1000 },
  );
  assert.equal(child.stdout, 'é🙂');
  const large = await runProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(2*1024*1024))'], {
    timeoutMs: 1000,
  });
  assert.equal(large.reason, 'output-limit');
  const missing = await runProcess('/not-a-real-benchmark-executable', [], { timeoutMs: 1000 });
  assert.equal(missing.reason, 'spawn-error');
});

test('unpriced model usage and overspending stop later attempts and retain reported cost', async () => {
  const root = await mkdtemp(join(tmpdir(), 'routing-spend-test-'));
  try {
    const cases = casesFor(manifest.tasks, { smoke: true });
    const missingPrices = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: '[1,2,3]',
      total_cost_usd: 0.1,
      modelUsage: {
        valid: { inputTokens: 1, outputTokens: 1, costUSD: 0.1 },
        model: { inputTokens: 1, outputTokens: 1, costUSD: 0 },
      },
    });
    const unpriced = await executeCases(cases, {
      root,
      budgetUsd: 1.2,
      reservationUsd: 0.4,
      timeoutMs: 1000,
      launcher: async () => ({ exitCode: 0, stdout: missingPrices, wallMs: 1 }),
    });
    assert.equal(unpriced.rows.length, 1);
    assert.equal(unpriced.report.knownCostUsd, 0.1);
    assert.equal(unpriced.report.reportedTotalCostUsd, null);
    const overspend = await executeCases(cases, {
      root,
      budgetUsd: 1.2,
      reservationUsd: 0.4,
      timeoutMs: 1000,
      launcher: async () => ({ exitCode: 0, stdout: result('[1,2,3]', 0.41), wallMs: 1 }),
    });
    assert.equal(overspend.rows.length, 1);
    assert.equal(overspend.rows[0].error, 'run-budget-exceeded');
    assert.equal(overspend.rows[0].passed, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('post-execution profile read failure preserves spent attempt accounting', async () => {
  const root = await mkdtemp(join(tmpdir(), 'routing-profile-test-'));
  try {
    const actual = await executeCases(casesFor(manifest.tasks, { smoke: true }), {
      root,
      budgetUsd: 1.2,
      reservationUsd: 0.4,
      timeoutMs: 1000,
      launcher: async (_item, cwd, timeoutMs) => {
        const outcome = await runProcess(
          process.execPath,
          ['-e', 'process.stdout.write(process.argv[1])', result('[1,2,3]', 0.05)],
          { cwd, timeoutMs },
        );
        return verifyProfile(outcome, { configPath: join(root, 'missing-config.json'), configSha256: 'expected' });
      },
    });
    assert.equal(actual.rows.length, 1);
    assert.equal(actual.rows[0].error, 'profile-unreadable');
    assert.equal(actual.rows[0].cost, 0.05);
    assert.equal(actual.accountedUsd, 0.05);
    assert.equal(actual.rows[0].passed, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('paired matrix reports both-repeat heldout regressions; rerun duplicates cannot hide failures or cost', () => {
  const rows = [1, 2].flatMap((repeat) =>
    ['table', 'auto'].map((engine) => ({
      taskId: 'heldout',
      split: 'heldout',
      mode: 'balanced',
      repeat,
      engine,
      passed: engine === 'table',
      cost: 0.1,
      priced: true,
      wallMs: 1,
    })),
  );
  const summary = report(rows);
  assert.equal(summary.discordances.length, 2);
  assert.deepEqual(summary.bothRepeatRegressions, [{ taskId: 'heldout', split: 'heldout', mode: 'balanced' }]);
  const rerun = report([...rows, { ...rows[1], passed: true }]);
  assert.equal(rerun.knownCostUsd, 0.5);
  assert.equal(rerun.ambiguousPairs, 1);
  assert.equal(rerun.incompletePairs, 1);
});

test('proposal split is hash-frozen before tuning; full live matrix refuses without launching', async () => {
  assert.equal(hash(await readFile(MANIFEST)), '2efac9527b671d5240441bae0430d89e35829356cde9abb1dfc54f5d5efcb97c');
  const child = await runProcess(process.execPath, ['scripts/benchmark-routing.mjs', '--live'], { timeoutMs: 1000 });
  assert.equal(child.exitCode, 1);
  assert.equal(child.stdout, '');
  await assert.rejects(cli(['--live']), /checkout\/profile isolation is not implemented; approval is required/);
});

test('malformed usage and plugin metadata retain positive cost but fail closed', () => {
  const good = { type: 'result', subtype: 'success', is_error: false, result: '[]', total_cost_usd: 0.25 };
  const valid = { inputTokens: 1, outputTokens: 1, costUSD: 0.1 };
  for (const modelUsage of [null, 3, 'wrong', [], [valid], { bad: null }, { bad: 'x' }, { good: valid, bad: [] }]) {
    const parsed = parseResult(JSON.stringify({ ...good, modelUsage }), 0);
    assert.equal(parsed.cost, 0.25);
    assert.equal(parsed.priced, false);
    assert.equal(parsed.ok, false);
  }
  for (const plugins of [null, {}, [null], ['router'], [{ name: 'router', path: '/valid' }, null]]) {
    const init = JSON.stringify({ type: 'system', subtype: 'init', plugins });
    const parsed = parseResult(`${init}\n${JSON.stringify({ ...good, modelUsage: { model: valid } })}`, 0);
    assert.deepEqual(parsed.plugins, []);
    assert.equal(parsed.cost, 0.25);
  }
});

test('malformed usage retains partial cost in attempt report and stops further launches', async () => {
  const root = await mkdtemp(join(tmpdir(), 'routing-malformed-test-'));
  try {
    const stdout = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: '[1,2,3]',
      total_cost_usd: 0.25,
      modelUsage: { bad: null },
    });
    const actual = await executeCases(casesFor(manifest.tasks, { smoke: true }), {
      root,
      budgetUsd: 1.2,
      reservationUsd: 0.4,
      timeoutMs: 1000,
      launcher: async () => ({ stdout, exitCode: 0, wallMs: 1 }),
    });
    assert.equal(actual.rows.length, 1);
    assert.equal(actual.rows[0].passed, null);
    assert.equal(actual.report.knownCostUsd, 0.25);
    assert.equal(actual.report.reportedTotalCostUsd, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
