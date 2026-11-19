import assert from 'node:assert/strict';
import test from 'node:test';
import { DECISIONS_PREFIX } from '../lib/decisions.mjs';
import { answering, CONFIG, controls, drain, harness, JEV_KEY, press, step, texts } from './harness.mjs';
import { assistant, jevResponse, toolResult, user } from './helpers.mjs';

// Times in toasts print in the local zone.
process.env.TZ = 'UTC';

const OPUS = 'claude-opus-5-5';
const HAIKU = 'claude-haiku-5-5';
const MEDIUM = jevResponse('medium', { micro: 0, low: 0, medium: 0.97, high: 0.03, uncertain: 0 });

// `router` is the router.json the session loads, if any.
async function started(t, router = null) {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const h = harness(JEV_KEY);
  if (router) h.files.set(CONFIG, JSON.stringify(router));
  h.model(OPUS);
  answering(h, MEDIUM);
  await h.event('session.start', { cwd: '/fixture' });
  return h;
}

// One routed turn that runs to its end; `failure` is the API error it ends on, if any. Returns the request it sent.
async function turn(h, turnId, failure = null) {
  await h.event('turn.start', { turnId, text: 'One edit.' });
  await drain(h.step({ ...step, turnId, model: OPUS }));
  if (failure) await h.event('classic.StopFailure', { hook_event_name: 'StopFailure', ...failure });
  await h.event('turn.complete', { turnId, isAborted: false });
  return h.requests.at(-1);
}

test('an overloaded model is held out: the next turn runs the nearest tier on another model, and says so', async (t) => {
  const h = await started(t);
  assert.equal((await turn(h, 't1', { error: 'overloaded' })).model, OPUS);
  assert.deepEqual(h.loop().held, {
    [OPUS]: { kind: 'availability', error: 'overloaded', since: 1_000_000, until: 1_000_000 + 5 * 60_000, streak: 1 },
  });
  assert.deepEqual(h.toasts, ['Opus 5.5 held out of routing: overloaded, 5 min']);
  const next = await turn(h, 't2');
  assert.deepEqual([next.model, next.effort], [HAIKU, 'high']);
  assert.equal(h.toasts.at(-1), 'Opus 5.5 overloaded · back 00:21 → Haiku 5.5 · high');
  assert.equal(h.state.get('lines:rl-t2').value.reason, 'model-held');
});

const LOW = jevResponse('low', { micro: 0, low: 0.97, medium: 0.03, high: 0, uncertain: 0 });

test('the hold is on the model the failed request ran, not on the session’s model', async (t) => {
  const h = await started(t);
  answering(h, LOW);
  assert.equal((await turn(h, 't1', { error: 'overloaded' })).model, HAIKU);
  assert.deepEqual(Object.keys(h.loop().held), [HAIKU]);
  assert.equal(h.toasts.at(-1), 'Haiku 5.5 held out of routing: overloaded, 5 min');
});

test('a subagent’s request in between leaves the main request’s model as the one a failure holds', async (t) => {
  const h = await started(t);
  answering(h, LOW);
  await h.event('turn.start', { turnId: 't1', text: 'One edit.' });
  await drain(h.step({ ...step, turnId: 't1', model: OPUS }));
  await drain(h.step({ ...step, turnId: 't1', agentId: 'a1', model: OPUS, effort: 'high' }));
  assert.deepEqual(
    h.requests.map((r) => r.model),
    [HAIKU, OPUS],
  );
  await h.event('classic.StopFailure', { hook_event_name: 'StopFailure', error: 'overloaded' });
  assert.deepEqual(Object.keys(h.loop().held), [HAIKU]);
});

test('a request routing passed on unchanged is the one a failure holds', async (t) => {
  const h = await started(t);
  answering(h, LOW);
  assert.equal((await turn(h, 't1')).model, HAIKU);
  const step2 = new AbortController();
  h.http(async () => {
    step2.abort();
    return { ok: true, status: 200, text: JSON.stringify(LOW), headers: {} };
  });
  await h.event('turn.start', { turnId: 't2', text: 'One edit.' });
  await drain(h.step({ ...step, turnId: 't2', model: OPUS }, {}, step2.signal));
  assert.equal(h.requests.at(-1).model, OPUS);
  await h.event('classic.StopFailure', { hook_event_name: 'StopFailure', error: 'overloaded' });
  assert.deepEqual(Object.keys(h.loop().held), [OPUS]);
});

