// Fetches the Artificial Analysis free API into a private local evidence overlay.
//   npm run evidence:aa [-- --force] [--days=14]
// The key comes from AA_API_KEY, else from ~/.config/claude-router/aa.env; it is never printed.
// The output is ~/.config/claude-router/evidence.local.mjs, mode 600, never committed: AA's terms allow personal use
// and attribution, not redistribution. Free tier: 100 requests/24h; this run uses one request per page (four today).
// A refresh is skipped while the overlay is younger than --days (7 by default), so a cron schedule cannot abuse the
// limit; --force refreshes anyway.
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { aaCapability, parseAaName } from '../lib/evidence-aa.mjs';
import { mergeProbe } from '../lib/evidence-probe.mjs';

const ENDPOINT = 'https://artificialanalysis.ai/api/v2/language/models/free';
const OUT_DIR = join(homedir(), '.config', 'claude-router');
const OUT_FILE = join(OUT_DIR, 'evidence.local.mjs');
const DAY_MS = 86_400_000;
const DEFAULT_DAYS = 7;
const MAX_PAGES = 10;

function usage() {
  console.log(`Usage: npm run evidence:aa [-- options]

  --force       refresh even if the overlay is younger than --days
  --days=<n>    minimum age before a refresh, in days (default ${DEFAULT_DAYS})
  -h, --help    this text

The key comes from AA_API_KEY, else ~/.config/claude-router/aa.env (AA_API_KEY=…).
Writes ~/.config/claude-router/evidence.local.mjs, mode 600. Never commit it.
The free tier allows 100 requests/24h; one refresh uses one request per page.`);
}

