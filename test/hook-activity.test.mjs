// The native router hook with activity routing: the classifier asked inside a turn, moves up and down, and the escalation watch.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readUsage, summarize } from '../lib/usage.mjs';
import { answering, band, CONFIG, drain, harness, JEV_KEY, start, step, texts } from './harness.mjs';
import { assistant, jevResponse, savedCounts, savedStats, sessionOf, toolResult, user } from './helpers.mjs';

const LOW = { micro: 0, low: 0.95, medium: 0.05, high: 0, uncertain: 0 };

// One whole turn on the session's `model`: its prompt, a routed step, then turn.complete over a transcript where the
// assistant called `tools`.
async function turn(h, turnId, model, tools = []) {
  await h.event('turn.start', { turnId, text: 'Next.' });
  h.messages(async () => [user('Next.')]);
  await drain(h.step({ ...step, turnId, model }));
  h.messages(async () => [user('Next.'), assistant('done', tools)]);
  await h.event('turn.complete', { turnId });
}

const reply = { turns: 1, requests: 1, inputTokens: 1100, outputTokens: 10 };

const MEDIUM = { micro: 0, low: 0.05, medium: 0.95, high: 0, uncertain: 0 };

const tick = () => new Promise((resolve) => setImmediate(resolve));

const bash = (id, command) => ({
  role: 'assistant',
  content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }],
});

const ran = (id, isError = false) => ({
  role: 'user',
  content: [{ type: 'tool_result', tool_use_id: id, is_error: isError }],
});

const reviewed = (h) => h.requests.map((r) => `${r.model}@${r.effort}`);

// Runs steps `from` up to `to` of one turn on `model`, letting background classifier reviews answer between steps.
async function longTurn(h, model, to, from = 0) {
  for (let index = from; index < to; index += 1) {
    await drain(h.step({ ...step, model, index, messageCount: 1 + 2 * index }));
    await tick();
  }
}

test('with no router.json, a fresh session asks the activity and runs its default route', async () => {
  for (const [model, answer, activity, expected] of [
    ['claude-haiku-5-5', jevResponse('low', LOW, 0, { code: 0.9, ops: 0.1 }), 'code', ['claude-sonnet-5-5', 'high']],
    [
      'claude-opus-5-5',
      jevResponse('medium', MEDIUM, 0, { ops: 0.9, code: 0.1 }, 'execute'),
      'ops',
      ['claude-haiku-5-5', 'high'],
    ],
    ['claude-haiku-5-5', jevResponse('low', LOW, 0, { explore: 0.9 }), 'explore', ['claude-haiku-5-5', 'high']],
  ]) {
    const h = harness(JEV_KEY);
    h.model(model);
    const bodies = answering(h, answer);
    await h.event('session.start', { cwd: '/fixture' });
    await turn(h, 't1', model, ['Edit']);
    assert.ok(bodies[0].questions.activity, activity);
    assert.deepEqual([h.requests[0].model, h.requests[0].effort], expected, activity);
    assert.equal(h.loop().decision.activity, activity);
  }
});

test('a turn routed as ops moves up once its own tool calls edit code, and stays up', async () => {
  const model = 'claude-sonnet-5-5';
  const h = harness(JEV_KEY);
  h.model(model);
  answering(h, jevResponse('medium', MEDIUM, 0, { ops: 0.9, code: 0.1 }, 'execute'));
  await start(h);
  await drain(h.step({ ...step, model }));
  h.messages(async () => [user('Run the worker brief.'), assistant('running', ['Bash']), toolResult('ok')]);
  await drain(h.step({ ...step, model, index: 1, messageCount: 3 }));
  h.messages(async () => [
    user('Run the worker brief.'),
    assistant('running', ['Bash']),
    toolResult('ok'),
    assistant('fixing', ['Edit']),
    toolResult('ok'),
  ]);
  await drain(h.step({ ...step, model, index: 2, messageCount: 5 }));
  await drain(h.step({ ...step, model, index: 3, messageCount: 7 }));
  assert.deepEqual(
    h.requests.map((r) => `${r.model}@${r.effort}`),
    ['claude-haiku-5-5@high', 'claude-haiku-5-5@high', 'claude-opus-5-5@medium', 'claude-opus-5-5@medium'],
  );
  assert.deepEqual([h.loop().decision.reason, h.loop().lastActivity], ['activity-up', 'code']);
  assert.equal(h.toasts.length, 1);
  assert.match(h.toasts[0], /^Model changed: Haiku 5\.5 · high → Opus 5\.5 · medium · ↑ code/);
  const { at, ...moved } = h.view().lastSwitch;
  assert.ok(Number.isFinite(at));
  assert.deepEqual(moved, {
    from: { tier: 'medium', model: 'claude-haiku-5-5', effort: 'high' },
    to: { tier: 'medium', model: 'claude-opus-5-5', effort: 'medium' },
    activity: 'code',
  });
});

