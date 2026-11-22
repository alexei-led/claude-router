// Generates lib/evidence.mjs from the committed benchmark snapshots under data/evidence/<date>/.
//   node scripts/check-evidence.mjs           report a diff; exit 0 when the file matches, 1 when it is stale
//   node scripts/check-evidence.mjs --write   rewrite lib/evidence.mjs (formatted by Biome)
// A snapshot that cannot be read or has lost a required column throws and exits 1 without writing; a single malformed
// row is skipped and reported on stderr, so one bad row cannot produce a wrong value.
//
// Capability is a benchmark-derived policy prior, never measured task adequacy. Only a (model, effort) cell a source
// measured becomes capability; unknown stays unknown and nothing is interpolated across efforts. For each source:
//
//   1. Each metric becomes a percentile (midrank, 0..1) over the measured reference models in that snapshot. The
//      Terminal-Bench snapshot marks its reference rows; LiveBench uses the models outside the router catalog; the
//      LMArena snapshot contains only router models, so every measured model there is the population (a documented
//      limitation, not a hidden assumption).
//   2. An activity composite is the fixed weighted mean below over the metrics the cell measured. A missing metric is
//      left out and the remaining weights are renormalized, so a source never contributes a zero for a metric it does
//      not publish. `review` and `docs` are deliberately weak cells: the sources have no direct suite for them.
//   3. The composite maps to the router's 0..3 half-step scale through anchors taken from the router's policy seeds
//      (Haiku 5.5 high = 1, Opus 5.5 medium = 2, Opus 5.5 xhigh = 3), but only where that source measured the exact
//      cell. With two or more anchors the map is piecewise linear through them. With one anchor it runs through 0 at
//      percentile 0 and 3 at percentile 1 as well; with none it is the linear 0..3 fallback. Neither endpoint is a
//      measurement, so both cases carry confidence `low` and the fallback is named in the generated header.
//   4. A cell several sources measured takes the mean of their mapped values, rounded to a half-step, and the weakest
//      contributor's confidence, because the merged value depends on every input.
//
// No bundled snapshot measures two anchor cells (Terminal-Bench publishes `max`, LMArena publishes `high` and `max`,
// LiveBench is model-level), so every bundled capability cell is `low` confidence. That is the honest state of the
// public data, not a defect in the generator.
//
// LiveBench is model-level: it contributes raw scores for every model and capability only in the `default` cell of a
// model with `efforts: []`. models.dev supplies identity, aliases and effort support; LiteLLM is recorded as the
// catalog cross-check and supplies no score here.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SNAPSHOT = '2026-11-22';
const SNAPSHOT_DIR = join(ROOT, 'data', 'evidence', SNAPSHOT);
const EVIDENCE_FILE = join(ROOT, 'lib', 'evidence.mjs');
const BIOME = join(ROOT, 'tools', 'node_modules', '.bin', 'biome');

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
export const ACTIVITIES = ['default', 'code', 'debug', 'explore', 'plan', 'review', 'ops', 'docs'];
const SOURCE_ORDER = ['livebench', 'lmarena', 'terminal_bench'];
const CONFIDENCE = { low: 0, medium: 1, high: 2 };

// One table, reviewed with the data. Weights compare evidence inside one activity; they are not percentages of task
// adequacy. A source that publishes a metric not listed here still keeps it in `scores`, but it does not move a
// capability. Learn more than one source's metrics only after normalizing each metric to its own percentile.
export const ACTIVITY_WEIGHTS = {
  default: {
    'lmarena.text.overall': 3,
    'lmarena.agent_capability.overall': 2,
    'lmarena.agent.overall': 1,
    'lmarena.webdev.overall': 1,
    'terminal_bench.accuracy': 2,
    'livebench.reasoning': 2,
    'livebench.coding': 1,
  },
  code: {
    'terminal_bench.accuracy': 3,
    'lmarena.agent_task_outcome.code': 3,
    'lmarena.agent_capability.code': 2,
    'lmarena.text.coding': 2,
    'lmarena.webdev.overall': 1,
    'livebench.coding': 2,
    'livebench.long_agentic': 1,
  },
  debug: {
    'terminal_bench.accuracy': 3,
    'lmarena.agent.overall': 2,
    'lmarena.text.hard_prompts': 2,
    'lmarena.agent_capability.code': 1,
    'livebench.reasoning': 2,
    'livebench.coding': 1,
  },
  explore: {
    'lmarena.text.hard_prompts': 2,
    'lmarena.text.math': 2,
    'lmarena.text.overall': 2,
    'lmarena.agent_capability.overall': 1,
    'livebench.reasoning': 2,
    'livebench.research': 1,
  },
  plan: {
    'lmarena.text.hard_prompts': 2,
    'lmarena.text.instruction_following': 2,
    'lmarena.agent_capability.overall': 2,
    'lmarena.text.multi_turn': 1,
    'livebench.reasoning': 2,
    'livebench.long_agentic': 1,
  },
  // Weak evidence: no source measures review directly, so it borrows the code and instruction-following cells.
  review: {
    'lmarena.agent_task_outcome.code': 2,
    'lmarena.text.coding': 2,
    'lmarena.text.instruction_following': 2,
    'lmarena.agent.overall': 1,
    'livebench.coding': 1,
    'livebench.reasoning': 1,
  },
  ops: {
    'terminal_bench.accuracy': 3,
    'lmarena.agent.overall': 2,
    'lmarena.agent_tool_efficiency.overall': 2,
    'lmarena.agent_task_outcome.overall': 1,
    'livebench.long_agentic': 2,
    'livebench.browser': 1,
  },
  // Weak evidence: no source measures documentation quality, so it reads instruction following and design.
  docs: {
    'lmarena.text.instruction_following': 3,
    'lmarena.text.overall': 2,
    'lmarena.text.multi_turn': 1,
    'livebench.design': 2,
    'livebench.research': 1,
  },
};

