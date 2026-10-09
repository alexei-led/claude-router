import assert from 'node:assert/strict';
import test from 'node:test';
import {
  answering,
  band,
  CONFIG,
  drain,
  harness,
  JEV_KEY,
  press,
  start,
  step,
  substituted,
  TINY_ROUTER,
  texts,
} from './harness.mjs';
import { assistant, jevResponse, user } from './helpers.mjs';

test('frozen native state reads do not restore consumed pins or drop first response usage', async () => {
  const h = harness();
  await start(h);
  await h.event('command.run', { command: 'router', args: 'pin high' });
  await drain(h.step(step));
  assert.equal(h.requests[0].model, 'claude-opus-5-5');
  assert.equal(h.view().pendingPin, null);
  assert.equal(h.view().actualModel, 'claude-opus-5-5');
  assert.equal(h.loop().lastRequest.tokens, 1100);
  assert.equal(h.loop().models['claude-opus-5-5@xhigh'].prefixTokens, 1000);
});

test('a failed routed request leaves an engine-selected fallback untouched', async () => {
  const h = harness();
  await start(h);
  await h.event('command.run', { command: 'router', args: 'pin high' });
  await drain(h.step(step, { usage: null, stopReason: null }));
  await drain(h.step({ ...step, effort: 'low' }));
  assert.deepEqual(
    h.requests.map((r) => [r.model, r.effort]),
    [
      ['claude-opus-5-5', 'xhigh'],
      [step.model, 'low'],
    ],
  );
});

test('Manual clicked during advice cancels selection before an API request is rewritten', async () => {
  const h = harness({ typesafe_api_key: 'synthetic-key' });
  let httpCalls = 0;
  h.http(() => {
    httpCalls += 1;
    return new Promise(() => {});
  });
  await start(h);
  const pending = drain(h.step(step));
  for (let i = 0; i < 100 && !httpCalls; i += 1) await Promise.resolve();
  assert.equal(httpCalls, 1);
  const tree = await h.render();
  const buttons = [];
  function walk(node) {
    if (!node) return;
    if (node.type === 'Button') buttons.push(node.props);
    if (Array.isArray(node.props?.children)) node.props.children.forEach(walk);
  }
  walk(tree);
  await buttons.find((button) => button.key === 'manual').onPress();
  await pending;
  assert.equal(h.requests[0].model, step.model);
  assert.equal(h.preferences.get('mode:s1'), 'manual');
  assert.equal(h.view().mode, 'manual');
  assert.equal(h.view().actualModel, step.model);
  assert.equal(h.view().outputTokens, 10);
});

test('clear starts a new Auto session without changing the previous Manual preference', async () => {
  const h = harness();
  await start(h);
  await h.event('command.run', { command: 'router', args: 'off' });
  await h.event('session.end', { reason: 'clear' });
  h.clear();
  await h.event('command.run', { command: 'router', args: 'pin high' });
  await drain(h.step({ ...step, turnId: 't2' }));
  assert.equal(h.view().mode, 'auto');
  assert.equal(h.requests[0].model, 'claude-opus-5-5');
  assert.equal(h.preferences.get('mode:s1'), 'manual');
  assert.equal(h.preferences.get('mode:s2'), 'auto');
});

test('resume restores each selected session mode and ignores a process-wide override', async () => {
  const preferences = new Map([
    ['mode:s1', 'manual'],
    ['mode:s2', 'auto'],
  ]);
  const h = harness({}, preferences);
  h.env.set('JEV_ROUTER_MODE', 'manual');
  await start(h);
  await h.event('session.end', { reason: 'resume' });
  h.clear('s2');
  await h.event('command.run', { command: 'router', args: 'pin high' });
  await drain(h.step({ ...step, turnId: 't2' }));
  assert.equal(h.requests[0].model, 'claude-opus-5-5');
  assert.equal(h.view().mode, 'auto');
  await h.event('session.end', { reason: 'resume' });
  h.clear('s1');
  await h.event('command.run', { command: 'router', args: 'pin high' });
  await drain(h.step({ ...step, turnId: 't3' }));
  assert.equal(h.requests[1].model, step.model);
  assert.equal(h.view().mode, 'manual');
});

test('a fresh process restoring the same conversation keeps an explicit Manual baseline', async () => {
  const original = harness();
  await start(original);
  await original.event('command.run', { command: 'router', args: 'off' });
  const resumed = harness({}, original.preferences);
  await start(resumed);
  await resumed.event('command.run', { command: 'router', args: 'pin high' });
  await drain(resumed.step(step));
  assert.equal(resumed.view().mode, 'manual');
  assert.equal(resumed.view().pendingPin, null);
  assert.equal(resumed.requests[0].model, step.model);
});