test('inside a turn the classifier is asked again in the background and a clear harder answer moves up', async () => {
  const model = 'claude-haiku-5-5';
  const h = harness(JEV_KEY);
  h.model(model);
  const bodies = answering(h, jevResponse('low', LOW), jevResponse('high', { high: 0.97, uncertain: 0.03 }));
  await start(h);
  await longTurn(h, model, 7);
  assert.equal(bodies.length, 2);
  assert.deepEqual(reviewed(h).slice(4), ['claude-haiku-5-5@high', 'claude-opus-5-5@xhigh', 'claude-opus-5-5@xhigh']);
  assert.equal(h.loop().decision.reason, 'jump');
  assert.equal(h.toasts.length, 1);
  const { at, from, to } = h.view().lastSwitch;
  assert.ok(Number.isFinite(at));
  assert.deepEqual(
    [from, to],
    [
      { tier: 'low', model: 'claude-haiku-5-5', effort: 'high' },
      { tier: 'high', model: 'claude-opus-5-5', effort: 'xhigh' },
    ],
  );
});

test('a pinned turn changes the route without becoming the last switch', async () => {
  const model = 'claude-haiku-5-5';
  const h = harness(JEV_KEY);
  h.model(model);
  answering(h, jevResponse('low', LOW));
  await start(h);
  await drain(h.step({ ...step, model }));
  await h.event('turn.complete', { turnId: step.turnId });
  await h.event('command.run', { command: 'router', args: 'pin high' });
  await drain(h.step({ ...step, turnId: 't2', model }));
  assert.equal(h.requests.at(-1).model, 'claude-opus-5-5');
  assert.equal(h.view().lastSwitch, null);
});

test('inside a turn a cheaper answer moves down only after the dwell and a passed verification', async () => {
  for (const [name, result, expected] of [
    ['tests passed', ran('v'), 'claude-haiku-5-5@high'],
    ['tests failed', ran('v', true), 'claude-opus-5-5@medium'],
    ['nothing verified', null, 'claude-opus-5-5@medium'],
  ]) {
    const model = 'claude-opus-5-5';
    const h = harness(JEV_KEY);
    h.model(model);
    answering(h, jevResponse('medium', MEDIUM), jevResponse('low', { low: 0.99, uncertain: 0.01 }));
    h.messages(async () => [user('Fix it.'), bash('v', 'npm test'), ...(result ? [result] : [])]);
    await start(h);
    await longTurn(h, model, 12);
    assert.equal(reviewed(h).at(-1), expected, name);
    if (!result || result.content[0].is_error) assert.equal(h.loop().decision.reason, 'downgrade-held', name);
  }
});

test('inside a turn a cheaper answer with its votes waits out the dwell, then moves down', async () => {
  const model = 'claude-opus-5-5';
  const h = harness(JEV_KEY);
  h.files.set(CONFIG, JSON.stringify({ policy: { reviewEveryRequests: 1 } }));
  h.model(model);
  answering(h, jevResponse('medium', MEDIUM), jevResponse('low', { low: 0.99, uncertain: 0.01 }));
  h.messages(async () => [user('Fix it.'), bash('v', 'npm test'), ran('v')]);
  await start(h);
  await longTurn(h, model, 7);
  assert.deepEqual([reviewed(h).at(-1), h.loop().decision.reason], ['claude-opus-5-5@medium', 'downgrade-held']);
  await longTurn(h, model, 12, 7);
  assert.equal(reviewed(h).at(-1), 'claude-haiku-5-5@high');
});

