// Local evidence probe: runs the tasks in a manifest against chosen model/effort pairs and aggregates pass rates into
// the same capability scale as the Artificial Analysis overlay.
//   npm run evidence:probe -- --plan
//   npm run evidence:probe -- --run --model glm=zai-org/GLM-5.3@max --profile ~/.claude-team --budget-usd 1
//   npm run evidence:probe -- --aggregate ~/.config/claude-router/evidence.probe.raw.json
// --plan is the default and spends nothing. --run needs an explicit --model and stays inside --budget-usd; it stops
// after three consecutive launch errors. Results land in ~/.config/claude-router/ (mode 600) and are merged into
// evidence.local.mjs by the next `npm run evidence:aa`.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { aggregateProbe, gradeAnswer, validateProbeManifest } from '../lib/evidence-probe.mjs';
import { runProcess } from './benchmark-routing.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(homedir(), '.config', 'claude-router');
const RAW_FILE = join(OUT_DIR, 'evidence.probe.raw.json');
const AGG_FILE = join(OUT_DIR, 'evidence.probe.json');
const SYSTEM_PROMPT = 'Answer the task exactly as asked. No tools. Return only the requested output.';

function usage() {
  console.log(`Usage: npm run evidence:probe -- [--plan | --run | --aggregate <file>] [options]

  --plan                 list the cases and the estimated cost (default)
  --run                  execute the cases through the Claude Code CLI
  --aggregate <file>     aggregate an existing raw results file
  --manifest <file>      task manifest (default data/probes/manifest.json)
  --model canonical=id@effort   a pair to run; repeat for more pairs
  --profile <dir>        CLAUDE_CONFIG_DIR for the CLI (for example ~/.claude-team)
  --wrapper <name>       run the CLI through a zsh function such as claude-work
  --no-router            disable the router plugin so --model and --effort reach the API unchanged
  --repeats <n>          attempts per task (default 3, the aggregate's minimum)
  --concurrency <n>      parallel CLI runs, 1..16 (default 1)
  --case-budget-usd <n>  per-case CLI budget cap (default 0.25)
  --fresh                discard the accumulated raw results before this run
  --budget-usd <n>       stop before the estimated spend exceeds this (default 1)
  --max-cases <n>        stop after this many cases
  --timeout-ms <n>       per-case deadline (default 180000)
  --include-examples     allow tasks marked example: true

Examples:
  npm run evidence:probe -- --plan --model glm=zai-org/GLM-5.3@max
  npm run evidence:probe -- --run --model glm=zai-org/GLM-5.3@max --profile ~/.claude-team`);
}

function fail(message) {
  console.error(message);
  process.exit(2);
}

function parseArgs(argv) {
  const options = {
    mode: 'plan',
    manifest: join(ROOT, 'data/probes/manifest.json'),
    models: [],
    repeats: 3,
    budgetUsd: 1,
    maxCases: Number.POSITIVE_INFINITY,
    timeoutMs: 180_000,
    caseBudgetUsd: 0.25,
    examples: false,
    aggregate: null,
    wrapper: null,
    fresh: false,
    noRouter: false,
    concurrency: 1,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined) fail(`${arg} needs a value`);
      i += 1;
      return next;
    };
    if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    } else if (arg === '--plan') options.mode = 'plan';
    else if (arg === '--run') options.mode = 'run';
    else if (arg === '--aggregate') {
      options.mode = 'aggregate';
      options.aggregate = value();
    } else if (arg === '--manifest') options.manifest = value();
    else if (arg === '--model') options.models.push(value());
    else if (arg === '--profile') options.profile = value();
    else if (arg === '--repeats') options.repeats = Number(value());
    else if (arg === '--budget-usd') options.budgetUsd = Number(value());
    else if (arg === '--max-cases') options.maxCases = Number(value());
    else if (arg === '--timeout-ms') options.timeoutMs = Number(value());
    else if (arg === '--include-examples') options.examples = true;
    else if (arg === '--wrapper') options.wrapper = value();
    else if (arg === '--fresh') options.fresh = true;
    else if (arg === '--no-router') options.noRouter = true;
    else if (arg === '--concurrency') options.concurrency = Number(value());
    else if (arg === '--case-budget-usd') options.caseBudgetUsd = Number(value());
    else fail(`unknown argument ${arg} (try --help)`);
  }
  if (!Number.isInteger(options.repeats) || options.repeats < 1) fail('--repeats must be a positive integer');
  if (!Number.isFinite(options.budgetUsd) || options.budgetUsd <= 0) fail('--budget-usd must be positive');
  if (!(options.maxCases >= 1)) fail('--max-cases must be positive');
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0) fail('--timeout-ms must be positive');
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 16)
    fail('--concurrency must be an integer from 1 to 16');
  if (!Number.isFinite(options.caseBudgetUsd) || options.caseBudgetUsd <= 0) fail('--case-budget-usd must be positive');
  if (options.wrapper !== null && !/^[a-z0-9-]+$/.test(options.wrapper))
    fail('--wrapper must be a shell function name of lowercase letters, digits and dashes');
  return options;
}

