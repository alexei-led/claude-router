// Sends the routing-mode probe set (test/fixtures/mode-probe.json) to one classifier as the router would ask it, then
// routes each answer in every mode, as a session's first turn, on the built-in routes and the profiles of
// scripts/mode-matrix.mjs. Writes experiments/mod-router/results/mode-probe-<classifier>.json: the answered tier and
// activity against the expected ones (classification), the route per mode and profile, checks of the mode rules on
// each live answer (routing), and per mode the model and effort mix and a nominal list price per turn.
// Reads keys as probe-classifier.mjs does. Never prints a key or the full URL. Billed; run by hand, not in CI.
// Usage: node scripts/probe-modes.mjs [classifier-id]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildActivityRequest, buildRequest, parseActivityAnswer, parseAnswers } from '../lib/classifier-apis.mjs';
import { resolveCredentials } from '../lib/classifier-contract.mjs';
import { EFFORTS, loadConfig, ROUTING_MODES } from '../lib/config.mjs';
import { ratesAt } from '../lib/cost.mjs';
import { applyMode } from '../lib/modes.mjs';
import { decide, PROFILES } from './mode-matrix.mjs';

// A nominal turn for comparing list prices: uncached input and output at these sizes. Effort changes how much a
// model writes, which this does not model; the mix shows the effort.
const NOMINAL = { input: 50_000, output: 2_000 };

if (existsSync('.env')) process.loadEnvFile('.env');
const base = loadConfig();
const id = process.argv[2] ?? base.classifier;
if (!Object.hasOwn(base.classifiers, id)) {
  console.error(`unknown classifier ${id}; configured: ${Object.keys(base.classifiers).join(', ')}`);
  process.exit(2);
}
const config = { ...base, classifier: id, activityRouting: 'on' };
const entry = config.classifiers[id];
const credentials = await resolveCredentials(entry, (name) => process.env[name.toUpperCase()]?.trim());
if (credentials.missing) {
  console.error(`${id}: ${credentials.missing}`);
  process.exit(2);
}