test('a review answer is decided on the checkpoint at the step it applies to, not the one it was asked at', async () => {
  const model = 'claude-opus-5-5';
  const h = harness(JEV_KEY);
  h.model(model);
  answering(h, jevResponse('medium', MEDIUM), jevResponse('low', { low: 0.99, uncertain: 0.01 }));
  h.messages(async () => [user('Fix it.'), bash('v', 'npm test'), ran('v')]);
  await start(h);
  await longTurn(h, model, 10);
  h.messages(async () => [user('Fix it.'), bash('v', 'npm test'), ran('v'), bash('w', 'npm test'), ran('w', true)]);
  await longTurn(h, model, 11, 10);
  assert.deepEqual([reviewed(h).at(-1), h.loop().decision.reason], ['claude-opus-5-5@medium', 'downgrade-held']);
});

test('an accepted cheaper activity is not undone by edits the review already saw', async () => {
  const model = 'claude-opus-5-5';
  const h = harness(JEV_KEY);
  h.model(model);
  answering(h, jevResponse('medium', MEDIUM, 0, { ops: 0.97, code: 0.03 }, 'execute'));
  h.messages(async () => [
    user('Run the brief.'),
    assistant('fixing', ['Edit']),
    toolResult('ok'),
    bash('v', 'npm test'),
    ran('v'),
  ]);
  await start(h);
  await longTurn(h, model, 14);
  const routes = reviewed(h);
  assert.deepEqual([routes[0], routes[1]], ['claude-haiku-5-5@high', 'claude-opus-5-5@medium']);
  assert.equal(routes.at(-1), 'claude-haiku-5-5@high');
  assert.equal(routes.lastIndexOf('claude-opus-5-5@medium') + 1, routes.indexOf('claude-haiku-5-5@high', 1));
});

test('an edit made after a review was asked moves the route up again once the review applies', async () => {
  const model = 'claude-opus-5-5';
  const h = harness(JEV_KEY);
  h.model(model);
  answering(h, jevResponse('medium', MEDIUM, 0, { ops: 0.97, code: 0.03 }, 'execute'));
  const before = [
    user('Run the brief.'),
    assistant('fixing', ['Edit']),
    toolResult('ok'),
    bash('v', 'npm test'),
    ran('v'),
  ];
  h.messages(async () => before);
  await start(h);
  await longTurn(h, model, 10);
  h.messages(async () => [...before, assistant('fixing more', ['Edit']), toolResult('ok')]);
  await longTurn(h, model, 12, 10);
  assert.deepEqual(reviewed(h).slice(-2), ['claude-opus-5-5@medium', 'claude-opus-5-5@medium']);
  assert.equal(h.loop().decision.activity, 'code');
});

test('a transcript that cannot be read inside a turn keeps the running route', async () => {
  const model = 'claude-haiku-5-5';
  const h = harness(JEV_KEY);
  h.files.set(CONFIG, JSON.stringify({ policy: { reviewEveryRequests: 1 } }));
  h.model(model);
  answering(
    h,
    jevResponse('medium', MEDIUM, 0, { ops: 0.9, code: 0.1 }, 'execute'),
    jevResponse('high', { high: 0.97, uncertain: 0.03 }),
  );
  h.messages(async () => [user('Run the brief.'), assistant('running', ['Bash']), toolResult('ok')]);
  await start(h);
  await longTurn(h, model, 2);
  h.messages(async () => {
    throw new Error('transcript unavailable');
  });
  await longTurn(h, model, 4, 2);
  assert.deepEqual(reviewed(h), Array(4).fill('claude-haiku-5-5@high'));
});

test('a step does not wait for the classifier review it starts', { timeout: 5_000 }, async () => {
  const model = 'claude-haiku-5-5';
  const h = harness(JEV_KEY);
  h.model(model);
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let calls = 0;
  h.http(async () => {
    calls += 1;
    const answer = calls === 1 ? jevResponse('low', LOW) : jevResponse('high', { high: 0.97, uncertain: 0.03 });
    if (calls > 1) await held;
    return { ok: true, status: 200, text: JSON.stringify(answer), headers: {} };
  });
  await start(h);
  await longTurn(h, model, 7);
  assert.equal(calls, 2);
  assert.deepEqual(reviewed(h), Array(7).fill('claude-haiku-5-5@high'));
  release();
  await tick();
  await longTurn(h, model, 8, 7);
  assert.equal(reviewed(h).at(-1), 'claude-opus-5-5@xhigh');
});

