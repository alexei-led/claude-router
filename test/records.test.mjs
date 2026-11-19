import assert from 'node:assert/strict';
import test from 'node:test';
import { afterResetOf, earlierSince, isRecord } from '../lib/records.mjs';

for (const [name, value, expected] of [
  ['an empty object', {}, true],
  ['an object with fields', { since: 1 }, true],
  ['null', null, false],
  ['undefined', undefined, false],
  ['an array', [], false],
  ['a string', 'record', false],
  ['a number', 3, false],
  ['a function', () => ({}), false],
])
  test(`isRecord: ${name} is ${expected ? '' : 'not '}a record`, () => {
    assert.equal(isRecord(value), expected);
  });

const EMPTY = Object.freeze({ since: null, empty: true });
const empty = () => EMPTY;

for (const [name, since, resetAt, resets] of [
  ['began before the reset', 99, 100, true],
  ['began exactly at the reset', 100, 100, false],
  ['began after the reset', 101, 100, false],
  ['has no first count', null, 100, false],
  ['predates the first count', undefined, 100, false],
  ['began before a reset at 0 ms', -1, 0, true],
  ['began before a reset that is not set', 1, undefined, false],
  ['began before a reset that is null', 1, null, false],
  ['began before a reset that is NaN', 1, Number.NaN, false],
  ['began before a reset that is infinite', 1, Number.POSITIVE_INFINITY, false],
])
  test(`afterResetOf: a record that ${name} ${resets ? 'reads as empty' : 'is kept'}`, () => {
    const record = { since, replies: 2 };
    assert.equal(afterResetOf(record, resetAt, empty), resets ? EMPTY : record);
  });

for (const [name, a, b, expected] of [
  ['both set takes the earlier', 5, 3, 3],
  ['both set, the other way round', 3, 5, 3],
  ['equal values', 4, 4, 4],
  ['only the first set', 7, null, 7],
  ['only the second set', null, 7, 7],
  ['neither set', null, null, null],
  ['undefined and null', undefined, null, null],
  ['a non-finite value is ignored', Number.NaN, 9, 9],
  ['an infinite value is ignored', Number.POSITIVE_INFINITY, 9, 9],
  ['zero is a value', 0, 5, 0],
  ['a negative value', -3, 0, -3],
])
  test(`earlierSince: ${name}`, () => {
    assert.equal(earlierSince(a, b), expected);
  });
