import assert from 'node:assert/strict';
import test from 'node:test';
import { DECISIONS_PREFIX, MAX_RECORDS, RETAIN_MS } from '../lib/decisions.mjs';
import { answering, CONFIG, drain, harness, JEV_KEY, press, step } from './harness.mjs';
import { assistant, jevResponse, toolResult, user } from './helpers.mjs';

const HIGH = jevResponse('high', { micro: 0, low: 0, medium: 0.05, high: 0.95, uncertain: 0 }, 0.2);
const NOTE = '<task-notification><status>completed</status></task-notification>';
const decisions = (h) => h.preferences.get(`${DECISIONS_PREFIX}s1`);

// One turn as the engine runs it: the prompt's submission, its turn starting inside it, one routed step, the end.
async function turn(h, turnId, text, kind, { messages = [user(text)] } = {}) {
  await h.submit({ text, origin: { kind }, wait: false }, () => h.event('turn.start', { turnId, text }));
  h.messages(async () => messages);
  await drain(h.step({ ...step, turnId, messageCount: messages.length }));
  h.messages(async () => [...messages, assistant('done')]);
  await h.event('turn.complete', { turnId });
}

test('a task notification is asked about the active goal, with the notification as the newest dialogue line', async () => {
  const h = harness(JEV_KEY);
  const bodies = answering(h, HIGH);
  await h.event('session.start', { cwd: '/fixture' });
  await turn(h, 't1', 'Fix the flaky deploy test.', 'composer');
  await turn(h, 't2', NOTE, 'task-notification', {
    messages: [user('Fix the flaky deploy test.'), assistant('started a background run'), user(NOTE)],
  });
  const [first, second] = bodies.filter((b) => b.questions?.route);
  assert.equal(first.state.currentRequest.text, 'Fix the flaky deploy test.');
  assert.equal(second.state.currentRequest.text, 'Fix the flaky deploy test.');
  assert.deepEqual(second.state.recentDialogue.at(-1), { role: 'user', text: NOTE });
  const rows = decisions(h).rows.filter((row) => row.kind === 'start');
  assert.deepEqual(
    rows.map((row) => [row.origin, row.same, row.cls]),
    [
      ['composer', false, 'high'],
      ['task-notification', true, 'high'],
    ],
  );
});

test('without a goal from this session, a notification is asked about as it reads', async () => {
  const h = harness(JEV_KEY);
  const bodies = answering(h, HIGH);
  await h.event('session.start', { cwd: '/fixture' });
  await turn(h, 't1', NOTE, 'task-notification');
  const [body] = bodies.filter((b) => b.questions?.route);
  assert.equal(body.state.currentRequest.text, NOTE);
  assert.equal(decisions(h).rows[0].same, true, 'it is still progress on the running work');
});

test('a submission queued behind a running turn names the turn that later starts with its text', async () => {
  const h = harness(JEV_KEY);
  answering(h, HIGH);
  await h.event('session.start', { cwd: '/fixture' });
  await h.submit({ text: 'Then commit it.', origin: { kind: 'composer' }, wait: true, turnId: 't0' });
  await h.submit({ text: 'Delivered.', origin: { kind: 'peer' }, wait: false, turnId: 't0' });
  await h.event('turn.start', { turnId: 't1', text: 'Then commit it.' });
  h.messages(async () => [user('Then commit it.')]);
  await drain(h.step({ ...step, turnId: 't1' }));
  await h.event('turn.complete', { turnId: 't1' });
  await h.event('turn.start', { turnId: 't2', text: 'Something else.' });
  await drain(h.step({ ...step, turnId: 't2' }));
  await h.event('turn.complete', { turnId: 't2' });
  assert.deepEqual(
    decisions(h)
      .rows.filter((row) => row.kind === 'start')
      .map((row) => row.origin),
    ['composer', 'unknown'],
  );
});

test('a prompt.submit hook passes the prompt on unchanged', async () => {
  const h = harness(JEV_KEY);
  await h.event('session.start', { cwd: '/fixture' });
  const input = { text: 'hello', origin: { kind: 'composer' }, wait: false };
  assert.deepEqual(await h.submit(input), { text: 'hello', origin: { kind: 'composer' } });
});

test('a dropped prompt names no later turn, and the drop passes on as core answered', async () => {
  const h = harness(JEV_KEY);
  answering(h, HIGH);
  await h.event('session.start', { cwd: '/fixture' });
  const dropped = { drop: 'blocked by a hook' };
  const input = { text: 'Same words.', origin: { kind: 'composer' }, wait: true, turnId: 't0' };
  assert.deepEqual(await h.submit(input, null, dropped), dropped);
  await h.event('turn.start', { turnId: 't1', text: 'Same words.' });
  h.messages(async () => [user('Same words.')]);
  await drain(h.step({ ...step, turnId: 't1' }));
  await h.event('turn.complete', { turnId: 't1' });
  assert.equal(decisions(h).rows[0].origin, 'unknown');
});