test('a new session start forgets the last session’s request: a failure before any holds the session’s model', async (t) => {
  const h = await started(t);
  answering(h, LOW);
  assert.equal((await turn(h, 't1')).model, HAIKU);
  await h.event('session.start', { cwd: '/fixture' });
  await h.event('classic.StopFailure', { hook_event_name: 'StopFailure', error: 'overloaded' });
  assert.deepEqual(Object.keys(h.loop().held), [OPUS]);
});

test('once the hold ends the next turn runs the held model again', async (t) => {
  const h = await started(t);
  await turn(h, 't1', { error: 'server_error' });
  t.mock.timers.tick(2 * 60_000 - 1);
  assert.equal((await turn(h, 't2')).model, HAIKU);
  t.mock.timers.tick(1);
  assert.equal((await turn(h, 't3')).model, OPUS);
});

test('a pinned turn on a held-out model runs the fallback and its route line names the hold', async (t) => {
  const h = await started(t);
  await turn(h, 't1', { error: 'rate_limit' });
  await h.event('command.run', { command: 'router', args: 'pin medium' });
  assert.equal((await turn(h, 't2')).model, HAIKU);
  assert.equal(h.loop().decision.pinned, true);
  assert.equal(h.state.get('lines:rl-t2').value.reason, 'model-held');
});

test('a turn whose own tool calls edit code does not move up onto the held-out model', async (t) => {
  const h = await started(t);
  await turn(h, 't1', { error: 'overloaded' });
  answering(h, jevResponse('medium', { medium: 0.97, high: 0.03 }, 0, { ops: 0.9, code: 0.1 }, 'execute'));
  await h.event('turn.start', { turnId: 't2', text: 'Run the worker brief.' });
  h.messages(async () => [user('Run the worker brief.')]);
  await drain(h.step({ ...step, turnId: 't2', model: OPUS }));
  h.messages(async () => [
    user('Run the worker brief.'),
    assistant('running', ['Bash']),
    toolResult('ok'),
    assistant('fixing', ['Edit']),
    toolResult('ok'),
  ]);
  await drain(h.step({ ...step, turnId: 't2', model: OPUS, index: 1, messageCount: 5 }));
  assert.deepEqual(
    h.requests.slice(1).map((r) => `${r.model}@${r.effort}`),
    ['claude-haiku-5-5@high', 'claude-haiku-5-5@high'],
  );
  assert.equal(h.loop().decision.activity, 'ops');
});

test('the shadow engine routes as the table does, so it holds the model and says so', async (t) => {
  const h = await started(t, { routingEngine: 'shadow' });
  await turn(h, 't1', { error: 'overloaded' });
  assert.deepEqual(Object.keys(h.loop().held), [OPUS]);
  assert.deepEqual(h.toasts, ['Opus 5.5 held out of routing: overloaded, 5 min']);
});

test('the auto engine does not route around holds, so it holds nothing and says nothing', async (t) => {
  const capability = { low: 2, medium: 2.5, high: 2.5, xhigh: 3, max: 3 };
  const h = await started(t, { routingEngine: 'auto', models: { opus: { capability } } });
  await turn(h, 't1', { error: 'overloaded' });
  assert.ok(h.loop());
  assert.equal(h.loop().held, undefined);
  assert.deepEqual(
    h.toasts.filter((text) => text.includes('held out')),
    [],
  );
});

for (const [name, failure] of [
  ['a rejected key', { error: 'authentication_failed' }],
  ['an invalid request', { error: 'invalid_request' }],
  ['an unknown error', { error: 'unknown' }],
  ['a subagent’s overloaded model', { error: 'overloaded', agent_id: 'a1' }],
])
  test(`${name} holds no model out`, async (t) => {
    const h = await started(t);
    await turn(h, 't1', failure);
    assert.equal(h.loop().held, undefined);
    assert.deepEqual(h.toasts, []);
    assert.equal((await turn(h, 't2')).model, OPUS);
  });

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const HOLDS_PLAN = 'holds/plan';
const decisions = (h) => h.preferences.get(`${DECISIONS_PREFIX}s1`);
const failureRows = (h) => decisions(h).rows.filter((row) => row.kind === 'failure');

