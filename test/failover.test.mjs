import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../lib/config.mjs';
import {
  accountNames,
  accountOfModel,
  activeHolds,
  classifyFailure,
  clearedModel,
  clearedSince,
  failureHold,
  heldAsSeen,
  heldIds,
  heldModels,
  holdCause,
  holdModel,
  holdMs,
  holdText,
  nextReset,
  readHold,
  releaseHold,
} from '../lib/failover.mjs';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const now = Date.parse('2026-11-19T10:00:00Z');
const opus = 'claude-opus-5-5';
const sonnet = 'claude-sonnet-5-5';
const reading = (kind, percent, resetsAt) => ({ kind, label: kind, percent, resetsAt });
const classify = (error, extra = {}) =>
  classifyFailure({
    error,
    details: undefined,
    limits: [],
    billing: 'plan',
    planAccounts: ['plan'],
    account: 'plan',
    accounts: {},
    now,
    ...extra,
  });

const availability = { kind: 'availability', scope: 'model', until: null };
const none = { kind: null, scope: 'model', until: null };

for (const [name, input, expected] of [
  ['an overloaded model', { error: 'overloaded' }, availability],
  ['a server error with no text', { error: 'server_error' }, availability],
  [
    'a server error from a dropped connection',
    { error: 'server_error', details: 'getaddrinfo ENOTFOUND api.anthropic.com' },
    availability,
  ],
  ['a model that is not found', { error: 'model_not_found' }, availability],
  ['a rate limit with no signal', { error: 'rate_limit' }, availability],
  [
    'a rate limit on a window with room left',
    { error: 'rate_limit', limits: [reading('five_hour', 99.9, now + HOUR)] },
    availability,
  ],
  [
    'a rate limit whose full window already reset',
    { error: 'rate_limit', limits: [reading('five_hour', 100, now - MINUTE)] },
    availability,
  ],
  [
    'a rate limit whose full window has no reset time',
    { error: 'rate_limit', limits: [reading('five_hour', 100, null)] },
    availability,
  ],
  [
    'a rate limit with only a spend cap at 100%',
    { error: 'rate_limit', limits: [reading('spend_limit', 120, now + HOUR)] },
    availability,
  ],
  [
    'the 5h window at 100%',
    { error: 'rate_limit', limits: [reading('five_hour', 100, now + 3 * HOUR)] },
    { kind: 'window', scope: 'account', until: now + 3 * HOUR + MINUTE, window: 'five_hour' },
  ],
  [
    'the 7d window at 100% beside a 5h window with room',
    { error: 'rate_limit', limits: [reading('five_hour', 40, now + HOUR), reading('seven_day', 100, now + 2 * DAY)] },
    { kind: 'window', scope: 'account', until: now + 2 * DAY + MINUTE, window: 'seven_day' },
  ],
  [
    'both windows at 100%: the later reset',
    {
      error: 'rate_limit',
      limits: [reading('five_hour', 100, now + HOUR), reading('seven_day', 100.0, now + DAY)],
    },
    { kind: 'window', scope: 'account', until: now + DAY + MINUTE, window: 'seven_day' },
  ],
  [
    'a window whose reset is further than a week',
    { error: 'rate_limit', limits: [reading('seven_day', 100, now + 30 * DAY)] },
    { kind: 'window', scope: 'account', until: now + 7 * DAY, window: 'seven_day' },
  ],
  [
    'a window at 100% beats the text',
    {
      error: 'rate_limit',
      details: 'You have hit your monthly spend limit',
      limits: [reading('five_hour', 100, now + HOUR)],
    },
    { kind: 'window', scope: 'account', until: now + HOUR + MINUTE, window: 'five_hour' },
  ],
  [
    'the monthly spend limit on an account with no reset',
    {
      error: 'rate_limit',
      details: "You've hit your organization's monthly spend limit",
      limits: [reading('five_hour', 30, now + HOUR)],
    },
    { kind: 'calendar', scope: 'account', until: now + DAY },
  ],
  [
    'the monthly spend limit on an account with a reset',
    {
      error: 'rate_limit',
      details: 'Monthly SPEND LIMIT reached',
      accounts: { plan: { reset: { monthly: 1, tz: 'UTC' } } },
    },
    { kind: 'calendar', scope: 'account', until: Date.parse('2026-12-01T00:00:00Z') },
  ],
  [
    'the z.ai balance 429',
    {
      error: 'rate_limit',
      details: '[1113] Insufficient balance or no resource package. Please recharge.',
      billing: 'mixed',
      account: 'zai',
    },
    { kind: 'balance', scope: 'account', until: null },
  ],
  [
    'a rate limit that names credit',
    { error: 'rate_limit', details: 'Your credit balance is too low', billing: 'billed', account: 'deepseek' },
    { kind: 'balance', scope: 'account', until: null },
  ],
  [
    'a Claude plan rate limit that names extra usage credits',
    { error: 'rate_limit', details: "You're out of extra usage credits · resets 7pm" },
    availability,
  ],
  [
    'a Claude plan rate limit that names credit in a session that also bills credits',
    { error: 'rate_limit', details: 'Add credits to keep going', billing: 'mixed' },
    availability,
  ],
  [
    'a rate limit that names credit on the plan account of a session that pays by key',
    { error: 'rate_limit', details: 'Your credit balance is too low', billing: 'billed' },
    { kind: 'balance', scope: 'account', until: null },
  ],
  ['a billing error with no text', { error: 'billing_error' }, { kind: 'balance', scope: 'account', until: null }],
  [
    'a billing error with text',
    { error: 'billing_error', details: 'Please recharge your account' },
    { kind: 'balance', scope: 'account', until: null },
  ],
  [
    'a full window in a session that also bills credits, with one plan account',
    { error: 'rate_limit', billing: 'mixed', limits: [reading('five_hour', 100, now + HOUR)] },
    { kind: 'window', scope: 'account', until: now + HOUR + MINUTE, window: 'five_hour' },
  ],
  [
    'a full window in a session that bills credits, with plan models in two accounts',
    {
      error: 'rate_limit',
      billing: 'mixed',
      planAccounts: ['plan', 'team'],
      limits: [reading('five_hour', 100, now + HOUR)],
    },
    availability,
  ],
  [
    'a full window while the plan models are all in an account other than the plan',
    {
      error: 'rate_limit',
      billing: 'mixed',
      planAccounts: ['team'],
      limits: [reading('five_hour', 100, now + HOUR)],
    },
    availability,
  ],
  [
    'a full window in a session with no plan windows',
    { error: 'rate_limit', billing: 'billed', limits: [reading('five_hour', 100, now + HOUR)] },
    availability,
  ],
  [
    'a full plan window while another account’s model failed',
    { error: 'rate_limit', account: 'zai', limits: [reading('five_hour', 100, now + HOUR)] },
    availability,
  ],
  ['a rejected key', { error: 'authentication_failed' }, none],
  ['a rejected key whose text names credit', { error: 'authentication_failed', details: 'invalid credit key' }, none],
  ['an organization not allowed', { error: 'oauth_org_not_allowed' }, none],
  ['an account on hold', { error: 'account_on_hold' }, none],
  ['an invalid request', { error: 'invalid_request', details: 'recharge' }, none],
  ['an unknown error', { error: 'unknown' }, none],
  ['no error word', { error: undefined }, none],
  ['a quota failure of a model no configured model ran', { error: 'billing_error', account: null }, none],
  [
    'a spend limit on a model no configured model ran',
    { error: 'rate_limit', details: 'spend limit', account: null },
    none,
  ],
  ['an overloaded model no configured model ran', { error: 'overloaded', account: null }, availability],
])
  test(`${name} classifies as ${expected.kind ?? 'nothing to hold'}`, () => {
    assert.deepEqual(classify(input.error, input), expected);
  });