test('the first turn of a session switches on one classifier answer', async () => {
  for (const [model, answer, expected] of [
    [
      'claude-haiku-5-5',
      jevResponse('medium', { micro: 0, low: 0.05, medium: 0.95, high: 0, uncertain: 0 }),
      ['claude-opus-5-5', 'medium', 'upgrade'],
    ],
    [
      'claude-opus-5-5',
      jevResponse('micro', { micro: 0.999, low: 0.001, medium: 0, high: 0, uncertain: 0 }),
      ['claude-haiku-5-5', 'medium', 'downgrade'],
    ],
  ]) {
    const h = harness({ typesafe_api_key: 'synthetic-key' });
    h.model(model);
    h.http(async () => ({ ok: true, status: 200, text: JSON.stringify(answer), headers: {} }));
    await start(h);
    await drain(h.step({ ...step, model }));
    assert.deepEqual([h.requests[0].model, h.requests[0].effort, h.loop().decision.reason], expected, model);
  }
});

test('a fresh session starts Auto on a model some tier routes to and Manual on any other', async () => {
  for (const [model, mode, effort] of [
    ['claude-opus-5-5', 'auto', 'medium'],
    ['claude-haiku-5-5', 'auto', 'high'],
    ['claude-sonnet-5-5', 'manual', 'low'],
    ['claude-fable-5-1', 'manual', 'low'],
  ]) {
    const h = harness();
    h.model(model);
    await start(h);
    await drain(h.step({ ...step, model, effort: 'low' }));
    assert.equal(h.view().mode, mode, model);
    assert.equal(h.preferences.get('mode:s1'), mode, model);
    assert.deepEqual([h.requests[0].model, h.requests[0].effort], [model, effort], model);
  }
});

test('a fresh session on a model no tier routes to says why routing starts off, until the mode changes', async () => {
  const h = harness();
  h.model('claude-sonnet-5-5');
  await start(h);
  const line = (await band(h)).line;
  assert.match(line, /Routing off · every turn uses Sonnet 5\.5/);
  assert.match(line, /Sonnet 5\.5 is not a routing tier/);
  await h.event('command.run', { command: 'router', args: 'auto' });
  assert.doesNotMatch((await band(h)).line, /not a routing tier/);
});

test('a fresh session on a tier model shows no start reason', async () => {
  const h = harness();
  await start(h);
  assert.doesNotMatch((await band(h)).line, /not a routing tier/);
});

test('a band drawn before session start does not decide the start mode', async () => {
  const h = harness();
  h.model('claude-fable-5-1');
  await band(h);
  await start(h);
  await drain(h.step({ ...step, model: 'claude-fable-5-1' }));
  assert.equal(h.view().mode, 'manual');
  assert.equal(h.preferences.get('mode:s1'), 'manual');
  assert.equal(h.requests[0].model, 'claude-fable-5-1');
  assert.equal(h.requests[0].effort, step.effort);
});

test('subagents preserve their resolved model and never replace main metrics', async () => {
  const h = harness();
  await start(h);
  await h.event('command.run', { command: 'router', args: 'pin high' });
  await drain(h.step(step));
  const before = structuredClone(h.view());
  for (const model of ['claude-haiku-4-5', 'claude-sonnet-5-5']) {
    await drain(h.step({ ...step, agentId: 'worker', model, effort: 'low' }));
    assert.equal(h.requests.at(-1).model, model);
    assert.equal(h.requests.at(-1).effort, 'low');
    assert.deepEqual(h.view(), before);
  }
});

test('a continuation context-fit publishes the model actually requested', async () => {
  const h = harness();
  h.files.set(CONFIG, TINY_ROUTER);
  await start(h);
  await drain(h.step({ ...step, turnId: 'prime' }));
  await h.event('command.run', { command: 'router', args: 'pin micro' });
  await drain(h.step(step));
  h.usage({ context: { tokens: 1100, breakdown: { totalTokens: 300_000 } } });
  await drain(h.step({ ...step, index: 1, messageCount: 3 }));
  assert.equal(h.view().selectedModel, 'claude-haiku-5-5');
  assert.equal(h.view().actualModel, 'claude-haiku-5-5');
  assert.equal(h.view().effort, 'high');
  assert.equal(h.view().reason, 'context-fit');
  assert.equal(h.view().contextTokens, 300_000);
});

