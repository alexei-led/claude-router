// Folding other sessions' ledger records into one archive record per session. Each session writes only its own record
// of a kind, so the keys grow by one per session ever run, and the engine reads the whole store file for every
// $.store.get: a start reading thousands of records took seconds. A start folds the settled ones into its archive, so a
// read of the counts kept across sessions takes a few gets. Pure: the hook reads, writes and deletes.
import { LEDGERS } from './ledgers.mjs';
import { isRecord } from './records.mjs';
import { daysBefore, RETAIN_DAYS } from './usage.mjs';

// A session's archive of a kind: `usage:v1:archive:<session id>`. It starts with the kind's prefix, so every reader
// adds it up as one more session's record.
export const archiveKey = (prefix, sessionId) => `${prefix}archive:${sessionId}`;
// The most records one start folds of a kind: each delete rewrites the whole store file, so a large store is folded
// over several starts, in the background.
export const FOLD_BATCH = 100;
// Fewer foldable records than this are left for a later start: a fold writes the archive and deletes each record.
export const FOLD_MIN = 8;
// A dated record whose last day is more than this many days before today is settled: its session has stopped adding
// to it. An undated kind's record is settled when its session's usage record is (settledSessions). The window is long,
// so a session that writes again almost never meets a fold of its record; one that does checks its record against the
// store before it writes (ledgers.mjs, checkDue).
export const SETTLE_DAYS = 30;
// The records one archive write takes in: each chunk is one archive write and a delete per record, each rewriting the
// whole store file, so a fold goes a chunk at a time with pauses between.
export const FOLD_CHUNK = 10;
// The newest per-session auto|manual modes kept (`mode:<session id>`): a resumed session older than these starts by
// the start rule again. Keys list in first-write order.
export const MODES_KEPT = 100;

/**
 * Session modes nothing will read again, deleted in the background: all but the newest MODES_KEPT `mode:<session id>`
 * keys, never `ownMode`.
 * @param {string[]} keys one $.store.keys() listing, in first-write order
 * @param {{ modePrefix: string, ownMode: string }} names
 * @returns {string[]}
 */
export function deadKeys(keys, { modePrefix, ownMode }) {
  const modes = keys.filter((key) => key.startsWith(modePrefix) && key !== ownMode);
  return modes.slice(0, Math.max(0, modes.length - MODES_KEPT));
}

// An archive lists as `folded` the records it took in, `[key, since, size]`, while their deletes are not seen to
// finish: a fold cut off between the archive write and a delete leaves the record in the store, and every reader leaves
// it out, as the archive holds its counts; the next fold deletes it. A record its session wrote again since has another
// `since` or size, so it counts. The list is not part of the record: the activity and savings readers take a record
// with no other field, so every reader and merge takes an archive without it (withoutFolded).
// The stored value's size, and its `since` as its kind reads it: an archive's without its `folded` list, which the
// activity and savings readers refuse.
const sizeOf = (value) => JSON.stringify(value ?? null).length;
const fingerprint = (value, read) => `${read(withoutFolded(value)).since}|${sizeOf(value)}`;

/**
 * The `folded` entry of a record `value` at `key` an archive takes in.
 * @param {(value: unknown) => { since: number | null }} read
 * @returns {[string, number | null, number]}
 */
export const foldedEntry = (key, value, read) => [key, read(withoutFolded(value)).since, sizeOf(value)];

/**
 * The well-formed `folded` entries of an archive's stored value.
 * @returns {Array<[string, number | null, number]>}
 */
export function foldedOf(value) {
  const list = isRecord(value) ? /** @type {{ folded?: unknown }} */ (value).folded : undefined;
  return Array.isArray(list) ? list.filter((one) => Array.isArray(one) && typeof one[0] === 'string') : [];
}