// The router's lead-approved policy seeds (lib/config.mjs, docs/providers.md). Only a source that measured these exact
// cells can calibrate its own scale; a source that measured one or none uses the documented fallback above.
export const POLICY_ANCHORS = [
  { key: 'claude-haiku-5-5', effort: 'high', value: 1 },
  { key: 'claude-opus-5-5', effort: 'medium', value: 2 },
  { key: 'claude-opus-5-5', effort: 'xhigh', value: 3 },
];

const LICENSES = {
  terminal_bench: { url: 'https://www.tbench.ai/leaderboard', license: 'Apache-2.0' },
  livebench: { url: 'https://livebench.ai/', license: 'Apache-2.0' },
};

const canonicalModel = (id) => id.replace(/\[1m\]$/, '');
const normalizeIdentity = (id) =>
  id
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/** The exact id and, for a namespaced id, its last path segment, both normalized for source-label matching. */
function identityForms(id) {
  const base = canonicalModel(id);
  const forms = new Set([normalizeIdentity(base)]);
  const parts = base.split('/');
  const last = parts[parts.length - 1];
  if (last) forms.add(normalizeIdentity(last));
  return [...forms].filter((form) => form.length > 0);
}

/**
 * The router's supported efforts from a models.dev record. A toggle-only model has no effort field, which the catalog
 * expresses as an empty list (the `default` capability cell).
 * @param {{ reasoning_options?: Array<{ type?: string, values?: unknown[] }> }} record
 * @returns {string[]}
 */
function supportedEfforts(record) {
  const values = new Set();
  for (const option of record.reasoning_options ?? []) {
    if (option?.type !== 'effort' || !Array.isArray(option.values)) continue;
    for (const value of option.values) if (EFFORTS.includes(value)) values.add(value);
  }
  return EFFORTS.filter((effort) => values.has(effort));
}

/**
 * @param {Array<{ key: string, aliases: string[] }>} models
 * @returns {(id: string) => string | null}
 */
export function buildResolver(models) {
  const index = new Map();
  for (const model of models) {
    for (const alias of model.aliases) {
      for (const form of identityForms(alias)) {
        const existing = index.get(form);
        if (existing && existing !== model.key)
          throw new Error(`evidence identity: "${form}" maps to both ${existing} and ${model.key}`);
        index.set(form, model.key);
      }
    }
  }
  return (id) => {
    if (typeof id !== 'string') return null;
    for (const form of identityForms(id)) {
      const key = index.get(form);
      if (key) return key;
    }
    return null;
  };
}

/**
 * The canonical catalog: keys are models.dev provider-local ids, which are the router's configured ids without `[1m]`.
 * Aliases add the exact router ids from the snapshot, their `[1m]`-stripped forms and the source canonical id.
 * @param {any} modelsDev
 */
export function buildCatalog(modelsDev) {
  if (!modelsDev?.source || !Array.isArray(modelsDev.router_models) || !Array.isArray(modelsDev.router_coverage))
    throw new Error('models.dev snapshot: missing source, router_models or router_coverage');
  const coverage = modelsDev.router_coverage;
  const models = modelsDev.router_models.map((record) => {
    if (typeof record?.id !== 'string' || record.id.length === 0)
      throw new Error('models.dev snapshot: a router model has no id');
    const aliases = new Set([record.id, `${record.id}[1m]`]);
    if (typeof record.canonical_model_id === 'string') aliases.add(record.canonical_model_id);
    for (const entry of coverage) {
      if (
        entry?.source_model_id === record.id &&
        entry.provider === record.provider &&
        typeof entry.router_id === 'string'
      ) {
        aliases.add(entry.router_id);
        aliases.add(canonicalModel(entry.router_id));
      }
    }
    return {
      key: record.id,
      aliases: [...aliases].filter((alias) => alias.length > 0).sort(),
      efforts: supportedEfforts(record),
    };
  });
  const byKey = new Map(models.map((model) => [model.key, model]));
  return { models, byKey, resolve: buildResolver(models) };
}

