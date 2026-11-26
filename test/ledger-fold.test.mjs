import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyMetrics, emptyStore, readMetrics, readStore } from '../lib/activity-stats.mjs';
import {
  absorbedKeys,
  archiveKey,
  archiveValue,
  deadKeys,
  FOLD_BATCH,
  FOLD_MIN,
  foldChunks,
  foldedEntry,
  foldKeys,
  MODES_KEPT,
  settledSessions,
  withoutFolded,
} from '../lib/ledger-fold.mjs';
import { LEDGERS } from '../lib/ledgers.mjs';
import { emptySavingsStore, readSavingsStore } from '../lib/savings.mjs';
import { readUsage } from '../lib/usage.mjs';

const NOW = new Date(2026, 10, 25, 12).getTime();
const USAGE = 'usage:v1:';
const METRICS = 'activity:metrics:v1:';
const OWN = archiveKey(USAGE, 'me');

const day = {
  cells: {},
  uncompared: {},
  whatIf: {},
  yours: {},
  hours: {},
  turns: 1,
  switches: { tier: 0, activity: 0 },
};
const usageOn = (last, since = 1) => ({ version: 3, since, days: { [last]: day } });
const metrics = (since) => ({ ...emptyMetrics(), since });
const usageKind = { read: readUsage, dated: true, own: OWN, now: NOW };
const metricsKind = { read: readMetrics, dated: false, own: archiveKey(METRICS, 'me'), now: NOW };
const sessions = (n, value) => Array.from({ length: n }, (_, i) => [`${USAGE}s${i}`, value(i)]);

test('fewer settled records than the fold minimum are left for a later start', () => {
  assert.deepEqual(
    foldKeys(
      sessions(FOLD_MIN - 1, () => usageOn('2026-09-01')),
      usageKind,
    ),
    [],
  );
});

test('a dated record is settled once its last day is more than thirty days before today', () => {
  for (const [last, folds] of [
    ['2026-10-25', true],
    ['2026-10-26', false],
    ['2026-11-25', false],
  ])
    assert.equal(
      foldKeys(
        sessions(FOLD_MIN, () => usageOn(last)),
        usageKind,
      ).length > 0,
      folds,
      last,
    );
});

test('a record this release cannot read whole is never folded', () => {
  const later = { version: 9, since: 1, days: { '2026-11-01': day } };
  const keys = foldKeys([...sessions(FOLD_MIN, () => usageOn('2026-09-01')), [`${USAGE}later`, later]], usageKind);
  assert.equal(keys.length, FOLD_MIN);
  assert.ok(!keys.includes(`${USAGE}later`));
});

test('an undated kind folds the records of sessions done, oldest first, at most a batch', () => {
  const entries = Array.from({ length: FOLD_BATCH + 5 }, (_, i) => [`${METRICS}s${i}`, metrics(FOLD_BATCH + 5 - i)]);
  const done = new Set(entries.map(([key]) => key.slice(METRICS.length)));
  const keys = foldKeys(entries, { ...metricsKind, prefix: METRICS, done });
  assert.equal(keys.length, FOLD_BATCH);
  assert.deepEqual(keys.slice(0, 2), [`${METRICS}s${FOLD_BATCH + 4}`, `${METRICS}s${FOLD_BATCH + 3}`]);
});

test('the session’s own archive is never among the records it folds', () => {
  const entries = [[OWN, usageOn('2026-09-01')], ...sessions(FOLD_MIN, () => usageOn('2026-09-01'))];
  const keys = foldKeys(entries, usageKind);
  assert.deepEqual([keys.includes(OWN), keys.length], [false, FOLD_MIN]);
});

test('a session is done once its usage reads whole and has no day in the last thirty days', () => {
  const entries = [
    [`${USAGE}idle`, usageOn('2026-10-01')],
    [`${USAGE}today`, usageOn('2026-11-25')],
    [`${USAGE}later`, { version: 9, since: 1, days: { '2026-10-01': day } }],
  ];
  assert.deepEqual([...settledSessions(entries, { prefix: USAGE, read: readUsage, now: NOW })], ['idle']);
});

test('an undated record of a session not done, or with no usage record, is never folded', () => {
  const entries = Array.from({ length: FOLD_MIN + 1 }, (_, i) => [`${METRICS}s${i}`, metrics(i + 1)]);
  const done = new Set(Array.from({ length: FOLD_MIN }, (_, i) => `s${i + 1}`));
  const keys = foldKeys(entries, { ...metricsKind, prefix: METRICS, done });
  assert.deepEqual([keys.length, keys.includes(`${METRICS}s0`)], [FOLD_MIN, false]);
});

