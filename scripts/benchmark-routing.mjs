// Step 6: paired planning/reporting and installed-release table-only harness smoke.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { loadConfig, ROUTING_MODES } from '../lib/config.mjs';
import { ratesAt } from '../lib/cost.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const MANIFEST = resolve(ROOT, 'test/fixtures/benchmark-routing.json');
const MODES = ROUTING_MODES;
const ENGINES = ['table', 'auto'];
const MAX_OUTPUT_BYTES = 1024 * 1024;

export const hash = (data) => createHash('sha256').update(data).digest('hex');

export function validateManifest(manifest) {
  if (
    manifest?.version !== 1 ||
    !Array.isArray(manifest.tasks) ||
    manifest.tasks.length < 20 ||
    manifest.tasks.length > 30
  )
    throw new Error('Manifest must contain 20–30 proposed tasks.');
  const ids = new Set();
  for (const task of manifest.tasks) {
    if (
      !/^[a-z0-9-]+$/.test(task.id) ||
      ids.has(task.id) ||
      !['development', 'heldout'].includes(task.split) ||
      typeof task.prompt !== 'string' ||
      !task.prompt ||
      task.check?.kind !== 'json-equal' ||
      !Object.hasOwn(task.check, 'expected') ||
      typeof task.smoke !== 'boolean' ||
      (task.smoke && task.split !== 'development')
    )
      throw new Error('Invalid task or split.');
    ids.add(task.id);
  }
  if (!manifest.tasks.some((t) => t.split === 'heldout') || manifest.tasks.filter((t) => t.smoke).length !== 3)
    throw new Error('Require heldout tasks and exactly three development smoke tasks.');
  return manifest;
}

export function casesFor(tasks, { smoke = false } = {}) {
  if (smoke)
    return tasks.filter((task) => task.smoke).map((task) => ({ task, engine: 'table', mode: 'balanced', repeat: 1 }));
  return tasks.flatMap((task) =>
    ENGINES.flatMap((engine) => MODES.flatMap((mode) => [1, 2].map((repeat) => ({ task, engine, mode, repeat })))),
  );
}

// This is a reservation estimate, not a bill or a guaranteed ceiling.
export function estimate(count, { inputTokens, outputTokens, inputRate, outputRate, inputMultiplier = 1 }) {
  const values = [count, inputTokens, outputTokens, inputRate, outputRate, inputMultiplier];
  if (values.some((n) => !Number.isFinite(n) || n <= 0) || !Number.isInteger(count))
    throw new Error('Positive count, token assumptions and configured rates are required.');
  return (count * (inputTokens * inputRate * inputMultiplier + outputTokens * outputRate)) / 1e6;
}

export function checkAnswer(task, text) {
  try {
    return isDeepStrictEqual(JSON.parse(text), task.check.expected);
  } catch {
    return false;
  }
}

// This consumes CLI JSON only, not guessed model IDs or router configuration.
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function validPlugins(value) {
  return (
    Array.isArray(value) && value.every((p) => isRecord(p) && typeof p.name === 'string' && typeof p.path === 'string')
  );
}

export function parseResult(stdout, exitCode) {
  const records = stdout.split('\n').flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
  const results = records.filter((row) => row?.type === 'result');
  if (results.length !== 1) return { ok: false, error: 'invalid-json-result', cost: null };
  const data = results[0];
  const usageShapeValid = isRecord(data.modelUsage) && Object.values(data.modelUsage).every(isRecord);
  const usage = Object.entries(usageShapeValid ? data.modelUsage : {}).map(([model, usage]) => ({
    model,
    inputTokens: usage?.inputTokens,
    outputTokens: usage?.outputTokens,
    cacheReadInputTokens: usage?.cacheReadInputTokens,
    cacheCreationInputTokens: usage?.cacheCreationInputTokens,
    costUSD: usage?.costUSD,
  }));
  const priced =
    usageShapeValid &&
    usage.length > 0 &&
    usage.every(
      (u) =>
        Number.isFinite(u.costUSD) &&
        u.costUSD > 0 &&
        Number.isFinite(u.inputTokens) &&
        u.inputTokens >= 0 &&
        Number.isFinite(u.outputTokens) &&
        u.outputTokens >= 0,
    );
  const cost = Number.isFinite(data.total_cost_usd) && data.total_cost_usd > 0 ? data.total_cost_usd : null;
  const ok =
    exitCode === 0 &&
    data.subtype === 'success' &&
    data.is_error === false &&
    typeof data.result === 'string' &&
    cost !== null &&
    priced;
  const plugins = records.find((r) => r?.type === 'system' && r.subtype === 'init')?.plugins;
  return {
    ok,
    cost,
    priced,
    answer: typeof data.result === 'string' ? data.result : null,
    modelUsage: usage,
    plugins: validPlugins(plugins) ? plugins.map((p) => ({ name: p.name, path: p.path })) : [],
    error: ok ? null : 'failed-or-unpriced-result',
  };
}