// `canonical=providerModelId@effort`, or `canonical=@effort` to let the profile's routes choose the model: the CLI
// then runs without --model and the served model is read from the result.
function parseModel(spec) {
  const eq = spec.indexOf('=');
  if (eq <= 0) fail(`--model must look like canonical=providerModelId@effort, got ${spec}`);
  const canonical = spec.slice(0, eq);
  const rest = spec.slice(eq + 1);
  const at = rest.lastIndexOf('@');
  const modelId = at >= 0 ? rest.slice(0, at) : rest;
  const effort = at >= 0 ? rest.slice(at + 1) : null;
  if (effort !== null && !/^[a-z]+$/.test(effort)) fail(`--model effort must be a level name, got ${effort}`);
  if (at < 0 && modelId === '') fail(`--model needs a model id or @effort, got ${spec}`);
  return { canonical, modelId, effort };
}

function loadManifest(options) {
  const manifest = validateProbeManifest(JSON.parse(readFileSync(options.manifest, 'utf8')));
  if (!options.examples && manifest.tasks.some((task) => task.example === true))
    fail('the manifest holds example tasks; write real tasks or pass --include-examples');
  return manifest;
}

function casesFor(manifest, models, repeats) {
  const cases = [];
  for (const model of models)
    for (const task of manifest.tasks)
      for (let repeat = 1; repeat <= repeats; repeat += 1) cases.push({ model, task, repeat });
  return cases;
}

function plan(cases) {
  for (const item of cases)
    console.log(
      `${item.model.canonical}@${item.model.effort ?? 'default'} ${item.task.activity}/${item.task.tier} ${item.task.id} #${item.repeat} ~$${item.task.estimateUsd.toFixed(4)}`,
    );
  const estimateUsd = cases.reduce((sum, item) => sum + item.task.estimateUsd, 0);
  console.log(`cases: ${cases.length}, estimated maximum: $${estimateUsd.toFixed(4)} (a ceiling, not a bill)`);
}

function answerOf(stdout) {
  let answer = null;
  let costUsd = null;
  let servedModel = null;
  for (const line of stdout.split('\n')) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record?.type === 'result') {
      // An errored result can carry text (a quota or budget message); only a successful result is an answer.
      if (record.subtype === 'success' && record.is_error === false && typeof record.result === 'string')
        answer = record.result;
      if (Number.isFinite(record.total_cost_usd)) costUsd = record.total_cost_usd;
      for (const [key, usage] of Object.entries(record.modelUsage ?? {})) {
        if (typeof usage?.canonicalModel === 'string') servedModel = usage.canonicalModel;
        else if (servedModel === null) servedModel = key;
      }
    }
  }
  return { answer, costUsd, servedModel };
}

async function runCase(item, options) {
  const args = [
    '-p',
    item.task.prompt,
    '--output-format',
    'stream-json',
    '--verbose',
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
    SYSTEM_PROMPT,
    '--max-budget-usd',
    String(options.caseBudgetUsd),
  ];
  if (options.noRouter) args.push('--settings', '{"enabledPlugins":{"router@alexei-led-claude-router":false}}');
  if (item.model.modelId) args.push('--model', item.model.modelId);
  if (item.model.effort) args.push('--effort', item.model.effort);
  const cwd = mkdtempSync(join(tmpdir(), 'evidence-probe-'));
  const env = { ...process.env, CLAUDE_CODE_MAX_OUTPUT_TOKENS: '2048' };
  if (options.profile) env.CLAUDE_CONFIG_DIR = options.profile;
  const [command, argv] = options.wrapper
    ? ['zsh', ['-ic', `${options.wrapper} "$@"`, 'evidence-probe', ...args]]
    : [options.command ?? 'claude', args];
  const outcome = await runProcess(command, argv, { cwd, timeoutMs: options.timeoutMs, env });
  const { answer: resultText, costUsd, servedModel } = answerOf(outcome.stdout);
  const served = typeof servedModel === 'string' ? servedModel.replace(/\[1m\]$/, '') : null;
  // A failed launch or a nonzero exit measured nothing about the model: the row is an error, never a failed attempt.
  const answer = outcome.reason === null && outcome.exitCode === 0 ? resultText : null;
  const passed = answer === null ? null : gradeAnswer(item.task, answer);
  return {
    taskId: item.task.id,
    activity: item.task.activity,
    tier: item.task.tier,
    model: served ?? item.model.canonical,
    requestedModel: item.model.modelId || null,
    effort: item.model.effort ?? 'default',
    repeat: item.repeat,
    passed,
    error: outcome.reason ?? (answer === null ? 'no-answer' : null),
    costUsd,
    wallMs: outcome.wallMs,
    answer: answer === null ? null : answer.slice(0, 300),
  };
}