// A turn whose request failed: the engine sends it and gets no reply back, so nothing counts as an answer.
async function failedTurn(h, turnId, failure) {
  await h.event('turn.start', { turnId, text: 'One edit.' });
  await drain(h.step({ ...step, turnId, model: OPUS }, { usage: undefined }));
  await h.event('classic.StopFailure', { hook_event_name: 'StopFailure', ...failure });
  await h.event('turn.complete', { turnId, isAborted: false });
  return h.requests.at(-1);
}

const planReadings = (...limits) => ({
  startedAt: 0,
  context: { tokens: 8000, breakdown: { totalTokens: 9000 } },
  rateLimits: limits.map(([kind, percentUsed, resetsInMs]) => ({
    kind,
    percentUsed,
    resetsAt: new Date(1_000_000 + resetsInMs).toISOString(),
  })),
});

test('a stand-in that fails is held, not the model it stood in for', async (t) => {
  const h = await started(t);
  await turn(h, 't1', { error: 'overloaded' });
  const next = await turn(h, 't2', { error: 'overloaded' });
  assert.equal(next.model, HAIKU);
  assert.deepEqual(Object.keys(h.loop().held), [OPUS, HAIKU]);
  assert.equal(h.loop().held[OPUS].until, 1_000_000 + 5 * MINUTE);
  assert.equal(h.loop().held[HAIKU].streak, 1);
  assert.equal(h.toasts.at(-1), 'Haiku 5.5 held out of routing: overloaded, 5 min');
});

test('each failed retry of a model holds it twice as long, and the hold ends as the doubled time passes', async (t) => {
  const h = await started(t);
  const untils = [];
  await failedTurn(h, 't1', { error: 'overloaded' });
  untils.push(h.loop().held[OPUS].until - Date.now());
  t.mock.timers.tick(5 * MINUTE);
  assert.equal((await failedTurn(h, 't2', { error: 'overloaded' })).model, OPUS);
  untils.push(h.loop().held[OPUS].until - Date.now());
  t.mock.timers.tick(10 * MINUTE - 1);
  assert.equal((await turn(h, 't3')).model, HAIKU);
  t.mock.timers.tick(1);
  assert.equal((await failedTurn(h, 't4', { error: 'overloaded' })).model, OPUS);
  untils.push(h.loop().held[OPUS].until - Date.now());
  assert.deepEqual(
    untils.map((ms) => ms / MINUTE),
    [5, 10, 20],
  );
  assert.deepEqual(h.loop().held[OPUS].streak, 3);
  assert.equal(h.toasts.at(-1), 'Opus 5.5 held out of routing: overloaded, 20 min');
});

test('a reply from the model after its hold ends clears the streak, so its next failure holds five minutes', async (t) => {
  const h = await started(t);
  await failedTurn(h, 't1', { error: 'overloaded' });
  t.mock.timers.tick(5 * MINUTE);
  assert.equal((await turn(h, 't2')).model, OPUS);
  assert.deepEqual(h.loop().held, {});
  await failedTurn(h, 't3', { error: 'overloaded' });
  assert.equal(h.loop().held[OPUS].streak, 1);
  assert.equal(h.loop().held[OPUS].until, Date.now() + 5 * MINUTE);
});

test('a reply from another model leaves the streak of the failed one', async (t) => {
  const h = await started(t);
  await failedTurn(h, 't1', { error: 'overloaded' });
  assert.equal((await turn(h, 't2')).model, HAIKU);
  assert.deepEqual(Object.keys(h.loop().held), [OPUS]);
});

test('a full 5h plan window holds the plan account until its reset, in the store, and no model in the loop', async (t) => {
  const h = await started(t);
  h.usage(planReadings(['five_hour', 100, 3 * HOUR], ['seven_day', 40, 2 * 24 * HOUR]));
  await turn(h, 't1', { error: 'rate_limit' });
  assert.deepEqual(h.preferences.get(HOLDS_PLAN), {
    kind: 'window',
    error: 'rate_limit',
    since: 1_000_000,
    until: 1_000_000 + 3 * HOUR + MINUTE,
    streak: 1,
    window: 'five_hour',
  });
  assert.equal(h.loop().held, undefined);
  assert.deepEqual(h.toasts, ['Claude plan held out of routing: usage limit, 4 h']);
});