export function report(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = JSON.stringify([row.taskId, row.split, row.mode, row.repeat]);
    const group = groups.get(key) ?? {};
    group[row.engine] ??= [];
    group[row.engine].push(row);
    groups.set(key, group);
  }
  const discordances = [];
  let incompletePairs = 0;
  let ambiguousPairs = 0;
  for (const [key, group] of groups) {
    if (group.table?.length > 1 || group.auto?.length > 1) ambiguousPairs++;
    const table = group.table?.length === 1 ? group.table[0] : null;
    const auto = group.auto?.length === 1 ? group.auto[0] : null;
    if (typeof table?.passed !== 'boolean' || typeof auto?.passed !== 'boolean') {
      incompletePairs++;
      continue;
    }
    if (table.passed !== auto.passed) {
      const [taskId, split, mode, repeat] = JSON.parse(key);
      discordances.push({ taskId, split, mode, repeat, table: table.passed, auto: auto.passed });
    }
  }
  const regressions = [];
  for (const item of discordances) {
    if (item.repeat !== 1 || !item.table || item.auto) continue;
    if (
      discordances.some(
        (other) =>
          other.taskId === item.taskId &&
          other.split === item.split &&
          other.mode === item.mode &&
          other.repeat === 2 &&
          other.table &&
          !other.auto,
      )
    )
      regressions.push({ taskId: item.taskId, split: item.split, mode: item.mode });
  }
  const costByModeEngine = {};
  for (const row of rows) {
    const key = `${row.mode}/${row.engine}`;
    const current = costByModeEngine[key] ?? { knownCostUsd: 0, unpricedRuns: 0 };
    current.knownCostUsd += row.cost ?? 0;
    if (row.cost == null || row.priced === false) current.unpricedRuns++;
    costByModeEngine[key] = current;
  }
  const knownCost = rows.reduce((sum, row) => sum + (row.cost ?? 0), 0);
  const unpriced = rows.filter((row) => row.cost === null || row.cost === undefined || row.priced === false).length;
  return {
    runs: rows.length,
    discordances,
    bothRepeatRegressions: regressions,
    costByModeEngine,
    incompletePairs,
    ambiguousPairs,
    knownCostUsd: knownCost,
    reportedTotalCostUsd: unpriced ? null : knownCost,
    unpricedRuns: unpriced,
    runWallMs: rows.reduce((sum, row) => sum + row.wallMs, 0),
  };
}