// The texts Claude Code gives for a used-up quota, as found in transcripts, each with a straight and a curly apostrophe.
// The account is billed by key unless `plan` names the Claude plan, whose rate limit is never a balance.
const calendar = { kind: 'calendar', scope: 'account', until: now + DAY };
const balance = { kind: 'balance', scope: 'account', until: null };
for (const [text, expected, extra] of [
  ["You've hit your individual spend limit · run /usage-credits to ask your admin for a higher limit", calendar],
  ["You've hit your monthly spend limit", calendar],
  ["You've hit your org's monthly spend limit", calendar],
  ["You've hit your channel's monthly spend limit", calendar],
  ["You've hit your team's pooled group budget", calendar],
  ["You've hit your individual usage limit", calendar],
  ["You've hit your usage credit limit", calendar],
  ['Usage is paused for your organization', calendar],
  ["You've hit your session limit · resets 7pm (Asia/Jerusalem)", availability],
  ["You've hit your weekly limit · resets Nov 3 at 7am (Asia/Jerusalem)", availability],
  ["You've hit your 5-hour limit · run /usage-credits to continue", availability],
  [
    "You've hit your monthly spend limit · raise it at claude.ai/settings/usage · your 5-hour limit resets 12:40am (Asia/Jerusalem)",
    availability,
  ],
  ['Your credit balance is running low … please recharge', balance],
  ['[1113][Insufficient balance or no resource package. Please recharge.]', balance],
  ["You're out of usage credits", balance],
  ['Your org is out of usage · add funds', balance],
  ["You're out of extra usage", balance],
  ['Fable 5 requires usage credits', balance],
  ['Credit balance is too low', balance],
  ["You're out of usage credits", availability, { account: 'plan', billing: 'plan' }],
  ['Your org is out of usage · add funds', availability, { account: 'plan', billing: 'plan' }],
])
  for (const details of new Set([text, text.replaceAll("'", '\u2019')]))
    test(`"${details}" on ${extra ? 'the plan' : 'a billed account'} classifies as ${expected.kind}`, () => {
      const input = { details, account: 'work-claude', billing: 'billed', ...extra };
      assert.deepEqual(classify('rate_limit', input), expected);
    });