/** RFC-4180-ish CSV: enough for the plain LiveBench table and for a quoted cell a future snapshot may add. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') field += char;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * The effort stated by a benchmark display name, or null when it states none.
 * @param {unknown} name
 * @returns {string | null}
 */
export function effortFromName(name) {
  if (typeof name !== 'string') return null;
  const suffix = /\(([^()]*)\)\s*$/.exec(name);
  if (!suffix) return null;
  for (const part of suffix[1].split(',').map((value) => value.trim().toLowerCase()))
    if (EFFORTS.includes(part)) return part;
  return null;
}

/**
 * @param {any} snapshot terminal-bench/rows.json
 * @returns {{
 *   rows: Array<{ id: string, effort: string, accuracy: number, role: string, date: string }>,
 *   warnings: string[],
 * }}
 */
export function parseTerminalBench(snapshot) {
  if (!Array.isArray(snapshot?.fields) || !Array.isArray(snapshot?.rows))
    throw new Error('terminal-bench snapshot: missing fields or rows');
  if (!snapshot.fields.includes('model_id') || !snapshot.fields.includes('m_accuracy'))
    throw new Error('terminal-bench snapshot: missing model_id or m_accuracy column');
  const rows = [];
  const warnings = [];
  for (const [index, row] of snapshot.rows.entries()) {
    const id = typeof row?.model_id === 'string' && row.model_id.length > 0 ? row.model_id : null;
    const accuracy = row?.m_accuracy;
    if (id === null || typeof accuracy !== 'number' || !Number.isFinite(accuracy)) {
      warnings.push(`terminal-bench row ${index}: skipped (missing model_id or numeric accuracy)`);
      continue;
    }
    if (row.role !== 'router' && row.role !== 'reference') {
      warnings.push(`terminal-bench row ${index}: skipped (role is not router or reference)`);
      continue;
    }
    const stated = typeof row.reasoning_effort === 'string' ? row.reasoning_effort.toLowerCase() : null;
    const effort = stated !== null && EFFORTS.includes(stated) ? stated : 'default';
    rows.push({
      id,
      effort,
      accuracy,
      role: row.role,
      date: typeof row.submission_date === 'string' ? row.submission_date : '',
    });
  }
  return { rows, warnings };
}

/**
 * @param {any} snapshot lmarena/router-models.json
 * @returns {{ groups: Array<{ ids: string[], cells: Record<string, Record<string, number>> }>, warnings: string[] }}
 */
export function parseLmarena(snapshot) {
  if (!Array.isArray(snapshot?.models)) throw new Error('lmarena snapshot: missing models');
  const groups = [];
  const warnings = [];
  for (const [index, model] of snapshot.models.entries()) {
    const ids = Array.isArray(model?.router_ids)
      ? model.router_ids.filter((id) => typeof id === 'string' && id.length > 0)
      : [];
    if (!Array.isArray(model?.benchmarks) || ids.length === 0) {
      warnings.push(`lmarena model ${index}: skipped (no benchmarks or router_ids)`);
      continue;
    }
    const cells = {};
    for (const benchmark of model.benchmarks) {
      const value = benchmark?.score;
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        warnings.push(`lmarena model ${index}: skipped a benchmark without a numeric score`);
        continue;
      }
      if (typeof benchmark.config !== 'string' || typeof benchmark.category !== 'string') {
        warnings.push(`lmarena model ${index}: skipped a benchmark without a config or category`);
        continue;
      }
      const effort = effortFromName(benchmark.model_name) ?? 'default';
      const metric = `lmarena.${benchmark.config}.${benchmark.category}`;
      const cell = cells[effort] ?? {};
      // The snapshot repeats one group's rows once per router id; the first copy is enough.
      if (!(metric in cell)) cell[metric] = value;
      cells[effort] = cell;
    }
    if (Object.keys(cells).length > 0) groups.push({ ids, cells });
  }
  return { groups, warnings };
}

/**
 * @param {string} text livebench/table.csv
 * @returns {{ rows: Array<{ id: string, scores: Record<string, number> }>, warnings: string[] }}
 */
