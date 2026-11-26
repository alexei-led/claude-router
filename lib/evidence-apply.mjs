// Apply the private local evidence overlay to a loaded config. Pure: the caller reads the overlay file.
//
// Precedence is user config > overlay > preset seeds. A model whose alias the user file declares a capability map for
// keeps that map in full; every other model takes the overlay cells its configured efforts support, keeping a preset
// seed where the overlay is silent.
import { ACTIVITIES } from './config.mjs';
import { canonicalModel } from './providers.mjs';

const ACTIVITY_KEYS = [...ACTIVITIES, 'default'];
const ASSIGNMENT = /EVIDENCE_LOCAL\s*=\s*\{/;
const FAST_SUFFIX = '-fast';
const halfStep = (value) => Number.isFinite(value) && value >= 0 && value <= 3 && Number.isInteger(value * 2);
/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function record(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// The overlay's per-effort values are activity maps. Keep only known, valid cells so a malformed row cannot fail a turn.
/**
 * @param {unknown} capability
 * @param {string[]} efforts
 * @returns {Record<string, number | Record<string, number>> | null}
 */
function entryCapability(capability, efforts) {
  if (!record(capability)) return null;
  /** @type {Record<string, number | Record<string, number>>} */
  const out = {};
  for (const effort of efforts) {
    if (!Object.hasOwn(capability, effort)) continue;
    const value = capability[effort];
    if (halfStep(value)) {
      out[effort] = /** @type {number} */ (value);
      continue;
    }
    if (!record(value)) continue;
    /** @type {Record<string, number>} */
    const activities = {};
    for (const activity of ACTIVITY_KEYS)
      if (halfStep(value[activity])) activities[activity] = /** @type {number} */ (value[activity]);
    if (Object.keys(activities).length) out[effort] = activities;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * The entry whose canonical key is `id`, else the one that lists it as an alias.
 * @param {Record<string, unknown>} entries
 * @param {string} id a canonical model id
 * @returns {Record<string, unknown> | null}
 */
function exactEntry(entries, id) {
  for (const [key, entry] of Object.entries(entries)) {
    if (record(entry) && canonicalModel(key) === id) return entry;
  }
  for (const entry of Object.values(entries)) {
    if (!record(entry) || !Array.isArray(entry.aliases)) continue;
    if (entry.aliases.some((alias) => canonicalModel(alias) === id)) return entry;
  }
  return null;
}

// A `-fast` id is the same weights served faster at a higher price, so quality evidence carries over from the base
// id; prices stay the config's. An exact entry wins, and no other suffix is read this way.
/**
 * @param {Record<string, unknown>} entries
 * @param {unknown} id
 * @returns {Record<string, unknown> | null}
 */
function matchEntry(entries, id) {
  if (typeof id !== 'string') return null;
  const canonical = canonicalModel(id);
  const exact = exactEntry(entries, canonical);
  if (exact || !canonical.endsWith(FAST_SUFFIX)) return exact;
  return exactEntry(entries, canonical.slice(0, -FAST_SUFFIX.length));
}

/**
 * @param {{ models?: Record<string, Record<string, unknown>> } | null} userFile
 * @param {string} alias
 */
function declaredCapability(userFile, alias) {
  const models = record(userFile?.models) ? userFile.models : null;
  const patch = models && Object.hasOwn(models, alias) ? models[alias] : null;
  return record(patch) && Object.hasOwn(patch, 'capability');
}

/**
 * Read the generated `export const EVIDENCE_LOCAL = {...};` text without importing it: the hooks runtime refuses a
 * dynamic import, and a static one would fail every session while the optional file is absent.
 * @param {unknown} text
 * @returns {unknown} The exported value, or null when the text does not hold one.
 */
export function parseEvidenceOverlay(text) {
  if (typeof text !== 'string') return null;
  const assignment = ASSIGNMENT.exec(text);
  if (!assignment) return null;
  const start = assignment.index + assignment[0].length - 1;
  const end = text.lastIndexOf('}');
  if (end < start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * @template {object} T
 * @param {T & { models?: Record<string, Record<string, unknown>> }} config A loaded config.
 * @param {unknown} overlay The `EVIDENCE_LOCAL` value, or null when no overlay exists.
 * @param {{ models?: Record<string, Record<string, unknown>> } | null} [userFile] The parsed router.json, for
 *   user-declared capabilities.
 * @returns {T} A new config; the input is never mutated. A bad overlay is ignored.
 */
export function applyEvidenceOverlay(config, overlay, userFile = null) {
  const entries = record(overlay) && record(overlay.entries) ? overlay.entries : null;
  const models = record(config?.models) ? config.models : null;
  if (!entries || !models) return { ...config };
  let changed = false;
  /** @type {Record<string, Record<string, unknown>>} */
  const next = {};
  for (const [alias, spec] of Object.entries(models)) {
    if (!record(spec) || declaredCapability(userFile, alias)) {
      next[alias] = spec;
      continue;
    }
    const entry = matchEntry(entries, spec.id);
    const efforts = Array.isArray(spec.efforts) && spec.efforts.length ? spec.efforts : ['default'];
    const capability = entry ? entryCapability(entry.capability, /** @type {string[]} */ (efforts)) : null;
    if (!capability) {
      next[alias] = spec;
      continue;
    }
    const existing = record(spec.capability) ? spec.capability : {};
    next[alias] = { ...spec, capability: { ...existing, ...capability } };
    changed = true;
  }
  return changed ? /** @type {T} */ ({ ...config, models: next }) : { ...config };
}