test('with activity routing on, an ops turn moves from Sonnet to Haiku inside its tier and records it', async () => {
  const h = harness(JEV_KEY);
  h.files.set(CONFIG, JSON.stringify({ activityRouting: 'on' }));
  h.model('claude-sonnet-5-5');
  answering(
    h,
    jevResponse('low', LOW, 0, { code: 0.9, ops: 0.1 }),
    jevResponse('low', LOW, 0, { ops: 0.81, code: 0.19 }, 'execute'),
  );
  await h.event('session.start', { cwd: '/fixture' });
  await turn(h, 't1', 'claude-sonnet-5-5', ['Edit']);
  assert.equal(h.view().mode, 'auto');
  assert.deepEqual([h.requests[0].model, h.requests[0].effort], ['claude-sonnet-5-5', 'high']);
  let line = (await band(h)).line;
  assert.match(line, /^▂▄▆█ Sonnet 5\.5 · high {3}code {3}= fits/);
  assert.match(line, /ctx [▰▱]+ \d+% {3}cache \d+% last/);
  await turn(h, 't2', 'claude-sonnet-5-5', ['Bash']);
  assert.deepEqual([h.requests[1].model, h.requests[1].effort], ['claude-haiku-5-5', 'high']);
  assert.deepEqual([h.loop().decision.reason, h.loop().lastActivity], ['activity-down', 'ops']);
  assert.equal(h.toasts.length, 1);
  assert.match(h.toasts[0], /^Model changed: Sonnet 5\.5 · high → Haiku 5\.5 · high · ↓ ops/);
  line = (await band(h)).line;
  assert.match(line, /^▂▄▆█ Haiku 5\.5 · high {3}ops \/ execute {3}↓ ops /);
  const { at, ...moved } = h.view().lastSwitch;
  assert.ok(Number.isFinite(at));
  assert.deepEqual(moved, {
    from: { tier: 'low', model: 'claude-sonnet-5-5', effort: 'high' },
    to: { tier: 'low', model: 'claude-haiku-5-5', effort: 'high' },
    activity: 'ops',
  });
  const now = texts(await h.render());
  assert.ok(now.includes('Haiku 5.5 · high') && now.includes('↓ ops'), 'Now names the route and why it moved');
  assert.ok(now.includes('ops') && now.includes(' 81%'), 'Now shows the activity answer it weighed');
  const { byActivity, ...counts } = h.view().activityStats;
  assert.deepEqual(
    Object.fromEntries(Object.entries(byActivity).map(([name, { routedUsd, ...rest }]) => [name, rest])),
    {
      code: { ...reply, pricedRequests: 1, routes: { 'claude-sonnet-5-5@high': 1 } },
      ops: { ...reply, pricedRequests: 1, routes: { 'claude-haiku-5-5@high': 1 } },
    },
  );
  // Each activity's cost is its replies' share of the routed total.
  assert.ok(byActivity.ops.routedUsd > 0 && byActivity.code.routedUsd > byActivity.ops.routedUsd);
  assert.ok(Math.abs(byActivity.code.routedUsd + byActivity.ops.routedUsd - sessionOf(h).routedUsd) < 1e-12);
  assert.deepEqual(counts, {
    switches: { tier: 0, activity: 1 },
    lateral: { taken: 1, refused: 0 },
    agreement: { matched: 2, total: 2 },
  });
  assert.deepEqual(savedCounts(h.preferences), {
    version: 1,
    confusion: { code: { code: 1 }, ops: { ops: 1 } },
    runs: { code: [1, 0, 0, 0, 0] },
    lateral: { taken: 1, refused: 0 },
  });
  const metrics = h.preferences.get('activity:metrics:v1:s1');
  assert.ok(Number.isFinite(metrics.since));
  assert.deepEqual(metrics, {
    version: 1,
    since: metrics.since,
    // Two timed classifier answers in the fastest bucket, and one cheaper activity move with no escalation yet.
    latency: { jev: [2, ...Array(21).fill(0)] },
    downMoves: { moves: 1, escalations: 0 },
    unpriced: { usage: 0, model: 0, ttl: 0, error: 0, comparison: 0 },
  });
  assert.deepEqual(h.view().activityMetrics, metrics);

  await h.event('session.end', { reason: 'clear' });
  assert.deepEqual(savedStats(h.preferences).runs, { code: [1, 0, 0, 0, 0], ops: [1, 0, 0, 0, 0] });
  h.clear('s2');
  await h.event('session.start', { cwd: '/fixture' });
  await turn(h, 't3', 'claude-sonnet-5-5', ['Bash']);
  assert.deepEqual(h.view().strip.cells, [{ low: 1 }], 'a new session starts its own strip');
  assert.equal(h.view().lastSwitch, null);
  assert.deepEqual(Object.keys(h.view().activityStats.byActivity), ['ops']);
  assert.equal(h.view().activityStats.byActivity.ops.turns, 1);

  const reloaded = harness(JEV_KEY, h.preferences);
  reloaded.files.set(CONFIG, JSON.stringify({ activityRouting: 'on' }));
  answering(reloaded, jevResponse('low', LOW, 0, { ops: 0.9 }, 'execute'));
  await reloaded.event('session.start', { cwd: '/fixture' });
  await turn(reloaded, 't1', 'claude-haiku-5-5', ['Bash']);
  assert.deepEqual(Object.keys(reloaded.view().activityStats.byActivity), ['ops']);
  assert.equal(reloaded.view().activityStats.byActivity.ops.turns, 1);
  assert.deepEqual(savedStats(reloaded.preferences).confusion, { code: { code: 1 }, ops: { ops: 3 } });
});

