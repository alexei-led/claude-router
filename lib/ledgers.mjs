// The counts kept across sessions, by kind, and this session's own record of each as the router holds it. Pure: the
// hook reads and writes the store.
//
// Each session writes only its own record of a kind, `prefix` and its session id, because $.store has no atomic
// update; the view's `field` shows every session's record since the last reset added up, and `ownField`, where a kind
// has one, this session's alone. One marker, SAVINGS_RESET_KEY, resets them all. `legacy` is the key all sessions
// shared before 1.10.3: it counts as another session's record until a reset deletes it. Another session's records that
// `prune` names are deleted when read. `savings` is no longer written: its records are the undated totals from before
// `usage`, which the All period adds. A start folds settled records into its own archive (ledger-fold.mjs); `dated`
// kinds keep days, which tell a settled record.
import {
  emptyMetrics,
  emptyStore,
  LEGACY_STORE_PREFIX,
  METRICS_PREFIX,
  mergeMetrics,
  mergeStores,
  metricsAfterReset,
  readMetrics,
  readStore,
  STORE_KEY,
  STORE_PREFIX,
  storeAfterReset,
} from './activity-stats.mjs';
import { DECISIONS_PREFIX } from './decisions.mjs';
import { isTraceKey, TRACE_PREFIX } from './replay-trace.mjs';
import { afterReset, emptySavingsStore, mergeSavingsStores, readSavingsStore, SAVINGS_PREFIX } from './savings.mjs';
import {
  emptySubagentStore,
  mergeSubagentStores,
  readSubagentStore,
  SUBAGENT_PREFIX,
  subagentsAfterReset,
} from './subagents.mjs';
import { emptyUsage, mergeUsage, prunedUsage, readUsage, USAGE_PREFIX, usageAfterReset } from './usage.mjs';

export const LEDGERS = {
  usage: {
    prefix: USAGE_PREFIX,
    field: 'usageStore',
    ownField: 'usageSession',
    read: readUsage,
    afterReset: usageAfterReset,
    merge: mergeUsage,
    empty: emptyUsage,
    prune: prunedUsage,
    dated: true,
  },
  savings: {
    prefix: SAVINGS_PREFIX,
    field: 'savingsStore',
    read: readSavingsStore,
    afterReset,
    merge: mergeSavingsStores,
    empty: emptySavingsStore,
  },
  metrics: {
    prefix: METRICS_PREFIX,
    field: 'activityMetrics',
    read: readMetrics,
    afterReset: metricsAfterReset,
    merge: mergeMetrics,
    empty: emptyMetrics,
  },
  subagents: {
    prefix: SUBAGENT_PREFIX,
    field: 'subagentStore',
    ownField: 'subagentSession',
    read: readSubagentStore,
    afterReset: subagentsAfterReset,
    merge: mergeSubagentStores,
    empty: emptySubagentStore,
    dated: true,
  },
  activity: {
    prefix: STORE_PREFIX,
    legacy: STORE_KEY,
    field: 'activityStore',
    read: readStore,
    afterReset: storeAfterReset,
    merge: mergeStores,
    empty: emptyStore,
  },
};
export const LEDGER_KINDS = Object.keys(LEDGERS);

/**
 * What a kind's held record needs of its kind: `dated` kinds keep days.
 * @typedef {{ read: (value: unknown) => object, empty: () => object, dated?: boolean,
 *   afterReset: (record: object, resetAt: unknown) => object }} RecordKind
 *
 * This session's record of a kind as the router holds it: `record`, what the readouts add; `stored`, whether the store
 * holds it; `writtenAt` (ms), when this session last wrote it.
 * @typedef {{ sessionId: string, record: object, stored: boolean, writtenAt: number | null }} HeldRecord
 */

// How long a write keeps a record out of every fold: a fold takes only a record whose session has no usage day in the
// last SETTLE_DAYS (ledger-fold.mjs), far longer.
export const RECHECK_MS = 24 * 60 * 60 * 1000;