test('Manual requests refresh main metrics without rewriting models or effort', async () => {
  const h = harness();
  h.files.set(CONFIG, TINY_ROUTER);
  await start(h);
  await drain(h.step({ ...step, turnId: 'prime' }));
  await h.event('command.run', { command: 'router', args: 'pin micro' });
  await drain(h.step(step));
  assert.equal(h.view().actualModel, 'claude-haiku-4-5');
  h.model('claude-opus-5-5');
  await h.event('config.set', { key: 'model', origin: { kind: 'user' } });
  const manual = { ...step, turnId: 'manual', model: 'claude-opus-5-5', effort: 'low' };
  await drain(
    h.step(manual, {
      usage: {
        model: 'claude-opus-5-5',
        input_tokens: 300,
        cache_read_input_tokens: 500,
        cache_creation_input_tokens: 200,
        output_tokens: 55,
      },
    }),
  );
  assert.equal(h.requests[2].model, manual.model);
  assert.equal(h.requests[2].effort, 'low');
  assert.equal(h.view().nativeModel, manual.model);
  assert.equal(h.view().selectedModel, manual.model);
  assert.equal(h.view().actualModel, manual.model);
  assert.equal(h.view().inputTokens, 1000);
  assert.equal(h.view().outputTokens, 55);
  assert.equal(h.view().cacheRead, 500);
});

test('turn completion removes an interrupted choosing indicator', async () => {
  const h = harness({ typesafe_api_key: 'synthetic-key' });
  let calls = 0;
  h.http(() => {
    calls += 1;
    return new Promise(() => {});
  });
  await start(h);
  const pending = drain(h.step(step));
  for (let i = 0; i < 100 && !calls; i += 1) await Promise.resolve();
  assert.equal(h.view().phase, 'choosing');
  await h.event('turn.complete', { turnId: 't1' });
  await pending;
  assert.equal(h.view().phase, 'ready');
  assert.equal(h.view().actualModel, null);
  assert.equal(h.view().health.failures, 0);
});

test('an unsupported Claude version leaves the native request unchanged', async () => {
  const h = harness();
  h.version('2.1.288');
  await start(h);
  await h.event('command.run', { command: 'router', args: 'auto' });
  await h.event('command.run', { command: 'router', args: 'pin high' });
  await drain(h.step(step));
  assert.equal(h.view().phase, 'unavailable');
  assert.match(h.view().error, /2\.1\.289/);
  assert.equal(h.view().pendingPin, null);
  assert.equal(h.requests[0].model, step.model);
  assert.equal(h.requests[0].effort, step.effort);
});

test('leftover v0.8 gateway settings pass requests through and name the keys to remove', async () => {
  const h = harness();
  h.env.set('ANTHROPIC_BASE_URL', 'http://127.0.0.1:43170');
  await start(h);
  await h.event('command.run', { command: 'router', args: 'pin high' });
  await drain(h.step(step));
  assert.equal(h.view().phase, 'unavailable');
  assert.match(h.view().error, /v0\.8 gateway settings remain/);
  assert.equal(h.requests[0].model, step.model);
  h.surfaces([]);
  const status = await h.event('command.run', { command: 'router', args: '' });
  assert.match(status.text, /ANTHROPIC_BASE_URL/);
  assert.match(status.text, /jev-router\[1m\]/);
  h.surfaces(['terminal']);
  assert.ok(texts(await h.render()).some((line) => /ANTHROPIC_BASE_URL/.test(line)));
});

test('project settings cannot redirect secure router configuration to another profile', async () => {
  const h = harness({ typesafe_api_key: 'synthetic-key' });
  h.settings({ env: { CLAUDE_CONFIG_DIR: '/fixture/untrusted' } });
  await start(h);
  await drain(h.step(step));
  assert.equal(h.view().phase, 'unavailable');
  assert.equal(h.requests[0].model, step.model);
  assert.equal(h.requests[0].effort, step.effort);
  assert.equal(h.files.size, 0);
});