test('a turn with activity routing off ends the watch after a cheaper activity move', async () => {
  const h = harness(JEV_KEY);
  h.files.set(
    CONFIG,
    JSON.stringify({ activityRouting: 'on', activities: { ops: { low: { model: 'haiku', effort: 'medium' } } } }),
  );
  h.model('claude-sonnet-5-5');
  answering(
    h,
    jevResponse('low', LOW, 0, { code: 0.9, ops: 0.1 }),
    jevResponse('low', LOW, 0, { ops: 0.81, code: 0.19 }, 'execute'),
  );
  await h.event('session.start', { cwd: '/fixture' });
  await turn(h, 't1', 'claude-sonnet-5-5', ['Edit']);
  await turn(h, 't2', 'claude-sonnet-5-5', ['Bash']);
  assert.equal(h.loop().decision.reason, 'activity-down');
  await h.event('command.run', { command: 'router', args: 'activities off' });
  await turn(h, 't3', 'claude-sonnet-5-5', ['Bash']);
  assert.notEqual(`${h.requests[2].model}@${h.requests[2].effort}`, `${h.requests[1].model}@${h.requests[1].effort}`);
  await h.event('command.run', { command: 'router', args: 'activities on' });
  const failing = [
    user('Fix the test.'),
    assistant('running', ['Bash']),
    toolResult('error: test_login failed', { isError: true }),
    assistant('editing', ['Edit']),
    toolResult('error: test_login failed', { isError: true }),
    user('Next.'),
  ];
  await h.event('turn.start', { turnId: 't4', text: 'Next.' });
  h.messages(async () => failing);
  await drain(h.step({ ...step, turnId: 't4', model: 'claude-sonnet-5-5' }));
  assert.equal(h.loop().decision.escalated, true);
  h.messages(async () => [...failing, assistant('done', ['Bash'])]);
  await h.event('turn.complete', { turnId: 't4' });
  assert.deepEqual(h.view().activityMetrics.downMoves, { moves: 1, escalations: 0 });
});

test('turning routing off ends the watch after a cheaper activity move', async () => {
  const h = harness(JEV_KEY);
  h.files.set(
    CONFIG,
    JSON.stringify({ activityRouting: 'on', activities: { ops: { low: { model: 'haiku', effort: 'medium' } } } }),
  );
  h.model('claude-sonnet-5-5');
  answering(
    h,
    jevResponse('low', LOW, 0, { code: 0.9, ops: 0.1 }),
    jevResponse('low', LOW, 0, { ops: 0.81, code: 0.19 }, 'execute'),
  );
  await h.event('session.start', { cwd: '/fixture' });
  await turn(h, 't1', 'claude-sonnet-5-5', ['Edit']);
  await turn(h, 't2', 'claude-sonnet-5-5', ['Bash']);
  assert.equal(h.loop().decision.reason, 'activity-down');
  await h.event('command.run', { command: 'router', args: 'off' });
  await turn(h, 't3', 'claude-sonnet-5-5', ['Bash']);
  assert.equal(h.requests[2].model, 'claude-sonnet-5-5');
  await h.event('command.run', { command: 'router', args: 'auto' });
  const failing = [
    user('Fix the test.'),
    assistant('running', ['Bash']),
    toolResult('error: test_login failed', { isError: true }),
    assistant('editing', ['Edit']),
    toolResult('error: test_login failed', { isError: true }),
    user('Next.'),
  ];
  await h.event('turn.start', { turnId: 't4', text: 'Next.' });
  h.messages(async () => failing);
  await drain(h.step({ ...step, turnId: 't4', model: 'claude-sonnet-5-5' }));
  assert.equal(h.loop().decision.escalated, true);
  h.messages(async () => [...failing, assistant('done', ['Bash'])]);
  await h.event('turn.complete', { turnId: 't4' });
  assert.deepEqual(h.view().activityMetrics.downMoves, { moves: 1, escalations: 0 });
});