/**
 * The held record of `sessionId` for its stored value `stored` of `kind`.
 * @param {RecordKind} kind
 * @returns {HeldRecord}
 */
export const heldRecord = (kind, sessionId, stored) => ({
  sessionId,
  record: kind.read(stored),
  stored: stored !== undefined,
  writtenAt: null,
});

/**
 * Whether `held` is checked against the store right before a write at `at`, as another session's fold may hold it. A
 * record this session never stored is in no fold. A dated record its write within RECHECK_MS gave a recent day is in
 * none either; a check without a write gives it no day. An undated record folds when its session's usage record is
 * settled, and a fold planned before this session's usage write may still be taking it: it is checked before this
 * session first writes it, and once written, that fold's read again leaves it. After that it is safe while `usage`,
 * this session's usage record, was written within RECHECK_MS, or the store holds none, as no fold planned since takes
 * it; `usage` null, not yet read, is not known safe.
 * @param {RecordKind} kind
 * @param {HeldRecord} held
 * @param {HeldRecord | null} usage
 */
export function checkDue(kind, held, at, usage) {
  if (!held.stored) return false;
  const recent = (writtenAt) => writtenAt !== null && at - writtenAt <= RECHECK_MS;
  if (kind.dated) return !recent(held.writtenAt);
  if (held.writtenAt === null) return true;
  if (usage && !usage.stored) return false;
  return !usage || !recent(usage.writtenAt);
}

/**
 * The record of a kind checked against the store, as just read: its stored value `value` (undefined: gone, as a fold
 * took it), and whether an archive holds that value (`absorbed`, a fold cut off before its delete). Gone or held, its
 * counts are the archive's and it starts over; else it is the stored value, which another process of the session may
 * have added to, read since the last reset at `resetAt`.
 * @param {RecordKind} kind
 * @param {{ value: unknown, absorbed: boolean, resetAt: unknown }} store
 * @returns {Partial<HeldRecord>}
 */
export function checkedHeld(kind, { value, absorbed, resetAt }) {
  if (value === undefined) return { record: kind.empty(), stored: false };
  if (absorbed) return { record: kind.empty() };
  return { record: kind.afterReset(kind.read(value), resetAt) };
}

/**
 * The turn `add(record, at)` (the record itself when it adds nothing) on `held`: the record to write, none when the
 * turn adds nothing.
 * @param {HeldRecord} held
 * @param {(record: object, at: number) => object} add
 * @returns {{ patch: Partial<HeldRecord>, write: object | null }}
 */
export function addTurn(held, add, at) {
  const record = add(held.record, at);
  if (record === held.record) return { patch: {}, write: null };
  return { patch: { record, writtenAt: at }, write: record };
}

/**
 * The keys of `keys` (one $.store.keys() listing) that Delete history deletes: every session's records of every kind,
 * decision records and traces. `now`: `sessionId`'s own, as a delete without a read races nothing of this session's,
 * and the shared record from before 1.10.3, which has no first count for the reset marker to hide. `later`: every other
 * session's, from a timer, each read again first, as they may be many.
 * @returns {{ now: string[], later: string[] }}
 */
export function historyKeys(keys, sessionId) {
  const first = new Set([
    ...Object.values(LEDGERS).flatMap((kind) => [`${kind.prefix}${sessionId}`, ...(kind.legacy ? [kind.legacy] : [])]),
    `${DECISIONS_PREFIX}${sessionId}`,
    `${TRACE_PREFIX}${sessionId}`,
  ]);
  const history = keys.filter(
    (key) =>
      key.startsWith(DECISIONS_PREFIX) ||
      isTraceKey(key) ||
      key === LEGACY_STORE_PREFIX ||
      key.startsWith(`${LEGACY_STORE_PREFIX}:`) ||
      Object.values(LEDGERS).some((kind) => key.startsWith(kind.prefix) || key === kind.legacy),
  );
  return { now: history.filter((key) => first.has(key)), later: history.filter((key) => !first.has(key)) };
}
