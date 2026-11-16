import assert from 'node:assert/strict';
import test from 'node:test';
import { DECISIONS_PREFIX, MAX_RECORDS, RETAIN_MS } from '../lib/decisions.mjs';
import { answering, CONFIG, drain, harness, JEV_KEY, press, step, texts } from './harness.mjs';
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

test('the reserved auto engine is visibly unavailable and never rewrites a request', async () => {
  const h = harness(JEV_KEY);
  h.files.set(CONFIG, JSON.stringify({ routingEngine: 'auto' }));
  const bodies = answering(h, HIGH);
  await h.event('session.start', { cwd: '/fixture' });
  assert.equal(h.view().phase, 'unavailable');
  assert.equal(h.view().error, 'auto routing is not available yet; use table or shadow');
  await h.event('command.run', { command: 'router', args: 'auto' });
  await h.event('turn.start', { turnId: 't1', text: 'Design it.' });
  await drain(h.step(step));
  assert.deepEqual(h.requests, [step]);
  assert.equal(bodies.length, 0);
  assert.equal(h.loop().decision, null);
  assert.equal(decisions(h), undefined);
  assert.match(texts(await h.render()).join('\n'), /auto routing is not available yet; use table or shadow/);
});

test('shadow proposals leave real requests and cache observations identical to table', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-16T10:00:00Z') });
  const runs = [];
  for (const routingEngine of ['table', 'shadow']) {
    const h = harness(JEV_KEY);
    h.files.set(CONFIG, JSON.stringify({ routingEngine }));
    const bodies = answering(h, HIGH);
    await h.event('session.start', { cwd: '/fixture' });
    await turn(h, 't1', 'First task.', 'composer');
    await turn(h, 't2', 'Second task.', 'composer', {
      messages: [user('First task.'), assistant('done'), user('Second task.')],
    });
    runs.push({ h, bodies });
  }
  const [table, shadow] = runs;
  assert.deepEqual(shadow.h.requests, table.h.requests);
  assert.deepEqual(shadow.bodies, table.bodies);
  const a = table.h.loop();
  const b = shadow.h.loop();
  const { shadow: _shadow, ...actual } = b;
  assert.deepEqual(actual, a);
  assert.deepEqual(shadow.h.preferences.get('usage:v1:s1'), table.h.preferences.get('usage:v1:s1'));
  assert.equal(a.shadow, undefined);
  const rows = decisions(shadow.h).rows.filter((row) => row.kind === 'start');
  assert.ok(rows.every((row) => row.engine === 'shadow' && row.alt?.outcome));
  assert.ok(
    decisions(table.h)
      .rows.filter((row) => row.kind !== 'end')
      .every((row) => row.engine === 'table' && !row.alt),
  );
  const listing = await shadow.h.event('command.run', { command: 'router', args: 'decisions' });
  assert.match(listing.text, /shadow demand .*target/);
  assert.match(texts(await shadow.h.render()).join('\n'), /shadow demand .*target/);
});

test('shadow uses the base demand policy in every mode and changes only the requirement', async () => {
  const results = [];
  for (const mode of ['cost', 'quality']) {
    const h = harness(JEV_KEY);
    h.files.set(CONFIG, JSON.stringify({ routingEngine: 'shadow', mode, policy: { upgradeVotes: 2 } }));
    answering(h, jevResponse('medium', { low: 0.05, medium: 0.75, high: 0.2, uncertain: 0 }));
    await h.event('session.start', { cwd: '/fixture' });
    await turn(h, 't1', 'First task.', 'composer');
    results.push(decisions(h).rows[0].alt);
  }
  assert.equal(results[0].demand, results[1].demand);
  assert.equal(results[0].reason, results[1].reason);
  assert.equal(results[1].requirement - results[0].requirement, 1);
});