test('a Manual turn ends the watch a cheaper move started while routing was turned off mid-turn', async () => {
  const h = harness(JEV_KEY);
  h.files.set(
    CONFIG,
    JSON.stringify({ activityRouting: 'on', activities: { ops: { low: { model: 'haiku', effort: 'medium' } } } }),
  );
  h.model('claude-sonnet-5-5');
  answering(
    h,
    jevResponse('low', LOW, 0, { code: 0.9, ops: 0.1 }),
    jevResponse('low', LOW, 0, { ops: 0.81, code: 0.19 }, 'execute'),
  );
  await h.event('session.start', { cwd: '/fixture' });
  await turn(h, 't1', 'claude-sonnet-5-5', ['Edit']);
  await h.event('turn.start', { turnId: 't2', text: 'Next.' });
  h.messages(async () => [user('Next.')]);
  await drain(h.step({ ...step, turnId: 't2', model: 'claude-sonnet-5-5' }));
  assert.equal(h.loop().decision.reason, 'activity-down');
  await h.event('command.run', { command: 'router', args: 'off' });
  h.messages(async () => [user('Next.'), assistant('done', ['Bash'])]);
  await h.event('turn.complete', { turnId: 't2' });
  await turn(h, 't3', 'claude-sonnet-5-5', ['Bash']);
  await h.event('command.run', { command: 'router', args: 'auto' });
  const failing = [
    user('Fix the test.'),
    assistant('running', ['Bash']),
    toolResult('error: test_login failed', { isError: true }),
    assistant('editing', ['Edit']),
    toolResult('error: test_login failed', { isError: true }),
    user('Next.'),
  ];
  await h.event('turn.start', { turnId: 't4', text: 'Next.' });
  h.messages(async () => failing);
  await drain(h.step({ ...step, turnId: 't4', model: 'claude-sonnet-5-5' }));
  assert.equal(h.loop().decision.escalated, true);
  h.messages(async () => [...failing, assistant('done', ['Bash'])]);
  await h.event('turn.complete', { turnId: 't4' });
  assert.equal(h.view().activityMetrics.downMoves.escalations, 0);
});

test('turning routing off mid-turn and straight back on does not keep the watch for that move', async () => {
  const h = harness(JEV_KEY);
  h.files.set(
    CONFIG,
    JSON.stringify({ activityRouting: 'on', activities: { ops: { low: { model: 'haiku', effort: 'medium' } } } }),
  );
  h.model('claude-sonnet-5-5');
  answering(
    h,
    jevResponse('low', LOW, 0, { code: 0.9, ops: 0.1 }),
    jevResponse('low', LOW, 0, { ops: 0.81, code: 0.19 }, 'execute'),
  );
  await h.event('session.start', { cwd: '/fixture' });
  await turn(h, 't1', 'claude-sonnet-5-5', ['Edit']);
  await h.event('turn.start', { turnId: 't2', text: 'Next.' });
  h.messages(async () => [user('Next.')]);
  await drain(h.step({ ...step, turnId: 't2', model: 'claude-sonnet-5-5' }));
  assert.equal(h.loop().decision.reason, 'activity-down');
  await h.event('command.run', { command: 'router', args: 'off' });
  h.messages(async () => [user('Next.'), assistant('done', ['Bash'])]);
  await h.event('turn.complete', { turnId: 't2' });
  await h.event('command.run', { command: 'router', args: 'auto' });
  const failing = [
    user('Fix the test.'),
    assistant('running', ['Bash']),
    toolResult('error: test_login failed', { isError: true }),
    assistant('editing', ['Edit']),
    toolResult('error: test_login failed', { isError: true }),
    user('Next.'),
  ];
  await h.event('turn.start', { turnId: 't4', text: 'Next.' });
  h.messages(async () => failing);
  await drain(h.step({ ...step, turnId: 't4', model: 'claude-sonnet-5-5' }));
  assert.equal(h.loop().decision.escalated, true);
  h.messages(async () => [...failing, assistant('done', ['Bash'])]);
  await h.event('turn.complete', { turnId: 't4' });
  assert.equal(h.view().activityMetrics.downMoves.escalations, 0);
});

