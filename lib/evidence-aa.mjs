// Artificial Analysis overlay: pure parsing and capability mapping for the free API rows. The fetch and the file write
// live in scripts/aa-evidence.mjs; nothing here reads the network, the clock or a file.
//
// A row names its effort in the display name ("GLM-5.3 (Max)", "Claude Haiku 5.5 (High)"); the free tier exposes no
// `effort` field. Rows without a suffix are the model's default configuration, which the adapter records as `max`
// only when the model's configured efforts include it and the provenance says so.

const QUALIFIERS = /\((.*)\)\s*$/;
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const ACTIVITY_INDEX = {
  default: 'intelligence',
  code: 'engineering',
  debug: 'engineering',
  ops: 'engineering',
  explore: 'intelligence',
  plan: 'intelligence',
  review: 'intelligence',
  docs: 'intelligence',
};

// Capability anchors on the router's 0..3 scale: Haiku 5.5 high = 1, Opus 5.5 medium = 2, Opus 5.5 xhigh = 3,
// all lead-approved policy seeds (lib/config.mjs). Index values are the 2026-11-22 free-API snapshot. The same
// policy anchors are read on each index, so every activity column has its own scale.
export const ANCHORS = {
  intelligence: [
    [29.9, 1],
    [48.2, 2],
    [57.4, 3],
  ],
  engineering: [
    [36.5, 1],
    [53.7, 2],
    [62.9, 3],
  ],
  strategy: [
    [37.1, 1],
    [56, 2],
    [59, 3],
  ],
};

/** @typedef {{ base: string, effort: string | null, assumption: string | null }} AaName */

/**
 * The base model and the effort a display name states, or null for a row the overlay cannot use (non-reasoning).
 * @param {string} name
 * @returns {AaName | null}
 */
export function parseAaName(name) {
  if (typeof name !== 'string' || !name.trim()) return null;
  const match = QUALIFIERS.exec(name);
  const base = name.replace(QUALIFIERS, '').trim();
  const group = match?.[1];
  const qualifiers = group ? group.split(',').map((part) => part.trim().toLowerCase()) : [];
  if (qualifiers.includes('non-reasoning')) return null;
  const effort = EFFORTS.find((level) => qualifiers.includes(level)) ?? null;
  const baseId = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return { base: baseId, effort, assumption: effort === null && qualifiers.includes('reasoning') ? 'reasoning' : null };
}

const roundHalf = (value) => Math.round(value * 2) / 2;
const clamp = (value) => Math.max(0, Math.min(3, value));

/**
 * The capability a benchmark index implies, on the router's 0..3 half-step scale, interpolated through the policy
 * anchors and extrapolated along the end segments. Null when the index is not a finite number.
 * @param {Array<[number, number]>} anchors
 * @param {unknown} index
 * @returns {number | null}
 */
export function capabilityFromIndex(anchors, index) {
  if (typeof index !== 'number' || !Number.isFinite(index) || anchors.length < 2) return null;
  const first = anchors[0];
  const last = anchors[anchors.length - 1];
  const next = anchors[1];
  if (!first || !last || !next) return null;
  const between = (x0, y0, x1, y1) => y0 + ((index - x0) * (y1 - y0)) / (x1 - x0);
  if (index <= first[0]) return clamp(roundHalf(between(first[0], first[1], next[0], next[1])));
  for (let i = 1; i < anchors.length; i += 1) {
    const previous = anchors[i - 1];
    const point = anchors[i];
    if (!previous || !point) continue;
    if (index <= point[0]) return clamp(roundHalf(between(previous[0], previous[1], point[0], point[1])));
  }
  const previous = anchors[anchors.length - 2];
  if (!previous) return null;
  return clamp(roundHalf(between(last[0], last[1], previous[0], previous[1])));
}

/** The activity capabilities one row's evaluations support, as `{ default, code, … }`, or null when none do. */
export function aaCapability(evaluations) {
  /** @type {Record<string, number>} */
  const out = {};
  for (const [activity, key] of Object.entries(ACTIVITY_INDEX)) {
    const value = evaluations?.[`artificial_analysis_${key}_index`];
    const capability = capabilityFromIndex(ANCHORS[key], value);
    if (capability !== null) out[activity] = capability;
  }
  return Object.keys(out).length ? out : null;
}