export function parseLiveBenchTable(text) {
  const table = parseCsv(text.replace(/^﻿/, ''));
  if (table.length === 0) throw new Error('livebench table: empty');
  const header = table[0].map((cell) => cell.trim());
  if (!header.includes('model')) throw new Error('livebench table: no model column');
  const metrics = header.filter((column) => column !== 'model' && column.length > 0);
  if (metrics.length === 0) throw new Error('livebench table: no metric columns');
  const rows = [];
  const warnings = [];
  for (let index = 1; index < table.length; index += 1) {
    const row = table[index];
    if (row.length === 1 && row[0] === '') continue;
    if (row.length !== header.length) {
      warnings.push(`livebench row ${index + 1}: skipped (${row.length} cells, expected ${header.length})`);
      continue;
    }
    const id = row[0].trim();
    if (id.length === 0) {
      warnings.push(`livebench row ${index + 1}: skipped (empty model id)`);
      continue;
    }
    const scores = {};
    for (let column = 1; column < header.length; column += 1) {
      const raw = row[column].trim();
      const value = raw.length === 0 ? Number.NaN : Number(raw);
      if (!Number.isFinite(value)) {
        warnings.push(`livebench row ${index + 1}: ${header[column]} is not a number; skipped`);
        continue;
      }
      scores[`livebench.${header[column]}`] = value;
    }
    if (Object.keys(scores).length > 0) rows.push({ id, scores });
  }
  return { rows, warnings };
}

/** Midrank percentile in 0..1; a value equal to every reference lands at 0.5. Null without a population. */
export function percentile(values, value) {
  if (!Array.isArray(values) || values.length === 0 || !Number.isFinite(value)) return null;
  let below = 0;
  let equal = 0;
  for (const candidate of values) {
    if (candidate < value) below += 1;
    else if (candidate === value) equal += 1;
  }
  return (below + 0.5 * equal) / values.length;
}

const roundHalf = (value) => Math.round(value * 2) / 2;
const clamp = (value) => Math.max(0, Math.min(3, value));

function dedupePoints(points) {
  const sorted = points
    .filter((point) => Number.isFinite(point[0]) && Number.isFinite(point[1]))
    .sort((left, right) => left[0] - right[0]);
  const out = [];
  for (const point of sorted) {
    const last = out[out.length - 1];
    if (last && Math.abs(last[0] - point[0]) < 1e-12) out[out.length - 1] = point;
    else out.push(point);
  }
  return out;
}

function interpolate(points, value) {
  if (points.length === 1) return points[0][1];
  const between = (x0, y0, x1, y1) => (x1 === x0 ? y1 : y0 + ((value - x0) * (y1 - y0)) / (x1 - x0));
  const first = points[0];
  const last = points[points.length - 1];
  if (value <= first[0]) return between(first[0], first[1], points[1][0], points[1][1]);
  for (let index = 1; index < points.length; index += 1) {
    if (value <= points[index][0])
      return between(points[index - 1][0], points[index - 1][1], points[index][0], points[index][1]);
  }
  return between(last[0], last[1], points[points.length - 2][0], points[points.length - 2][1]);
}

/**
 * The capability a composite percentile implies. Zero or one measured anchor cannot fit the policy curve; the
 * documented fallback still returns a half-step so the cell is visible, and the caller marks it `low`.
 * @param {Array<[number, number]>} anchors
 * @param {number} composite
 * @returns {number}
 */
export function capabilityFromComposite(anchors, composite) {
  const points = dedupePoints(anchors);
  if (points.length === 0) return clamp(roundHalf(composite * 3));
  const table = points.length >= 2 ? points : dedupePoints([[0, 0], ...points, [1, 3]]);
  return clamp(roundHalf(interpolate(table, composite)));
}

function pushValue(reference, metric, effort, value) {
  if (!Number.isFinite(value)) return;
  let byEffort = reference.get(metric);
  if (!byEffort) {
    byEffort = new Map();
    reference.set(metric, byEffort);
  }
  let values = byEffort.get(effort);
  if (!values) {
    values = [];
    byEffort.set(effort, values);
  }
  values.push(value);
}

function weightedMean(weights, percentiles) {
  let sum = 0;
  let total = 0;
  for (const [metric, weight] of Object.entries(weights)) {
    const value = percentiles.get(metric);
    if (typeof value === 'number') {
      sum += value * weight;
      total += weight;
    }
  }
  return total > 0 ? sum / total : null;
}

function percentilesFor(reference, metrics, effort) {
  const percentiles = new Map();
  for (const [metric, value] of Object.entries(metrics)) {
    const values = reference.get(metric)?.get(effort);
    const parsed = values ? percentile(values, value) : null;
    if (parsed !== null) percentiles.set(metric, parsed);
  }
  return percentiles;
}