test('turning routing off and back on before the turn finishes does not keep the watch for that move', async () => {
  const h = harness(JEV_KEY);
  h.files.set(
    CONFIG,
    JSON.stringify({ activityRouting: 'on', activities: { ops: { low: { model: 'haiku', effort: 'medium' } } } }),
  );
  h.model('claude-sonnet-5-5');
  answering(
    h,
    jevResponse('low', LOW, 0, { code: 0.9, ops: 0.1 }),
    jevResponse('low', LOW, 0, { ops: 0.81, code: 0.19 }, 'execute'),
  );
  await h.event('session.start', { cwd: '/fixture' });
  await turn(h, 't1', 'claude-sonnet-5-5', ['Edit']);
  await h.event('turn.start', { turnId: 't2', text: 'Next.' });
  h.messages(async () => [user('Next.')]);
  await drain(h.step({ ...step, turnId: 't2', model: 'claude-sonnet-5-5' }));
  assert.equal(h.loop().decision.reason, 'activity-down');
  await h.event('command.run', { command: 'router', args: 'off' });
  await h.event('command.run', { command: 'router', args: 'auto' });
  h.messages(async () => [user('Next.'), assistant('done', ['Bash'])]);
  await h.event('turn.complete', { turnId: 't2' });
  const failing = [
    user('Fix the test.'),
    assistant('running', ['Bash']),
    toolResult('error: test_login failed', { isError: true }),
    assistant('editing', ['Edit']),
    toolResult('error: test_login failed', { isError: true }),
    user('Next.'),
  ];
  await h.event('turn.start', { turnId: 't4', text: 'Next.' });
  h.messages(async () => failing);
  await drain(h.step({ ...step, turnId: 't4', model: 'claude-sonnet-5-5' }));
  assert.equal(h.loop().decision.escalated, true);
  h.messages(async () => [...failing, assistant('done', ['Bash'])]);
  await h.event('turn.complete', { turnId: 't4' });
  assert.equal(h.view().activityMetrics.downMoves.escalations, 0);
});

test('turning routing off and back on while the finished turn is recorded does not keep the watch for that move', async () => {
  const h = harness(JEV_KEY);
  h.files.set(
    CONFIG,
    JSON.stringify({ activityRouting: 'on', activities: { ops: { low: { model: 'haiku', effort: 'medium' } } } }),
  );
  h.model('claude-sonnet-5-5');
  answering(
    h,
    jevResponse('low', LOW, 0, { code: 0.9, ops: 0.1 }),
    jevResponse('low', LOW, 0, { ops: 0.81, code: 0.19 }, 'execute'),
  );
  await h.event('session.start', { cwd: '/fixture' });
  await turn(h, 't1', 'claude-sonnet-5-5', ['Edit']);
  await h.event('turn.start', { turnId: 't2', text: 'Next.' });
  h.messages(async () => [user('Next.')]);
  await drain(h.step({ ...step, turnId: 't2', model: 'claude-sonnet-5-5' }));
  assert.equal(h.loop().decision.reason, 'activity-down');
  const id = h.$.session.id;
  let reads = null;
  h.$.session.id = async () => {
    const sessionId = await id();
    // The second read after the messages is the record's last: routing goes off and back on while it is pending.
    if (reads !== null && ++reads === 2) {
      reads = null;
      await h.event('command.run', { command: 'router', args: 'off' });
      await h.event('command.run', { command: 'router', args: 'auto' });
    }
    return sessionId;
  };
  h.messages(async () => {
    reads = 0;
    return [user('Next.'), assistant('done', ['Bash'])];
  });
  await h.event('turn.complete', { turnId: 't2' });
  h.$.session.id = id;
  const failing = [
    user('Fix the test.'),
    assistant('running', ['Bash']),
    toolResult('error: test_login failed', { isError: true }),
    assistant('editing', ['Edit']),
    toolResult('error: test_login failed', { isError: true }),
    user('Next.'),
  ];
  await h.event('turn.start', { turnId: 't4', text: 'Next.' });
  h.messages(async () => failing);
  await drain(h.step({ ...step, turnId: 't4', model: 'claude-sonnet-5-5' }));
  assert.equal(h.loop().decision.escalated, true);
  h.messages(async () => [...failing, assistant('done', ['Bash'])]);
  await h.event('turn.complete', { turnId: 't4' });
  assert.equal(h.view().activityMetrics.downMoves.escalations, 0);
});

