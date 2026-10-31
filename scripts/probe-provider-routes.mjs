// Billed synthetic microchecks, not a coding benchmark. Explicit provider and USD ceiling required.
// node scripts/probe-provider-routes.mjs <minimax|mimo|kimi> <budget-usd>
// Keys stay in ~/.claude/secrets.json (chezmoi). No source code, real conversations or reasoning text is saved.

import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { ACTIVITIES, loadConfig, ROUTING_MODES, TIERS } from '../lib/config.mjs';
import { modeRoute } from '../lib/modes.mjs';
import { canonicalModel } from '../lib/providers.mjs';

const ENDPOINTS = {
  minimax: 'https://api.minimax.io/anthropic/v1/messages',
  mimo: 'https://api.xiaomimimo.com/anthropic/v1/messages',
  kimi: 'https://api.moonshot.ai/anthropic/v1/messages',
};
export const TASKS = JSON.parse(readFileSync(new URL('../test/fixtures/provider-tasks.json', import.meta.url), 'utf8'));
const MAX_OUTPUT = 2048;

export function matchesTask(text, expected) {
  try {
    return isDeepStrictEqual(JSON.parse(text.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, '')), expected);
  } catch {
    return false;
  }
}

// Test each distinct (activity, model, effort) once; record every mode/tier cell that would run it.
export function probeCases(config) {
  const cases = new Map();
  for (const activity of ACTIVITIES)
    for (const tier of TIERS)
      for (const mode of ROUTING_MODES) {
        const route = modeRoute(config, mode, tier, activity);
        const key = [activity, route.model, route.effort].join('/');
        if (!cases.has(key)) cases.set(key, { activity, ...route, cells: [] });
        cases.get(key).cells.push({ tier, mode });
      }
  return [...cases.values()];
}

// Unknown or failed usage costs the full reservation, never zero. Reported counters are not an invoice.
export function usageUsd(spec, usage) {
  if (!usage || !Number.isFinite(usage.input_tokens) || !Number.isFinite(usage.output_tokens)) return null;
  const input = usage.input_tokens + (usage.cache_creation_input_tokens ?? 0);
  const read = usage.cache_read_input_tokens ?? 0;
  if ([input, read, usage.output_tokens].some((n) => n < 0 || !Number.isFinite(n))) return null;
  return (input * spec.input + read * spec.cacheRead + usage.output_tokens * spec.output) / 1e6;
}

export async function run(provider, budgetUsd) {
  if (!Object.hasOwn(ENDPOINTS, provider) || !Number.isFinite(budgetUsd) || budgetUsd <= 0 || budgetUsd > 5)
    throw new Error('Expected minimax|mimo|kimi and a positive budget no greater than USD 5.');
  const config = loadConfig({ provider });
  const secrets = JSON.parse(readFileSync(join(homedir(), '.claude', 'secrets.json'), 'utf8'));
  const key = secrets[provider];
  if (typeof key !== 'string' || !key) throw new Error('Selected provider credential is missing.');
  const out = new URL(`../experiments/mod-router/results/provider-routes-${provider}.json`, import.meta.url);
  const result = {
    provider,
    date: new Date().toISOString(),
    budgetUsd,
    accountedUsd: 0,
    method:
      'One synthetic JSON microcheck per activity/route, no retries. Cells enumerate configured routes in every mode and tier. HTTP acceptance does not prove an effort is honored. Not a benchmark or savings result.',
    rows: [],
  };
  for (const scenario of probeCases(config)) {
    const task = TASKS.find((t) => t.activity === scenario.activity);
    const spec = config.models[scenario.model];
    const body = {
      model: canonicalModel(spec.id),
      max_tokens: MAX_OUTPUT,
      ...(scenario.effort ? { thinking: { type: 'adaptive' }, output_config: { effort: scenario.effort } } : {}),
      messages: [{ role: 'user', content: task.prompt }],
    };
    // UTF-8 bytes bound input tokens for these short ASCII fixtures; reserve 4096 more for provider overhead.
    const reserveUsd = ((Buffer.byteLength(JSON.stringify(body)) + 4096) * spec.input + MAX_OUTPUT * spec.output) / 1e6;
    if (result.accountedUsd + reserveUsd > budgetUsd) {
      result.stopped = 'budget-reservation';
      break;
    }
    const started = Date.now();
    let row;
    try {
      const response = await fetch(ENDPOINTS[provider], {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(90000),
        headers: {
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
          'x-api-key': key,
          authorization: `Bearer ${key}`,
        },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      const text = (data.content ?? [])
        .filter((p) => p.type === 'text')
        .map((p) => p.text)
        .join('');
      const estimatedUsd = usageUsd(spec, data.usage);
      row = {
        ...scenario,
        requested: body.model,
        served: data.model ?? null,
        status: response.status,
        ms: Date.now() - started,
        stop: data.stop_reason ?? null,
        usage: data.usage ?? null,
        estimatedUsd,
        passed:
          response.ok &&
          data.stop_reason === 'end_turn' &&
          data.model === body.model &&
          matchesTask(text, task.expected),
        text,
      };
      result.accountedUsd += estimatedUsd ?? reserveUsd;
      if (response.status === 401 || response.status === 403) result.stopped = 'authorization';
    } catch {
      result.accountedUsd += reserveUsd;
      row = {
        ...scenario,
        ms: Date.now() - started,
        passed: false,
        error: 'request-failed-or-timed-out',
        reservedUsd: reserveUsd,
      };
    }
    result.rows.push(row);
    writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
    console.log(
      provider +
        ' ' +
        scenario.activity +
        ' ' +
        scenario.model +
        '/' +
        scenario.effort +
        ': ' +
        (row.passed ? 'pass' : 'FAIL'),
    );
    if (result.stopped) break;
  }
  writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`Accounted USD ${result.accountedUsd.toFixed(6)}; wrote ${fileURLToPath(out)}`);
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await run(process.argv[2], Number(process.argv[3]));
  if (result.stopped || result.rows.some((r) => !r.passed)) process.exitCode = 1;
}