test('a billed substitute keeps the rest of the turn native and the next turn routes again', async () => {
  const h = harness();
  await start(h);
  await h.event('command.run', { command: 'router', args: 'pin high' });
  await drain(h.step(step, substituted));
  await drain(h.step({ ...step, index: 1, effort: 'low' }));
  await h.event('turn.start', { turnId: 't2', text: 'Next edit.' });
  await h.event('command.run', { command: 'router', args: 'pin high' });
  await drain(h.step({ ...step, turnId: 't2' }));
  await drain(h.step({ ...step, turnId: 't2', index: 1 }));
  assert.deepEqual(
    h.requests.map((r) => [r.turnId, r.index, r.model]),
    [
      ['t1', 0, 'claude-opus-5-5'],
      ['t1', 1, step.model],
      ['t2', 0, 'claude-opus-5-5'],
      ['t2', 1, 'claude-opus-5-5'],
    ],
  );
});

test('a compaction inside a turn keeps its pin and a native fallback for the remaining steps', async () => {
  const h = harness();
  await start(h);
  await h.event('command.run', { command: 'router', args: 'pin high' });
  await drain(h.step(step));
  await h.event('session.compact', { trigger: 'auto' });
  await drain(h.step({ ...step, index: 1, messageCount: 0 }));
  await drain(h.step({ ...step, index: 2, model: 'claude-haiku-4-5' }));
  await h.event('session.compact', { trigger: 'auto' });
  await drain(h.step({ ...step, index: 3, model: 'claude-haiku-4-5' }));
  assert.deepEqual(
    h.requests.map((r) => r.model),
    ['claude-opus-5-5', 'claude-opus-5-5', 'claude-haiku-4-5', 'claude-haiku-4-5'],
  );
});

test('the engine echoing our routed model is not a fallback but a third model is', async () => {
  const h = harness();
  await start(h);
  await h.event('command.run', { command: 'router', args: 'pin high' });
  await drain(h.step(step));
  await drain(h.step({ ...step, index: 1, model: 'claude-opus-5-5' }));
  await drain(h.step({ ...step, index: 2, model: 'claude-haiku-4-5' }));
  assert.deepEqual(
    h.requests.map((r) => r.model),
    ['claude-opus-5-5', 'claude-opus-5-5', 'claude-haiku-4-5'],
  );
  assert.equal(h.view().reason, 'native-fallback');
});

test('an interrupt while the transcript is still loading never publishes choosing', async () => {
  const h = harness({ typesafe_api_key: 'synthetic-key' });
  let release;
  h.messages(() => new Promise((resolve) => (release = () => resolve([{ role: 'user', content: 'One edit.' }]))));
  let calls = 0;
  h.http(() => {
    calls += 1;
    return new Promise(() => {});
  });
  await start(h);
  const pending = drain(h.step(step));
  for (let i = 0; i < 100 && !release; i += 1) await Promise.resolve();
  await h.event('turn.complete', { turnId: 't1' });
  release();
  await pending;
  assert.equal(calls, 0);
  assert.notEqual(h.view().phase, 'choosing');
  assert.equal(h.requests[0].model, step.model);
});

test('clear after a manual /model choice on a non-baseline model starts Auto', async () => {
  const h = harness();
  await start(h);
  h.model('claude-opus-5-5');
  await h.event('command.run', { command: 'model', origin: { kind: 'user' } });
  assert.equal(h.preferences.get('mode:s1'), 'manual');
  await h.event('session.end', { reason: 'clear' });
  h.clear('s2');
  const pinned = await h.event('command.run', { command: 'router', args: 'pin micro' });
  assert.match(pinned.text, /pinned for the next turn/);
  await drain(h.step({ ...step, turnId: 't2', model: 'claude-opus-5-5' }));
  assert.equal(h.view().mode, 'auto');
  assert.equal(h.view().pendingPin, null);
  assert.equal(h.preferences.get('mode:s2'), 'auto');
});

test('replies record the tier that served them and the strip counts switches', async () => {
  const h = harness();
  await start(h);
  await h.event('command.run', { command: 'router', args: 'pin high' });
  await drain(h.step(step));
  await h.event('command.run', { command: 'router', args: 'off' });
  await drain(h.step({ ...step, turnId: 't2' }));
  assert.deepEqual(h.view().tiers, ['high', null]);
  assert.equal(h.view().history.length, 2);
  await drain(h.step({ ...step, turnId: 't3' }, { usage: null }));
  assert.equal(h.view().tiers.length, h.view().history.length);
  assert.ok(texts(await h.render()).some((line) => /0 switches/.test(line)));
});