test('with activity routing on, a turn without an activity answer keeps the activity but ends the run', async () => {
  const h = harness(JEV_KEY);
  h.files.set(CONFIG, JSON.stringify({ activityRouting: 'on' }));
  h.model('claude-sonnet-5-5');
  answering(h, jevResponse('low', LOW, 0, { code: 0.9, ops: 0.1 }), jevResponse('low', LOW, 0));
  await h.event('session.start', { cwd: '/fixture' });
  await turn(h, 't1', 'claude-sonnet-5-5', ['Edit']);
  await turn(h, 't2', 'claude-sonnet-5-5', ['Edit']);
  assert.equal(h.loop().lastActivity, 'code');
  const { cells } = summarize(readUsage(h.preferences.get('usage:v1:s1')), { from: null, to: null });
  assert.deepEqual(
    Object.entries(cells).map(([key, sums]) => [key.split('|')[1], sums[0]]),
    [['code', 2]],
  );
  assert.deepEqual(savedStats(h.preferences).runs, { code: [1, 0, 0, 0, 0] });
});

test('a Sonnet session limited to Sonnet keeps its effort on a turn the code cell was not chosen for', async () => {
  const sonnet = 'claude-sonnet-5-5';
  const h = harness(JEV_KEY);
  h.settings({ availableModels: ['sonnet'] });
  h.model(sonnet);
  answering(h, jevResponse('low', LOW, 0, { explore: 0.95, code: 0.05 }));
  await start(h);
  await drain(h.step({ ...step, model: sonnet, effort: 'low' }));
  assert.deepEqual(
    [h.requests[0].model, h.requests[0].effort, h.view().tier, h.view().activity],
    [sonnet, 'low', null, null],
  );
});

test('with activity routing on, a continuation that falls back to the native model drops the activity label', async () => {
  const h = harness(JEV_KEY);
  h.files.set(CONFIG, JSON.stringify({ activityRouting: 'on' }));
  answering(h, jevResponse('low', LOW, 0, { code: 0.95, ops: 0.05 }));
  await h.event('session.start', { cwd: '/fixture' });
  await h.event('turn.start', { turnId: 't1', text: 'Next.' });
  await drain(h.step(step));
  assert.deepEqual([h.requests[0].model, h.view().activity], ['claude-sonnet-5-5', 'code']);
  h.settings({ availableModels: ['haiku'] });
  await drain(h.step({ ...step, index: 1, messageCount: 3 }));
  assert.deepEqual([h.requests[1].model, h.view().tier, h.view().activity], ['claude-haiku-5-5', null, null]);
});

test('a review still in flight when its turn ends does not keep the next turn from being classified', async () => {
  const model = 'claude-haiku-5-5';
  const h = harness(JEV_KEY);
  h.model(model);
  let calls = 0;
  h.http(async () => {
    calls += 1;
    if (calls === 2) await new Promise(() => {});
    const answer = calls === 1 ? jevResponse('low', LOW) : jevResponse('high', { high: 0.97, uncertain: 0.03 });
    return { ok: true, status: 200, text: JSON.stringify(answer), headers: {} };
  });
  await start(h);
  await longTurn(h, model, 7);
  assert.equal(calls, 2);
  await h.event('turn.complete', { turnId: 't1' });
  await h.event('turn.start', { turnId: 't2', text: 'Next.' });
  await drain(h.step({ ...step, turnId: 't2', model }));
  assert.equal(calls, 3);
  assert.equal(h.view().error, null);
  assert.equal(h.loop().decision.tier, 'high');
});