// The date the existing overlay was generated, or null when there is none.
function checkedDate() {
  try {
    const match = /"checked": "(\d{4}-\d{2}-\d{2})"/.exec(readFileSync(OUT_FILE, 'utf8'));
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  usage();
  process.exit(0);
}
const daysArg = args.find((arg) => arg.startsWith('--days='));
const minimumDays = daysArg ? Number(daysArg.slice('--days='.length)) : DEFAULT_DAYS;
if (!Number.isFinite(minimumDays) || minimumDays <= 0) {
  console.error('--days must be a positive number');
  process.exit(2);
}
if (!args.includes('--force')) {
  const checked = checkedDate();
  if (checked !== null) {
    const ageDays = (Date.now() - Date.parse(`${checked}T00:00:00Z`)) / DAY_MS;
    if (ageDays < minimumDays) {
      console.log(
        `aa evidence: overlay checked ${checked}, younger than ${minimumDays} days; nothing to do (use --force)`,
      );
      process.exit(0);
    }
  }
}

// AA base ids (as parseAaName gives them) to the router's canonical ids. Only models whose identity is attested.
const MODELS = {
  'claude-opus-5-5': ['claude-opus-5-5'],
  'claude-sonnet-5-5': ['claude-sonnet-5-5'],
  'claude-haiku-5-5': ['claude-haiku-5-5'],
  'claude-fable-5-2': ['claude-fable-5-2'],
  'glm-5-3': ['glm-5.3', 'zai-org/GLM-5.3'],
  'glm-5-3-flash': ['glm-5.3-flash', 'zai-org/GLM-5.3-Flash'],
  'deepseek-v4-1-flash-1017': ['deepseek-v4.1-flash-1017', 'deepseek-ai/DeepSeek-V4.1-Flash-1017', 'deepseek-flash'],
  'kimi-k3-1-pro': ['kimi-k3.1-pro', 'moonshotai/Kimi-K3.1-Pro'],
  'minimax-m3-1-flash': ['minimax-m3.1-flash', 'MiniMax-M3.1-Flash'],
  'mimo-v2-6-flash': ['mimo-v2.6-flash'],
  'mimo-v2-6-pro': ['mimo-v2.6-pro'],
};

function apiKey() {
  if (process.env.AA_API_KEY) return process.env.AA_API_KEY;
  try {
    const text = readFileSync(join(OUT_DIR, 'aa.env'), 'utf8');
    for (const line of text.split('\n')) {
      const match = /^\s*(?:export\s+)?AA_API_KEY\s*=\s*(.*)\s*$/.exec(line);
      if (match) return match[1].replace(/^["']|["']$/g, '');
    }
  } catch {}
  throw new Error('AA_API_KEY is not set: export it or write AA_API_KEY=… to ~/.config/claude-router/aa.env');
}

async function fetchPage(key, page) {
  const res = await fetch(`${ENDPOINT}?page=${page}`, { headers: { 'x-api-key': key } });
  if (!res.ok) throw new Error(`Artificial Analysis answered ${res.status} on page ${page}`);
  return res.json();
}

const AA_INDEX = /^artificial_analysis_(.+)_index$/;
const PROBE_FILE = join(OUT_DIR, 'evidence.probe.json');
const PERFORMANCE = {
  outputTokensPerSecond: 'median_output_tokens_per_second',
  timeToFirstTokenSec: 'median_time_to_first_token_seconds',
  timeToFirstAnswerSec: 'median_time_to_first_answer_token_seconds',
  endToEndSec: 'median_end_to_end_response_time_seconds',
};

// Every index the row carries, plus the published pricing, cost per task and performance, so a later decision can
// use a different dimension without another request.
function scoresOf(row) {
  const scores = {};
  for (const [key, value] of Object.entries(row?.evaluations ?? {})) {
    const match = AA_INDEX.exec(key);
    if (match?.[1] && Number.isFinite(value)) scores[match[1]] = value;
  }
  const costPerTaskUsd = row?.artificial_analysis_intelligence_index_cost?.cost_per_task?.total_cost;
  if (Number.isFinite(costPerTaskUsd)) scores.costPerTaskUsd = costPerTaskUsd;
  const pricing = {
    input: row?.pricing?.price_1m_input_tokens,
    output: row?.pricing?.price_1m_output_tokens,
    cacheRead: row?.pricing?.price_1m_cache_hit_tokens,
    cacheWrite: row?.pricing?.price_1m_cache_write_tokens,
  };
  const prices = Object.fromEntries(Object.entries(pricing).filter(([, value]) => Number.isFinite(value)));
  if (Object.keys(prices).length) scores.pricing = prices;
  const performance = {};
  for (const [name, key] of Object.entries(PERFORMANCE)) {
    const value = row?.performance?.[key];
    if (Number.isFinite(value)) performance[name] = value;
  }
  if (Object.keys(performance).length) scores.performance = performance;
  return scores;
}

function build(rows, checked) {
  /** @type {Record<string, any>} */
  const entries = {};
  for (const row of rows) {
    const parsed = parseAaName(row?.name);
    if (!parsed) continue;
    const aliases = MODELS[parsed.base];
    if (!aliases) continue;
    const capability = aaCapability(row.evaluations);
    if (!capability) continue;
    // A row without an effort suffix is the model's default configuration; record it as `max` with provenance.
    const effort = parsed.effort ?? 'max';
    const id = aliases[0];
    if (!id) continue;
    let entry = entries[id];
    if (!entry) {
      entry = { aliases, capability: {}, scores: {}, confidence: {}, notes: [], sources: ['artificial_analysis'] };
      entries[id] = entry;
    }
    entry.capability[effort] = capability;
    entry.scores[effort] = scoresOf(row);
    entry.confidence[effort] = parsed.effort ? 'medium' : 'low';
    if (!parsed.effort)
      entry.notes.push(`${row.name}: no effort suffix in the free API; recorded as ${effort}, the strongest effort`);
  }
  return { checked, source: 'https://artificialanalysis.ai/', tier: 'free', entries };
}

function write(overlay) {
  mkdirSync(OUT_DIR, { recursive: true });
  const body = [
    '// Generated by scripts/aa-evidence.mjs from the Artificial Analysis free API.',
    '// Private local overlay for personal routing; attribution: https://artificialanalysis.ai/',
    '// Do not commit or redistribute. Regenerate instead of editing.',
    `export const EVIDENCE_LOCAL = ${JSON.stringify(overlay, null, 2)};`,
    '',
  ].join('\n');
  const tmp = `${OUT_FILE}.tmp`;
  writeFileSync(tmp, body, { mode: 0o600 });
  renameSync(tmp, OUT_FILE);
  chmodSync(OUT_FILE, 0o600);
}

const key = apiKey();
const first = await fetchPage(key, 1);
const totalPages = first.pagination.total_pages;
// A runaway pagination is a changed API, not evidence: refuse before spending more of the daily limit.
if (!Number.isSafeInteger(totalPages) || totalPages < 1 || totalPages > MAX_PAGES)
  throw new Error(`Artificial Analysis reported ${totalPages} pages, more than the ${MAX_PAGES} this script accepts`);
const rows = [...first.data];
for (let page = 2; page <= totalPages; page += 1) rows.push(...(await fetchPage(key, page)).data);
const overlay = build(rows, new Date().toISOString().slice(0, 10));
// Probe results are local task measurements; where they cover a cell they replace the benchmark prior.
try {
  const probe = JSON.parse(readFileSync(PROBE_FILE, 'utf8'));
  if (probe?.entries && Object.keys(probe.entries).length) {
    mergeProbe(overlay.entries, probe.entries);
    console.log(`aa evidence: merged probe results for ${Object.keys(probe.entries).length} models`);
  }
} catch {}
write(overlay);
const efforts = Object.values(overlay.entries).reduce((sum, entry) => sum + Object.keys(entry.capability).length, 0);
console.log(
  `aa evidence: ${rows.length} rows, ${Object.keys(overlay.entries).length} models, ${efforts} effort cells, ${totalPages} requests → ${OUT_FILE}`,
);
for (const [id, entry] of Object.entries(overlay.entries))
  console.log(
    `${id}: ${Object.entries(entry.capability)
      .map(([effort, cap]) => `${effort}=${cap.default}`)
      .join(' ')}`,
  );