test('with activity routing off the end row still holds the turn bucket', async () => {
  const h = harness(JEV_KEY);
  answering(h, HIGH);
  h.files.set(CONFIG, JSON.stringify({ activityRouting: 'off' }));
  await h.event('session.start', { cwd: '/fixture' });
  await turn(h, 't1', 'Ship it.', 'composer', {
    messages: [
      user('Ship it.'),
      { role: 'assistant', content: [{ type: 'tool_use', id: 'g', name: 'Bash', input: { command: 'git push' } }] },
      toolResult('ok'),
    ],
  });
  assert.equal(decisions(h).rows.at(-1).observed, 'ops');
});

test('each turn writes its decision rows and its end, with unpriced replies by cause', async () => {
  const h = harness(JEV_KEY);
  answering(h, HIGH);
  await h.event('session.start', { cwd: '/fixture' });
  // The cache lifetime cannot be read: the reply is routed but not priced.
  h.$.session.usage = async () => {
    throw new Error('no usage');
  };
  const messages = [
    user('Run the tests.'),
    { role: 'assistant', content: [{ type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'npm test' } }] },
    toolResult('ok'),
  ];
  await h.submit({ text: 'Run the tests.', origin: { kind: 'composer' }, wait: false }, () =>
    h.event('turn.start', { turnId: 't1', text: 'Run the tests.' }),
  );
  h.messages(async () => [user('Run the tests.')]);
  await drain(h.step({ ...step, turnId: 't1' }));
  h.messages(async () => messages);
  await h.event('turn.complete', { turnId: 't1' });
  const [start, end] = decisions(h).rows;
  assert.equal(start.kind, 'start');
  assert.equal(start.route, 'claude-opus-5-5@xhigh');
  assert.deepEqual(end, { at: end.at, kind: 'end', observed: 'check', requests: 1, priced: 0, unpriced: { ttl: 1 } });
  assert.deepEqual(h.preferences.get('activity:metrics:v1:s1').unpriced, { usage: 0, model: 0, ttl: 1, error: 0 });
  const listed = await h.event('command.run', { command: 'router', args: 'decisions 5' });
  assert.match(
    listed.text,
    /start {5}composer {2}asked high 95% {2}new task {2}-> high claude-opus-5-5@xhigh {2}\(jump\)/,
  );
  assert.match(listed.text, /end {7}tools check {2}1 request {2}0 priced {2}unpriced ttl 1$/);
});

test('/router decisions reads no session text and says when nothing is recorded', async () => {
  const h = harness(JEV_KEY);
  await h.event('session.start', { cwd: '/fixture' });
  const listed = await h.event('command.run', { command: 'router', args: 'decisions' });
  assert.equal(listed.text, 'No routing decisions recorded in this session yet.');
});

test('Delete history removes every session decision record', async () => {
  const h = harness(JEV_KEY);
  answering(h, HIGH);
  h.preferences.set(`${DECISIONS_PREFIX}other`, { version: 1, since: 1, rows: [] });
  await h.event('session.start', { cwd: '/fixture' });
  await turn(h, 't1', 'One edit.', 'composer');
  assert.ok(decisions(h));
  await press(h, 'tab-usage');
  await press(h, 'delete-history');
  await press(h, 'delete-confirm');
  assert.deepEqual(
    [...h.preferences.keys()].filter((key) => key.startsWith(DECISIONS_PREFIX)),
    [],
  );
});

test('session start lets go of expired and surplus decision records of other sessions', async () => {
  const h = harness(JEV_KEY);
  const now = Date.now();
  const record = (at) => ({ version: 1, since: at, rows: [{ at, kind: 'end', requests: 0, priced: 0, unpriced: {} }] });
  h.preferences.set(`${DECISIONS_PREFIX}expired`, record(now - RETAIN_MS - 1000));
  for (let i = 0; i < MAX_RECORDS + 2; i += 1) h.preferences.set(`${DECISIONS_PREFIX}r${i}`, record(now - i * 1000));
  h.preferences.set(`${DECISIONS_PREFIX}future`, { version: 2, rows: 'later' });
  await h.event('session.start', { cwd: '/fixture' });
  const kept = [...h.preferences.keys()].filter((key) => key.startsWith(DECISIONS_PREFIX));
  assert.equal(kept.length, MAX_RECORDS + 1);
  assert.ok(!kept.includes(`${DECISIONS_PREFIX}expired`));
  assert.ok(kept.includes(`${DECISIONS_PREFIX}r0`));
  assert.ok(!kept.includes(`${DECISIONS_PREFIX}r${MAX_RECORDS + 1}`));
  assert.ok(kept.includes(`${DECISIONS_PREFIX}future`));
});
