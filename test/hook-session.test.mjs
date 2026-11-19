// The native router hook's session life: start mode, pins, fallbacks, resume and clear, and what it does when routing is unavailable.
import assert from 'node:assert/strict';
import test from 'node:test';
import { TRACE_PREFIX, usableTrace } from '../lib/replay-trace.mjs';
import { readUsage, summarize } from '../lib/usage.mjs';
import {
  answering,
  band,
  CONFIG,
  drain,
  harness,
  JEV_KEY,
  start,
  step,
  substituted,
  TINY_ROUTER,
  texts,
} from './harness.mjs';
import { assistant, jevResponse, toolResult, user } from './helpers.mjs';

// One whole turn on the session's `model`: its prompt, a routed step, then turn.complete over a transcript where the
// assistant called `tools`.
async function _turn(h, turnId, model, tools = []) {
  await h.event('turn.start', { turnId, text: 'Next.' });
  h.messages(async () => [user('Next.')]);
  await drain(h.step({ ...step, turnId, model }));
  h.messages(async () => [user('Next.'), assistant('done', tools)]);
  await h.event('turn.complete', { turnId });
}

const _reply = { turns: 1, requests: 1, inputTokens: 1100, outputTokens: 10 };

test('frozen native state reads do not restore consumed pins or drop first response usage', async () => {
  const h = harness();
  await start(h);
  await h.event('command.run', { command: 'router', args: 'pin high' });
  await drain(h.step(step));
  assert.equal(h.requests[0].model, 'claude-opus-5-5');
  assert.equal(h.view().pendingPin, null);
  assert.equal(h.view().actualModel, 'claude-opus-5-5');
  assert.equal(h.loop().lastRequest.tokens, 1100);
  assert.equal(h.loop().models['claude-opus-5-5'].prefixTokens, 1000);
});

test('a pinned turn interrupted before its route is written leaves the pin for the next turn', async () => {
  const h = harness();
  await start(h);
  await h.event('command.run', { command: 'router', args: 'pin high' });
  const set = h.$.state.set;
  let release;
  h.$.state.set = async (ref, value, options) => {
    if (ref.key === 'loops' && !release) await new Promise((resolve) => (release = resolve));
    return set(ref, value, options);
  };
  const stepping = drain(h.step(step));
  for (let i = 0; i < 100 && !release; i += 1) await Promise.resolve();
  h.$.state.set = set;
  await h.event('turn.complete', { turnId: step.turnId });
  release();
  await stepping;
  assert.equal(h.view().pendingPin, 'high');
  await drain(h.step({ ...step, turnId: 't2' }));
  assert.equal(h.requests.at(-1).model, 'claude-opus-5-5');
  assert.equal(h.view().pendingPin, null);
});

test('a pin pressed again while a pinned turn chooses serves the next turn', async () => {
  const h = harness();
  await start(h);
  await h.event('command.run', { command: 'router', args: 'pin high' });
  const set = h.$.state.set;
  let release;
  h.$.state.set = async (ref, value, options) => {
    if (ref.key === 'loops' && !release) await new Promise((resolve) => (release = resolve));
    return set(ref, value, options);
  };
  const stepping = drain(h.step(step));
  for (let i = 0; i < 100 && !release; i += 1) await Promise.resolve();
  h.$.state.set = set;
  await h.event('command.run', { command: 'router', args: 'pin high' });
  release();
  await stepping;
  assert.equal(h.requests.at(-1).model, 'claude-opus-5-5');
  assert.equal(h.view().pendingPin, 'high');
});