function buildAnchors(cellsByKey, reference) {
  const anchors = Object.fromEntries(ACTIVITIES.map((activity) => [activity, []]));
  for (const anchor of POLICY_ANCHORS) {
    const metrics = cellsByKey.get(anchor.key)?.[anchor.effort];
    if (!metrics) continue;
    const percentiles = percentilesFor(reference, metrics, anchor.effort);
    for (const activity of ACTIVITIES) {
      const composite = weightedMean(ACTIVITY_WEIGHTS[activity], percentiles);
      if (composite !== null) anchors[activity].push([composite, anchor.value]);
    }
  }
  for (const activity of ACTIVITIES) anchors[activity] = dedupePoints(anchors[activity]);
  return anchors;
}

function capabilityCell(reference, metrics, effort, anchors) {
  const percentiles = percentilesFor(reference, metrics, effort);
  const out = {};
  for (const activity of ACTIVITIES) {
    const composite = weightedMean(ACTIVITY_WEIGHTS[activity], percentiles);
    if (composite === null) continue;
    out[activity] = capabilityFromComposite(anchors[activity], composite);
  }
  return Object.keys(out).length > 0 ? out : null;
}

function sourceConfidence(anchors, source) {
  const fitted = ACTIVITIES.every((activity) => anchors[activity].length >= 2);
  if (!fitted) return 'low';
  return source === 'livebench' ? 'medium' : 'high';
}

function weakest(left, right) {
  return CONFIDENCE[left] <= CONFIDENCE[right] ? left : right;
}

function recordScore(scores, key, source, effort, metrics) {
  let bySource = scores.get(key);
  if (!bySource) {
    bySource = {};
    scores.set(key, bySource);
  }
  let byEffort = bySource[source];
  if (!byEffort) {
    byEffort = {};
    bySource[source] = byEffort;
  }
  let cell = byEffort[effort];
  if (!cell) {
    cell = {};
    byEffort[effort] = cell;
  }
  for (const [metric, value] of Object.entries(metrics)) if (!(metric in cell)) cell[metric] = value;
}

function setCell(cells, key, effort, metrics) {
  let byEffort = cells.get(key);
  if (!byEffort) {
    byEffort = {};
    cells.set(key, byEffort);
  }
  if (!(effort in byEffort)) byEffort[effort] = metrics;
}

function loadSnapshots(root) {
  const readJson = (relative) => {
    const path = join(root, relative);
    try {
      return JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`snapshot ${relative}: ${message}`);
    }
  };
  let livebench;
  try {
    livebench = readFileSync(join(root, 'livebench', 'table.csv'), 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`snapshot livebench/table.csv: ${message}`);
  }
  return {
    modelsDev: readJson('models-dev.json'),
    litellm: readJson('litellm.json'),
    terminalBench: readJson('terminal-bench/rows.json'),
    lmarena: readJson('lmarena/router-models.json'),
    livebench,
  };
}

function buildSources(snapshots, date) {
  const modelsDev = snapshots.modelsDev.source;
  const litellm = snapshots.litellm._meta;
  const lmarena = snapshots.lmarena;
  for (const [name, value] of [
    ['models.dev url', modelsDev?.url],
    ['models.dev license', modelsDev?.license],
    ['litellm source_url', litellm?.source_url],
    ['litellm license', litellm?.license],
    ['lmarena license', lmarena?.license],
  ]) {
    if (typeof value !== 'string' || value.length === 0)
      throw new Error(`evidence sources: snapshot is missing the ${name}`);
  }
  return {
    models_dev: {
      url: modelsDev.url,
      checked: modelsDev.fetched_at_utc ?? date,
      snapshot: `${date}/models-dev.json`,
      license: modelsDev.license,
    },
    litellm: {
      url: litellm.source_url,
      checked: litellm.fetched_at_utc ?? date,
      snapshot: `${date}/litellm.json`,
      license: litellm.license,
    },
    terminal_bench: {
      url: LICENSES.terminal_bench.url,
      checked: date,
      snapshot: `${date}/terminal-bench/rows.json`,
      license: LICENSES.terminal_bench.license,
    },
    lmarena: {
      url: 'https://lmarena.ai/leaderboard',
      checked: lmarena.fetched_at_utc ?? date,
      snapshot: `${date}/lmarena/router-models.json`,
      license: lmarena.license,
    },
    livebench: {
      url: LICENSES.livebench.url,
      checked: date,
      snapshot: `${date}/livebench/`,
      license: LICENSES.livebench.license,
    },
  };
}