for (const [name, details, expected] of [
  ['a spend cap', "You've hit your individual spend limit", calendar],
  ['a plan window', "You've hit your weekly limit", none],
])
  test(`a billing error that names ${name} classifies as ${expected.kind ?? 'nothing to hold'}`, () => {
    assert.deepEqual(classify('billing_error', { details, account: 'work-claude', billing: 'billed' }), expected);
  });

for (const [name, reset, at, expected] of [
  ['next month on the 1st', { monthly: 1, tz: 'UTC' }, '2026-11-19T10:00:00Z', '2026-12-01T00:00:00Z'],
  ['this month when the day is ahead', { monthly: 25, tz: 'UTC' }, '2026-11-19T10:00:00Z', '2026-11-25T00:00:00Z'],
  ['the next month at the exact reset', { monthly: 1, tz: 'UTC' }, '2026-12-01T00:00:00Z', '2027-01-01T00:00:00Z'],
  ['into the next year', { monthly: 15, tz: 'UTC' }, '2026-12-20T00:00:00Z', '2027-01-15T00:00:00Z'],
  ['a zone behind UTC', { monthly: 15, tz: 'America/New_York' }, '2026-11-10T12:00:00Z', '2026-11-15T00:00:00-05:00'],
  ['a zone ahead of UTC', { monthly: 28, tz: 'Asia/Tokyo' }, '2026-02-27T20:00:00Z', '2026-03-28T00:00:00+09:00'],
  [
    'midnight before daylight saving ends',
    { monthly: 1, tz: 'America/New_York' },
    '2026-10-20T12:00:00Z',
    '2026-11-01T00:00:00-04:00',
  ],
  [
    'midnight after daylight saving ends',
    { monthly: 2, tz: 'America/New_York' },
    '2026-10-20T12:00:00Z',
    '2026-11-02T00:00:00-05:00',
  ],
])
  test(`a monthly reset ${name}`, () => {
    assert.equal(nextReset(reset, Date.parse(at)), Date.parse(expected));
  });

