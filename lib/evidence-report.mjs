// Coverage of the local evidence overlay: which effort/activity cells it fills, where confidence is low, and which
// configured model ids it does not cover. Pure: scripts/evidence-report.mjs reads the files and prints.
import { ACTIVITIES, EFFORTS } from './config.mjs';

/**
 * @typedef {object} EffortCells
 * @property {string} effort
 * @property {Record<string, number>} activities Effective values, with a missing activity taking the effort default.
 * @property {string[]} unknown Activities with neither their own value nor an effort default.
 * @property {number | null} default
 * @property {string | null} confidence
 * @typedef {object} ModelCells
 * @property {string} model
 * @property {string[]} aliases
 * @property {EffortCells[]} efforts
 * @property {boolean} noCapability
 * @property {string[]} lowConfidence
 * @typedef {object} OverlaySummary
 * @property {string | null} checked
 * @property {string | null} source
 * @property {string | null} tier
 * @property {ModelCells[]} models
 * @property {Array<{ model: string, effort: string }>} lowConfidence
 * @property {Array<{ model: string, effort: string, activity: string }>} missing
 * @property {string[]} noCapability
 * @typedef {{ path: string, json: unknown }} ProfileText
 * @typedef {{ profile: string, alias: string, id: string }} ConfiguredModel
 * @typedef {ConfiguredModel & { evidence: string | null, covered: boolean }} ConfiguredCoverage
 */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/** A finite number, or null for anything else (Unknown stays absent, never zero). */
const asNumber = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** Normalize one effort's capability (a number or an activity map) to numeric activity values. */
function activityValues(value) {
  /** @type {Record<string, number>} */
  const values = {};
  if (typeof value === 'number') {
    const shared = asNumber(value);
    if (shared !== null) values.default = shared;
    return values;
  }
  if (!isObject(value)) return values;
  for (const key of [...ACTIVITIES, 'default']) {
    const number = asNumber(value[key]);
    if (number !== null) values[key] = number;
  }
  return values;
}

/**
 * The effort cells an overlay entry fills, in effort order. An activity without its own value uses the same
 * effort's `default`; only a cell with neither stays unknown.
 * @param {unknown} entry
 * @returns {EffortCells[]}
 */
export function effortCells(entry) {
  const source = isObject(entry) ? entry : {};
  const capability = isObject(source.capability) ? source.capability : {};
  const confidence = isObject(source.confidence) ? source.confidence : {};
  /** @type {EffortCells[]} */
  const cells = [];
  for (const effort of EFFORTS) {
    const value = capability[effort];
    if (value === undefined || value === null) continue;
    const values = activityValues(value);
    const fallback = values.default ?? null;
    /** @type {Record<string, number>} */
    const activities = {};
    /** @type {string[]} */
    const unknown = [];
    for (const activity of ACTIVITIES) {
      const cell = values[activity] ?? fallback;
      if (cell === null) unknown.push(activity);
      else activities[activity] = cell;
    }
    const level = typeof confidence[effort] === 'string' ? confidence[effort] : null;
    cells.push({ effort, activities, unknown, default: fallback, confidence: level });
  }
  return cells;
}

/** @returns {ModelCells} */
export function summarizeEntry(model, entry) {
  const source = isObject(entry) ? entry : {};
  const aliases = Array.isArray(source.aliases) ? source.aliases.filter((alias) => typeof alias === 'string') : [];
  const efforts = effortCells(entry);
  const noCapability = efforts.length === 0 || efforts.every((cell) => cell.unknown.length === ACTIVITIES.length);
  const lowConfidence = efforts.filter((cell) => cell.confidence === 'low').map((cell) => cell.effort);
  return { model, aliases, efforts, noCapability, lowConfidence };
}

/**
 * Coverage of a whole overlay: every model's cells plus the flattened unknown and low-confidence cells.
 * @param {unknown} overlay
 * @returns {OverlaySummary}
 */
export function summarizeOverlay(overlay) {
  const root = isObject(overlay) ? overlay : {};
  const entries = isObject(root.entries) ? root.entries : {};
  const models = Object.entries(entries).map(([model, entry]) => summarizeEntry(model, entry));
  /** @type {OverlaySummary} */
  const summary = {
    checked: typeof root.checked === 'string' ? root.checked : null,
    source: typeof root.source === 'string' ? root.source : null,
    tier: typeof root.tier === 'string' ? root.tier : null,
    models,
    lowConfidence: models.flatMap((model) => model.lowConfidence.map((effort) => ({ model: model.model, effort }))),
    missing: models.flatMap((model) =>
      model.efforts.flatMap((cell) =>
        cell.unknown.map((activity) => ({ model: model.model, effort: cell.effort, activity })),
      ),
    ),
    noCapability: models.filter((model) => model.noCapability).map((model) => model.model),
  };
  return summary;
}

/** A model id without the long-context suffix, which the overlay keys and aliases do not carry. */
export function canonicalModelId(id) {
  return typeof id === 'string' ? id.trim().replace(/\[1m\]$/, '') : '';
}

/** Maps every overlay entry key and alias to the entry that owns it. */
export function overlayAliasIndex(overlay) {
  const root = isObject(overlay) ? overlay : {};
  const entries = isObject(root.entries) ? root.entries : {};
  /** @type {Map<string, string>} */
  const index = new Map();
  for (const [model, entry] of Object.entries(entries)) {
    index.set(canonicalModelId(model), model);
    if (!isObject(entry) || !Array.isArray(entry.aliases)) continue;
    for (const alias of entry.aliases) {
      const canonical = canonicalModelId(alias);
      if (canonical !== '' && !index.has(canonical)) index.set(canonical, model);
    }
  }
  return index;
}

/**
 * The model ids the profiles configure, read from `models.<alias>.id`. Every other profile field is ignored.
 * @param {ProfileText[]} profiles
 * @returns {ConfiguredModel[]}
 */
export function configuredModels(profiles) {
  /** @type {ConfiguredModel[]} */
  const models = [];
  for (const profile of profiles) {
    const path = typeof profile.path === 'string' ? profile.path : '';
    const json = isObject(profile.json) ? profile.json : {};
    if (!isObject(json.models)) continue;
    for (const [alias, model] of Object.entries(json.models)) {
      const id = typeof model === 'string' ? model : isObject(model) && typeof model.id === 'string' ? model.id : null;
      if (id !== null) models.push({ profile: path, alias, id });
    }
  }
  return models;
}

/**
 * Each configured model id joined to the overlay entry whose key or alias matches it after the `[1m]` suffix is
 * stripped.
 * @param {unknown} overlay
 * @param {ProfileText[]} profiles
 * @returns {ConfiguredCoverage[]}
 */
export function configuredCoverage(overlay, profiles) {
  const index = overlayAliasIndex(overlay);
  return configuredModels(profiles).map((model) => {
    const evidence = index.get(canonicalModelId(model.id)) ?? null;
    return { ...model, evidence, covered: evidence !== null };
  });
}
