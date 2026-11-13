import assert from 'node:assert/strict';
import test from 'node:test';
import { STORE_PREFIX } from '../lib/activity-stats.mjs';
import { DECISIONS_PREFIX } from '../lib/decisions.mjs';
import { answering, CONFIG, drain, harness, JEV_KEY, press, step } from './harness.mjs';
import { assistant, jevResponse, toolResult, user } from './helpers.mjs';

const phase = (choice) => ({
  type: 'choice',
  choice,
  probabilities: Object.fromEntries(
    ['produce', 'reason', 'verify', 'execute', 'report', 'uncertain'].map((p) => [p, p === choice ? 1 : 0]),
  ),
});
const answer = (continuation, phaseName = 'produce', goal = 'code') => {
  const body = jevResponse('medium', { medium: 0.99, low: 0.01 }, continuation, { [goal]: 1 });
  body.answers.phase = phase(phaseName);
  return body;
};
async function run(h, id, text, history, origin = 'composer') {
  await h.submit({ text, origin: { kind: origin }, wait: false }, () => h.event('turn.start', { turnId: id, text }));
  h.messages(async () => [...history, user(text)]);
  await drain(h.step({ ...step, turnId: id, messageCount: history.length + 1 }));
  await h.event('turn.complete', { turnId: id });
}

test('the production hook retains a goal across verification and commit, then replaces it on a new task', async () => {
  const h = harness(JEV_KEY);
  const bodies = answering(h, answer(0));
  await h.event('session.start', { cwd: '/fixture' });
  const goal = 'Implement the endpoint and tests, verify it and commit it.';
  await run(h, 'g1', goal, []);
  answering(h, answer(0.99, 'verify'));
  await run(h, 'g2', 'Run npm test.', [user(goal), assistant('Implementation is done; next are tests.')]);
  assert.equal(h.view().goal, 'code');
  assert.equal(h.view().taskPhase, 'verify');
  const currentBodies = [];
  h.http(async (_url, init) => {
    currentBodies.push(JSON.parse(init.body));
    return { ok: true, status: 200, text: JSON.stringify(answer(0.99, 'execute')) };
  });
  await run(h, 'g3', 'Commit it.', [
    user(goal),
    assistant('Implementation is done; next are tests.'),
    user('Run npm test.'),
    assistant('All tests passed; I will commit it next.'),
  ]);
  assert.equal(currentBodies[0].state.activeGoal.text, goal);
  h.http(async (_url, init) => {
    currentBodies.push(JSON.parse(init.body));
    return { ok: true, status: 200, text: JSON.stringify(answer(0, 'execute', 'ops')) };
  });
  const nextGoal = 'New task: deploy the approved artifact. No code changes.';
  await run(h, 'g4', nextGoal, [
    user(goal),
    assistant('Implementation is done; next are tests.'),
    user('Run npm test.'),
    assistant('All tests passed; I will commit it next.'),
    user('Commit it.'),
    assistant('Committed.'),
  ]);
  h.http(async (_url, init) => {
    currentBodies.push(JSON.parse(init.body));
    return { ok: true, status: 200, text: JSON.stringify(answer(0.99, 'report', 'ops')) };
  });
  await run(h, 'g5', 'Report the result.', [
    user(goal),
    assistant('Implementation is done; next are tests.'),
    user('Run npm test.'),
    assistant('All tests passed; I will commit it next.'),
    user('Commit it.'),
    assistant('Committed.'),
    user(nextGoal),
    assistant('Deployed.'),
  ]);
  assert.equal(currentBodies.at(-1).state.activeGoal.text, nextGoal);
  assert.ok(bodies[0].questions.phase);
});

test('progress reports do not replace the goal, and clear removes the previous anchor', async () => {
  const h = harness(JEV_KEY);
  answering(h, answer(0));
  await h.event('session.start', { cwd: '/fixture' });
  const goal = 'Implement the service endpoint and tests.';
  await run(h, 'p1', goal, []);
  const bodies = answering(h, answer(0.99, 'report'));
  const note = 'The background check completed.';
  await run(h, 'p2', note, [user(goal)], 'task-notification');
  assert.equal(bodies[0].state.activeGoal.text, goal);
  assert.equal(bodies[0].state.currentStep.text, note);
  await h.event('session.end', { reason: 'clear' });
  h.clear('s2');
  await h.event('session.start', { cwd: '/fixture' });
  const after = answering(h, answer(0, 'produce', 'docs'));
  await run(h, 'p3', 'Write a README.', []);
  assert.notEqual(after[0].state.activeGoal?.text, goal);
});