const classified = (error, extra) => classify(error, extra);

for (const [error, ms] of [
  ['rate_limit', 5 * MINUTE],
  ['overloaded', 5 * MINUTE],
  ['server_error', 2 * MINUTE],
  ['model_not_found', 60 * MINUTE],
])
  test(`${error} holds the failed model out for ${ms / MINUTE} min`, () => {
    assert.deepEqual(holdModel({}, opus, classified(error), error, now), {
      [opus]: { kind: 'availability', error, since: now, until: now + ms, streak: 1 },
    });
  });

for (const error of [
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
    assert.deepEqual(holdModel({}, opus, classified(error), error, now), {});
    assert.equal(failureHold(classified(error), error, undefined, now), null);
  });

for (const [name, at, held] of [
  ['a millisecond before its end', now + 5 * MINUTE - 1, [opus]],
  ['at its end', now + 5 * MINUTE, []],
  ['after its end', now + 5 * MINUTE + 1, []],
])
  test(`a five-minute hold ${name} holds ${held.length ? 'the model' : 'nothing'}`, () => {
    const holds = holdModel({}, opus, classified('overloaded'), 'overloaded', now);
    assert.deepEqual(heldModels(holds, at), held);
  });

const fails = (held, model, error, at) => holdModel(held, model, classified(error), error, at);

test('a failed retry doubles the hold, up to an hour: 5, 10, 20, 40, 60, 60', () => {
  let held = {};
  let at = now;
  const lasts = [];
  for (let retry = 0; retry < 6; retry += 1) {
    held = fails(held, opus, 'overloaded', at);
    lasts.push((held[opus].until - at) / MINUTE);
    assert.equal(held[opus].streak, retry + 1);
    at = held[opus].until;
  }
  assert.deepEqual(lasts, [5, 10, 20, 40, 60, 60]);
});

test('a server error doubles from its own two minutes', () => {
  let held = fails({}, opus, 'server_error', now);
  held = fails(held, opus, 'server_error', held[opus].until);
  assert.equal((held[opus].until - held[opus].since) / MINUTE, 4);
});

test('a retry that fails with another error starts the streak over', () => {
  const first = fails({}, opus, 'overloaded', now);
  const second = fails(first, opus, 'overloaded', first[opus].until);
  const third = fails(second, opus, 'server_error', second[opus].until);
  assert.deepEqual([second[opus].streak, third[opus].streak], [2, 1]);
  assert.equal((third[opus].until - third[opus].since) / MINUTE, 2);
});

test('a failure while the model is still held is not a retry and leaves the hold', () => {
  const first = fails({}, opus, 'overloaded', now);
  assert.deepEqual(fails(first, opus, 'overloaded', now + MINUTE), first);
});

test('a model answering clears its streak, so the next failure holds five minutes again', () => {
  const failed = fails(fails({}, opus, 'overloaded', now), opus, 'overloaded', now + 5 * MINUTE);
  assert.equal(failed[opus].streak, 2);
  const answered = clearedModel(failed, opus);
  assert.deepEqual(answered, {});
  assert.equal(fails(answered, opus, 'overloaded', now + 20 * MINUTE)[opus].streak, 1);
});