test('the router command opens the pane, switches modes and pins, with no setup or status forms', async () => {
  const h = harness();
  await start(h);
  assert.deepEqual(await h.event('command.run', { command: 'router', args: '' }), {});
  assert.match((await h.event('command.run', { command: 'router', args: 'off' })).text, /^Routing off:/);
  assert.match((await h.event('command.run', { command: 'router', args: 'auto' })).text, /^Routing on\./);
  assert.equal(h.commandCalls(), 0);
  assert.deepEqual(await h.event('command.run', { command: 'router', args: 'setup' }), {});
  assert.equal(h.commandCalls(), 0);
});

test('a substituted reply is not counted as the requested tier', async () => {
  const h = harness();
  await start(h);
  await h.event('command.run', { command: 'router', args: 'pin high' });
  await drain(h.step(step, substituted));
  assert.deepEqual(h.view().tiers, [null]);
});

test('a 1.1 router.json makes routing unavailable and points to the migration script', async () => {
  const h = harness();
  h.files.set(CONFIG, JSON.stringify({ jev: { timeoutMs: 900 } }));
  await start(h);
  assert.equal(h.view().phase, 'unavailable');
  assert.match(h.view().error, /migrate-config\.mjs/);
});

const LOW = { micro: 0, low: 0.95, medium: 0.05, high: 0, uncertain: 0 };
const STATS = 'activity:stats:v1';

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

test('with activity routing on, an ops turn moves from Sonnet to Haiku inside its tier and records it', async () => {
  const h = harness(JEV_KEY);
  h.files.set(CONFIG, JSON.stringify({ activityRouting: 'on' }));
  h.model('claude-sonnet-5-5');
  answering(
    h,
    jevResponse('low', LOW, 0, { code: 0.9, ops: 0.1 }),
    jevResponse('low', LOW, 0, { ops: 0.81, code: 0.19 }),
  );
  await h.event('session.start', { cwd: '/fixture' });
  await turn(h, 't1', 'claude-sonnet-5-5', ['Edit']);
  assert.equal(h.view().mode, 'auto');
  assert.deepEqual([h.requests[0].model, h.requests[0].effort], ['claude-sonnet-5-5', 'medium']);
  let line = (await band(h)).line;
  assert.match(line, / low code → Sonnet 5\.5 · medium/);
  assert.match(line, /ctx \d+% · cache \d+%/);
  await turn(h, 't2', 'claude-sonnet-5-5', ['Bash']);
  assert.deepEqual([h.requests[1].model, h.requests[1].effort], ['claude-haiku-5-5', 'high']);
  assert.deepEqual([h.loop().decision.reason, h.loop().lastActivity], ['activity-down', 'ops']);
  assert.equal(h.toasts.length, 1);
  assert.match(h.toasts[0], /^Model changed: Sonnet 5\.5 · medium → Haiku 5\.5 · high · ops/);
  line = (await band(h)).line;
  assert.match(line, / low ops → Haiku 5\.5 · high/);
  assert.match(line, /↘ ops/);
  assert.deepEqual(h.view().activities, ['code', 'ops']);
  assert.deepEqual(h.view().activityStats, {
    byActivity: { code: reply, ops: reply },
    switches: { tier: 0, activity: 1 },
    agreement: { matched: 2, total: 2 },
    shadow: { differs: 0, turns: 0 },
  });
  assert.deepEqual(h.preferences.get(STATS), {
    version: 1,
    confusion: { code: { code: 1 }, ops: { ops: 1 } },
    runs: { code: [1, 0, 0, 0, 0] },
    lateral: { taken: 1, refused: 0 },
    shadow: { differs: 0, turns: 0 },
  });

  await h.event('session.end', { reason: 'clear' });
  assert.deepEqual(h.preferences.get(STATS).runs, { code: [1, 0, 0, 0, 0], ops: [1, 0, 0, 0, 0] });
  h.clear('s2');
  await h.event('session.start', { cwd: '/fixture' });
  await turn(h, 't3', 'claude-sonnet-5-5', ['Bash']);
  assert.deepEqual(h.view().activities, ['ops']);
  assert.deepEqual(h.view().activityStats.byActivity, { ops: reply });

  const reloaded = harness(JEV_KEY, h.preferences);
  reloaded.files.set(CONFIG, JSON.stringify({ activityRouting: 'on' }));
  answering(reloaded, jevResponse('low', LOW, 0, { ops: 0.9 }));
  await reloaded.event('session.start', { cwd: '/fixture' });
  await turn(reloaded, 't1', 'claude-haiku-5-5', ['Bash']);
  assert.deepEqual(reloaded.view().activityStats.byActivity, { ops: reply });
  assert.deepEqual(reloaded.preferences.get(STATS).confusion, { code: { code: 1 }, ops: { ops: 3 } });
});