test('on a provider that gives each effort its own cache, the loop keys the observed cache by effort', async () => {
  for (const [name, value] of [
    ['CLAUDE_CODE_USE_BEDROCK', '1'],
    ['CLAUDE_CODE_USE_VERTEX', 'true'],
    ['CLAUDE_CODE_USE_FOUNDRY', '1'],
    ['CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS', '1'],
    ['ANTHROPIC_BASE_URL', 'https://gateway.example'],
  ]) {
    const h = harness();
    h.env.set(name, value);
    await start(h);
    await h.event('command.run', { command: 'router', args: 'pin high' });
    await drain(h.step(step));
    assert.deepEqual(Object.keys(h.loop().models), ['claude-opus-5-5@xhigh'], name);
  }
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

test('a fresh session starts Auto on a model some route runs and Manual on any other', async () => {
  // With activity routing on, the default, Sonnet runs the code cell at low; with it off only the tier routes count.
  for (const [model, file, mode, effort] of [
    ['claude-opus-5-5', {}, 'auto', 'medium'],
    ['claude-haiku-5-5', {}, 'auto', 'high'],
    ['claude-sonnet-5-5', {}, 'auto', 'high'],
    ['claude-sonnet-5-5', { activityRouting: 'off' }, 'manual', 'low'],
    ['claude-fable-5-1', {}, 'manual', 'low'],
  ]) {
    const h = harness();
    h.files.set(CONFIG, JSON.stringify(file));
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
  h.files.set(CONFIG, JSON.stringify({ activityRouting: 'off' }));
  h.model('claude-sonnet-5-5');
  await start(h);
  const line = (await band(h)).line;
  assert.match(line, /^○ Sonnet 5\.5 +routing off +not a routing tier/);
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
  h.version('2.1.320');
  await start(h);
  await h.event('command.run', { command: 'router', args: 'auto' });
  await h.event('command.run', { command: 'router', args: 'pin high' });
  await drain(h.step(step));
  assert.equal(h.view().phase, 'unavailable');
  assert.match(h.view().error, /2\.1\.321/);
  assert.equal(h.view().pendingPin, null);
  assert.equal(h.requests[0].model, step.model);
  assert.equal(h.requests[0].effort, step.effort);
});

test('while routing is unavailable, /router says why and its on, off and activity commands change nothing', async () => {
  const h = harness();
  h.version('2.1.320');
  await start(h);
  const command = async (args) => (await h.event('command.run', { command: 'router', args })).text;
  const why = 'Routing unavailable: requires Claude Code 2.1.321 or newer. Claude’s model is kept.';
  const mode = h.preferences.get('mode:s1');
  for (const args of ['auto', 'off', 'pin high', 'activities off']) assert.equal(await command(args), why, args);
  assert.equal(h.preferences.get('mode:s1'), mode);
  assert.equal(h.files.get(CONFIG), undefined);
  h.surfaces([]);
  const text = await command('');
  assert.equal(text.split('\n')[0], why);
  assert.doesNotMatch(text, /routing (on|off)/);
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

test('a session that starts on a model no route names keeps it when routing is turned on: its failures do not escalate below it', async () => {
  const fable = 'claude-fable-5-2';
  const fableStep = { ...step, model: fable, effort: 'xhigh' };
  const h = harness();
  h.model(fable);
  await start(h);
  await drain(h.step(fableStep));
  assert.equal(h.view().mode, 'manual');
  await h.event('command.run', { command: 'router', args: 'auto' });
  h.messages(async () => [
    user('Fix the test.'),
    assistant('running', ['Bash']),
    toolResult('error: test_login failed', { isError: true }),
    assistant('editing', ['Edit']),
    toolResult('error: test_login failed', { isError: true }),
    user('Next.'),
  ]);
  await drain(h.step({ ...fableStep, turnId: 't2' }));
  assert.deepEqual(
    h.requests.map((r) => `${r.model}@${r.effort}`),
    [`${fable}@xhigh`, `${fable}@xhigh`],
  );
  assert.equal(h.loop().decision.escalated, false);
});

test('a /model change before routing starts replaces the seeded route, so Auto does not resume on the first model', async () => {
  const fable = 'claude-fable-5-2';
  const h = harness();
  h.model(fable);
  await start(h);
  await drain(h.step({ ...step, model: fable, effort: 'xhigh' }));
  h.model(step.model);
  await h.event('command.run', { command: 'model', origin: { kind: 'user' } });
  await drain(h.step({ ...step, turnId: 't2' }));
  await h.event('command.run', { command: 'router', args: 'auto' });
  await drain(h.step({ ...step, turnId: 't3' }));
  assert.equal(h.requests.at(-1).model, step.model);
});

const modelSwitch = (source) => ({
  hook_event_name: 'PostModelSwitch',
  from_model: step.model,
  to_model: 'claude-opus-5-5',
  requested_model: 'opus',
  source,
});

for (const [source, mode] of [
  ['picker', 'manual'],
  ['sdk', 'manual'],
  ['auto', 'auto'],
  ['resume', 'auto'],
]) {
  test(`a '${source}' model switch with no /model command leaves the session ${mode}`, async () => {
    const h = harness();
    await start(h);
    h.model('claude-opus-5-5');
    await h.event('classic.PostModelSwitch', modelSwitch(source));
    assert.equal(h.view().mode, mode);
    assert.equal(h.preferences.get('mode:s1'), mode === 'manual' ? 'manual' : undefined);
    if (mode === 'manual') {
      assert.equal(h.view().nativeModel, 'claude-opus-5-5');
      assert.equal(h.view().reason, 'model selected manually');
    }
  });
}

test('a plugin-run /model stays Auto though the engine reports the switch as a command', async () => {
  const h = harness();
  await start(h);
  h.model('claude-opus-5-5');
  await h.event('command.run', { command: 'model', origin: { kind: 'plugin' } });
  await h.event('classic.PostModelSwitch', modelSwitch('command'));
  assert.equal(h.view().mode, 'auto');
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

test('replies record the tier that served them, and the strip shows a reply routing did not serve as a dot', async () => {
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
  const { from, ...strip } = h.view().strip;
  assert.ok(Number.isFinite(from));
  assert.deepEqual(strip, { per: 1, cells: [{ high: 1 }, { none: 1 }] });
  const lines = texts(await h.render());
  assert.ok(lines.includes('█'), 'the pinned reply is a high cell');
  assert.ok(lines.includes('· not routed 1'));
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

test('a substituted reply is not counted as the requested tier, and its usage is kept under the model that served it', async () => {
  const h = harness();
  await start(h);
  await h.event('command.run', { command: 'router', args: 'pin high' });
  await drain(h.step(step, substituted));
  assert.deepEqual(h.view().tiers, [null]);
  await h.event('turn.complete', { turnId: step.turnId });
  const cells = Object.keys(summarize(readUsage(h.preferences.get('usage:v1:s1')), { from: null, to: null }).cells);
  assert.equal(cells.length, 1);
  assert.match(cells[0], /^balanced\|none\|none\|claude-sonnet-5-5@/);
});

test('a 1.1 router.json makes routing unavailable and points to the migration script', async () => {
  const h = harness();
  h.files.set(CONFIG, JSON.stringify({ jev: { timeoutMs: 900 } }));
  await start(h);
  assert.equal(h.view().phase, 'unavailable');
  assert.match(h.view().error, /migrate-config\.mjs/);
});

const HIGH = jevResponse('high', { high: 0.99, medium: 0.01 });
const opus = { ...step, model: 'claude-opus-5-5' };
const sentModels = (h) => h.requests.map((r) => `${r.model}@${r.effort}`);

test('settings that cannot be read pass the step through as Claude Code built it', async () => {
  const h = harness(JEV_KEY);
  answering(h, HIGH);
  await start(h);
  const read = h.$.settings.read;
  h.$.settings.read = async (args) => {
    if (args === undefined) throw new Error('settings unreadable');
    return read(args);
  };
  await drain(h.step(opus));
  assert.deepEqual(h.requests, [opus]);
});

test('a failure after the request went out never sends the step again', async () => {
  const h = harness(JEV_KEY);
  answering(h, HIGH);
  await start(h);
  const id = h.$.session.id;
  h.$.session.id = async (...args) => {
    if (h.requests.length > 0) throw new Error('session unreadable');
    return id(...args);
  };
  await assert.rejects(drain(h.step(opus)), /session unreadable/);
  assert.equal(h.requests.length, 1);
});

test('a transcript that cannot be read passes the first step through, and the next step decides', async () => {
  const h = harness(JEV_KEY);
  answering(h, HIGH);
  await start(h);
  h.messages(async () => {
    throw new Error('transcript unreadable');
  });
  await drain(h.step(opus));
  h.messages(async () => [user('One edit.')]);
  await drain(h.step({ ...opus, index: 1 }));
  assert.deepEqual(sentModels(h), ['claude-opus-5-5@medium', 'claude-opus-5-5@xhigh']);
});

test('a decision that throws passes its step through and is made again at the next step', async () => {
  const h = harness(JEV_KEY);
  answering(h, HIGH);
  await start(h);
  const set = h.$.state.set;
  h.$.state.set = async (ref, value, options) => {
    if (ref.key === 'loops') throw new Error('state unwritable');
    return set(ref, value, options);
  };
  await drain(h.step(opus));
  h.$.state.set = set;
  await drain(h.step({ ...opus, index: 1 }));
  assert.deepEqual(sentModels(h), ['claude-opus-5-5@medium', 'claude-opus-5-5@xhigh']);
});

test('a shadow decision that throws passes its step through and leaves the trace incomplete', async () => {
  const h = harness(JEV_KEY);
  h.files.set(CONFIG, JSON.stringify({ routingEngine: 'shadow', policy: { reviewEveryRequests: 0 } }));
  answering(h, HIGH);
  await start(h);
  const set = h.$.state.set;
  h.$.state.set = async (ref, value, options) => {
    if (ref.key === 'loops') throw new Error('state unwritable');
    return set(ref, value, options);
  };
  await drain(h.step(opus));
  h.$.state.set = set;
  await h.event('turn.complete', { turnId: 't1' });
  await h.event('turn.start', { turnId: 't2', text: 'Next.' });
  await drain(h.step({ ...opus, turnId: 't2' }));
  await h.event('turn.complete', { turnId: 't2' });
  const trace = h.preferences.get(`${TRACE_PREFIX}s1`);
  assert.deepEqual(h.requests[0], opus);
  assert.equal(usableTrace(trace), false);
  assert.ok(trace.incomplete.includes('gap'));
});

test('a shadow step outside a started turn that decides nothing leaves the trace incomplete', async () => {
  const h = harness(JEV_KEY);
  h.files.set(CONFIG, JSON.stringify({ routingEngine: 'shadow', policy: { reviewEveryRequests: 0 } }));
  answering(h, HIGH);
  await start(h);
  h.messages(async () => {
    throw new Error('transcript unreadable');
  });
  await drain(h.step(opus));
  h.messages(async () => [user('Next.')]);
  await h.event('turn.start', { turnId: 't2', text: 'Next.' });
  await drain(h.step({ ...opus, turnId: 't2' }));
  await h.event('turn.complete', { turnId: 't2' });
  const trace = h.preferences.get(`${TRACE_PREFIX}s1`);
  assert.deepEqual(h.requests[0], opus);
  assert.ok(trace.incomplete.includes('gap'));
});

test('a turn whose completion fails leaves none of its decision rows pending', async () => {
  const h = harness(JEV_KEY);
  h.files.set(CONFIG, JSON.stringify({ routingEngine: 'auto', activityRouting: 'off' }));
  answering(h, HIGH);
  await start(h);
  h.messages(async () => [user('One edit.')]);
  await drain(h.step(step));
  const id = h.$.session.id;
  h.$.session.id = async () => {
    throw new Error('session unreadable');
  };
  await h.event('turn.complete', { turnId: 't1' });
  h.$.session.id = id;
  const listed = await h.event('command.run', { command: 'router', args: 'decisions' });
  assert.equal(listed.text, 'No routing decisions recorded in this session yet.');
});

test('routing turned off and on while the classifier answers routes the turn’s next step', async () => {
  const h = harness(JEV_KEY);
  let release;
  h.http(
    () =>
      new Promise((resolve) => {
        release = () => resolve({ ok: true, status: 200, text: JSON.stringify(HIGH), headers: {} });
      }),
  );
  await start(h);
  const running = drain(h.step(opus));
  await new Promise((resolve) => setImmediate(resolve));
  await h.event('command.run', { command: 'router', args: 'off' });
  await h.event('command.run', { command: 'router', args: 'auto' });
  release();
  await running;
  const asked = answering(h, HIGH);
  await drain(h.step({ ...opus, index: 1 }));
  assert.equal(asked.length, 1);
  assert.deepEqual([h.loop().turnId, h.view().phase, h.view().mode], ['t1', 'routed', 'auto']);
});

test('a saved mode that cannot be read starts the session by the start rule and is not written over', async () => {
  class ModeUnreadable extends Map {
    get(key) {
      if (key === 'mode:s1') throw new Error('store unreadable');
      return super.get(key);
    }
  }
  const h = harness(JEV_KEY, new ModeUnreadable([['mode:s1', 'manual']]));
  answering(h, HIGH);
  await start(h);
  assert.equal(h.view().mode, 'auto');
  await drain(h.step(opus));
  assert.deepEqual(sentModels(h), ['claude-opus-5-5@xhigh']);
  assert.equal(Map.prototype.get.call(h.preferences, 'mode:s1'), 'manual');
});

test('a router.json that does not load is read once per session start, and a fixed file loads at the next', async () => {
  const h = harness(JEV_KEY);
  h.files.set(CONFIG, '{');
  const reads = [];
  const read = h.$.fs.read;
  h.$.fs.read = async (path) => {
    reads.push(path);
    return read(path);
  };
  let registered = 0;
  h.$.command.register = async () => {
    registered += 1;
    return {};
  };
  await start(h);
  await drain(h.step(step));
  await h.event('turn.complete', { turnId: step.turnId });
  await h.event('turn.start', { turnId: 't2', text: 'Next.' });
  await drain(h.step({ ...step, turnId: 't2' }));
  assert.deepEqual([reads.filter((path) => path === CONFIG).length, registered], [1, 1]);
  assert.equal(h.view().phase, 'unavailable');
  h.files.set(CONFIG, JSON.stringify({}));
  await h.event('session.start', { cwd: '/fixture' });
  assert.equal(h.view().phase, 'ready');
});

test('a router.json read that fails at session start is tried again at the next event', async () => {
  const h = harness(JEV_KEY);
  h.files.set(CONFIG, JSON.stringify({}));
  answering(h, HIGH);
  const read = h.$.fs.read;
  let failing = true;
  h.$.fs.read = async (path) => {
    if (failing && path === CONFIG) throw new Error('EIO: i/o error');
    return read(path);
  };
  await start(h);
  assert.equal(h.view().phase, 'unavailable');
  failing = false;
  await h.event('turn.complete', { turnId: step.turnId });
  await h.event('turn.start', { turnId: 't2', text: 'Next.' });
  await drain(h.step({ ...step, turnId: 't2' }));
  assert.equal(h.view().phase, 'routed');
});

test('a /router command that fails to register leaves routing ready', async () => {
  const h = harness(JEV_KEY);
  h.$.command.register = async () => {
    throw new Error('register failed');
  };
  await start(h);
  assert.equal(h.view().phase, 'ready');
});

test('session.start, turn.start and turn.complete pass their event on when the router’s bookkeeping throws', async () => {
  const h = harness(JEV_KEY);
  h.http(() => new Promise(() => {}));
  await start(h);
  const running = drain(h.step(opus));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.view().phase, 'choosing');
  h.$.session.id = async () => {
    throw new Error('session unreadable');
  };
  for (const [name, input] of [
    ['turn.complete', { turnId: 't1' }],
    ['turn.start', { turnId: 't2', text: 'Next.' }],
    ['session.start', { cwd: '/fixture' }],
  ])
    assert.deepEqual(await h.event(name, input), input, name);
  await running.catch(() => {});
});

test('a compaction does not write its history reset over a loop write made since it read the loop', async () => {
  const h = harness();
  await start(h);
  await drain(h.step(step));
  const get = h.$.state.get;
  h.$.state.get = async (ref) => {
    const read = await get(ref);
    const stored = h.state.get('loops:main');
    if (ref.key === 'loops' && stored)
      h.state.set('loops:main', { value: { ...stored.value, requests: 99 }, version: stored.version + 1 });
    return read;
  };
  await h.event('session.compact', { trigger: 'auto' });
  h.$.state.get = get;
  assert.equal(h.loop().requests, 99);
});