test('an answer at a time clears the hold set before it, and never one set after it', () => {
  const held = fails(fails({}, opus, 'overloaded', now), 'other', 'overloaded', now);
  assert.deepEqual(Object.keys(clearedSince(held, opus, now + MINUTE)), ['other']);
  // The failure here is later than the answer: a stale queued clear must not remove it.
  assert.equal(clearedSince(held, opus, now - MINUTE), held);
  assert.equal(clearedSince(held, 'absent', now + MINUTE), held);
  assert.deepEqual(clearedSince({}, opus, now), {});
});

test('a model answering leaves other models’ streaks, and clears one under its bracketed id', () => {
  const held = fails(fails({}, opus, 'overloaded', now), sonnet, 'overloaded', now);
  assert.deepEqual(Object.keys(clearedModel(held, opus)), [sonnet]);
  assert.deepEqual(Object.keys(clearedModel({ 'claude-opus-5-5[1m]': held[opus] }, opus)), []);
  assert.equal(clearedModel(held, 'claude-haiku-5-5'), held);
  assert.equal(clearedModel(undefined, opus), undefined);
});

test('a failed retry keeps the model eligible only once the doubled hold ends', () => {
  const first = fails({}, opus, 'overloaded', now);
  const second = fails(first, opus, 'overloaded', now + 5 * MINUTE);
  assert.deepEqual(heldModels(second, now + 5 * MINUTE + 10 * MINUTE - 1), [opus]);
  assert.deepEqual(heldModels(second, now + 5 * MINUTE + 10 * MINUTE), []);
});

test('a new failure keeps other models’ holds, ended ones as their streak', () => {
  const first = fails({}, sonnet, 'server_error', now);
  const second = fails(first, opus, 'overloaded', now + MINUTE);
  assert.deepEqual(heldModels(second, now + MINUTE), [sonnet, opus]);
  const third = fails(second, 'claude-haiku-5-5', 'rate_limit', now + 3 * MINUTE);
  assert.deepEqual(heldModels(third, now + 3 * MINUTE), [opus, 'claude-haiku-5-5']);
  assert.deepEqual(Object.keys(third), [sonnet, opus, 'claude-haiku-5-5']);
});

test('a shorter hold does not cut a longer one short, and a longer one extends it', () => {
  const missing = fails({}, opus, 'model_not_found', now);
  assert.deepEqual(fails(missing, opus, 'server_error', now + MINUTE), missing);
  const busy = fails({}, opus, 'server_error', now);
  assert.deepEqual(fails(busy, opus, 'overloaded', now + MINUTE)[opus], {
    kind: 'availability',
    error: 'overloaded',
    since: now + MINUTE,
    until: now + 6 * MINUTE,
    streak: 1,
  });
});

test('no hold map and a map with only ended holds hold nothing', () => {
  assert.deepEqual(activeHolds(undefined, now), {});
  const ended = { [opus]: { kind: 'availability', error: 'overloaded', since: now - MINUTE, until: now, streak: 1 } };
  assert.deepEqual(heldModels(ended, now), []);
});

test('a hold without a model id holds nothing', () => {
  assert.deepEqual(holdModel({}, null, classified('overloaded'), 'overloaded', now), {});
});

for (const [kind, failure, until] of [
  ['window', { kind: 'window', scope: 'account', until: now + 3 * HOUR }, now + 3 * HOUR],
  ['calendar', { kind: 'calendar', scope: 'account', until: now + DAY }, now + DAY],
  ['balance', { kind: 'balance', scope: 'account', until: null }, null],
])
  test(`a ${kind} failure holds its account with the time it gave`, () => {
    assert.deepEqual(failureHold(failure, 'rate_limit', undefined, now), {
      kind,
      error: 'rate_limit',
      since: now,
      until,
      streak: 1,
    });
  });

test('a window hold keeps the window it waits for, and a stored one reads back with it', () => {
  const hold = failureHold(
    { kind: 'window', scope: 'account', until: now + 3 * HOUR, window: 'seven_day' },
    'rate_limit',
    undefined,
    now,
  );
  assert.equal(hold?.window, 'seven_day');
  assert.deepEqual(readHold(hold), hold);
  assert.equal(readHold({ ...hold, window: 'one_hour' })?.window, undefined);
});

