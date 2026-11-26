// What the records kept across sessions share: savings, activity stats and metrics, and subagents. Each session keeps
// its own record of a kind, with `since` (ms), its first count after a reset; the readout sums them.

export const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// A record whose first count came before the last reset at `resetAt` (ms) reads as `empty()`.
export const afterResetOf = (record, resetAt, empty) =>
  Number.isFinite(resetAt) && record.since !== null && record.since < resetAt ? empty() : record;

// Whether a stored record's first count came at or after `at` (ms): its `since`, or a trace's `startedAt`. A Reset's
// background delete keeps such a record, started over after the reset.
export function startedSince(value, at) {
  const stored = isRecord(value) ? /** @type {{ since?: unknown, startedAt?: unknown }} */ (value) : {};
  const first = stored.since ?? stored.startedAt;
  return typeof first === 'number' && Number.isFinite(first) && first >= at;
}

// The earlier of two `since` values, or null when neither is set.
export function earlierSince(a, b) {
  const since = [a, b].filter(Number.isFinite);
  return since.length ? Math.min(...since) : null;
}