test('a same-or-longer replaced history cannot reuse an old goal anchor', async () => {
  const h = harness(JEV_KEY);
  answering(h, answer(0));
  await h.event('session.start', { cwd: '/fixture' });
  const oldGoal = 'Implement the original endpoint.';
  await run(h, 'b1', oldGoal, []);
  const bodies = answering(h, answer(0.99, 'verify'));
  await run(h, 'b2', 'Run the tests.', [
    user('This is a different restored branch.'),
    assistant('Ready for verification.'),
  ]);
  assert.notEqual(bodies[0].state.activeGoal?.text, oldGoal);
});

test('a review never uses assistant text from before the current user request as its phase', async () => {
  const h = harness(JEV_KEY);
  const model = 'claude-opus-5-5';
  h.model(model);
  h.files.set(CONFIG, JSON.stringify({ policy: { reviewEveryRequests: 1 } }));
  const bodies = answering(h, answer(0));
  await h.event('session.start', { cwd: '/fixture' });
  const goal = 'Implement a new API endpoint and tests.';
  const messages = [
    user('Earlier task.'),
    assistant('I will only run the tests now.'),
    user(goal),
    { role: 'assistant', content: [{ type: 'tool_use', id: 'r', name: 'Read', input: { file_path: 'app.js' } }] },
  ];
  h.messages(async () => messages);
  await h.submit({ text: goal, origin: { kind: 'composer' }, wait: false }, () =>
    h.event('turn.start', { turnId: 'review', text: goal }),
  );
  for (let index = 0; index < 6; index += 1) {
    await drain(h.step({ ...step, model, turnId: 'review', index, messageCount: messages.length }));
    await new Promise(setImmediate);
  }
  assert.ok(bodies.length > 1);
  assert.ok(bodies.slice(1).every((body) => body.state.currentStep.text === goal));
});