function dedupeTerminalBench(rows) {
  const best = new Map();
  for (const row of rows) {
    const id = `${row.id}\u0000${row.effort}`;
    const previous = best.get(id);
    if (!previous || row.date > previous.date || (row.date === previous.date && row.accuracy > previous.accuracy))
      best.set(id, row);
  }
  return [...best.values()];
}

function terminalBenchData(snapshot, resolve) {
  const parsed = parseTerminalBench(snapshot);
  const reference = new Map();
  const router = new Map();
  for (const row of dedupeTerminalBench(parsed.rows)) {
    const metrics = { 'terminal_bench.accuracy': row.accuracy };
    if (row.role === 'reference') {
      pushValue(reference, 'terminal_bench.accuracy', row.effort, row.accuracy);
      continue;
    }
    const key = resolve(row.id);
    if (key) router.set(key, { ...(router.get(key) ?? {}), [row.effort]: metrics });
  }
  return { reference, cells: router, warnings: parsed.warnings };
}

function lmarenaData(snapshot, resolve) {
  const parsed = parseLmarena(snapshot);
  const reference = new Map();
  const cells = new Map();
  for (const group of parsed.groups) {
    for (const [effort, metrics] of Object.entries(group.cells)) {
      for (const [metric, value] of Object.entries(metrics)) pushValue(reference, metric, effort, value);
    }
    const keys = [...new Set(group.ids.map(resolve).filter((candidate) => candidate !== null))];
    if (keys.length === 0) continue;
    if (keys.length > 1) {
      parsed.warnings.push(`lmarena group: router ids resolve to ${keys.join(', ')}; skipped`);
      continue;
    }
    const key = keys[0];
    for (const [effort, metrics] of Object.entries(group.cells)) setCell(cells, key, effort, metrics);
  }
  return { reference, cells, warnings: parsed.warnings };
}

function liveBenchData(text, resolve) {
  const parsed = parseLiveBenchTable(text);
  const reference = new Map();
  const scores = new Map();
  const cells = new Map();
  for (const row of parsed.rows) {
    const key = resolve(row.id);
    if (!key) {
      for (const [metric, value] of Object.entries(row.scores)) pushValue(reference, metric, 'model', value);
      continue;
    }
    if (!scores.has(key)) scores.set(key, row.scores);
    setCell(cells, key, 'model', row.scores);
  }
  return { reference, scores, cells, warnings: parsed.warnings };
}

function effortRank(effort) {
  if (effort === 'default') return -1;
  const index = EFFORTS.indexOf(effort);
  return index < 0 ? EFFORTS.length : index;
}

function normalizeScores(scores) {
  const out = {};
  for (const source of SOURCE_ORDER) {
    const byEffort = scores?.[source];
    if (!byEffort) continue;
    out[source] = {};
    for (const effort of Object.keys(byEffort).sort((left, right) => effortRank(left) - effortRank(right))) {
      const metrics = byEffort[effort];
      out[source][effort] = Object.fromEntries(
        Object.keys(metrics)
          .sort()
          .map((metric) => [metric, metrics[metric]]),
      );
    }
  }
  return out;
}

function assembleEvidence({ models, scores, capabilities, date }) {
  const evidence = {};
  for (const model of [...models].sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))) {
    const bySource = capabilities.get(model.key) ?? {};
    const efforts = new Set();
    for (const byEffort of Object.values(bySource)) for (const effort of Object.keys(byEffort)) efforts.add(effort);
    const capability = {};
    const confidence = {};
    const modelScores = scores.get(model.key);
    const used = new Set(Object.keys(modelScores ?? {}));
    for (const effort of [...efforts].sort((left, right) => effortRank(left) - effortRank(right))) {
      const sums = {};
      let weakestConfidence = 'high';
      for (const source of SOURCE_ORDER) {
        const cell = bySource[source]?.[effort];
        if (!cell?.capability) continue;
        weakestConfidence = weakest(weakestConfidence, cell.confidence);
        for (const [activity, value] of Object.entries(cell.capability)) {
          let sum = sums[activity];
          if (!sum) {
            sum = { total: 0, count: 0 };
            sums[activity] = sum;
          }
          sum.total += value;
          sum.count += 1;
        }
      }
      if (Object.keys(sums).length === 0) continue;
      const activities = {};
      for (const activity of ACTIVITIES) {
        const sum = sums[activity];
        if (!sum) continue;
        activities[activity] = roundHalf(clamp(sum.total / sum.count));
      }
      capability[effort] = activities;
      confidence[effort] = weakestConfidence;
    }
    evidence[model.key] = {
      aliases: model.aliases,
      checked: date,
      scores: normalizeScores(modelScores),
      capability,
      confidence,
      sources: [...used].sort(),
    };
  }
  return evidence;
}

