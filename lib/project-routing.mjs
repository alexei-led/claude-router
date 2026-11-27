import { ACTIVITIES, DEADLINE_CHOICES_MS, DEFAULTS, sameCell, TIERS, validateConfig } from './config.mjs';

const ROUTE_FIELDS = ['model', 'effort'];
const PATCH_FIELDS = [
  'mode',
  'routingEngine',
  'activityRouting',
  'baselineTier',
  'routes',
  'activities',
  'policy',
  'modes',
  'classifiers',
];
const POLICY_FIELDS = Object.keys(DEFAULTS.policy);
const MODE_FIELDS = Object.keys(DEFAULTS.modes);
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const DIGEST = /^[a-f0-9]{64}$/;
const REVISION = /^[a-f0-9]{32}$/;
const PROJECT_DEADLINE_MAX_MS = Math.max(...DEADLINE_CHOICES_MS);

// Why a project file is refused, in words that name the setting and carry nothing the file holds, so they can be shown.
export class ProjectSettingError extends Error {}

function fields(value, allowed, section) {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${section} must be an object`);
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new Error(`${section} contains an unsupported setting`);
  return Object.entries(value);
}

function routeFields(route, section) {
  for (const [key, value] of fields(route, ROUTE_FIELDS, section)) {
    if (key === 'model' && typeof value !== 'string') throw new Error(`${section}.model must name a profile model`);
  }
}

// What a person is told when a project's local file applies: setting names only. Null when it sets nothing.
/**
 * @param {string} file
 * @param {string[]} settings
 */
export function projectFileNotice(file, settings) {
  return settings.length ? `Project .claude/${file} changes ${settings.join(', ')}: /router to review` : null;
}

// Compose on the validated profile, not the provider defaults or the raw profile file. Only these trees can change;
// in particular the classifier catalogue and all evidence, credentials and provider dependencies stay profile-owned.
export function applyRoutingPatch(base, patch, stored = false) {
  const next = { ...base };
  for (const [key, value] of fields(patch, stored ? [...PATCH_FIELDS, 'classifier'] : PATCH_FIELDS, 'routing patch')) {
    if (key === 'routes') {
      next.routes = { ...base.routes };
      for (const [tier, route] of fields(value, TIERS, 'routes')) {
        routeFields(route, `routes.${tier}`);
        next.routes[tier] = { ...base.routes[tier], ...route };
      }
    } else if (key === 'activities') {
      next.activities = { ...base.activities };
      for (const [activity, tiers] of fields(value, ACTIVITIES, 'activities')) {
        const inherited = base.activities[activity];
        const row = { ...inherited };
        for (const [tier, route] of fields(tiers, TIERS, `activities.${activity}`)) {
          if (route !== null) routeFields(route, `activities.${activity}.${tier}`);
          if (route === null || Object.keys(route).length)
            row[tier] = route === null ? null : { ...inherited?.[tier], ...route };
        }
        next.activities[activity] = row;
      }
    } else if (key === 'policy') {
      fields(value, POLICY_FIELDS, 'policy');
      next.policy = { ...base.policy, ...value };
    } else if (key === 'modes') {
      next.modes = { ...base.modes };
      for (const [mode, entry] of fields(value, MODE_FIELDS, 'modes')) {
        fields(entry, ['policy'], `modes.${mode}`);
        if (!Object.hasOwn(entry, 'policy')) continue;
        fields(entry.policy, POLICY_FIELDS, `modes.${mode}.policy`);
        next.modes[mode] = { policy: { ...base.modes[mode]?.policy, ...entry.policy } };
      }
    } else if (key === 'classifiers') {
      next.classifiers = { ...base.classifiers };
      for (const [id, entry] of fields(value, Object.keys(base.classifiers), 'classifiers')) {
        fields(entry, ['timeoutMs'], 'classifier deadline');
        // A cloned repository must not make every turn wait longer than the pane could ask for.
        if (!stored && entry.timeoutMs > PROJECT_DEADLINE_MAX_MS)
          throw new ProjectSettingError(`sets classifiers.${id}.timeoutMs above ${PROJECT_DEADLINE_MAX_MS} ms`);
        next.classifiers[id] = { ...base.classifiers[id], ...entry };
      }
    } else {
      next[key] = value;
    }
  }
  validateConfig(next);
  return next;
}

// The verifier is a separate domain-separated digest, not a copy of the lookup digest or a stored absolute path.
export function readRoutingPreference(value, identity, base) {
  if (value === undefined) return { record: null, config: base, error: null, resettable: false };
  const owned = Boolean(
    value && Object.hasOwn(value, 'identity') && DIGEST.test(identity) && value.identity === identity,
  );
  try {
    if (!owned) throw new Error('scope mismatch');
    fields(value, ['version', 'identity', 'revision', 'patch'], 'project preference');
    if (value.version !== 1 || typeof value.revision !== 'string' || !REVISION.test(value.revision))
      throw new Error('invalid envelope');
    return { record: value, config: applyRoutingPatch(base, value.patch, true), error: null, resettable: true };
  } catch {
    return {
      record: null,
      config: base,
      error: owned
        ? 'stored project routing overrides are invalid. Clear overrides to recover'
        : 'stored project routing overrides have an unverified identity. Check the active profile and plugin storage',
      resettable: owned,
    };
  }
}

// The edited value and what it replaces, independent of unrelated fields in the current record. An activity cell
// may be explicitly null; walking through it is a conflict, even if the target leaf is otherwise absent.
export function routingEdits(before, after, path = []) {
  const out = [];
  for (const key of new Set([...Object.keys(after), ...Object.keys(before)])) {
    const [a, b] = [before[key], after[key]];
    if (a === b) continue;
    if ((isRecord(a) || a === undefined) && (isRecord(b) || b === undefined) && (isRecord(a) || isRecord(b)))
      out.push(...routingEdits(a ?? {}, b ?? {}, [...path, key]));
    else if (JSON.stringify(a) !== JSON.stringify(b))
      out.push(Object.hasOwn(after, key) ? { path: [...path, key], value: b } : { path: [...path, key] });
  }
  return out;
}

function atPath(tree, path) {
  let node = tree;
  for (const key of path) {
    if (node === null) return null;
    if (node === undefined || !Object.hasOwn(node, key)) return undefined;
    node = node[key];
  }
  return node;
}

export function routingConflict(edits, snapshot, current) {
  return edits.some(({ path }) => {
    const before = atPath(snapshot, path);
    const now = atPath(current, path);
    if (before === now) return false;
    // Whole activity cell transitions compare both route fields, regardless of JSON member order.
    if (before && now && typeof before === 'object' && typeof now === 'object') return !sameCell(before, now);
    return true;
  });
}

function removeKey(node, key) {
  // biome-ignore lint/nursery/noDynamicDelete: the key comes from a config path, and the tree is a private clone
  delete node[key];
}

// Copy the path, not the graph: built-in activity rows can share one route object.
function editAt(node, path, leaf) {
  const [key, ...rest] = path;
  const next = { ...node };
  if (!rest.length) {
    if (Object.hasOwn(leaf, 'value')) next[key] = leaf.value;
    else removeKey(next, key);
    return next;
  }
  if (!isRecord(node?.[key]) && !Object.hasOwn(leaf, 'value')) return next;
  const branch = editAt(isRecord(node?.[key]) ? node[key] : {}, rest, leaf);
  if (Object.keys(branch).length) next[key] = branch;
  else removeKey(next, key);
  return next;
}

// Apply just the intended leaves. Other leaves of the freshly read patch stay as they are.
export function applyRoutingEdits(patch, edits) {
  return edits.reduce((current, { path, ...leaf }) => editAt(current, path, leaf), patch);
}
