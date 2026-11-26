// This session's held record of a kind, and which keys Delete history deletes when.
import assert from 'node:assert/strict';
import test from 'node:test';
import { addTurn, checkDue, checkedHeld, heldRecord, historyKeys, LEDGERS, RECHECK_MS } from '../lib/ledgers.mjs';
import { emptySavingsStore, readSavingsStore } from '../lib/savings.mjs';

const SAVINGS = LEDGERS.savings;
const USAGE = LEDGERS.usage;
const stored = (replies, since = 1) => ({ ...emptySavingsStore(), since, replies });
const reply = (record, at) => ({ ...record, since: record.since ?? at, replies: record.replies + 1 });
const replies = (record) => readSavingsStore(record).replies;
const turnOn = (held, at) => {
  const { patch, write } = addTurn(held, reply, at);
  return { held: { ...held, ...patch, ...(write ? { stored: true } : {}) }, write };
};
// A dated kind's held record, as the usage record is.
const dated = (writtenAt, isStored = true) => ({ ...heldRecord(USAGE, 's1', undefined), stored: isStored, writtenAt });

test('a dated record this session wrote within a day needs no check; one it has not written does', () => {
  assert.equal(checkDue(USAGE, dated(null, false), 0, null), false);
  assert.equal(checkDue(USAGE, dated(null), 0, null), true);
  assert.equal(checkDue(USAGE, dated(10), 10 + RECHECK_MS, null), false);
  assert.equal(checkDue(USAGE, dated(10), 11 + RECHECK_MS, null), true);
});

test('a check alone leaves a record due; only the write after it does not', () => {
  const loaded = { ...heldRecord(SAVINGS, 's1', stored(3)) };
  const checked = { ...loaded, ...checkedHeld(SAVINGS, { value: stored(3), absorbed: false, resetAt: null }) };
  assert.equal(checkDue(USAGE, { ...checked, stored: true }, 5, null), true);
  const { held, write } = turnOn(checked, 5);
  assert.deepEqual([replies(write), held.writtenAt], [4, 5]);
});

test('an undated record is due while this session has a usage record it has not written within a day', () => {
  const metrics = { ...heldRecord(SAVINGS, 's1', stored(3)), writtenAt: 100 };
  assert.equal(checkDue(SAVINGS, metrics, 100, dated(null)), true);
  assert.equal(checkDue(SAVINGS, metrics, 100, dated(100)), false);
  assert.equal(checkDue(SAVINGS, metrics, 100, null), true);
  assert.equal(checkDue(SAVINGS, metrics, 100, dated(null, false)), false);
});

test('with no usage record stored, an undated record is checked before this session first writes it', () => {
  const loaded = heldRecord(SAVINGS, 's1', stored(3));
  const noUsage = dated(null, false);
  assert.equal(checkDue(SAVINGS, loaded, 100, noUsage), true);
  assert.equal(checkDue(SAVINGS, { ...loaded, writtenAt: 100 }, 100 + 2 * RECHECK_MS, noUsage), false);
});

test('an undated record read from the store is checked before this session first writes it, however recent its usage', () => {
  const loaded = heldRecord(SAVINGS, 's1', stored(3));
  assert.equal(checkDue(SAVINGS, loaded, 100, dated(100)), true);
});

test('checked, a record a fold took or an archive holds starts over; one still its own is read as stored now', () => {
  for (const [store, record, isStored] of [
    [{ value: undefined, absorbed: false }, 0, false],
    [{ value: stored(3), absorbed: true }, 0, true],
    [{ value: stored(5), absorbed: false }, 5, true],
  ]) {
    const held = { ...heldRecord(SAVINGS, 's1', stored(3)), ...checkedHeld(SAVINGS, { ...store, resetAt: null }) };
    assert.deepEqual([replies(held.record), held.stored], [record, isStored], JSON.stringify(store));
  }
});

test('a stored value from before the last reset reads as empty when checked', () => {
  const held = checkedHeld(SAVINGS, { value: stored(3, 1), absorbed: false, resetAt: 5 });
  assert.equal(replies(held.record), 0);
});

test('Delete history deletes this session’s records and the shared record from before 1.10.3 at once, the rest later', () => {
  const keys = [
    'usage:v1:s1',
    'usage:v1:s2',
    'usage:v1:archive:s1',
    'decisions:v1:s1',
    'decisions:v1:s2',
    'trace:v2:s1',
    'trace:v1:s1',
    'activity:goals:v1',
    'mode:s1',
    'savings:reset:v1',
  ];
  assert.deepEqual(historyKeys(keys, 's1'), {
    now: ['usage:v1:s1', 'decisions:v1:s1', 'trace:v2:s1', 'activity:goals:v1'],
    later: ['usage:v1:s2', 'usage:v1:archive:s1', 'decisions:v1:s2', 'trace:v1:s1'],
  });
});