/**
 * Build the checked-in evidence from the snapshots on disk. Pure apart from reading the snapshot directory, so the
 * check and the tests call the same function.
 * @param {{ root?: string, date?: string }} [options]
 */
export function buildEvidence({ root = SNAPSHOT_DIR, date = SNAPSHOT } = {}) {
  const snapshots = loadSnapshots(root);
  const catalog = buildCatalog(snapshots.modelsDev);
  const scores = new Map();
  const capabilities = new Map();
  const warnings = [];

  const terminal = terminalBenchData(snapshots.terminalBench, catalog.resolve);
  for (const [key, byEffort] of terminal.cells) {
    for (const [effort, metrics] of Object.entries(byEffort))
      recordScore(scores, key, 'terminal_bench', effort, metrics);
  }
  const lmarena = lmarenaData(snapshots.lmarena, catalog.resolve);
  for (const [key, byEffort] of lmarena.cells) {
    for (const [effort, metrics] of Object.entries(byEffort)) recordScore(scores, key, 'lmarena', effort, metrics);
  }
  const livebench = liveBenchData(snapshots.livebench, catalog.resolve);
  for (const [key, metrics] of livebench.scores) recordScore(scores, key, 'livebench', 'model', metrics);

  warnings.push(...terminal.warnings, ...lmarena.warnings, ...livebench.warnings);

  const emit = (source, cells, reference) => {
    const anchors = buildAnchors(cells, reference);
    const confidence = sourceConfidence(anchors, source);
    for (const [key, byEffort] of cells) {
      const model = catalog.byKey.get(key);
      if (!model) continue;
      for (const [effort, metrics] of Object.entries(byEffort)) {
        let output = effort;
        if (source === 'livebench') {
          // Model-level data may fill only a model with no effort field.
          if (model.efforts.length > 0) continue;
          output = 'default';
        } else if (effort === 'default' || !model.efforts.includes(effort)) continue;
        const capability = capabilityCell(reference, metrics, effort, anchors);
        if (!capability) continue;
        let bySource = capabilities.get(key);
        if (!bySource) {
          bySource = {};
          capabilities.set(key, bySource);
        }
        let byEffortOut = bySource[source];
        if (!byEffortOut) {
          byEffortOut = {};
          bySource[source] = byEffortOut;
        }
        if (!(output in byEffortOut)) byEffortOut[output] = { capability, confidence };
      }
    }
  };
  emit('terminal_bench', terminal.cells, terminal.reference);
  emit('lmarena', lmarena.cells, lmarena.reference);
  emit('livebench', livebench.cells, livebench.reference);

  return {
    sources: buildSources(snapshots, date),
    evidence: assembleEvidence({ models: catalog.models, scores, capabilities, date }),
    warnings,
    date,
  };
}