test('unassociated progress cannot use a phase-only ops route', async () => {
  const h = harness(JEV_KEY);
  h.files.set(CONFIG, JSON.stringify({ policy: { minDwellRequests: 0 } }));
  answering(h, answer(0));
  h.model('claude-opus-5-5');
  await h.event('session.start', { cwd: '/fixture' });
  const goal = 'Implement a service endpoint and tests.';
  await run(h, 'n1', goal, []);
  answering(h, answer(0.99, 'verify'));
  await run(
    h,
    'n2',
    'A previous task completed; run its checks.',
    [
      user(goal),
      { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Bash', input: { command: 'npm test' } }] },
      toolResult('passed'),
    ],
    'task-notification',
  );
  assert.notEqual(h.loop().decision.activity, 'ops');
  assert.equal(
    h.preferences
      .get(`${DECISIONS_PREFIX}s1`)
      .rows.filter((row) => row.kind === 'start')
      .at(-1).down,
    false,
  );
});

test('an async verification phase cannot weaken the route after newer implementation progress', async () => {
  const h = harness(JEV_KEY);
  const model = 'claude-opus-5-5';
  h.model(model);
  h.files.set(CONFIG, JSON.stringify({ policy: { reviewEveryRequests: 1, minDwellRequests: 0 } }));
  answering(h, answer(0, 'produce'), answer(0.99, 'verify'));
  await h.event('session.start', { cwd: '/fixture' });
  const goal = 'Implement the API client and its tests.';
  await h.submit({ text: goal, origin: { kind: 'composer' }, wait: false }, () =>
    h.event('turn.start', { turnId: 'fresh-phase', text: goal }),
  );
  let messages = [user(goal)];
  h.messages(async () => messages);
  await drain(h.step({ ...step, model, turnId: 'fresh-phase', index: 0, messageCount: messages.length }));
  messages = [
    user(goal),
    { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Bash', input: { command: 'npm test' } }] },
    toolResult('passed'),
  ];
  await drain(h.step({ ...step, model, turnId: 'fresh-phase', index: 1, messageCount: messages.length }));
  await new Promise(setImmediate);
  messages = [...messages, assistant('Now I need to implement the remaining client behavior.')];
  await drain(h.step({ ...step, model, turnId: 'fresh-phase', index: 2, messageCount: messages.length }));
  assert.equal(h.loop().decision.goal, 'code');
  assert.notEqual(h.loop().decision.activity, 'ops');
  assert.notEqual(h.loop().decision.taskPhase, 'verify');
});

test('old turn-activity counters are preserved but not merged into the goal contract', async () => {
  const h = harness(JEV_KEY);
  const legacy = 'activity:stats:v1:legacy';
  h.preferences.set(legacy, {
    version: 1,
    since: 1,
    confusion: { ops: { check: 100 } },
    runs: {},
    lateral: { taken: 0, refused: 0 },
  });
  await h.event('session.start', { cwd: '/fixture' });
  assert.deepEqual(h.view().activityStore.confusion, {});
  assert.ok(h.preferences.has(legacy));
  assert.notEqual(STORE_PREFIX, 'activity:stats:v1:');
  await press(h, 'tab-usage');
  await press(h, 'delete-history');
  await press(h, 'delete-confirm');
  assert.equal(h.preferences.has(legacy), false);
});

test('a delayed older turn start cannot replace the newer goal owner', async () => {
  const h = harness(JEV_KEY);
  const bodies = answering(h, answer(0));
  await h.event('session.start', { cwd: '/fixture' });
  let release;
  let started;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const firstRead = new Promise((resolve) => {
    started = resolve;
  });
  let first = true;
  h.$.session.id = async () => {
    if (first) {
      first = false;
      started();
      await pending;
    }
    return 's1';
  };
  const older = h.submit({ text: 'Old implementation task.', origin: { kind: 'composer' }, wait: false }, () =>
    h.event('turn.start', { turnId: 'older', text: 'Old implementation task.' }),
  );
  await firstRead;
  const goal = 'Implement the newer service task.';
  await h.submit({ text: goal, origin: { kind: 'composer' }, wait: false }, () =>
    h.event('turn.start', { turnId: 'newer', text: goal }),
  );
  release();
  await older;
  h.messages(async () => [user(goal)]);
  await drain(h.step({ ...step, turnId: 'newer', messageCount: 1 }));
  assert.equal(bodies.at(-1).state.currentRequest.text, goal);
  assert.equal(bodies.at(-1).state.activeGoal, undefined);
  await h.event('turn.complete', { turnId: 'newer' });
  await run(h, 'after-newer', 'Background work finished.', [user(goal)], 'task-notification');
  assert.equal(bodies.at(-1).state.activeGoal.text, goal);
});

test('a continuation without an anchor cannot seed the short reply as a new durable goal', async () => {
  const h = harness(JEV_KEY);
  const bodies = answering(h, answer(0.99, 'verify'));
  await h.event('session.start', { cwd: '/fixture' });
  await run(h, 'empty1', 'Yes, proceed.', [user('Implement the service.'), assistant('Shall I run tests?')]);
  await run(h, 'empty2', 'Report status.', [
    user('Implement the service.'),
    assistant('Shall I run tests?'),
    user('Yes, proceed.'),
    assistant('Done.'),
  ]);
  assert.equal(bodies.at(-1).state.activeGoal, undefined);
});

test('ambiguous continuity cannot preserve a stale goal into another request', async () => {
  const h = harness(JEV_KEY);
  answering(h, answer(0));
  await h.event('session.start', { cwd: '/fixture' });
  const goal = 'Implement the original endpoint.';
  await run(h, 'a1', goal, []);
  answering(h, answer(0.5, 'uncertain', 'uncertain'));
  await run(h, 'a2', 'Maybe that other thing.', [user(goal)]);
  const bodies = answering(h, answer(0, 'produce', 'docs'));
  await run(h, 'a3', 'Write a new README.', [
    user(goal),
    assistant('Checking the request.'),
    user('Maybe that other thing.'),
    assistant('Please clarify.'),
  ]);
  assert.notEqual(bodies[0].state.activeGoal?.text, goal);
});
