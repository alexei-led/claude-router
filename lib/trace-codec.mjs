// The stored form of replay events (trace:v3). A routed request repeats nearly everything the one before it said, so
// each event is kept as its difference from the last one of its kind: unchanged fields are left out, whole numbers are
// kept as differences, long field names are shortened and times are kept as the time since the previous event. Lossless
// for projected events (traceEvent); the in-memory form is unchanged.

const TYPES = ['initial', 'config', 'request', 'response', 'reset', 'control', 'end'];
const OPERATIONS = ['choose', 'observed', 'continue'];
// Part of the stored format: append only, never reorder or remove.
const KEYS = [
  ...['turn', 'index', 'messageCount', 'generation', 'requestSeq', 'model', 'effort', 'mode', 'engineModel'],
  ...['engineEffort', 'reviewedAt', 'observedFrom', 'requestedModel', 'servedModel', 'usage', 'stopReason', 'ttl'],
  ...['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'output_tokens', 'unanswered'],
  ...['taskProgress', 'facts', 'advice', 'pin', 'keyword', 'nativeModel', 'availableModels', 'held', 'contextKnown'],
  ...['contextTokens', 'hasImages', 'actualHasImages', 'observed', 'expected', 'check', 'edit', 'run', 'delegate'],
  ...['anyCheck', 'nonDocEdit', 'prompt', 'lastTool', 'result', 'error', 'continuation', 'downAllowed', 'progress'],
  ...['midTurn', 'failure', 'signature', 'choice', 'probabilities', 'confidence', 'activity', 'phase', 'uncertain'],
  ...['micro', 'low', 'medium', 'high', 'code', 'debug', 'explore', 'plan', 'review', 'ops', 'docs', 'produce'],
  ...['execute', 'verify', 'report', 'tier', 'floorActivity', 'goal', 'taskPhase', 'route', 'pinned', 'reason'],
  ...['loop', 'configured', 'config', 'cause', 'enabled', 'source', 'provider', 'routingEngine', 'baselineTier'],
  ...['routes', 'activities', 'configuredActivities', 'activityRouting', 'routingMode', 'modes', 'policy', 'models'],
  ...['effortSplitsCache', 'cache', 'context', 'strength', 'contextWindow', 'input', 'cacheRead', 'output', 'billing'],
  ...['efforts', 'capability', 'default', 'imageInput', 'longContext', 'offPeak', 'multiplier', 'lastRoute'],
  ...['lastActivity', 'state', 'resolutions', 'lastRequest', 'historyMeasured', 'hasRoutedDecision', 'requests'],
  ...['switchedAt', 'ineligible', 'suspended', 'servedRoute', 'decision', 'lastMessageCount', 'lastAt'],
  ...['prefixTokens', 'tokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'votes', 'holdUntilTurn'],
];
const SHORT = new Map(KEYS.map((key, i) => [key, `~${i.toString(36)}`]));
// Lists the keys a difference drops; no recorded field or alias is empty.
const REMOVED = '';

const isObject = (v) => v !== null && typeof v === 'object';
const isPlain = (v) => isObject(v) && !Array.isArray(v);
const mapKeys = (v, rename) => {
  if (Array.isArray(v)) return v.map((item) => mapKeys(item, rename));
  if (!isObject(v)) return v;
  return Object.fromEntries(Object.entries(v).map(([key, value]) => [rename(key), mapKeys(value, rename)]));
};
const shorten = (key) => SHORT.get(key) ?? (key.startsWith('~') ? `~~${key}` : key);
const expand = (key) => {
  if (key.startsWith('~~')) return key.slice(2);
  if (!key.startsWith('~')) return key;
  // A later build's alias: reading on would drop the field it names.
  const name = KEYS[Number.parseInt(key.slice(1), 36)];
  if (name === undefined) throw new Error('unknown trace field');
  return name;
};

// Undefined for no difference.
function difference(prior, next) {
  if (prior === next) return undefined;
  if (Number.isSafeInteger(prior) && Number.isSafeInteger(next)) return next - prior;
  if (!isObject(prior) || !isObject(next) || Array.isArray(prior) !== Array.isArray(next)) return next;
  if (Array.isArray(next) && next.length !== prior.length) return next;
  const keys = Object.keys(next).filter((key) => next[key] !== undefined);
  const had = Object.keys(prior).filter((key) => prior[key] !== undefined);
  const known = new Set(had);
  const removed = had.filter((key) => next[key] === undefined);
  // A catalog's order breaks ties, so an object whose keys moved is written whole.
  const order = [...had.filter((key) => next[key] !== undefined), ...keys.filter((key) => !known.has(key))];
  if (order.some((key, i) => key !== keys[i])) return { [REMOVED]: had, ...next };
  const changed = keys.flatMap((key) => {
    const part = difference(known.has(key) ? prior[key] : undefined, next[key]);
    return part === undefined ? [] : [[key, part]];
  });
  if (removed.length) changed.push([REMOVED, removed]);
  return changed.length ? Object.fromEntries(changed) : undefined;
}

// Unchanged parts are shared with `prior`: readers project every event into new objects (traceEvent).
function applied(prior, part) {
  if (part === undefined) return prior;
  if (Number.isSafeInteger(prior) && Number.isSafeInteger(part)) return prior + part;
  if (!isObject(prior) || !isPlain(part)) return part;
  const removed = new Set(part[REMOVED] ?? []);
  const next = Array.isArray(prior)
    ? [...prior]
    : Object.fromEntries(Object.entries(prior).filter(([key]) => !removed.has(key)));
  for (const [key, value] of Object.entries(part)) if (key !== REMOVED) next[key] = applied(next[key], value);
  return next;
}

// What both directions remember: the last body of each kind, the clock, and the last request's place.
function memory() {
  return { bodies: new Map(), clock: 0, request: { turn: 0, index: 0 } };
}

// A reply names its request by how far back it is, and its turn and step by their difference from that request's, so
// all three stay the same from one reply to the next.
function relative(held, type, body, seq, sign) {
  if (type !== 'response') return body;
  const out = { ...body };
  if (Number.isSafeInteger(out.requestSeq)) out.requestSeq = seq - out.requestSeq;
  for (const key of ['turn', 'index']) if (Number.isSafeInteger(out[key])) out[key] += sign * held.request[key];
  return out;
}

/**
 * A projected event (traceEvent): the packer reads these fields, and keeps the rest as differences.
 * @typedef {{ type: string, at: number | null, seq?: number, turn?: number, index?: number,
 *   configured?: object, config?: object,
 *   operations?: ({ kind: string | null, at: number } & Record<string, unknown>)[] } & Record<string, unknown>} TraceInput
 */

/** @returns {(event: TraceInput) => unknown[]} packs one event after those packed before it */
export function tracePacker() {
  const held = memory();
  let position = 0;
  return (event) => {
    position++;
    const { type, at, seq, operations, ...rest } = event;
    // A sequence number out of place is kept, so a damaged record stays recognisably damaged.
    if (seq !== undefined && seq !== position) rest.seq = seq;
    const timed = Number.isSafeInteger(at);
    if (!timed) rest.at = at;
    const body = relative(held, type, rest, seq ?? position, -1);
    if (type === 'request') held.request = { turn: rest.turn ?? 0, index: rest.index ?? 0 };
    const entry = [
      TYPES.indexOf(type),
      timed ? /** @type {number} */ (at) - held.clock : null,
      mapKeys(difference(held.bodies.get(type) ?? {}, body) ?? {}, shorten),
    ];
    held.bodies.set(type, body);
    if (timed) held.clock = /** @type {number} */ (at);
    if (operations)
      entry.push(
        operations.map((operation) => {
          const { kind, at: opAt, ...fields } = operation;
          const slot = `operation:${kind}`;
          const part = difference(held.bodies.get(slot) ?? {}, fields) ?? {};
          held.bodies.set(slot, fields);
          const since = opAt - (timed ? /** @type {number} */ (at) : 0);
          return [OPERATIONS.indexOf(/** @type {string} */ (kind)), since, mapKeys(part, shorten)];
        }),
      );
    return entry;
  };
}

export function packEvents(events) {
  const pack = tracePacker();
  return events.map((event) => pack(event));
}

export function unpackEvents(entries) {
  const held = memory();
  return entries.map(([code, since, packed, operations], i) => {
    const type = TYPES[code];
    if (!type) throw new Error('unknown trace event');
    const decoded = applied(held.bodies.get(type) ?? {}, mapKeys(packed, expand));
    held.bodies.set(type, decoded);
    const event = { type, seq: i + 1, ...relative(held, type, decoded, decoded.seq ?? i + 1, 1) };
    if (since !== null) {
      held.clock += since;
      event.at = held.clock;
    }
    if (type === 'request') held.request = { turn: event.turn ?? 0, index: event.index ?? 0 };
    if (operations)
      event.operations = operations.map(([kindCode, offset, fields]) => {
        const kind = OPERATIONS[kindCode];
        const slot = `operation:${kind}`;
        const next = applied(held.bodies.get(slot) ?? {}, mapKeys(fields, expand));
        held.bodies.set(slot, next);
        return { kind, at: offset + (since === null ? 0 : held.clock), ...next };
      });
    return event;
  });
}
