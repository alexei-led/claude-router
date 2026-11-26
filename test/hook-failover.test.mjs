import assert from 'node:assert/strict';
import test from 'node:test';
import { DECISIONS_PREFIX } from '../lib/decisions.mjs';
import { readTrace, TRACE_PREFIX } from '../lib/replay-trace.mjs';
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

test('a model hold reaches the pane’s held-out view in the same event, without reopening the pane', async (t) => {
  const h = await started(t);
  await turn(h, 't1', { error: 'overloaded' });
  assert.deepEqual(Object.keys(h.view().holds.models), [OPUS]);
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

test('the auto engine holds the failed model out and routes the next turn around it', async (t) => {
  const capability = { low: 2, medium: 2.5, high: 2.5, xhigh: 3, max: 3 };
  const h = await started(t, { routingEngine: 'auto', models: { opus: { capability } } });
  await turn(h, 't1', { error: 'overloaded' });
  assert.deepEqual(Object.keys(h.loop().held), [OPUS]);
  assert.ok(h.toasts.includes('Opus 5.5 held out of routing: overloaded, 5 min'));
  const next = await turn(h, 't2');
  assert.notEqual(next.model, OPUS);
  assert.equal(h.loop().decision.reason, 'forced');
  // The pane names the hold under auto too, as for every engine.
  assert.ok(Object.keys(h.view().holds.models).includes(OPUS));
});

test('when a model hold ends the model is eligible again, and rising demand moves back through normal gates', async (t) => {
  const capability = { low: 2, medium: 2.5, high: 2.5, xhigh: 3, max: 3 };
  const h = await started(t, { routingEngine: 'auto', models: { opus: { capability } } });
  await turn(h, 't1', { error: 'overloaded' });
  assert.notEqual((await turn(h, 't2')).model, OPUS);
  t.mock.timers.tick(5 * 60_000);
  const HIGH = jevResponse('high', { micro: 0, low: 0, medium: 0.03, high: 0.97, uncertain: 0 });
  answering(h, HIGH);
  // Two votes to raise the demand to 3, then the upgrade bar moves the route back onto Opus.
  await turn(h, 't3');
  assert.equal((await turn(h, 't4')).model, OPUS);
});

test('a shadow proposal never names the model the table just held out, and the trace records the hold', async (t) => {
  const capability = { low: 2, medium: 2.5, high: 2.5, xhigh: 3, max: 3 };
  const h = await started(t, { routingEngine: 'shadow', models: { opus: { capability } } });
  await turn(h, 't1', { error: 'overloaded' });
  await turn(h, 't2');
  const start = decisions(h)
    .rows.filter((row) => row.kind === 'start')
    .at(-1);
  assert.ok(start.alt?.route);
  assert.ok(!start.alt.route.startsWith('opus@'), `shadow target names the held model: ${start.alt.route}`);
  const stored = h.preferences.get(`${TRACE_PREFIX}s1`);
  const request = stored.events.find((event) => event.type === 'request' && event.turn === 2);
  assert.deepEqual(request.operations[0].held, [OPUS]);
  // The reader keeps the held ids, so a replay sees what the live proposal saw.
  assert.deepEqual(
    readTrace(stored).events.find((event) => event.type === 'request' && event.turn === 2).operations[0].held,
    [OPUS],
  );
});

test('a full plan window holds the account for the auto engine, and a credits model takes over', async (t) => {
  const glm = {
    id: 'zai-org/GLM-5.3',
    input: 1.4,
    cacheRead: 0.26,
    output: 4.4,
    contextWindow: 1_000_000,
    billing: 'credits',
    efforts: ['high', 'max'],
    capability: { high: 2.5, max: 3 },
    imageInput: false,
  };
  const h = await started(t, { routingEngine: 'auto', models: { opus: {}, glm } });
  h.usage(planReadings(['five_hour', 100, 3 * HOUR]));
  await turn(h, 't1', { error: 'rate_limit' });
  assert.deepEqual(h.preferences.get(HOLDS_PLAN), {
    kind: 'window',
    error: 'rate_limit',
    since: 1_000_000,
    until: 1_000_000 + 3 * HOUR + MINUTE,
    streak: 1,
    window: 'five_hour',
  });
  const next = await turn(h, 't2');
  assert.equal(next.model, 'zai-org/GLM-5.3');
  assert.ok(h.toasts.some((text) => text.includes('Claude plan held out of routing')));
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
  await failedTurn(second, 't1', { error: 'rate_limit' });
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
    probeAt: 1_000_000 + HOUR,
  });
  assert.equal(h.loop().held, undefined);
  assert.deepEqual(h.toasts, ['Claude plan held out of routing: no balance, until released, next try 01:16']);
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

const HAIKU_PLAN = {
  id: 'team-haiku-5-5',
  input: 1,
  output: 5,
  cacheRead: 0.1,
  contextWindow: 200_000,
  billing: 'plan',
  efforts: [],
};

test('in a session that also pays credits, a full plan window holds the plan account', async (t) => {
  const h = await started(t, { models: { glm: GLM } });
  h.usage(planReadings(['five_hour', 100, 3 * HOUR]));
  await turn(h, 't1', { error: 'rate_limit' });
  assert.equal(h.preferences.get(HOLDS_PLAN).kind, 'window');
  assert.equal(h.loop().held?.[OPUS], undefined);
});

test('with plan models in two accounts, a full plan window is only an availability hold', async (t) => {
  const h = await started(t, { models: { glm: GLM, haikuTeam: { ...HAIKU_PLAN, account: 'team' } } });
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

test('an empty error_details leaves the last assistant message to classify and record', async (t) => {
  const h = await started(t);
  const text = "You've hit your individual spend limit";
  await turn(h, 't1', { error: 'rate_limit', error_details: '', last_assistant_message: text });
  assert.equal(h.preferences.get(HOLDS_PLAN).kind, 'calendar');
  assert.equal(failureRows(h)[0].details, text);
});

test('a model hold is recorded with the model that was held', async (t) => {
  const h = await started(t);
  await turn(h, 't1', { error: 'overloaded', error_details: 'Overloaded' });
  const [row] = failureRows(h);
  assert.deepEqual([row.fail, row.scope, row.held, row.details], ['availability', 'model', OPUS, 'Overloaded']);
});

test('the auto engine records the failure and holds what the table engine would', async (t) => {
  const capability = { low: 2, medium: 2.5, high: 2.5, xhigh: 3, max: 3 };
  const h = await started(t, { routingEngine: 'auto', models: { opus: { capability } } });
  await turn(h, 't1', { error: 'billing_error' });
  assert.deepEqual(h.preferences.get(HOLDS_PLAN), {
    kind: 'balance',
    error: 'billing_error',
    since: 1_000_000,
    until: null,
    streak: 1,
    probeAt: 1_000_000 + HOUR,
  });
  assert.deepEqual(
    failureRows(h).map((row) => [row.err, row.fail, row.scope, row.held]),
    [['billing_error', 'balance', 'account', 'plan']],
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

test('a subagent’s failure holds the model its agent ran, and writes no failure row', async (t) => {
  const h = await started(t);
  // A main turn first: a model hold needs the session's loop.
  await turn(h, 't1');
  // One agent step names the model a later StopFailure for that agent holds.
  await drain(h.step({ ...step, turnId: 'a1-t', agentId: 'a1', model: HAIKU }, { usage: undefined }));
  await h.event('classic.StopFailure', { hook_event_name: 'StopFailure', error: 'overloaded', agent_id: 'a1' });
  assert.deepEqual(Object.keys(h.loop().held), [HAIKU]);
  assert.ok(Object.keys(h.view().holds.models).includes(HAIKU));
  assert.deepEqual(failureRows(h), []);
  // A reply from that model ends its streak, as a main reply does: the next failure starts at the base time, and
  // the pane stops naming a hold routing no longer keeps.
  await drain(h.step({ ...step, turnId: 'a1-t2', agentId: 'a1', model: HAIKU }));
  assert.deepEqual(Object.keys(h.loop().held), []);
  assert.deepEqual(Object.keys(h.view().holds.models), []);
});

test('an agent reply that lands while a main step is deciding merges its clear into that step’s write', async (t) => {
  const h = await started(t);
  await turn(h, 't1');
  await drain(h.step({ ...step, turnId: 'a1-t', agentId: 'a1', model: HAIKU }, { usage: undefined }));
  await h.event('classic.StopFailure', { hook_event_name: 'StopFailure', error: 'overloaded', agent_id: 'a1' });
  assert.deepEqual(Object.keys(h.loop().held), [HAIKU]);
  // The next main step suspends on its transcript; the agent's successful reply lands inside that window.
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let entered = () => {};
  const reached = new Promise((resolve) => {
    entered = resolve;
  });
  let gated = false;
  h.messages(async () => {
    if (!gated) {
      gated = true;
      entered();
      await gate;
    }
    return [{ role: 'user', content: [{ type: 'text', text: 'One edit.' }] }];
  });
  await h.event('turn.start', { turnId: 't2', text: 'One edit.' });
  const main = drain(h.step({ ...step, turnId: 't2', model: OPUS }));
  await reached;
  await drain(h.step({ ...step, turnId: 'a1-t2', agentId: 'a1', model: HAIKU }));
  release();
  await main;
  // The clear did not advance the loop under the suspended step: its decision still wrote, and the clear came with it.
  assert.equal(h.loop().turnId, 't2');
  assert.deepEqual(Object.keys(h.loop().held), []);
  assert.equal(h.requests.at(-1).model, OPUS);
  assert.deepEqual(Object.keys(h.view().holds.models), []);
});

test('a subagent failure whose request is unknown holds nothing, and the plan stays usable', async (t) => {
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
  await failedTurn(h, 't2', { error: 'overloaded' });
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

test('a released model hold leaves the held-out view and the typeahead at once, and Undo brings it back', async (t) => {
  const h = await started(t);
  await turn(h, 't1', { error: 'overloaded' });
  assert.deepEqual(await typeahead(h, '/router release o'), ['opus']);
  await command(h, 'release opus');
  assert.deepEqual(h.view().holds.models, {});
  assert.deepEqual(await typeahead(h, '/router release o'), []);
  await press(h, 'undo');
  assert.deepEqual(Object.keys(h.view().holds.models), [OPUS]);
  assert.deepEqual(await typeahead(h, '/router release o'), ['opus']);
});

// Every write of the loop loses to a write made since it was read, as when a step of the next turn writes it first.
function loseLoopWrites(h) {
  const set = h.$.state.set;
  h.$.state.set = async (ref, value, options) => {
    const stored = h.state.get('loops:main');
    if (ref.key === 'loops' && stored) h.state.set('loops:main', { ...stored, version: stored.version + 1 });
    return set(ref, value, options);
  };
}

test('a release whose loop write loses to another write says so and keeps the hold', async (t) => {
  const h = await started(t);
  await turn(h, 't1', { error: 'overloaded' });
  loseLoopWrites(h);
  assert.equal((await command(h, 'release opus')).text, 'Opus 5.5 could not be released.');
  assert.deepEqual(Object.keys(h.loop().held), [OPUS]);
});

test('a model hold whose loop write loses to another write holds nothing and claims nothing', async (t) => {
  const h = await started(t);
  await h.event('turn.start', { turnId: 't1', text: 'One edit.' });
  await drain(h.step({ ...step, turnId: 't1', model: OPUS }));
  loseLoopWrites(h);
  await h.event('classic.StopFailure', { hook_event_name: 'StopFailure', error: 'overloaded' });
  assert.equal(h.loop().held, undefined);
  assert.deepEqual(h.toasts, []);
});

test('a failure that arrives while its turn completes keeps the turn’s end row', async (t) => {
  const h = await started(t);
  await h.event('turn.start', { turnId: 't1', text: 'One edit.' });
  await drain(h.step({ ...step, turnId: 't1', model: OPUS }));
  const get = h.$.store.get;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let waiting = false;
  h.$.store.get = async (key) => {
    if (!key.startsWith(DECISIONS_PREFIX)) {
      waiting = true;
      await gate;
    }
    return get(key);
  };
  const completing = h.event('turn.complete', { turnId: 't1', isAborted: false });
  while (!waiting) await new Promise((resolve) => setImmediate(resolve));
  h.$.store.get = get;
  await h.event('classic.StopFailure', { hook_event_name: 'StopFailure', error: 'overloaded' });
  release();
  await completing;
  assert.deepEqual(
    decisions(h).rows.map((row) => row.kind),
    ['start', 'failure', 'end'],
  );
});

// A spend-cap hold on the plan account, its first probe an hour after it was set.
const SPEND_HOLD = {
  kind: 'calendar',
  error: 'rate_limit',
  since: 1_000_000,
  until: 1_000_000 + 24 * HOUR,
  streak: 1,
  probeAt: 1_000_000 + HOUR,
};
const ANSWERED = 'Claude plan answered again: routing may use it';
const NO_REPLY = { stopReason: null, usage: null };

async function probing(t, hold = SPEND_HOLD) {
  const h = await started(t, CHAINED);
  h.preferences.set(HOLDS_PLAN, hold);
  return h;
}

// One main turn whose request gets `response`, with no StopFailure.
async function sentTurn(h, turnId, response = {}) {
  await h.event('turn.start', { turnId, text: 'One edit.' });
  await drain(h.step({ ...step, turnId, model: OPUS }, response));
  await h.event('turn.complete', { turnId, isAborted: false });
  return h.requests.at(-1).model;
}

test('a held account is tried again once its probe is due, and an answer ends the hold', async (t) => {
  const h = await probing(t);
  t.mock.timers.tick(HOUR - 1);
  assert.equal(await sentTurn(h, 't1'), GLM_ID);
  assert.equal(h.preferences.has(HOLDS_PLAN), true);
  t.mock.timers.tick(1);
  assert.equal(await sentTurn(h, 't2'), OPUS);
  assert.equal(h.preferences.has(HOLDS_PLAN), false);
  assert.deepEqual(h.view().holds.accounts, {});
  assert.equal(h.toasts.filter((text) => text === ANSWERED).length, 1);
});

test('a hold stored without a probe time is not tried before it ends', async (t) => {
  const { probeAt, ...old } = SPEND_HOLD;
  const h = await probing(t, old);
  t.mock.timers.tick(2 * HOUR);
  assert.equal(await sentTurn(h, 't1'), GLM_ID);
});

test('a probe that gets no reply waits twice as long, and the next turn uses the stand-in', async (t) => {
  const h = await probing(t);
  t.mock.timers.tick(HOUR);
  await h.event('turn.start', { turnId: 't1', text: 'One edit.' });
  await drain(h.step({ ...step, turnId: 't1', model: OPUS }, NO_REPLY));
  assert.deepEqual(h.preferences.get(HOLDS_PLAN), { ...SPEND_HOLD, streak: 2, probeAt: 1_000_000 + 3 * HOUR });
  assert.equal(h.view().holds.accounts.plan.probeAt, 1_000_000 + 3 * HOUR);
  await h.event('turn.complete', { turnId: 't1', isAborted: false });
  assert.equal(await sentTurn(h, 't2'), GLM_ID);
});

test('the failure that ends a probe’s turn extends the hold and keeps its backoff', async (t) => {
  // No model outside the held account: the step has no stand-in, so the failed one is the probe’s.
  const h = await started(t);
  h.preferences.set(HOLDS_PLAN, SPEND_HOLD);
  t.mock.timers.tick(HOUR);
  await sentTurn(h, 't1', NO_REPLY);
  await h.event('classic.StopFailure', {
    hook_event_name: 'StopFailure',
    error: 'rate_limit',
    last_assistant_message: "You've hit your individual spend limit",
  });
  const held = h.preferences.get(HOLDS_PLAN);
  assert.deepEqual([held.streak, held.probeAt, held.until], [2, 1_000_000 + 3 * HOUR, 1_000_000 + 25 * HOUR]);
});

test('an aborted probe stays due', async (t) => {
  const h = await probing(t);
  t.mock.timers.tick(HOUR);
  const abort = new AbortController();
  await h.event('turn.start', { turnId: 't1', text: 'One edit.' });
  abort.abort();
  await drain(h.step({ ...step, turnId: 't1', model: OPUS }, NO_REPLY, abort.signal));
  assert.deepEqual(h.preferences.get(HOLDS_PLAN), SPEND_HOLD);
  assert.equal(h.requests.length, 1);
});

test('a probe another session released is not written back', async (t) => {
  const h = await probing(t);
  t.mock.timers.tick(HOUR);
  await h.event('turn.start', { turnId: 't1', text: 'One edit.' });
  await drain(h.step({ ...step, turnId: 't1', model: OPUS }));
  assert.equal(h.preferences.has(HOLDS_PLAN), false);
  h.preferences.set(HOLDS_PLAN, SPEND_HOLD);
  await h.event('turn.start', { turnId: 't2', text: 'One edit.' });
  const get = h.$.store.get;
  let reads = 0;
  h.$.store.get = async (key) => {
    if (key === HOLDS_PLAN && ++reads === 2) h.preferences.delete(HOLDS_PLAN);
    return get(key);
  };
  await drain(h.step({ ...step, turnId: 't2', model: OPUS }, NO_REPLY));
  assert.equal(h.preferences.has(HOLDS_PLAN), false);
});

test('a subagent spawn still sees a hold whose probe is due', async (t) => {
  const h = await probing(t);
  answering(h, LOW);
  t.mock.timers.tick(HOUR);
  const input = {
    subagentType: 'Explore',
    description: 'Look',
    prompt: 'Find the file.',
    parentModel: OPUS,
    agentId: undefined,
  };
  const { sent } = await h.spawn(input);
  assert.equal(sent, input);
});

test('a subagent reply from a held account’s model ends the hold', async (t) => {
  const h = await started(t);
  h.preferences.set(HOLDS_PLAN, { ...SPEND_HOLD, kind: 'window' });
  // The main turn reads the hold; the agent's reply ends it from that reading.
  await sentTurn(h, 't1', NO_REPLY);
  await drain(h.step({ ...step, turnId: 'a1-t', agentId: 'a1', model: HAIKU }));
  assert.equal(h.preferences.has(HOLDS_PLAN), false);
  assert.deepEqual(h.view().holds.accounts, {});
  assert.deepEqual(h.toasts, [ANSWERED]);
});

test('a reply from another model leaves the account hold', async (t) => {
  const h = await started(t);
  h.preferences.set(HOLDS_PLAN, SPEND_HOLD);
  await sentTurn(h, 't1', NO_REPLY);
  await drain(
    h.step(
      { ...step, turnId: 'a1-t', agentId: 'a1', model: HAIKU },
      { usage: { model: GLM_ID, input_tokens: 1, output_tokens: 1 } },
    ),
  );
  assert.equal(h.preferences.has(HOLDS_PLAN), true);
});

test('a reply to a request sent before the hold was set leaves it', async (t) => {
  const h = await started(t);
  h.preferences.set(HOLDS_PLAN, { ...SPEND_HOLD, since: 1_000_001 });
  await sentTurn(h, 't1', NO_REPLY);
  await drain(h.step({ ...step, turnId: 'a1-t', agentId: 'a1', model: HAIKU }));
  assert.equal(h.preferences.has(HOLDS_PLAN), true);
});

// Opus gets no reply; every other model answers.
const opusFails = (request) => (request.model === OPUS ? NO_REPLY : {});
const sentModels = (h) => h.requests.map((request) => request.model);

test('a probe that gets no reply is sent again on the stand-in in the same step', async (t) => {
  const h = await probing(t);
  t.mock.timers.tick(HOUR);
  await h.event('turn.start', { turnId: 't1', text: 'One edit.' });
  const response = await drain(h.step({ ...step, turnId: 't1', model: OPUS }, opusFails));
  assert.equal(response.stopReason, 'end_turn');
  assert.deepEqual(sentModels(h), [OPUS, GLM_ID]);
  assert.equal(h.requests.at(-1).effort, 'max');
  assert.equal(h.preferences.get(HOLDS_PLAN).streak, 2);
  assert.equal(h.loop().decision.model, GLM_ID);
  assert.deepEqual(h.loop().route, { model: 'opus', effort: 'medium' });
  assert.equal(h.view().selectedModel, GLM_ID);
  assert.deepEqual(
    h.toasts.filter((text) => text.includes('still limited')),
    ['Opus 5.5 still limited → GLM 5.3'],
  );
  await h.event('turn.complete', { turnId: 't1', isAborted: false });
  const [row] = failureRows(h);
  assert.deepEqual(
    [row.err, row.fail, row.scope, row.held, row.route],
    [null, 'calendar', 'account', 'plan', `${GLM_ID}@max`],
  );
});

test('a model tried again after its hold ended is held twice as long and the stand-in answers', async (t) => {
  const h = await started(t, CHAINED);
  await failedTurn(h, 't1', { error: 'overloaded' });
  t.mock.timers.tick(5 * MINUTE);
  await h.event('turn.start', { turnId: 't2', text: 'One edit.' });
  await drain(h.step({ ...step, turnId: 't2', model: OPUS }, opusFails));
  assert.deepEqual(sentModels(h).slice(1), [OPUS, GLM_ID]);
  assert.deepEqual(h.loop().held[OPUS], {
    kind: 'availability',
    error: 'overloaded',
    since: Date.now(),
    until: Date.now() + 10 * MINUTE,
    streak: 2,
  });
  assert.deepEqual(Object.keys(h.view().holds.models), [OPUS]);
  await h.event('turn.complete', { turnId: 't2', isAborted: false });
  const row = failureRows(h).at(-1);
  assert.deepEqual([row.fail, row.scope, row.held], ['availability', 'model', OPUS]);
});

test('a step retries once: a stand-in that gets no reply either is the model a failure then holds', async (t) => {
  const h = await started(t, CHAINED);
  await failedTurn(h, 't1', { error: 'overloaded' });
  t.mock.timers.tick(5 * MINUTE);
  await h.event('turn.start', { turnId: 't2', text: 'One edit.' });
  await drain(h.step({ ...step, turnId: 't2', model: OPUS }, NO_REPLY));
  assert.deepEqual(sentModels(h).slice(1), [OPUS, GLM_ID]);
  await h.event('classic.StopFailure', { hook_event_name: 'StopFailure', error: 'overloaded' });
  assert.deepEqual(Object.keys(h.loop().held), [OPUS, GLM_ID]);
  assert.equal(h.loop().held[OPUS].streak, 2);
});

test('a model with no failure history is not sent again', async (t) => {
  const h = await started(t, CHAINED);
  await h.event('turn.start', { turnId: 't1', text: 'One edit.' });
  const response = await drain(h.step({ ...step, turnId: 't1', model: OPUS }, opusFails));
  assert.equal(response.stopReason, null);
  assert.deepEqual(sentModels(h), [OPUS]);
});

test('the auto engine does not send a failed step again', async (t) => {
  const capability = { low: 2, medium: 2.5, high: 2.5, xhigh: 3, max: 3 };
  const h = await started(t, { routingEngine: 'auto', models: { opus: { capability } } });
  await failedTurn(h, 't1', { error: 'overloaded' });
  h.preferences.set(HOLDS_PLAN, SPEND_HOLD);
  t.mock.timers.tick(HOUR);
  await h.event('turn.start', { turnId: 't2', text: 'One edit.' });
  await drain(h.step({ ...step, turnId: 't2', model: OPUS }, NO_REPLY));
  assert.equal(h.requests.length, 2);
});

test('an answer leaves a hold another session set after the request was sent', async (t) => {
  const h = await probing(t);
  t.mock.timers.tick(HOUR);
  const newer = { ...SPEND_HOLD, since: Date.now() + 1, probeAt: Date.now() + HOUR };
  await sentTurn(h, 't1', () => {
    h.preferences.set(HOLDS_PLAN, newer);
    return {};
  });
  assert.deepEqual(h.preferences.get(HOLDS_PLAN), newer);
  assert.deepEqual(h.view().holds.accounts.plan, newer);
  assert.equal(h.toasts.includes(ANSWERED), false);
});

test('a probe another session already put off is not put off again', async (t) => {
  const h = await probing(t);
  t.mock.timers.tick(HOUR);
  const put = { ...SPEND_HOLD, streak: 2, probeAt: Date.now() + 2 * HOUR };
  const get = h.$.store.get;
  let reads = 0;
  h.$.store.get = async (key) => {
    if (key === HOLDS_PLAN && ++reads === 2) h.preferences.set(HOLDS_PLAN, put);
    return get(key);
  };
  await sentTurn(h, 't1', NO_REPLY);
  assert.deepEqual(h.preferences.get(HOLDS_PLAN), put);
});

// A reply the router learns nothing from: the request ran, with no usage to count.
const NO_USAGE = { usage: null };

test('a turn whose probe is due keeps the held account’s model on its continuation steps', async (t) => {
  const h = await probing(t);
  t.mock.timers.tick(HOUR);
  await h.event('turn.start', { turnId: 't1', text: 'One edit.' });
  for (const index of [0, 1]) await drain(h.step({ ...step, turnId: 't1', model: OPUS, index }, NO_USAGE));
  assert.deepEqual(sentModels(h), [OPUS, OPUS]);
});

// Haiku on its own account, so a turn can start outside the held plan and move onto it.
const CHEAP_HAIKU = { models: { haiku: { account: 'cheap' } } };

test('a turn’s own edits move it up onto an account whose probe is due', async (t) => {
  const h = await started(t, CHEAP_HAIKU);
  h.preferences.set(HOLDS_PLAN, SPEND_HOLD);
  t.mock.timers.tick(HOUR);
  answering(h, jevResponse('medium', { medium: 0.97, high: 0.03 }, 0, { ops: 0.9, code: 0.1 }, 'execute'));
  await h.event('turn.start', { turnId: 't1', text: 'Run the worker brief.' });
  h.messages(async () => [user('Run the worker brief.')]);
  await drain(h.step({ ...step, turnId: 't1', model: OPUS }));
  h.messages(async () => [user('Run the worker brief.'), assistant('fixing', ['Edit']), toolResult('ok')]);
  await drain(h.step({ ...step, turnId: 't1', model: OPUS, index: 1, messageCount: 3 }));
  assert.deepEqual(sentModels(h), [HAIKU, OPUS]);
});

test('a mid-turn review moves a turn up onto an account whose probe is due', async (t) => {
  const h = await started(t, { ...CHEAP_HAIKU, policy: { reviewEveryRequests: 1 } });
  h.preferences.set(HOLDS_PLAN, SPEND_HOLD);
  t.mock.timers.tick(HOUR);
  answering(h, LOW, jevResponse('high', { high: 0.97, uncertain: 0.03 }));
  await h.event('turn.start', { turnId: 't1', text: 'One edit.' });
  for (const index of [0, 1, 2, 3]) {
    await drain(h.step({ ...step, turnId: 't1', model: OPUS, index, messageCount: 1 + 2 * index }));
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(sentModels(h)[0], HAIKU);
  assert.equal(sentModels(h).at(-1), OPUS);
});

test('a reply to a step the router passed on unrouted ends the account hold', async (t) => {
  const capability = { low: 2, medium: 2.5, high: 2.5, xhigh: 3, max: 3 };
  const h = await started(t, { routingEngine: 'auto', models: { opus: { capability } } });
  h.preferences.set(HOLDS_PLAN, SPEND_HOLD);
  await sentTurn(h, 't1');
  assert.equal(h.view().reason, 'no-route-native');
  assert.equal(h.preferences.has(HOLDS_PLAN), false);
  assert.deepEqual(
    h.toasts.filter((text) => text === ANSWERED),
    [ANSWERED],
  );
});

test('a step whose session changed during the failed request is not sent again', async (t) => {
  const h = await probing(t);
  t.mock.timers.tick(HOUR);
  await sentTurn(h, 't1', () => {
    h.clear('s2');
    return NO_REPLY;
  });
  assert.deepEqual(sentModels(h), [OPUS]);
});

test('a probe with no other model free is not sent again, and records and says nothing', async (t) => {
  const h = await started(t);
  h.preferences.set(HOLDS_PLAN, SPEND_HOLD);
  t.mock.timers.tick(HOUR);
  await sentTurn(h, 't1', NO_REPLY);
  assert.deepEqual(sentModels(h), [OPUS]);
  assert.deepEqual(
    h.toasts.filter((text) => text.includes('still limited')),
    [],
  );
  assert.deepEqual(failureRows(h), []);
});

test('the shadow engine sends a failed probe again and marks its trace incomplete', async (t) => {
  const h = await started(t, { ...CHAINED, routingEngine: 'shadow' });
  h.preferences.set(HOLDS_PLAN, SPEND_HOLD);
  t.mock.timers.tick(HOUR);
  await sentTurn(h, 't1', opusFails);
  assert.deepEqual(sentModels(h), [OPUS, GLM_ID]);
  assert.ok(h.preferences.get(`${TRACE_PREFIX}s1`).incomplete.includes('gap'));
});