/** A stored value as its kind reads it: an archive without its `folded` list, anything else as it is. */
export function withoutFolded(value) {
  if (!isRecord(value) || !Object.hasOwn(/** @type {object} */ (value), 'folded')) return value;
  const { folded: _list, ...record } = /** @type {{ folded?: unknown }} */ (value);
  return record;
}

/**
 * The archive `archive` (its stored value, undefined for none) with `values`, the records at `keys`, taken in at `now`:
 * their counts merged since `resetAt`, a dated kind's days within RETAIN_DAYS as a session's own record keeps them, and
 * the `folded` list of what it and the archives among `values` still list of the keys in the store when read (`present`)
 * and not deleted since (`done`), then `keys`.
 * @param {{ merge: (values: unknown[], resetAt: unknown) => object, read: (value: unknown) => { since: number | null },
 *   dated?: boolean }} kind
 * @param {{ archive: unknown, keys: string[], values: unknown[], resetAt: unknown, now: number,
 *   present: { has: (key: string) => boolean }, done: Set<string> }} fold
 */
export function archiveValue(kind, { archive, keys, values, resetAt, now, present, done }) {
  const listed = [archive, ...values].flatMap(foldedOf).filter(([key]) => present.has(key) && !done.has(key));
  const merged = kind.merge([archive, ...values].map(withoutFolded), resetAt);
  return {
    ...(kind.dated ? withinRetention(merged, now) : merged),
    folded: [...listed, ...keys.map((key, i) => foldedEntry(key, values[i], kind.read))],
  };
}

// A dated record without its days older than RETAIN_DAYS.
function withinRetention(record, now) {
  const cutoff = daysBefore(now, RETAIN_DAYS);
  const days = /** @type {{ days?: Record<string, unknown> }} */ (record).days ?? {};
  return { ...record, days: Object.fromEntries(Object.entries(days).filter(([day]) => day >= cutoff)) };
}

/**
 * The keys of `entries` (one kind's records, `[key, stored value]`) that an archive among them already holds: readers
 * leave them out, and a fold deletes them.
 * @param {Array<[string, unknown]>} entries
 * @param {{ prefix: string, read: (value: unknown) => { since: number | null } }} kind
 * @returns {Set<string>}
 */
export function absorbedKeys(entries, { prefix, read }) {
  const listed = new Map();
  for (const [key, value] of entries)
    if (key.startsWith(archiveKey(prefix, '')))
      for (const [name, since, size] of foldedOf(value)) listed.set(name, `${since}|${size}`);
  const absorbed = new Set();
  for (const [key, value] of entries) if (listed.get(key) === fingerprint(value, read)) absorbed.add(key);
  return absorbed;
}

// The last day of a dated record that reads whole, null for one that does not (a later release's, say), or undefined
// for one with no day.
function lastDay(stored, read) {
  const value = withoutFolded(stored);
  const record = read(value);
  if (record.since === null) return null;
  const storedDays = isRecord(value) ? /** @type {{ days?: unknown }} */ (value).days : undefined;
  const raw = isRecord(storedDays) ? Object.keys(/** @type {object} */ (storedDays)) : [];
  const days = Object.keys(record.days ?? {});
  if (raw.length !== days.length) return null;
  return days.sort().at(-1);
}

/**
 * The sessions done, as the ids after `prefix` in `entries` (the usage records): those whose record reads whole and has
 * days, none after the settle cutoff. An undated kind folds only their records, as it has no day to tell a running
 * session's record from a finished one's; a session with no usage record, or one this release cannot read, is not done.
 * @param {Array<[string, unknown]>} entries
 * @param {{ prefix: string, read: (value: unknown) => { since: number | null, days?: object }, now: number }} kind
 * @returns {Set<string>}
 */
export function settledSessions(entries, { prefix, read, now }) {
  const cutoff = daysBefore(now, SETTLE_DAYS);
  const settled = new Set();
  for (const [key, value] of entries) {
    if (!key.startsWith(prefix)) continue;
    const last = lastDay(value, read);
    if (typeof last === 'string' && last < cutoff) settled.add(key.slice(prefix.length));
  }
  return settled;
}

