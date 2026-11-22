// Local evidence probe: tasks graded per activity and demand tier, aggregated into the same capability scale as the
// Artificial Analysis overlay. Pure: the runner (scripts/evidence-probe.mjs) executes and writes; this module only
// validates, grades and aggregates.
import { ACTIVITIES, TIERS } from './config.mjs';

export const CHECK_KINDS = ['exact', 'json-equal', 'contains', 'regex'];
export const PROBE_VERSION = 1;
const LEVEL = new Map(TIERS.map((tier, index) => [tier, index]));

/** Validate a probe manifest; throws one message naming the first problem. */
export function validateProbeManifest(manifest) {
  if (manifest?.version !== PROBE_VERSION || !Array.isArray(manifest.tasks) || !manifest.tasks.length)
    throw new Error('probe manifest must have version 1 and a non-empty tasks list');
  const ids = new Set();
  for (const task of manifest.tasks) {
    if (typeof task.id !== 'string' || !/^[a-z0-9-]+$/.test(task.id) || ids.has(task.id))
      throw new Error('task id must be unique and use lowercase letters, digits and dashes');
    ids.add(task.id);
    if (!ACTIVITIES.includes(task.activity)) throw new Error(`${task.id}: unknown activity`);
    if (!TIERS.includes(task.tier)) throw new Error(`${task.id}: tier must be one of ${TIERS.join(', ')}`);
    if (typeof task.prompt !== 'string' || !task.prompt.trim()) throw new Error(`${task.id}: prompt is required`);
    if (!CHECK_KINDS.includes(task.check?.kind)) throw new Error(`${task.id}: unknown check kind`);
    if (task.check.kind !== 'contains' && !Object.hasOwn(task.check, 'expected'))
      throw new Error(`${task.id}: check.expected is required`);
    if (!Number.isFinite(task.estimateUsd) || task.estimateUsd <= 0)
      throw new Error(`${task.id}: estimateUsd must be positive`);
  }
  return manifest;
}

const asText = (answer) => (typeof answer === 'string' ? answer.trim() : '');

/** Whether an answer passes the task's check. */
export function gradeAnswer(task, answer) {
  const text = asText(answer);
  const { check } = task;
  if (!text) return false;
  if (check.kind === 'exact') return text === asText(check.expected);
  if (check.kind === 'contains') return text.includes(asText(check.expected));
  if (check.kind === 'regex') {
    try {
      return new RegExp(check.expected).test(text);
    } catch {
      return false;
    }
  }
  try {
    return JSON.stringify(JSON.parse(text)) === JSON.stringify(check.expected);
  } catch {
    return false;
  }
}

/**
 * The capability a set of tier results supports: the highest tier whose pass rate clears `passBar`, or 0 when micro
 * was attempted and failed, or null when too few attempts exist to decide. A next tier that is partly adequate
 * (at least half the bar) adds a half-step. `tiers` maps micro/low/medium/high to `{ passed, attempts }`.
 */
export function probeCapability(tiers, { passBar = 0.8, minAttempts = 3 } = {}) {
  /** @type {number | null} */
  let level = null;
  let partial = false;
  for (const tier of TIERS) {
    const stat = tiers?.[tier];
    if (!stat || stat.attempts < minAttempts) break;
    const rate = stat.passed / stat.attempts;
    if (rate >= passBar) level = LEVEL.get(tier) ?? null;
    else {
      if (level !== null && rate >= passBar / 2) partial = true;
      break;
    }
  }
  if (level === null) {
    const micro = tiers?.micro;
    return micro && micro.attempts >= minAttempts ? 0 : null;
  }
  return partial ? level + 0.5 : level;
}

const addAttempt = (bucket, passed) => {
  const stat = bucket ?? { passed: 0, attempts: 0 };
  stat.passed += passed ? 1 : 0;
  stat.attempts += 1;
  return stat;
};