// Child group termination is best-effort; Windows cannot kill a descendant tree through Node alone.
export function runProcess(command, args, { cwd, timeoutMs, env = process.env, inspectLine = () => null } = {}) {
  return new Promise((resolveResult) => {
    const start = Date.now();
    let stdout = '';
    let stderr = '';
    let reason = null;
    let pendingLine = '';
    const child = spawn(command, args, {
      cwd,
      env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stop = (why) => {
      if (reason) return;
      reason = why;
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {}
    };
    const interrupt = () => stop('interrupted');
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', interrupt);
    const timer = setTimeout(() => stop('deadline'), timeoutMs);
    const collect = (stream, chunk) => {
      if (reason) return;
      if (stream === 'stdout') {
        stdout += chunk;
        pendingLine += chunk;
        const lines = pendingLine.split('\n');
        pendingLine = lines.pop();
        for (const line of lines) {
          try {
            const problem = inspectLine(line);
            if (problem) stop(problem);
          } catch {
            stop('inspection-error');
          }
        }
      } else stderr += chunk;
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > MAX_OUTPUT_BYTES) stop('output-limit');
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => collect('stdout', chunk));
    child.stderr.on('data', (chunk) => collect('stderr', chunk));
    child.on('error', () => {
      reason ??= 'spawn-error';
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', interrupt);
      resolveResult({ exitCode: code, stdout, reason, wallMs: Date.now() - start });
    });
  });
}

// Shared accounting/checks for offline system-boundary fixtures and the installed table-only smoke.
export async function executeCases(cases, { launcher, root, budgetUsd, reservationUsd, timeoutMs, maxFailures = 1 }) {
  const startedAt = Date.now();
  if (
    !Number.isFinite(budgetUsd) ||
    budgetUsd <= 0 ||
    !Number.isFinite(reservationUsd) ||
    reservationUsd <= 0 ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    !Number.isInteger(maxFailures) ||
    maxFailures <= 0
  )
    throw new Error('Positive budget, reservation, deadline and failure budget required.');
  if (cases.length * reservationUsd - budgetUsd > 1e-9) throw new Error('Insufficient budget for reservations.');
  await mkdir(root, { recursive: true });
  const trustedFiles = [fileURLToPath(import.meta.url), MANIFEST];
  const trustedHashes = await Promise.all(trustedFiles.map(async (path) => hash(await readFile(path))));
  const rows = [];
  let accounted = 0;
  let failures = 0;
  for (const item of cases) {
    if (accounted + reservationUsd - budgetUsd > 1e-9) break;
    const cwd = await mkdtemp(join(root, 'case-'));
    await mkdir(join(cwd, '.claude'));
    await writeFile(join(cwd, '.claude', 'router.json'), JSON.stringify({ mode: item.mode }));
    const started = Date.now();
    let outcome;
    try {
      outcome = await launcher(item, cwd, timeoutMs);
    } catch {
      outcome = { exitCode: null, stdout: '', reason: 'launch-error', wallMs: Date.now() - started };
    }
    const currentHashes = await Promise.all(
      trustedFiles.map(async (path) =>
        readFile(path)
          .then(hash)
          .catch(() => null),
      ),
    );
    if (currentHashes.some((value, index) => value !== trustedHashes[index])) outcome.reason = 'check-integrity';
    const parsed = parseResult(outcome.stdout, outcome.exitCode);
    const cost = parsed.cost;
    if (cost > reservationUsd) outcome.reason ??= 'run-budget-exceeded';
    const passed = parsed.ok && !outcome.reason ? checkAnswer(item.task, parsed.answer) : null;
    accounted += cost ?? reservationUsd;
    const row = {
      taskId: item.task.id,
      split: item.task.split,
      engine: item.engine,
      mode: item.mode,
      repeat: item.repeat,
      passed,
      cost,
      wallMs: outcome.wallMs,
      error: outcome.reason ?? parsed.error,
      modelUsage: parsed.modelUsage,
      priced: parsed.priced ?? false,
      plugins: parsed.plugins,
    };
    rows.push(row);
    if (passed !== true) failures++;
    // A missing/zero cost or process failure makes further spend unknowable.
    if (cost === null || !parsed.priced || outcome.reason || failures >= maxFailures || accounted - budgetUsd > 1e-9)
      break;
  }
  return {
    evidence: 'System-boundary fixture unless explicitly launched through installed table smoke adapter',
    rows,
    accountedUsd: accounted,
    wallMs: Date.now() - startedAt,
    report: report(rows),
  };
}

export async function restoreActiveEnv(path, operation) {
  const original = await readFile(path).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  const restore = async () => {
    if (original === null)
      await unlink(path).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
    else await writeFile(path, original);
    const restored = await readFile(path).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!isDeepStrictEqual(restored, original)) throw new Error('Active environment restoration failed.');
  };
  try {
    return await operation();
  } finally {
    await restore();
  }
}