test('shadow asks and shows what on would do, and never changes the routed model', async () => {
  const h = harness(JEV_KEY);
  const bodies = answering(h, jevResponse('low', LOW, 0, { code: 0.9, ops: 0.1 }));
  await h.event('session.start', { cwd: '/fixture' });
  await turn(h, 't1', 'claude-haiku-5-5', ['Read']);
  assert.ok(bodies[0].questions.activity);
  assert.deepEqual([h.requests[0].model, h.requests[0].effort], ['claude-haiku-5-5', 'high']);
  assert.equal(h.loop().lastActivity, null);
  assert.deepEqual(h.toasts, []);
  assert.equal(h.view().activity, 'code');
  assert.equal(h.view().activityChoice, 'code');
  assert.deepEqual(h.view().wouldRoute, {
    activity: 'code',
    tier: 'low',
    model: 'claude-sonnet-5-5',
    effort: 'medium',
    reason: 'activity-up',
  });
  assert.match((await band(h)).line, / low code \(shadow\) → Haiku 5\.5 · high/);
  assert.deepEqual(h.view().activityStats.shadow, { differs: 1, turns: 1 });
  assert.deepEqual(h.view().activityStats.agreement, { matched: 0, total: 1 });
  assert.deepEqual(h.preferences.get(STATS).shadow, { differs: 1, turns: 1 });
  assert.deepEqual(h.preferences.get(STATS).confusion, { code: { read: 1 } });
  h.surfaces([]);
  const { text } = await h.event('command.run', { command: 'router', args: '' });
  assert.match(text, /^Activity: code \(90%\)$/m);
  assert.match(text, /^Route: low \+ code would use Sonnet 5\.5 · medium \(shadow; using Haiku 5\.5 · high\)$/m);
});

test('/router activities writes the mode to router.json, off stops the question, and Undo restores it', async () => {
  const h = harness(JEV_KEY);
  const bodies = answering(h, jevResponse('low', LOW, 0, { code: 0.9, ops: 0.1 }));
  await h.event('session.start', { cwd: '/fixture' });
  await turn(h, 't1', 'claude-haiku-5-5');
  assert.ok(bodies[0].questions.activity);
  const command = async (args) => (await h.event('command.run', { command: 'router', args })).text;
  assert.equal(await command('activities later'), 'Choose activities off, shadow, on.');
  assert.equal(await command('activities shadow'), 'Activity routing is already shadow.');
  assert.equal(await command('activities off'), 'Saved: activity routing shadow → off. Applies from the next turn.');
  assert.deepEqual(JSON.parse(h.files.get(CONFIG)), { activityRouting: 'off' });
  await turn(h, 't2', 'claude-haiku-5-5');
  assert.equal(bodies.length, 2);
  assert.equal(bodies[1].questions.activity, undefined);
  assert.equal(h.view().activity, null);
  assert.equal(h.view().activityStats.byActivity.code.turns, 1);
  assert.equal(h.view().activityStats.byActivity.none, undefined);
  await press(h, 'undo');
  assert.deepEqual(JSON.parse(h.files.get(CONFIG)), {});
  await turn(h, 't3', 'claude-haiku-5-5');
  assert.ok(bodies[2].questions.activity);
});

test('a failing stats store or transcript never breaks a turn', async () => {
  const saved = new Map();
  const store = {
    get: (key) => {
      if (key === STATS) throw new Error('store down');
      return saved.get(key);
    },
    set: (key, value) => {
      if (key === STATS) throw new Error('store down');
      return saved.set(key, value);
    },
  };
  const h = harness(JEV_KEY, store);
  answering(h, jevResponse('low', LOW, 0, { code: 0.9, ops: 0.1 }));
  await h.event('session.start', { cwd: '/fixture' });
  await turn(h, 't1', 'claude-haiku-5-5', ['Edit']);
  assert.equal(h.requests[0].model, 'claude-haiku-5-5');
  assert.equal(h.view().activityStats.byActivity.code.turns, 1);
  await h.event('turn.start', { turnId: 't2', text: 'Next.' });
  await drain(h.step({ ...step, turnId: 't2' }));
  h.messages(() => Promise.reject(new Error('transcript gone')));
  await h.event('turn.complete', { turnId: 't2' });
  assert.equal(h.requests.length, 2);
  assert.equal(h.view().activityStats.byActivity.code.turns, 1);
  await h.event('session.end', { reason: 'clear' });
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