function capabilityOf(tiers, options) {
  const capability = probeCapability(tiers, options);
  const attempts = Object.values(tiers).reduce((sum, stat) => sum + stat.attempts, 0);
  const passRate = attempts ? Object.values(tiers).reduce((sum, stat) => sum + stat.passed, 0) / attempts : null;
  const confidence = attempts >= 12 ? 'high' : attempts >= 6 ? 'medium' : 'low';
  return { capability, attempts, passRate, confidence, tiers };
}

/**
 * Aggregates graded rows (`{ model, effort, activity, tier, passed }`) into probe entries keyed by canonical model
 * id: `capability[effort][activity]` plus the underlying `tiers` statistics. `default` aggregates every activity.
 * `checked` and `aliases` come from the caller; aliases default to the model id itself.
 * @param {Array<{ model: string, effort: string, activity: string, tier: string, passed: boolean }>} rows
 * @param {{ checked?: string, aliases?: Record<string, string[]>, options?: { passBar?: number, minAttempts?: number } }} [meta]
 */
export function aggregateProbe(rows, { checked, aliases = {}, options = {} } = {}) {
  /** @type {Record<string, any>} */
  const entries = {};
  for (const row of rows) {
    if (!row || !TIERS.includes(row.tier) || !ACTIVITIES.includes(row.activity)) continue;
    if (typeof row.model !== 'string' || !row.model || typeof row.effort !== 'string' || !row.effort) continue;
    let entry = entries[row.model];
    if (!entry) {
      entry = { aliases: aliases[row.model] ?? [row.model], capability: {}, probe: {} };
      entries[row.model] = entry;
    }
    let effort = entry.probe[row.effort];
    if (!effort) {
      effort = { activities: {} };
      entry.probe[row.effort] = effort;
    }
    let activity = effort.activities[row.activity];
    if (!activity) {
      activity = {};
      effort.activities[row.activity] = activity;
    }
    activity[row.tier] = addAttempt(activity[row.tier], row.passed === true);
    effort.default ??= {};
    effort.default[row.tier] = addAttempt(effort.default[row.tier], row.passed === true);
  }
  for (const entry of Object.values(entries)) {
    for (const [effort, stat] of Object.entries(entry.probe)) {
      /** @type {Record<string, any>} */
      const activities = {};
      for (const [activity, tiers] of Object.entries(stat.activities))
        activities[activity] = capabilityOf(tiers, options);
      const overall = capabilityOf(stat.default, options);
      activities.default = overall;
      entry.capability[effort] = Object.fromEntries(
        Object.entries(activities)
          .filter(([, value]) => value.capability !== null)
          .map(([activity, value]) => [activity, value.capability]),
      );
      entry.confidence = entry.confidence ?? {};
      entry.confidence[effort] = overall.confidence;
      entry.probe[effort] = { activities, attempts: overall.attempts, passRate: overall.passRate };
      // The raw per-tier counters are folded into the per-activity statistics above.
      delete entry.probe[effort].default;
    }
    entry.checked = checked;
    entry.sources = ['probe'];
  }
  return entries;
}

/**
 * Merge probe entries into an Artificial Analysis overlay: a probe value replaces the benchmark prior for the same
 * model, effort and activity, and its statistics are kept beside it. Models the overlay does not have are added.
 */
export function mergeProbe(entries, probe) {
  for (const [model, source] of Object.entries(probe)) {
    let entry = entries[model];
    if (!entry) {
      entry = { aliases: source.aliases, capability: {}, scores: {}, confidence: {} };
      entries[model] = entry;
    }
    entry.probe = source.probe;
    entry.aliases = [...new Set([...(entry.aliases ?? []), ...(source.aliases ?? [])])];
    entry.sources = [...new Set([...(entry.sources ?? []), 'probe'])];
    for (const [effort, capability] of Object.entries(source.capability)) {
      entry.capability[effort] = { ...(entry.capability[effort] ?? {}), ...capability };
      entry.confidence[effort] = source.confidence[effort];
    }
  }
  return entries;
}