test('a quota hold is never doubled by another failure after it ended', () => {
  const failure = { kind: 'window', scope: 'account', until: now + 3 * HOUR };
  const first = failureHold(failure, 'rate_limit', undefined, now);
  const later = now + 4 * HOUR;
  const again = failureHold({ ...failure, until: later + 3 * HOUR }, 'rate_limit', first, later);
  assert.deepEqual([again?.streak, (again?.until ?? 0) - later], [1, 3 * HOUR]);
});

test('a quota hold that ends later stays, one that ends sooner is extended, a balance outlasts both', () => {
  const longer = { kind: 'window', scope: 'account', until: now + 3 * HOUR };
  const running = failureHold(longer, 'rate_limit', undefined, now);
  assert.equal(
    failureHold({ ...longer, until: now + HOUR }, 'rate_limit', running ?? undefined, now + MINUTE),
    running,
  );
  assert.equal(
    failureHold({ ...longer, until: now + 5 * HOUR }, 'rate_limit', running ?? undefined, now)?.until,
    now + 5 * HOUR,
  );
  const balance = failureHold(
    { kind: 'balance', scope: 'account', until: null },
    'billing_error',
    running ?? undefined,
    now,
  );
  assert.equal(balance?.until, null);
  assert.equal(failureHold(longer, 'rate_limit', balance ?? undefined, now + 10 * DAY), balance);
});

test('releasing ends a model hold or an account hold, and names nothing else', () => {
  const held = fails(fails({}, opus, 'overloaded', now), sonnet, 'overloaded', now);
  assert.deepEqual(Object.keys(releaseHold(held, opus) ?? {}), [sonnet]);
  assert.equal(releaseHold(held, 'claude-haiku-5-5'), held);
  const accounts = {
    plan: failureHold({ kind: 'balance', scope: 'account', until: null }, 'billing_error', undefined, now),
  };
  assert.deepEqual(releaseHold(accounts, 'plan'), {});
  assert.equal(releaseHold(undefined, 'plan'), undefined);
});

for (const [name, value, expected] of [
  [
    'a stored hold',
    { kind: 'window', error: 'rate_limit', since: 1, until: 2, streak: 1 },
    { kind: 'window', error: 'rate_limit', since: 1, until: 2, streak: 1 },
  ],
  [
    'a hold until released',
    { kind: 'balance', error: 'billing_error', since: 1, until: null, streak: 1, extra: 'x' },
    { kind: 'balance', error: 'billing_error', since: 1, until: null, streak: 1 },
  ],
  ['no value', undefined, null],
  ['a string', 'window', null],
  ['an unknown kind', { kind: 'forever', error: 'x', since: 1, until: 2, streak: 1 }, null],
  ['a time that is not a number', { kind: 'window', error: 'x', since: 1, until: '2', streak: 1 }, null],
  ['a streak that is not a count', { kind: 'window', error: 'x', since: 1, until: 2, streak: 1.5 }, null],
])
  test(`${name} reads as ${expected ? 'a hold' : 'none'}`, () => {
    assert.deepEqual(readHold(value), expected);
  });

const config = loadConfig({
  userFile: {
    models: {
      glm: {
        id: 'glm-5.3[1m]',
        input: 1,
        output: 2,
        cacheRead: 0.1,
        contextWindow: 1_000_000,
        billing: 'credits',
        efforts: ['high', 'max'],
        account: 'zai',
      },
      deepseek: {
        id: 'deepseek-flash',
        input: 1,
        output: 2,
        cacheRead: 0.1,
        contextWindow: 1_000_000,
        billing: 'credits',
        efforts: [],
      },
    },
  },
});