export function smokeArgs(prompt) {
  return [
    '-p',
    prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--max-budget-usd',
    '0.40',
    '--max-turns',
    '1',
    '--tools',
    '',
    '--strict-mcp-config',
    '--mcp-config',
    '{"mcpServers":{}}',
    '--no-session-persistence',
    '--setting-sources',
    'user',
    '--system-prompt',
    'Return only the requested JSON. No tools.',
  ];
}

export async function preflight(profile = join(homedir(), '.claude-team')) {
  const configPath = join(profile, 'model-proxy-router.json');
  const configBytes = await readFile(configPath);
  const file = JSON.parse(configBytes);
  if ((file.routingEngine ?? 'table') !== 'table') throw new Error('Installed smoke requires unchanged table config.');
  const config = loadConfig({ userFile: file, provider: 'model-proxy' });
  const index = JSON.parse(await readFile(join(profile, 'plugins/installed_plugins.json')));
  const plugin = index.plugins?.['router@alexei-led-claude-router']?.find((p) => p.scope === 'user');
  if (!plugin?.installPath) throw new Error('Installed user router not found.');
  const rates = Object.values(config.models).map((model) => ratesAt(model, 10000));
  const assumptions = {
    inputTokens: 10000,
    outputTokens: 512,
    inputRate: Math.max(...rates.map((r) => r.input)),
    outputRate: Math.max(...rates.map((r) => r.output)),
    inputMultiplier: config.cache.mode === 'explicit' ? Math.max(...Object.values(config.cache.writeMultiplier)) : 1,
  };
  return {
    configPath,
    configSha256: hash(configBytes),
    pluginPath: plugin.installPath,
    pluginVersion: plugin.version,
    assumptions,
    pricingSource: 'Read-only selected model-proxy catalog maximum rates, ratesAt at peak; not proxy billing',
    perRunCliBudgetUsd: 0.4,
    aggregateReservationUsd: 1.2,
    timeoutMs: 90000,
    estimateUsd: estimate(3, assumptions),
    configEngine: 'table',
  };
}

function routerPlugins(plugins) {
  return plugins.filter((p) => typeof p?.name === 'string' && /^router(?:@|$)/.test(p.name));
}

export async function verifyProfile(outcome, { configPath, configSha256 }) {
  try {
    if (hash(await readFile(configPath)) !== configSha256) outcome.reason = 'profile-changed';
  } catch {
    outcome.reason = 'profile-unreadable';
  }
  return outcome;
}

export async function smokeLaunch(item, cwd, timeoutMs, safety) {
  if (
    item.engine !== 'table' ||
    item.mode !== 'balanced' ||
    item.repeat !== 1 ||
    !item.task.smoke ||
    item.task.split !== 'development'
  )
    throw new Error('Only installed table/balanced development smoke is permitted.');
  if (hash(await readFile(safety.configPath)) !== safety.configSha256)
    throw new Error('Profile changed before launch.');
  const outcome = await runProcess(
    'zsh',
    ['-ic', 'claude-mp-work "$@"', 'benchmark-routing', ...smokeArgs(item.task.prompt)],
    {
      cwd,
      timeoutMs,
      env: { ...process.env, CLAUDE_CODE_MAX_OUTPUT_TOKENS: '512' },
      inspectLine: (line) => {
        let record;
        try {
          record = JSON.parse(line);
        } catch {
          return null;
        }
        if (record?.type !== 'system' || record.subtype !== 'init') return null;
        const plugins = routerPlugins(record.plugins ?? []);
        return plugins.length === 1 && plugins[0].path === safety.pluginPath ? null : 'router-plugin-provenance';
      },
    },
  );
  const plugins = routerPlugins(parseResult(outcome.stdout, outcome.exitCode).plugins ?? []);
  if (plugins.length !== 1 || plugins[0].path !== safety.pluginPath) outcome.reason ??= 'router-plugin-provenance';
  return verifyProfile(outcome, safety);
}