test('another session reads the account hold back, and a weaker failure there does not shorten it', async (t) => {
  const first = await started(t);
  first.usage(planReadings(['five_hour', 100, 3 * HOUR]));
  await turn(first, 't1', { error: 'rate_limit' });
  const stored = first.preferences.get(HOLDS_PLAN);
  const second = harness(JEV_KEY, first.preferences);
  second.model(OPUS);
  answering(second, MEDIUM);
  second.usage(planReadings(['five_hour', 100, HOUR]));
  await second.event('session.start', { cwd: '/fixture' });
  t.mock.timers.tick(MINUTE);
  await turn(second, 't1', { error: 'rate_limit' });
  assert.deepEqual(second.preferences.get(HOLDS_PLAN), stored);
});

test('an account hold written from the plan is replaced by a longer one', async (t) => {
  const h = await started(t);
  h.usage(planReadings(['five_hour', 100, HOUR]));
  await turn(h, 't1', { error: 'rate_limit' });
  h.usage(planReadings(['five_hour', 100, HOUR], ['seven_day', 100, 24 * HOUR]));
  await turn(h, 't2', { error: 'rate_limit' });
  assert.equal(h.preferences.get(HOLDS_PLAN).until, 1_000_000 + 24 * HOUR + MINUTE);
});

test('a billing error holds the plan account until it is released, not a model', async (t) => {
  const h = await started(t);
  await turn(h, 't1', { error: 'billing_error' });
  assert.deepEqual(h.preferences.get(HOLDS_PLAN), {
    kind: 'balance',
    error: 'billing_error',
    since: 1_000_000,
    until: null,
    streak: 1,
  });
  assert.equal(h.loop().held, undefined);
  assert.deepEqual(h.toasts, ['Claude plan held out of routing: no balance, until released']);
});

test('the monthly spend limit holds a day when the account has no reset', async (t) => {
  const h = await started(t);
  await turn(h, 't1', { error: 'rate_limit', error_details: "You've hit your organization's monthly spend limit" });
  assert.equal(h.preferences.get(HOLDS_PLAN).kind, 'calendar');
  assert.equal(h.preferences.get(HOLDS_PLAN).until, 1_000_000 + 24 * HOUR);
});

test('the monthly spend limit holds until the account’s configured reset', async (t) => {
  const h = await started(t, { accounts: { plan: { reset: { monthly: 1, tz: 'UTC' } } } });
  await turn(h, 't1', { error: 'rate_limit', error_details: 'monthly spend limit' });
  assert.equal(h.preferences.get(HOLDS_PLAN).until, Date.parse('1970-02-01T00:00:00Z'));
});

const GLM = {
  id: 'glm-5.3[1m]',
  input: 1,
  output: 2,
  cacheRead: 0.1,
  contextWindow: 1_000_000,
  billing: 'credits',
  efforts: ['high', 'max'],
};

test('in a session that also pays credits, a full plan window is only an availability hold', async (t) => {
  const h = await started(t, { models: { glm: GLM } });
  h.usage(planReadings(['five_hour', 100, 3 * HOUR]));
  await turn(h, 't1', { error: 'rate_limit' });
  assert.equal(h.preferences.has(HOLDS_PLAN), false);
  assert.equal(h.loop().held[OPUS].kind, 'availability');
});

test('the z.ai balance error holds that account until released and leaves the plan free', async (t) => {
  const h = await started(t, { models: { glm: GLM } });
  h.model(GLM.id);
  await h.event('classic.StopFailure', {
    hook_event_name: 'StopFailure',
    error: 'rate_limit',
    error_details: '[1113] Insufficient balance or no resource package. Please recharge.',
  });
  assert.equal(h.preferences.get('holds/glm').kind, 'balance');
  assert.equal(h.preferences.get('holds/glm').until, null);
  assert.equal(h.preferences.has(HOLDS_PLAN), false);
});

test('a failure with no account text and no readings is availability and works without error_details', async (t) => {
  const h = await started(t);
  await turn(h, 't1', { error: 'rate_limit' });
  assert.equal(h.loop().held[OPUS].kind, 'availability');
  assert.equal(h.preferences.has(HOLDS_PLAN), false);
});