test('a model’s account is its configured one, the plan for a plan model, else itself', () => {
  assert.equal(accountOfModel(config, opus), 'plan');
  assert.equal(accountOfModel(config, 'claude-haiku-5-5'), 'plan');
  assert.equal(accountOfModel(config, 'glm-5.3'), 'zai');
  assert.equal(accountOfModel(config, 'glm-5.3[1m]'), 'zai');
  assert.equal(accountOfModel(config, 'deepseek-flash'), 'deepseek');
  assert.equal(accountOfModel(config, 'gpt-6.2'), null);
  assert.equal(accountOfModel(config, undefined), null);
  assert.deepEqual(accountNames(config), ['plan', 'zai', 'deepseek']);
});

test('an account hold covers every model of the account, beside the model holds', () => {
  const accountHolds = {
    plan: failureHold({ kind: 'window', scope: 'account', until: now + HOUR }, 'rate_limit', undefined, now),
  };
  const held = fails({}, 'glm-5.3[1m]', 'overloaded', now);
  const planIds = ['fable', 'opus', 'sonnet', 'haiku'].map((alias) => config.models[alias].id);
  assert.deepEqual(heldIds(config, held, accountHolds, now), ['glm-5.3[1m]', ...planIds]);
  assert.deepEqual(heldIds(config, held, accountHolds, now + 5 * MINUTE), planIds);
  assert.deepEqual(heldIds(config, held, accountHolds, now + HOUR), []);
  assert.deepEqual(heldIds(config, undefined, undefined, now), []);
});

for (const [hold, at, words] of [
  [{ kind: 'availability', error: 'overloaded', until: now + 5 * MINUTE }, now, 'overloaded, 5 min'],
  [{ kind: 'availability', error: 'rate_limit', until: now + 5 * MINUTE }, now + 30_000, 'rate limited, 5 min'],
  [{ kind: 'availability', error: 'server_error', until: now + 10_000 }, now, 'server error, 1 min'],
  [{ kind: 'availability', error: 'model_not_found', until: now + 60 * MINUTE }, now, 'model not found, 60 min'],
  [{ kind: 'window', error: 'rate_limit', until: now + 3 * HOUR - 1 }, now, 'usage limit, 3 h'],
  [{ kind: 'calendar', error: 'rate_limit', until: now + DAY }, now, 'spend limit, 24 h'],
  [{ kind: 'balance', error: 'billing_error', until: null }, now, 'no balance, until released'],
])
  test(`a hold reads "${words}"`, () => {
    assert.equal(holdText(hold, at), words);
  });

for (const [hold, words] of [
  [{ kind: 'window', window: 'five_hour' }, '5h limit'],
  [{ kind: 'window', window: 'seven_day' }, '7d limit'],
  [{ kind: 'window' }, 'usage limit'],
  [{ kind: 'calendar' }, 'spend limit'],
  [{ kind: 'balance' }, 'no balance'],
  [{ kind: 'availability', error: 'overloaded', streak: 1 }, 'overloaded'],
  [{ kind: 'availability', error: 'overloaded', streak: 2 }, 'overloaded ×2'],
  [{ kind: 'availability', error: 'rate_limit', streak: 1 }, 'rate limited'],
])
  test(`a ${hold.kind} hold is caused by "${words}"`, () => {
    assert.equal(holdCause(hold), words);
  });

test('a held id is named too by the snapshot its reply resolved it to', () => {
  assert.deepEqual(heldAsSeen(['claude-haiku-4-5'], { 'claude-haiku-4-5': 'claude-haiku-4-5-20251001' }), [
    'claude-haiku-4-5',
    'claude-haiku-4-5-20251001',
  ]);
  assert.deepEqual(heldAsSeen(['claude-opus-5-5'], {}), ['claude-opus-5-5']);
  assert.deepEqual(heldAsSeen(['a', 'b'], { a: 'a-dated', b: 'b-dated', c: 'c-dated' }), [
    'a',
    'b',
    'a-dated',
    'b-dated',
  ]);
});