test('bounded execute demand does not depend on table pricing, cache or a held activity cell', async () => {
  const results = [];
  for (const input of [1, 1000]) {
    const h = harness(JEV_KEY);
    h.files.set(
      CONFIG,
      JSON.stringify({ routingEngine: 'shadow', models: { haiku: { input, cacheRead: input / 10 } } }),
    );
    h.model('claude-opus-5-5');
    answering(
      h,
      jevResponse('medium', { medium: 1 }, 0, { code: 1 }, 'produce'),
      jevResponse('medium', { medium: 1 }, 0, { code: 1 }, 'execute'),
    );
    await h.event('session.start', { cwd: '/fixture' });
    await turn(h, 't1', 'Implement it.', 'composer');
    if (input === 1)
      h.state.get('loops:main').value.models['claude-haiku-5-5'] = {
        prefixTokens: 9000,
        lastAt: Date.now(),
        ttl: '5m',
      };
    await turn(h, 't2', 'Run the check.', 'composer');
    const row = decisions(h)
      .rows.filter((r) => r.kind === 'start')
      .at(-1);
    results.push({ activity: row.activity, raw: h.loop().shadow.state.demand, demand: row.alt.demand });
  }
  assert.notEqual(results[0].activity, results[1].activity, 'the table accepts one ops cell and holds the other');
  assert.deepEqual(
    results.map(({ raw, demand }) => [raw, demand]),
    [
      [2, 1.5],
      [2, 1.5],
    ],
  );
});

test('bounded execute confidence uses base policy, not mode activityMass patches', async () => {
  const results = [];
  for (const mode of ['cost', 'quality']) {
    const h = harness(JEV_KEY);
    h.files.set(
      CONFIG,
      JSON.stringify({
        routingEngine: 'shadow',
        mode,
        policy: { activityMass: 0.6 },
        modes: { cost: { policy: { activityMass: 0.99 } }, quality: { policy: { activityMass: 0.2 } } },
      }),
    );
    answering(h, jevResponse('medium', { medium: 1 }, 0, { code: 0.8, uncertain: 0.2 }, 'execute'));
    await h.event('session.start', { cwd: '/fixture' });
    await turn(h, 't1', 'Run the check.', 'composer');
    results.push(decisions(h).rows[0].alt.demand);
  }
  assert.deepEqual(results, [1.5, 1.5]);
});

test('a shadow tier pin is one turn only and preserves unpinned demand evidence', async () => {
  const h = harness(JEV_KEY);
  h.files.set(CONFIG, JSON.stringify({ routingEngine: 'shadow' }));
  answering(h, jevResponse('low', { low: 1 }));
  await h.event('session.start', { cwd: '/fixture' });
  await turn(h, 't1', 'First task.', 'composer');
  const before = structuredClone(h.loop().shadow.state);
  await h.event('command.run', { command: 'router', args: 'pin high' });
  await turn(h, 't2', 'Pinned task.', 'composer');
  assert.equal(
    decisions(h)
      .rows.filter((r) => r.kind === 'start')
      .at(-1).alt.demand,
    3,
  );
  assert.deepEqual(h.loop().shadow.state, before);
  await turn(h, 't3', 'Next task.', 'composer');
  assert.match(
    decisions(h)
      .rows.filter((r) => r.kind === 'start')
      .at(-1).alt.route,
    /^haiku@/,
  );
  assert.equal(
    decisions(h)
      .rows.filter((r) => r.kind === 'start')
      .at(-1).alt.demand,
    1,
  );
});

test('cost and quality pins propose the same exact demand and target', async () => {
  const proposals = [];
  for (const mode of ['cost', 'quality']) {
    const h = harness(JEV_KEY);
    h.files.set(CONFIG, JSON.stringify({ routingEngine: 'shadow', mode }));
    await h.event('session.start', { cwd: '/fixture' });
    await h.event('command.run', { command: 'router', args: 'pin low' });
    await turn(h, 't1', 'Pinned task.', 'composer');
    proposals.push(decisions(h).rows[0].alt);
  }
  assert.equal(proposals[0].requirement, 1);
  assert.equal(proposals[1].requirement, 1);
  assert.deepEqual(proposals[0], proposals[1]);
});