/**
 * The keys of `entries` (`[key, stored value]`, other sessions' records of one kind) a start folds into its archive
 * `own`, oldest first: records that read whole and hold counts; in a `dated` kind, those with no day after the settle
 * cutoff; in an undated one, the shared record from before 1.10.3 and those of sessions in `done` (settledSessions).
 * Never `own` itself. None when fewer than FOLD_MIN qualify.
 * @param {Array<[string, unknown]>} entries
 * @param {{ read: (value: unknown) => { since: number | null, days?: object }, dated: boolean, own: string, now: number,
 *   prefix?: string, done?: Set<string> }} kind
 * @returns {string[]}
 */
export function foldKeys(entries, { read, dated, own, now, prefix = '', done = new Set() }) {
  const cutoff = daysBefore(now, SETTLE_DAYS);
  const settled = [];
  for (const [key, value] of entries) {
    if (key === own) continue;
    if (!dated && key.startsWith(prefix) && !done.has(key.slice(prefix.length))) continue;
    const record = read(withoutFolded(value));
    // An empty read is a record this release cannot read whole, as a later release's: folding would drop it.
    if (record.since === null) continue;
    if (dated) {
      const last = lastDay(value, read);
      if (last === null || (last !== undefined && last >= cutoff)) continue;
    }
    settled.push({ key, since: record.since });
  }
  if (settled.length < FOLD_MIN) return [];
  return settled
    .sort((a, b) => a.since - b.since)
    .slice(0, FOLD_BATCH)
    .map(({ key }) => key);
}

const chunked = (keys) =>
  Array.from({ length: Math.ceil(keys.length / FOLD_CHUNK) }, (_, i) =>
    keys.slice(i * FOLD_CHUNK, (i + 1) * FOLD_CHUNK),
  );

/**
 * What a read of the counts kept across sessions read of one kind: its records `[key, stored value]`, those an archive
 * among them already holds (absorbedKeys), the reset they were read against, and every key the store held then.
 * @typedef {{ kind: string, entries: Array<[string, unknown]>, absorbed: Set<string>, resetAt: unknown,
 *   listing: Set<string> }} LedgerRead
 */

/**
 * What a session start folds of what it read, as chunks in order: per kind, the records an archive holds, only
 * deleted, then the settled ones (foldKeys); then `dead` keys nothing reads (deadKeys). A chunk carries `held`, the
 * records as read, so each is read again before it goes, and a fold chunk `present`, the keys the store held, so an
 * archive keeps listing a record it holds while that record is anywhere in the store, a session's own included.
 * @param {LedgerRead[]} read
 * @param {{ sessionId: string, now: number, dead?: string[] }} start
 */
export function foldChunks(read, { sessionId, now, dead = [] }) {
  const usage = read.find((one) => one.kind === 'usage');
  // Without the usage records no session counts as done, so no undated record is folded.
  const done = settledSessions(usage?.entries ?? [], { prefix: LEDGERS.usage.prefix, read: LEDGERS.usage.read, now });
  done.delete(sessionId);
  const chunks = [];
  for (const { kind, entries, absorbed, resetAt, listing } of read) {
    const { prefix, read: readRecord, dated } = LEDGERS[kind];
    const held = new Map(entries);
    chunks.push(...chunked([...absorbed]).map((drop) => ({ kind, drop, held })));
    const keys = foldKeys(
      entries.filter(([key]) => !absorbed.has(key)),
      {
        read: readRecord,
        dated: Boolean(dated),
        own: archiveKey(prefix, sessionId),
        now,
        prefix,
        done,
      },
    );
    chunks.push(...chunked(keys).map((slice) => ({ kind, keys: slice, held, resetAt, present: listing })));
  }
  chunks.push(...chunked(dead).map((drop) => ({ drop })));
  return chunks;
}