test('a failure is recorded in the turn’s decisions with the text, the readings, the kind and what was held', async (t) => {
  const h = await started(t);
  h.usage(planReadings(['five_hour', 100, 3 * HOUR], ['seven_day', 12.34, 2 * 24 * HOUR]));
  const details = `monthly limit ${'x'.repeat(400)}`;
  await turn(h, 't1', { error: 'rate_limit', error_details: details });
  assert.deepEqual(failureRows(h), [
    {
      at: 1_000_000,
      kind: 'failure',
      err: 'rate_limit',
      details: details.slice(0, 300),
      limits: [
        { kind: 'five_hour', pct: 100, resets: 1_000_000 + 3 * HOUR },
        { kind: 'seven_day', pct: 12.3, resets: 1_000_000 + 2 * 24 * HOUR },
      ],
      fail: 'window',
      scope: 'account',
      held: 'plan',
    },
  ]);
});

test('a failure with no text records none, and one that holds nothing records what Claude Code gave', async (t) => {
  const h = await started(t);
  await turn(h, 't1', { error: 'authentication_failed' });
  assert.deepEqual(failureRows(h), [
    {
      at: 1_000_000,
      kind: 'failure',
      err: 'authentication_failed',
      details: null,
      limits: [],
      fail: null,
      scope: null,
      held: null,
    },
  ]);
});

test('a model hold is recorded with the model that was held', async (t) => {
  const h = await started(t);
  await turn(h, 't1', { error: 'overloaded', error_details: 'Overloaded' });
  const [row] = failureRows(h);
  assert.deepEqual([row.fail, row.scope, row.held, row.details], ['availability', 'model', OPUS, 'Overloaded']);
});

test('the auto engine records the failure and holds nothing', async (t) => {
  const capability = { low: 2, medium: 2.5, high: 2.5, xhigh: 3, max: 3 };
  const h = await started(t, { routingEngine: 'auto', models: { opus: { capability } } });
  await turn(h, 't1', { error: 'billing_error' });
  assert.equal(h.preferences.has(HOLDS_PLAN), false);
  assert.deepEqual(
    failureRows(h).map((row) => [row.err, row.fail, row.held]),
    [['billing_error', null, null]],
  );
});

test('a failure that arrives after its turn completed is still recorded', async (t) => {
  const h = await started(t);
  await h.event('turn.start', { turnId: 't1', text: 'One edit.' });
  await drain(h.step({ ...step, turnId: 't1', model: OPUS }, { usage: undefined }));
  await h.event('turn.complete', { turnId: 't1', isAborted: false });
  await h.event('classic.StopFailure', { hook_event_name: 'StopFailure', error: 'overloaded' });
  assert.deepEqual(
    failureRows(h).map((row) => row.err),
    ['overloaded'],
  );
});

test('a subagent’s failure is neither held nor recorded', async (t) => {
  const h = await started(t);
  await turn(h, 't1', { error: 'billing_error', agent_id: 'a1' });
  assert.equal(h.preferences.has(HOLDS_PLAN), false);
  assert.deepEqual(failureRows(h), []);
});

test('/router decisions lists a failure without its text', async (t) => {
  const h = await started(t);
  await turn(h, 't1', { error: 'overloaded', error_details: 'secret text' });
  const listing = await h.event('command.run', { command: 'router', args: 'decisions' });
  const text = JSON.stringify(listing);
  assert.match(text, /failure +overloaded {2}availability held model claude-opus-5-5/);
  assert.doesNotMatch(text, /secret text/);
});

const CHAINED = { models: { glm: GLM }, fallbacks: { opus: ['glm@max'] } };
const GLM_ID = GLM.id;

test('a fallback target stands in for a held model on its continuation too, and the hold ending returns to the source', async (t) => {
  const h = await started(t, CHAINED);
  await turn(h, 't1', { error: 'overloaded' });
  assert.deepEqual(await turn(h, 't2').then((r) => [r.model, r.effort]), [GLM_ID, 'max']);
  assert.equal(h.state.get('lines:rl-t2').value.reason, 'model-held');
  await h.event('turn.start', { turnId: 't3', text: 'One edit.' });
  await drain(h.step({ ...step, turnId: 't3', model: OPUS }));
  await drain(h.step({ ...step, turnId: 't3', model: OPUS, index: 1, messageCount: 3 }));
  assert.deepEqual(
    h.requests.slice(-2).map((r) => r.model),
    [GLM_ID, GLM_ID],
  );
  assert.deepEqual(h.loop().decision.fallback, { from: 'opus', step: 1, of: 1 });
  assert.deepEqual(h.loop().route, { model: 'opus', effort: 'medium' });
  t.mock.timers.tick(5 * MINUTE);
  assert.equal((await turn(h, 't4')).model, OPUS);
});