test('a shadow failure cannot change the table route or poison its state', async () => {
  const h = harness(JEV_KEY);
  h.files.set(CONFIG, JSON.stringify({ routingEngine: 'shadow' }));
  answering(h, HIGH);
  await h.event('session.start', { cwd: '/fixture' });
  await turn(h, 't1', 'First task.', 'composer');
  const saved = h.state.get('loops:main');
  saved.value.shadow.state.votes = null;
  await turn(h, 't2', 'Next task.', 'composer');
  assert.equal(h.requests.at(-1).model, 'claude-opus-5-5');
  assert.equal(h.loop().shadow, undefined);
  assert.equal(
    decisions(h)
      .rows.filter((r) => r.kind === 'start')
      .at(-1).alt.reason,
    'error',
  );
});

test('shadow demand state resets when history generation changes', async () => {
  const h = harness(JEV_KEY);
  h.files.set(CONFIG, JSON.stringify({ routingEngine: 'shadow' }));
  answering(h, HIGH);
  await h.event('session.start', { cwd: '/fixture' });
  await turn(h, 't1', 'First task.', 'composer');
  const loop = h.state.get('loops:main').value;
  loop.generation += 1;
  await turn(h, 't2', 'Next task.', 'composer');
  assert.equal(h.loop().shadow.generation, loop.generation);
  assert.equal(h.loop().shadow.state.turn, 1);
});

test('shadow switches apply next turn and never resume stale demand after a table interval', async () => {
  const h = harness(JEV_KEY);
  h.files.set(CONFIG, JSON.stringify({ routingEngine: 'shadow' }));
  answering(h, HIGH);
  await h.event('session.start', { cwd: '/fixture' });
  await h.event('turn.start', { turnId: 't1', text: 'First task.' });
  await drain(h.step(step));
  h.files.set(CONFIG, JSON.stringify({ routingEngine: 'table' }));
  await h.event('command.run', { command: 'router', args: 'activities off' });
  await drain(h.step({ ...step, index: 1 }));
  assert.ok(h.loop().shadow, 'the current turn keeps its frozen config');
  await h.event('turn.complete', { turnId: 't1' });
  await turn(h, 't2', 'Table task.', 'composer');
  assert.equal(h.loop().shadow, undefined);
  h.files.set(CONFIG, JSON.stringify({ routingEngine: 'shadow', activityRouting: 'off' }));
  await h.event('command.run', { command: 'router', args: 'activities on' });
  await turn(h, 't3', 'Shadow task.', 'composer');
  assert.equal(h.loop().shadow.state.turn, 1);
});

test('a manual interval fences stale shadow votes', async () => {
  const h = harness(JEV_KEY);
  h.files.set(CONFIG, JSON.stringify({ routingEngine: 'shadow' }));
  answering(h, HIGH);
  await h.event('session.start', { cwd: '/fixture' });
  await turn(h, 't1', 'First task.', 'composer');
  await h.event('command.run', { command: 'router', args: 'off' });
  await turn(h, 't2', 'Manual task.', 'composer');
  await h.event('command.run', { command: 'router', args: 'auto' });
  await turn(h, 't3', 'Routed task.', 'composer');
  assert.equal(h.loop().shadow.state.turn, 1);
});

test('fresh shadow demand starts at the configured baseline, not the accepted table tier', async () => {
  const h = harness(JEV_KEY);
  h.files.set(CONFIG, JSON.stringify({ routingEngine: 'shadow' }));
  h.model('claude-opus-5-5');
  answering(h, jevResponse('uncertain', { uncertain: 1 }));
  await h.event('session.start', { cwd: '/fixture' });
  await turn(h, 't1', 'Task.', 'composer');
  assert.equal(h.loop().shadow.state.demand, 1);
  await h.event('command.run', { command: 'router', args: 'off' });
  await h.event('command.run', { command: 'router', args: 'auto' });
  await turn(h, 't2', 'Next task.', 'composer');
  assert.equal(h.loop().shadow.state.demand, 1);
});