const HEADER = `// Generated by scripts/check-evidence.mjs from the committed snapshots under data/evidence/__DATE__/:
//   node scripts/check-evidence.mjs --write
// Do not edit by hand. The default run prints a diff; the check reports drift from the committed snapshots.
//
// Capability is a benchmark-derived policy prior, never measured task adequacy. Only a (model, effort) cell a source
// measured becomes capability; unknown stays unknown and nothing is interpolated across efforts. Each source turns
// each metric into a percentile over its measured reference models, applies the fixed activity weight table from the
// generator to a composite in 0..1, then maps it to the router's 0..3 half-step scale through the router's policy
// seeds (Haiku 5.5 high = 1, Opus 5.5 medium = 2, Opus 5.5 xhigh = 3) where that source measured the exact cell. A
// source that measures fewer than two of those cells cannot fit the curve: its cells use the documented linear
// fallback and are marked \`low\`. A cell several sources measured averages their mapped values and takes the weakest
// confidence. No bundled snapshot measures two anchor cells, so every capability below is \`low\` confidence.
// LiveBench is model-level: it adds scores for every model and capability only in the \`default\` cell of a model
// with \`efforts: []\`. models.dev supplies identity, aliases and effort support; LiteLLM is recorded as the catalog
// cross-check and supplies no score. The activity weights and the calibration rule live in one place: the comments
// at the top of the generator.`;

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function quote(text) {
  return `'${text.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}

function literal(value) {
  if (typeof value === 'string') return quote(value);
  if (value === null) return 'null';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (typeof value === 'boolean') return String(value);
  throw new Error(`evidence render: unsupported value ${typeof value}`);
}

function renderValue(value, indent) {
  const pad = '  '.repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const items = value.map((item) => `${pad}  ${renderValue(item, indent + 1)},`);
    return `[\n${items.join('\n')}\n${pad}]`;
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 0) return '{}';
    const items = keys.map((key) => {
      const name = IDENTIFIER.test(key) ? key : quote(key);
      return `${pad}  ${name}: ${renderValue(value[key], indent + 1)},`;
    });
    return `{\n${items.join('\n')}\n${pad}}`;
  }
  return literal(value);
}

/** Deterministic, unformatted generated source. Biome formatting happens in the CLI path. */
export function renderEvidence({ sources, evidence, date = SNAPSHOT }) {
  const header = HEADER.replace('__DATE__', date);
  return [
    header,
    '',
    `export const EVIDENCE_SOURCES = ${renderValue(sources, 0)};`,
    '',
    `export const EVIDENCE = ${renderValue(evidence, 0)};`,
    '',
  ].join('\n');
}

function formatWithBiome(content) {
  try {
    return execFileSync(BIOME, ['format', '--stdin-file-path', 'lib/evidence.mjs'], {
      input: content,
      encoding: 'utf8',
      cwd: ROOT,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`biome format failed, run npm run setup: ${message}`);
  }
}

/** A compact unified diff of two texts: enough to see what the check wants to change. */
export function diffText(before, after, context = 2) {
  const left = before.split('\n');
  const right = after.split('\n');
  const rows = left.length + 1;
  const columns = right.length + 1;
  const table = Array.from({ length: rows }, () => new Uint32Array(columns));
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      table[i][j] = left[i] === right[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      ops.push({ type: ' ', text: left[i] });
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      ops.push({ type: '-', text: left[i] });
      i += 1;
    } else {
      ops.push({ type: '+', text: right[j] });
      j += 1;
    }
  }
  while (i < left.length) {
    ops.push({ type: '-', text: left[i] });
    i += 1;
  }
  while (j < right.length) {
    ops.push({ type: '+', text: right[j] });
    j += 1;
  }

  const changed = ops.map((op, index) => (op.type === ' ' ? -1 : index)).filter((index) => index >= 0);
  if (changed.length === 0) return '';
  const lines = [];
  let cursor = 0;
  while (cursor < changed.length) {
    const start = Math.max(0, changed[cursor] - context);
    let end = changed[cursor];
    while (cursor + 1 < changed.length && changed[cursor + 1] - end <= context * 2 + 1) {
      cursor += 1;
      end = changed[cursor];
    }
    end = Math.min(ops.length - 1, end + context);
    const slice = ops.slice(start, end + 1);
    const leftCount = slice.filter((op) => op.type !== '+').length;
    const rightCount = slice.filter((op) => op.type !== '-').length;
    const leftStart = ops.slice(0, start).filter((op) => op.type !== '+').length + 1;
    const rightStart = ops.slice(0, start).filter((op) => op.type !== '-').length + 1;
    lines.push(`@@ -${leftStart},${leftCount} +${rightStart},${rightCount} @@`);
    for (const op of slice) lines.push(`${op.type}${op.text}`);
    cursor += 1;
  }
  return `${lines.join('\n')}\n`;
}

function summarize({ evidence, date }) {
  const lines = [`Evidence ${date}: ${Object.keys(evidence).length} models`];
  for (const [key, entry] of Object.entries(evidence)) {
    const efforts = Object.keys(entry.capability);
    const where = efforts.length > 0 ? efforts.join(', ') : 'no capability';
    const sources = entry.sources.length > 0 ? entry.sources.join(', ') : 'no scores';
    lines.push(`- ${key}: ${where}; ${sources}`);
  }
  return lines.join('\n');
}

function readCurrent() {
  try {
    return readFileSync(EVIDENCE_FILE, 'utf8');
  } catch {
    return null;
  }
}

function main(argv) {
  const unknown = argv.filter((argument) => argument !== '--write');
  if (unknown.length > 0) {
    console.error(`evidence check: unknown argument ${unknown[0]}`);
    return 1;
  }
  let built;
  try {
    built = buildEvidence();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`evidence check: ${message}`);
    return 1;
  }
  for (const warning of built.warnings) console.error(`evidence check: ${warning}`);
  let rendered;
  try {
    rendered = formatWithBiome(renderEvidence(built));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`evidence check: ${message}`);
    return 1;
  }
  const current = readCurrent();
  if (current === rendered) {
    console.log(summarize(built));
    return 0;
  }
  if (current === null) console.log('lib/evidence.mjs does not exist');
  else process.stdout.write(diffText(current, rendered));
  if (argv.includes('--write')) {
    writeFileSync(EVIDENCE_FILE, rendered);
    console.log(`wrote ${EVIDENCE_FILE}`);
    console.log(summarize(built));
    return 0;
  }
  console.error('lib/evidence.mjs is stale: run node scripts/check-evidence.mjs --write');
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = main(process.argv.slice(2));