test('a fallback target that fails is the one held, so the next turn falls to the nearest tier', async (t) => {
  const h = await started(t, CHAINED);
  await turn(h, 't1', { error: 'overloaded' });
  assert.equal((await failedTurn(h, 't2', { error: 'overloaded' })).model, GLM_ID);
  assert.deepEqual(Object.keys(h.loop().held), [OPUS, GLM_ID]);
  assert.equal((await turn(h, 't3')).model, HAIKU);
});

test('an account hold in the store skips the plan models of a chain, until it ends', async (t) => {
  const h = await started(t, { models: { glm: GLM }, fallbacks: { opus: ['sonnet', 'glm@max'] } });
  const until = 1_000_000 + 3 * HOUR;
  h.preferences.set(HOLDS_PLAN, { kind: 'window', error: 'rate_limit', since: 1_000_000, until, streak: 1 });
  assert.deepEqual(await turn(h, 't1').then((r) => [r.model, r.effort]), [GLM_ID, 'max']);
  assert.deepEqual(h.loop().decision.fallback, { from: 'opus', step: 2, of: 2 });
  t.mock.timers.tick(3 * HOUR);
  assert.equal((await turn(h, 't2')).model, OPUS);
});

const command = (h, args) => h.event('command.run', { command: 'router', args });
const typeahead = async (h, text) => {
  const start = text.lastIndexOf(' ') + 1;
  return (await h.autocomplete({ text, cursor: text.length, token: text.slice(start), start })).map((row) => row.text);
};
const nothingHeld = 'Nothing is held out of routing.';

test('/router holds lists a plan hold and a model hold with scope, kind, cause and end', async (t) => {
  const h = await started(t);
  assert.deepEqual(await command(h, 'holds'), { text: nothingHeld });
  h.usage(planReadings(['five_hour', 100, 3 * HOUR]));
  await turn(h, 't1', { error: 'rate_limit' });
  await turn(h, 't2', { error: 'overloaded' });
  const { text } = await command(h, 'holds');
  assert.deepEqual(text.split('\n').slice(0, 3), [
    'Held out of routing:',
    '  plan (account) · window: 5h limit · back 03:17 · holds out Fable 5.2, Opus 5.5, Sonnet 5.5, Haiku 5.5',
    '  opus (model) · availability: overloaded · back 00:21',
  ]);
});

test('/router release plan ends the account hold, and routing may use the account at once', async (t) => {
  const h = await started(t);
  h.usage(planReadings(['five_hour', 100, 3 * HOUR]));
  await turn(h, 't1', { error: 'rate_limit' });
  assert.equal(h.preferences.has(HOLDS_PLAN), true);
  assert.deepEqual(await typeahead(h, '/router release p'), ['plan']);
  const { text } = await command(h, 'release plan');
  assert.equal(text, 'Released Claude plan: routing may use it from the next turn.');
  assert.equal(h.preferences.has(HOLDS_PLAN), false);
  assert.deepEqual(h.view().holds, { accounts: {}, models: {} });
  assert.equal((await turn(h, 't2')).model, OPUS);
  assert.deepEqual(await typeahead(h, '/router release p'), []);
});

test('/router release opus ends a model hold, and says why a model held through its account stays', async (t) => {
  const h = await started(t);
  await turn(h, 't1', { error: 'overloaded' });
  assert.deepEqual(Object.keys(h.loop().held), [OPUS]);
  assert.equal((await command(h, 'release opus')).text, 'Released Opus 5.5: routing may use it from the next turn.');
  assert.equal(h.loop().held[OPUS], undefined);
  assert.equal((await turn(h, 't2')).model, OPUS);
  h.usage(planReadings(['five_hour', 100, 3 * HOUR]));
  await turn(h, 't3', { error: 'rate_limit' });
  assert.equal(
    (await command(h, 'release opus')).text,
    'opus is held through Claude plan, not on its own: /router release plan',
  );
  assert.equal(h.preferences.has(HOLDS_PLAN), true);
  assert.equal((await command(h, 'release nonsense')).text, 'Nothing held under that name. Held: plan.');
  assert.equal((await command(h, 'release')).text, 'Name what to release: plan.');
});

