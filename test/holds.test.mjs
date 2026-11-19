import assert from 'node:assert/strict';
import test from 'node:test';

process.env.TZ = 'UTC';

const { loadConfig } = await import('../lib/config.mjs');
const { backText, heldCause, heldRows, heldWhy, holdsText, releaseRow } = await import('../lib/holds.mjs');

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const now = Date.parse('2026-11-19T10:00:00Z');
const opus = 'claude-opus-5-5';
const glmId = 'glm-5.3[1m]';
const config = loadConfig({
  userFile: {
    models: {
      glm: {
        id: glmId,
        input: 1,
        output: 2,
        cacheRead: 0.1,
        contextWindow: 1_000_000,
        billing: 'credits',
        efforts: ['high', 'max'],
        account: 'zai',
      },
    },
    fallbacks: { opus: ['glm@max'] },
  },
});
const window5h = {
  kind: 'window',
  window: 'five_hour',
  error: 'rate_limit',
  since: now,
  until: now + 9 * HOUR,
  streak: 1,
};
const balance = { kind: 'balance', error: 'billing_error', since: now, until: null, streak: 1 };
const overloaded = { kind: 'availability', error: 'overloaded', since: now, until: now + 10 * MINUTE, streak: 2 };

for (const [name, until, expected] of [
  ['no end', null, 'until released'],
  ['later today', now + 9 * HOUR, 'back 19:00'],
  ['another day this week', now + 2 * DAY, 'back Sat 10:00'],
  ['further than a week', now + 20 * DAY, 'back Dec 9'],
  ['an end that has passed', now - MINUTE, 'back now'],
])
  test(`a hold with ${name} reads "${expected}"`, () => {
    assert.equal(backText(until, now), expected);
  });

test('an account’s row names the models of the account, a model’s row only itself', () => {
  const rows = heldRows(config, { accounts: { plan: window5h }, models: { [glmId]: overloaded } }, now);
  assert.deepEqual(
    rows.map((row) => [row.scope, row.key, row.word, row.name, row.text, row.covers]),
    [
      [
        'account',
        'plan',
        'plan',
        'Claude plan',
        '5h limit · back 19:00',
        ['Fable 5.2', 'Opus 5.5', 'Sonnet 5.5', 'Haiku 5.5'],
      ],
      ['model', glmId, 'glm', 'GLM 5.3', 'overloaded ×2 · back 10:10', []],
    ],
  );
});

test('an account other than the plan is named as configured, and a balance is held until released', () => {
  const [row] = heldRows(config, { accounts: { zai: balance } }, now);
  assert.deepEqual([row?.name, row?.text, row?.covers], ['zai', 'no balance · until released', ['GLM 5.3']]);
});

test('a hold that has ended, and no holds at all, give no rows', () => {
  const ended = { ...overloaded, until: now };
  assert.deepEqual(heldRows(config, { accounts: {}, models: { [opus]: ended } }, now), []);
  assert.deepEqual(heldRows(config, null, now), []);
  assert.deepEqual(heldRows(config, undefined, now), []);
});

test('the cause names the holder of the model the chain step is for', () => {
  const holds = { accounts: { plan: window5h }, models: { [glmId]: overloaded } };
  assert.equal(
    heldCause(config, { holds, fallback: { from: 'opus', step: 1, of: 1 } }, now),
    'Claude plan 5h limit · back 19:00',
  );
  assert.equal(
    heldCause(config, { holds, fallback: { from: 'glm', step: 1, of: 1 } }, now),
    'GLM 5.3 overloaded ×2 · back 10:10',
  );
});

test('without a chain step the one hold running is the cause, and two holds name none', () => {
  const one = { accounts: { plan: window5h }, models: {} };
  assert.equal(heldCause(config, { holds: one, fallback: null }, now), 'Claude plan 5h limit · back 19:00');
  const two = { ...one, models: { [glmId]: overloaded } };
  assert.equal(heldCause(config, { holds: two, fallback: null }, now), null);
  assert.equal(heldCause(config, { holds: null, fallback: null }, now), null);
});

test('the why names the held model and the step, only for a turn a chain target runs', () => {
  const fallback = { from: 'opus', step: 1, of: 2 };
  assert.equal(heldWhy(config, { reason: 'model-held', fallback }), '↷ Opus 5.5 held · fallback 1 of 2');
  assert.equal(heldWhy(config, { reason: 'model-held', fallback: null }), null);
  assert.equal(heldWhy(config, { reason: 'same-tier', fallback }), null);
  assert.equal(heldWhy(config, { reason: 'model-held', fallback: { ...fallback, from: 'gone' } }), null);
});

const holds = { accounts: { plan: window5h }, models: { [glmId]: overloaded } };
for (const [word, expected] of [
  ['plan', 'plan'],
  ['glm', glmId],
  [glmId, glmId],
])
  test(`release ${word} names the hold under ${expected}`, () => {
    assert.equal(releaseRow(config, holds, word, now).row?.key, expected);
  });

const twoOfOne = { accounts: { glm: balance }, models: { [glmId]: overloaded } };

test('an account and a model of the same name release by different words, each its own hold', () => {
  const own = loadConfig({ userFile: { models: { glm: { ...config.models.glm, account: undefined } } } });
  const rows = heldRows(own, twoOfOne, now);
  assert.deepEqual(
    rows.map((row) => [row.scope, row.word]),
    [
      ['account', 'glm'],
      ['model', glmId],
    ],
  );
  assert.equal(new Set(rows.map((row) => row.word)).size, rows.length);
  assert.equal(releaseRow(own, twoOfOne, 'glm', now).row?.scope, 'account');
  assert.equal(releaseRow(own, twoOfOne, glmId, now).row?.scope, 'model');
});

for (const [name, word, held, expected] of [
  [
    'a model held through its account',
    'opus',
    holds,
    'opus is held through Claude plan, not on its own: /router release plan',
  ],
  ['a name that is not held', 'sonnet5', holds, 'Nothing held under that name. Held: plan, glm.'],
  ['no name', undefined, holds, 'Name what to release: plan, glm.'],
  ['no name and nothing held', undefined, {}, 'Nothing is held out of routing.'],
  ['a name when nothing is held', 'plan', {}, 'Nothing is held out of routing.'],
])
  test(`release with ${name} answers in words`, () => {
    assert.equal(releaseRow(config, held, word, now).text, expected);
  });

test('/router holds lists scope, kind, cause and end, and what an account holds out', () => {
  assert.equal(
    holdsText(config, holds, now),
    [
      'Held out of routing:',
      '  plan (account) · window: 5h limit · back 19:00 · holds out Fable 5.2, Opus 5.5, Sonnet 5.5, Haiku 5.5',
      '  glm (model) · availability: overloaded ×2 · back 10:10',
      'End one early with /router release <model|account>.',
    ].join('\n'),
  );
  assert.equal(holdsText(config, {}, now), 'Nothing is held out of routing.');
});
