import assert from 'node:assert/strict';
import test from 'node:test';
import { activeHolds, heldModels, holdModel, holdMs, holdText } from '../lib/failover.mjs';

const MINUTE = 60_000;
const now = 1_000_000;
const opus = 'claude-opus-5-5';
const sonnet = 'claude-sonnet-5-5';

for (const [error, ms] of [
  ['rate_limit', 5 * MINUTE],
  ['overloaded', 5 * MINUTE],
  ['server_error', 2 * MINUTE],
  ['model_not_found', 60 * MINUTE],
])
  test(`${error} holds the failed model out for ${ms / MINUTE} min`, () => {
    assert.deepEqual(holdModel({}, opus, error, now), { [opus]: { error, until: now + ms } });
  });

for (const error of [
  'billing_error',
  'authentication_failed',
  'oauth_org_not_allowed',
  'account_on_hold',
  'verification_required',
  'invalid_request',
  'max_output_tokens',
  'cloud_credential_error',
  'unknown',
  undefined,
])
  test(`${error} holds no model out`, () => {
    assert.equal(holdMs(error), null);
    assert.deepEqual(holdModel({}, opus, error, now), {});
  });

for (const [name, at, held] of [
  ['a millisecond before its end', now + 5 * MINUTE - 1, [opus]],
  ['at its end', now + 5 * MINUTE, []],
  ['after its end', now + 5 * MINUTE + 1, []],
])
  test(`a five-minute hold ${name} holds ${held.length ? 'the model' : 'nothing'}`, () => {
    const holds = holdModel({}, opus, 'overloaded', now);
    assert.deepEqual(heldModels(holds, at), held);
  });

test('a new failure drops expired holds and keeps running ones', () => {
  const first = holdModel({}, sonnet, 'server_error', now);
  const second = holdModel(first, opus, 'overloaded', now + MINUTE);
  assert.deepEqual(heldModels(second, now + MINUTE), [sonnet, opus]);
  const third = holdModel(second, 'claude-haiku-5-5', 'rate_limit', now + 3 * MINUTE);
  assert.deepEqual(Object.keys(third), [opus, 'claude-haiku-5-5']);
});

test('a shorter hold does not cut a longer one short, and a longer one extends it', () => {
  const missing = holdModel({}, opus, 'model_not_found', now);
  assert.deepEqual(holdModel(missing, opus, 'server_error', now + MINUTE), missing);
  const busy = holdModel({}, opus, 'server_error', now);
  assert.deepEqual(holdModel(busy, opus, 'overloaded', now + MINUTE)[opus], {
    error: 'overloaded',
    until: now + 6 * MINUTE,
  });
});

test('no hold map and a map with only expired holds hold nothing', () => {
  assert.deepEqual(activeHolds(undefined, now), {});
  assert.deepEqual(heldModels({ [opus]: { error: 'overloaded', until: now } }, now), []);
});

test('a hold without a model id holds nothing', () => {
  assert.deepEqual(holdModel({}, null, 'overloaded', now), {});
});

for (const [hold, at, words] of [
  [{ error: 'overloaded', until: now + 5 * MINUTE }, now, 'overloaded, 5 min'],
  [{ error: 'rate_limit', until: now + 5 * MINUTE }, now + 30_000, 'rate limited, 5 min'],
  [{ error: 'server_error', until: now + 10_000 }, now, 'server error, 1 min'],
  [{ error: 'model_not_found', until: now + 60 * MINUTE }, now, 'model not found, 60 min'],
])
  test(`a hold reads "${words}"`, () => {
    assert.equal(holdText(hold, at), words);
  });