test('the pane lists a hold from its failure, Release ends it with Undo, and Undo puts it back', async (t) => {
  const h = await started(t);
  h.usage(planReadings(['five_hour', 100, 3 * HOUR]));
  await turn(h, 't1', { error: 'rate_limit' });
  const stored = h.preferences.get(HOLDS_PLAN);
  assert.ok(texts(await h.render()).includes('HELD OUT'));
  await press(h, 'release-account-plan');
  assert.equal(h.preferences.has(HOLDS_PLAN), false);
  assert.equal(h.view().notice, 'Released Claude plan: routing may use it from the next turn.');
  assert.ok(!texts(await h.render()).includes('HELD OUT'));
  await press(h, 'undo');
  assert.deepEqual(h.preferences.get(HOLDS_PLAN), stored);
  assert.equal(h.view().notice, 'Undid: released Claude plan.');
  assert.ok(texts(await h.render()).includes('HELD OUT'));
});

test('Undo of a release keeps an account hold set since, and says so', async (t) => {
  const h = await started(t);
  h.usage(planReadings(['five_hour', 100, 3 * HOUR]));
  await turn(h, 't1', { error: 'rate_limit' });
  await press(h, 'release-account-plan');
  const newer = { kind: 'balance', error: 'billing_error', since: 1_000_000, until: null, streak: 1 };
  h.preferences.set(HOLDS_PLAN, newer);
  await press(h, 'undo');
  assert.deepEqual(h.preferences.get(HOLDS_PLAN), newer);
  assert.equal(h.view().notice, 'Not undone: Claude plan is held again.');
  assert.equal(h.view().lastWrite ?? null, null);
});

test('Undo of a release keeps a model hold set since, and says so', async (t) => {
  const h = await started(t);
  await turn(h, 't1', { error: 'overloaded' });
  await h.event('command.run', { command: 'router', args: '' });
  await press(h, `release-model-${OPUS}`);
  assert.equal(h.loop().held[OPUS], undefined);
  await turn(h, 't2', { error: 'overloaded' });
  const newer = h.loop().held[OPUS];
  assert.ok(newer);
  await press(h, 'undo');
  assert.deepEqual(h.loop().held[OPUS], newer);
  assert.equal(h.view().notice, 'Not undone: Opus 5.5 is held again.');
  assert.equal(h.view().lastWrite ?? null, null);
});

test('Release in the pane on a hold another session ended says so and draws no Undo', async (t) => {
  const h = await started(t);
  h.usage(planReadings(['five_hour', 100, 3 * HOUR]));
  await turn(h, 't1', { error: 'rate_limit' });
  const release = controls(await h.render()).find((c) => c.key === 'release-account-plan');
  h.preferences.delete(HOLDS_PLAN);
  await release.onPress();
  assert.equal(h.view().notice, 'Already released.');
  assert.equal(h.view().lastWrite ?? null, null);
});

test('a switch to a chain target is announced with the holder and its end, then the route that runs', async (t) => {
  const h = await started(t, { models: { glm: GLM }, fallbacks: { opus: ['sonnet', 'glm@max'] } });
  await turn(h, 't1');
  h.preferences.set(HOLDS_PLAN, {
    kind: 'window',
    window: 'five_hour',
    error: 'rate_limit',
    since: 1_000_000,
    until: 1_000_000 + 3 * HOUR + MINUTE,
    streak: 1,
  });
  assert.deepEqual(await turn(h, 't2').then((r) => [r.model, r.effort]), [GLM_ID, 'max']);
  assert.equal(h.toasts.at(-1), 'Claude plan 5h limit · back 03:17 → GLM 5.3 · max');
  assert.deepEqual(h.view().fallback, { from: 'opus', step: 2, of: 2 });
  assert.ok(texts(await h.render()).includes('↷ Opus 5.5 held · fallback 2 of 2'));
  t.mock.timers.tick(3 * HOUR + MINUTE);
  await turn(h, 't3');
  assert.equal(h.view().fallback, null);
});