test('a record an archive lists counts in the archive alone, unless its session wrote it again since', () => {
  const kept = usageOn('2026-11-01');
  const written = { ...usageOn('2026-11-01'), days: { '2026-11-01': day, '2026-11-02': day } };
  const restarted = usageOn('2026-11-01', 7);
  const archive = {
    ...usageOn('2026-11-01'),
    folded: [
      foldedEntry(`${USAGE}kept`, kept, readUsage),
      foldedEntry(`${USAGE}written`, usageOn('2026-11-01'), readUsage),
      foldedEntry(`${USAGE}restarted`, usageOn('2026-11-01'), readUsage),
      ['malformed'],
      'not an entry',
    ],
  };
  const entries = [
    [OWN, archive],
    [`${USAGE}kept`, kept],
    [`${USAGE}written`, written],
    [`${USAGE}restarted`, restarted],
  ];
  assert.deepEqual([...absorbedKeys(entries, { prefix: USAGE, read: readUsage })], [`${USAGE}kept`]);
});

test('all but the newest kept session modes are dead, the session’s own never', () => {
  const keys = [...Array.from({ length: MODES_KEPT + 3 }, (_, i) => `mode:s${i}`), 'usage:v1:x'];
  assert.deepEqual(deadKeys(keys, { modePrefix: 'mode:', ownMode: 'mode:s1' }), ['mode:s0', 'mode:s2']);
});

const SAVINGS = LEDGERS.savings;
const savings = (replies, since = 1) => ({ ...emptySavingsStore(), since, replies });
const savingsReplies = (record) => readSavingsStore(record).replies;

test('an archive taken into another is fingerprinted as its kind reads it, without its folded list', () => {
  const archive = { ...emptyStore(), since: 7, folded: [] };
  assert.equal(foldedEntry('activity:goals:v1:archive:x', archive, readStore)[1], 7);
});

test('an archive is read without its folded list, and lists what is still in the store and not yet deleted', () => {
  const archive = {
    ...savings(5),
    folded: [
      ['savings:v1:gone', 1, 9],
      ['savings:v1:left', 1, 9],
      ['savings:v1:done', 1, 9],
    ],
  };
  assert.deepEqual(withoutFolded(archive), savings(5));
  const plain = savings(5);
  assert.equal(withoutFolded(plain), plain);
  const value = archiveValue(SAVINGS, {
    archive,
    keys: ['savings:v1:new'],
    values: [savings(2)],
    resetAt: null,
    now: NOW,
    present: new Set(['savings:v1:left', 'savings:v1:done', 'savings:v1:new']),
    done: new Set(['savings:v1:done']),
  });
  assert.equal(savingsReplies(withoutFolded(value)), 7);
  assert.deepEqual(value.folded, [['savings:v1:left', 1, 9], foldedEntry('savings:v1:new', savings(2), SAVINGS.read)]);
});

test('a dated archive keeps the days a session’s own record keeps', () => {
  const value = archiveValue(LEDGERS.usage, {
    archive: undefined,
    keys: [`${USAGE}a`, `${USAGE}b`],
    values: [usageOn('2024-01-01'), usageOn('2026-11-01')],
    resetAt: null,
    now: NOW,
    present: new Set(),
    done: new Set(),
  });
  assert.deepEqual(Object.keys(value.days), ['2026-11-01']);
});

test('a start deletes the records an archive holds before it folds, and the dead keys last', () => {
  const settled = Array.from({ length: FOLD_MIN }, (_, i) => [`savings:v1:s${i + 2}`, savings(1, i + 1)]);
  const listing = new Set(['savings:v1:held', ...settled.map(([key]) => key)]);
  const chunks = foldChunks(
    [
      // Their sessions are done: each has a usage record with no recent day.
      {
        kind: 'usage',
        entries: settled.map(([key]) => [key.replace('savings:v1:', USAGE), usageOn('2026-09-01')]),
        absorbed: new Set(),
        resetAt: null,
        listing,
      },
      {
        kind: 'savings',
        entries: [['savings:v1:held', savings(1)], ...settled],
        absorbed: new Set(['savings:v1:held']),
        resetAt: null,
        listing,
      },
    ],
    { sessionId: 's1', now: NOW, dead: ['mode:old'] },
  );
  const savingsChunks = chunks.filter((chunk) => chunk.kind !== 'usage');
  assert.deepEqual(
    savingsChunks.map((chunk) => chunk.drop ?? chunk.keys),
    [['savings:v1:held'], settled.map(([key]) => key), ['mode:old']],
  );
  assert.equal(savingsChunks[1].present, listing);
  assert.ok(!savingsChunks[1].keys.includes(archiveKey('savings:v1:', 's1')));
});