async function post(body) {
  const response = await fetch(credentials.endpoint, {
    method: 'POST',
    headers: {
      ...(credentials.apiKey ? { authorization: `Bearer ${credentials.apiKey}` } : {}),
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(entry.timeoutMs * 4),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return JSON.parse(await response.text());
}

async function ask(text) {
  const advice = parseAnswers(config, await post(buildRequest(config, text, [])));
  const step = buildActivityRequest(config, text, []);
  return step ? { ...advice, activity: parseActivityAnswer(config, await post(step)) } : advice;
}

const pair = (d) => `${d.route.model}@${d.route.effort}`;
const nominalUsd = (cfg, d) => {
  const rates = ratesAt(cfg.models[d.route.model], NOMINAL.input);
  return (rates.input * NOMINAL.input + rates.output * NOMINAL.output) / 1e6;
};
// -1 cheaper, 0 same, 1 dearer: input price, then effort on one model.
const order = (cfg, a, b) => {
  const [pa, pb] = [cfg.models[a.route.model].input, cfg.models[b.route.model].input];
  if (pa !== pb) return Math.sign(pa - pb);
  if (a.route.model !== b.route.model) return 0;
  return Math.sign(EFFORTS.indexOf(a.route.effort) - EFFORTS.indexOf(b.route.effort));
};

const { probes } = JSON.parse(readFileSync(new URL('../test/fixtures/mode-probe.json', import.meta.url), 'utf8'));
const rows = [];
const errors = {};
for (const [index, probe] of probes.entries()) {
  process.stdout.write(`\r${index + 1}/${probes.length}`);
  let advice;
  try {
    advice = await ask(probe.text);
  } catch (error) {
    errors[error.message] = (errors[error.message] ?? 0) + 1;
    continue;
  }
  const activity = advice.activity ?? null;
  const row = {
    text: probe.text,
    expected: { tier: probe.tier, activity: probe.activity },
    answered: {
      tier: advice.choice,
      tierProbability: advice.probabilities[advice.choice] ?? null,
      activity: activity?.choice ?? null,
      activityProbability: activity ? (activity.probabilities?.[activity.choice] ?? null) : null,
    },
    routes: {},
    violations: [],
    // A mode's policy fields (lower or higher bars) can take a borderline answer another tier than balanced does.
    tierMovedByPolicy: [],
  };
  for (const [profile, { file }] of Object.entries(PROFILES)) {
    const configured = { ...loadConfig({ userFile: file }), classifier: id };
    const byMode = Object.fromEntries(
      ROUTING_MODES.map((mode) => {
        const cfg = applyMode(configured, { mode, source: 'profile' });
        return [mode, { cfg, d: decide(cfg, advice, { configured }) }];
      }),
    );
    row.routes[profile] = Object.fromEntries(
      ROUTING_MODES.map((mode) => [
        mode,
        { tier: byMode[mode].d.tier, route: pair(byMode[mode].d), nominalUsd: nominalUsd(configured, byMode[mode].d) },
      ]),
    );
    const { cost, balanced, quality } = byMode;
    const fail = (rule) => row.violations.push(`${profile}: ${rule}`);
    if (order(configured, cost.d, balanced.d) > 0) fail('cost dearer than balanced');
    if (order(configured, quality.d, balanced.d) < 0) fail('quality cheaper than balanced');
    for (const mode of ROUTING_MODES)
      if (byMode[mode].d.tier !== balanced.d.tier)
        row.tierMovedByPolicy.push(`${profile} ${mode}: ${balanced.d.tier} -> ${byMode[mode].d.tier}`);
    // Cost never makes a turn micro the classifier did not name.
    if (cost.d.tier === 'micro' && advice.choice !== 'micro') fail('cost created micro');
    const micro = ROUTING_MODES.filter((m) => byMode[m].d.tier === 'micro').map((m) => pair(byMode[m].d));
    if (new Set(micro).size > 1) fail('micro differs between modes');
    for (const mode of ROUTING_MODES)
      if (byMode[mode].d.tier !== 'micro' && !EFFORTS.includes(byMode[mode].d.effort)) fail(`${mode} without effort`);
  }
  rows.push(row);
}

const summary = (profile) =>
  Object.fromEntries(
    ROUTING_MODES.map((mode) => {
      const mix = {};
      let usd = 0;
      for (const row of rows) {
        const r = row.routes[profile][mode];
        mix[r.route] = (mix[r.route] ?? 0) + 1;
        usd += r.nominalUsd;
      }
      const differs = rows.filter((row) => row.routes[profile][mode].route !== row.routes[profile].balanced.route);
      return [mode, { mix, nominalUsd: Math.round(usd * 1e4) / 1e4, routesDifferingFromBalanced: differs.length }];
    }),
  );
const tierRight = rows.filter((r) => r.answered.tier === r.expected.tier).length;
const activityRight = rows.filter((r) => r.answered.activity === r.expected.activity).length;
const result = {
  classifier: id,
  model: entry.model,
  date: new Date().toISOString(),
  label: 'list-price estimate per nominal turn; not measured cost',
  nominalTurn: NOMINAL,
  probes: probes.length,
  answered: rows.length,
  errors,
  classification: {
    tierMatches: tierRight,
    activityMatches: activityRight,
    mismatches: rows
      .filter((r) => r.answered.tier !== r.expected.tier || r.answered.activity !== r.expected.activity)
      .map((r) => ({ text: r.text, expected: r.expected, answered: r.answered })),
  },
  routing: {
    violations: rows.flatMap((r) => r.violations.map((v) => `${v}: ${r.text}`)),
    tierMovedByPolicy: rows.flatMap((r) => r.tierMovedByPolicy.map((v) => `${v}: ${r.text}`)),
  },
  modes: Object.fromEntries(Object.keys(PROFILES).map((profile) => [profile, summary(profile)])),
  rows,
};
const dir = fileURLToPath(new URL('../experiments/mod-router/results/', import.meta.url));
mkdirSync(dir, { recursive: true });
const out = join(dir, `mode-probe-${id}.json`);
writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
console.log(
  `\n${id} (${entry.model}) at ${new URL(credentials.endpoint).host}: ${rows.length}/${probes.length} answered, ` +
    `tier ${tierRight} and activity ${activityRight} as expected, ${result.routing.violations.length} routing violations`,
);
for (const [profile, modes] of Object.entries(result.modes))
  for (const [mode, s] of Object.entries(modes))
    console.log(
      `${profile} ${mode}: $${s.nominalUsd} nominal, ${s.routesDifferingFromBalanced} differ, ${JSON.stringify(s.mix)}`,
    );
console.log(`wrote ${out}`);