export async function cli(args = process.argv.slice(2)) {
  const bytes = await readFile(MANIFEST);
  const manifest = validateManifest(JSON.parse(bytes));
  const allowed = ['--dry-run', '--smoke', '--live'];
  if (args.some((arg) => !allowed.includes(arg)) || (args.includes('--dry-run') && args.includes('--live')))
    throw new Error('Usage: node scripts/benchmark-routing.mjs [--dry-run] [--smoke] | --live --smoke');
  const smoke = args.includes('--smoke');
  const live = args.includes('--live');
  if (live && !smoke)
    throw new Error('Full live matrix disabled: auto is unavailable; checkout/profile isolation is not implemented.');
  const cases = casesFor(manifest.tasks, { smoke });
  // Built-in catalog is a portable dry-run scenario only. Smoke preflight reads selected profile rates.
  const config = loadConfig({});
  const rates = Object.values(config.models).map((m) => ratesAt(m, 10000));
  const assumptions = {
    inputTokens: 10000,
    outputTokens: 512,
    inputRate: Math.max(...rates.map((r) => r.input)),
    outputRate: Math.max(...rates.map((r) => r.output)),
    inputMultiplier: Math.max(...Object.values(config.cache.writeMultiplier)),
  };
  const safety = live ? await preflight() : null;
  const plan = {
    manifestSha256: hash(bytes),
    status: manifest.status,
    taskCount: smoke ? 3 : manifest.tasks.length,
    developmentTasks: manifest.tasks.filter((task) => task.split === 'development').length,
    heldoutTasks: manifest.tasks.filter((task) => task.split === 'heldout').length,
    runs: cases.length,
    modes: smoke ? ['balanced'] : MODES,
    engines: smoke ? ['table'] : ENGINES,
    repeats: smoke ? 1 : 2,
    assumptions: safety?.assumptions ?? assumptions,
    estimateUsd: safety?.estimateUsd ?? estimate(cases.length, assumptions),
    pricingSource: safety?.pricingSource ?? 'Built-in catalog maximum rates at peak; configured-price scenario only',
    limitation: 'Input tokens assumed, output capped at 512 for smoke; proxy bill unknown. Auto live unavailable.',
    ...(safety
      ? {
          installedRouterVersion: safety.pluginVersion,
          configSha256: safety.configSha256,
          perRunCliBudgetUsd: safety.perRunCliBudgetUsd,
          aggregateReservationUsd: safety.aggregateReservationUsd,
          command: ['zsh', '-ic', 'claude-mp-work "$@"', 'benchmark-routing', ...smokeArgs('<task prompt>')],
        }
      : {}),
  };
  console.log(JSON.stringify(plan, null, 2));
  if (!live) return;
  await mkdir(join(ROOT, '.pi'), { recursive: true });
  const ledger = join(ROOT, '.pi', 'benchmark-smoke-reservation.json');
  await writeFile(
    ledger,
    JSON.stringify({
      reservedUsd: 1.2,
      reason: 'One approved three-task smoke; reruns require review',
      manifestSha256: hash(bytes),
    }),
    { flag: 'wx' },
  );
  const root = await mkdtemp(join(ROOT, '.pi', 'benchmark-smoke-'));
  const result = await restoreActiveEnv(join(homedir(), '.claude/active-env.json'), () =>
    executeCases(cases, {
      root,
      budgetUsd: safety.aggregateReservationUsd,
      reservationUsd: safety.perRunCliBudgetUsd,
      timeoutMs: safety.timeoutMs,
      launcher: (item, cwd, timeoutMs) => smokeLaunch(item, cwd, timeoutMs, safety),
    }),
  );
  const artifact = {
    ...plan,
    ...result,
    evidence: 'installed-release table-only harness validation, not paired engine evaluation',
  };
  const output = join(root, 'report.json');
  await writeFile(output, `${JSON.stringify(artifact, null, 2)}\n`);
  await writeFile(
    ledger,
    JSON.stringify({
      reservedUsd: 1.2,
      output,
      accountedUsd: result.accountedUsd,
      reportedTotalCostUsd: result.report.reportedTotalCostUsd,
    }),
  );
  console.log(JSON.stringify({ output, ...result.report, activeEnvRestored: true }, null, 2));
  if (result.rows.length !== 3 || result.rows.some((row) => row.passed !== true)) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