test('a review answered after compaction never adds a shadow proposal', async () => {
  const h = harness(JEV_KEY);
  h.files.set(CONFIG, JSON.stringify({ routingEngine: 'shadow', policy: { reviewEveryRequests: 1 } }));
  let release;
  let calls = 0;
  h.http(async () => {
    calls += 1;
    if (calls > 1) await new Promise((resolve) => (release = resolve));
    return { ok: true, status: 200, text: JSON.stringify(HIGH), headers: {} };
  });
  await h.event('session.start', { cwd: '/fixture' });
  await h.event('turn.start', { turnId: 't1', text: 'Task.' });
  await drain(h.step(step));
  await drain(h.step({ ...step, index: 1 }));
  for (let i = 0; i < 100 && !release; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(release);
  await h.event('session.compact', { trigger: 'auto' });
  release();
  await new Promise((resolve) => setImmediate(resolve));
  await drain(h.step({ ...step, index: 2 }));
  await h.event('turn.complete', { turnId: 't1' });
  assert.equal(decisions(h).rows.filter((r) => r.kind === 'review').length, 0);
});

test('shadow prices a real substituted cache identity for the next proposal', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-16T10:00:00Z') });
  const h = harness(JEV_KEY);
  h.files.set(CONFIG, JSON.stringify({ routingEngine: 'shadow' }));
  answering(h, jevResponse('low', { low: 1 }));
  await h.event('session.start', { cwd: '/fixture' });
  await turn(h, 't1', 'Task.', 'composer');
  const loop = h.state.get('loops:main').value;
  const id = 'claude-haiku-5-5-20261101';
  loop.resolutions['claude-haiku-5-5'] = id;
  loop.models[id] = { ...loop.models['claude-haiku-5-5'], prefixTokens: 9000, lastAt: Date.now() };
  delete loop.models['claude-haiku-5-5'];
  await turn(h, 't2', 'Next.', 'composer');
  const alt = decisions(h)
    .rows.filter((row) => row.kind === 'start')
    .at(-1).alt;
  assert.match(alt.route, /^haiku@/);
  assert.ok(alt.maxUsd < 0.01, String(alt.maxUsd));
});

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
  assert.ok(start.reason === 'jump' && !('mass' in start) && !('bar' in start));
  assert.deepEqual(end, { at: end.at, kind: 'end', observed: 'check', requests: 1, priced: 0, unpriced: { ttl: 1 } });
  assert.deepEqual(h.preferences.get('activity:metrics:v1:s1').unpriced, {
    usage: 0,
    model: 0,
    ttl: 1,
    error: 0,
    comparison: 0,
  });
  const listed = await h.event('command.run', { command: 'router', args: 'decisions 5' });
  assert.match(
    listed.text,
    /start {5}composer {2}asked high 95% {2}new task {2}-> high claude-opus-5-5@xhigh {2}\(jump\)/,
  );
  assert.match(listed.text, /end {7}tools check {2}1 request {2}0 priced {2}unpriced ttl 1$/);
});

test('a held move writes the mass it compared and the bar, and /router decisions prints them', async () => {
  const h = harness(JEV_KEY);
  answering(h, HIGH);
  await h.event('session.start', { cwd: '/fixture' });
  await turn(h, 't1', 'Design the cache.', 'composer');
  answering(h, jevResponse('low', { micro: 0, low: 0.6, medium: 0, high: 0.4, uncertain: 0 }, 0.2));
  await turn(h, 't2', 'Rename one variable.', 'composer');
  const held = decisions(h).rows.filter((row) => row.kind === 'start')[1];
  assert.equal(held.reason, 'downgrade-pending');
  assert.equal(held.mass, 0.6);
  assert.ok(held.bar >= 0.9 && held.bar <= 1, String(held.bar));
  const listed = await h.event('command.run', { command: 'router', args: 'decisions 5' });
  assert.match(listed.text, new RegExp(`\\(downgrade-pending 60% vs bar ${Math.round(held.bar * 100)}%\\)`));
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