async function run(options) {
  if (!options.models.length) fail('--run needs at least one --model canonical=providerModelId@effort');
  const manifest = loadManifest(options);
  const models = options.models.map(parseModel);
  const cases = casesFor(manifest, models, options.repeats).slice(0, options.maxCases);
  const rows = [];
  let committed = 0;
  let stopped = false;
  let next = 0;
  const worker = async () => {
    let consecutiveErrors = 0;
    while (!stopped) {
      const index = next;
      next += 1;
      if (index >= cases.length) return;
      const item = cases[index];
      // Reserve the case's ceiling synchronously, before any await: with --concurrency, every worker must see it.
      if (committed + item.task.estimateUsd > options.budgetUsd) {
        stopped = true;
        console.log(`stopped before ${item.task.id}: estimated spend would exceed $${options.budgetUsd}`);
        return;
      }
      committed += item.task.estimateUsd;
      const row = await runCase(item, options);
      rows.push(row);
      const actual = Number.isFinite(row.costUsd) ? row.costUsd : item.task.estimateUsd;
      committed += actual - item.task.estimateUsd;
      consecutiveErrors = row.error === null ? 0 : consecutiveErrors + 1;
      console.log(
        `${row.model}@${row.effort} ${row.activity}/${row.tier} ${row.taskId} #${row.repeat}: ${row.passed === null ? `error ${row.error}` : row.passed ? 'pass' : 'fail'} $${(row.costUsd ?? 0).toFixed(4)}`,
      );
      if (consecutiveErrors >= 3) {
        stopped = true;
        console.log('stopped after three consecutive launch errors');
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(options.concurrency, cases.length) }, worker));
  writeResults(rows, { fresh: options.fresh });
  return rows;
}

function aliasesOf(rows) {
  /** @type {Record<string, string[]>} */
  const aliases = {};
  for (const row of rows) aliases[row.model] = [...new Set([...(aliases[row.model] ?? []), row.model])];
  return aliases;
}

function writeResults(rows, { fresh = false } = {}) {
  const checked = new Date().toISOString().slice(0, 10);
  let all = rows;
  if (!fresh) {
    try {
      const previous = JSON.parse(readFileSync(RAW_FILE, 'utf8'));
      if (Array.isArray(previous.rows)) all = [...previous.rows, ...rows];
    } catch {}
  }
  const entries = aggregateProbe(all, { checked, aliases: aliasesOf(all) });
  mkdirSync(OUT_DIR, { recursive: true });
  for (const [file, body] of [
    [RAW_FILE, { checked, rows: all }],
    [AGG_FILE, { checked, source: 'local probe', entries }],
  ]) {
    writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
  }
  const attempts = all.filter((row) => row.passed !== null).length;
  console.log(`probe: ${attempts}/${all.length} graded attempts accumulated → ${AGG_FILE}`);
}

const options = parseArgs(process.argv.slice(2));
if (options.mode === 'plan') {
  const manifest = loadManifest(options);
  const models = options.models.length
    ? options.models.map(parseModel)
    : [{ canonical: 'model', modelId: '<id>', effort: null }];
  plan(casesFor(manifest, models, options.repeats).slice(0, options.maxCases));
} else if (options.mode === 'aggregate') {
  const raw = JSON.parse(readFileSync(options.aggregate, 'utf8'));
  if (!Array.isArray(raw.rows)) fail('the results file must hold a rows array');
  writeResults(raw.rows, { fresh: true });
} else {
  await run(options);
}
