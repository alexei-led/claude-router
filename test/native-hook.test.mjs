import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from '../hooks/native-router.mjs';

function harness(options = {}, preferences = new Map()) {
  const hooks = [];
  const state = new Map();
  const env = new Map([
    ['HOME', '/fixture'],
    ['CLAUDE_CONFIG_DIR', '/fixture/team'],
  ]);
  const requests = [];
  const files = new Map();
  let model = 'claude-sonnet-5-5';
  let usage = { context: { tokens: 8000, breakdown: { totalTokens: 9000 } } };
  let draft = '';
  let commandCalls = 0;
  let surfaces = ['terminal'];
  const copied = [];
  const toasts = [];
  let version = '2.1.289';
  let settings = {};
  let sessionId = 's1';
  let snapshot = new Map();
  let messages = async () => [{ role: 'user', content: 'One edit.' }];
  let http = async () => {
    throw new Error('unexpected HTTP');
  };
  const keyOf = (ref) => `${ref.key}:${ref.id ?? ''}`;
  const $ = {
    plugin: { name: 'router', root: '/fixture/plugin' },
    env: { get: async (key) => env.get(key), set: async (key, value) => env.set(key, value) },
    store: { get: async (key) => preferences.get(key), set: async (key, value) => preferences.set(key, value) },
    state: {
      get: async (ref) => {
        const key = keyOf(ref);
        if (!snapshot.has(key)) snapshot.set(key, structuredClone(state.get(key) ?? { value: undefined, version: 0 }));
        return snapshot.get(key);
      },
      set: async (ref, value, options) => {
        const key = keyOf(ref);
        const previous = state.get(key)?.version ?? 0;
        if (options?.ifVersion !== undefined && options.ifVersion !== previous)
          return { isSet: false, version: previous };
        state.set(key, { value: structuredClone(value), version: previous + 1 });
        return { isSet: true, version: previous + 1 };
      },
    },
    fs: {
      exists: async (path) => files.has(path),
      read: async (path) => files.get(path),
      stat: async () => ({ isLink: false }),
      write: async (path, text) => files.set(path, text),
    },
    command: {
      register: async () => ({}),
      run: async () => {
        commandCalls += 1;
        return { text: 'settings opened' };
      },
    },
    prompt: {
      read: async () => ({ text: draft, cursor: draft.length }),
      fill: async ({ text }) => {
        draft = text;
        return { isFilled: true };
      },
    },
    session: {
      version: async () => ({ version }),
      model: async () => model,
      id: async () => sessionId,
      surfaces: async () => surfaces,
      messages: (...args) => messages(...args),
      usage: async () => usage,
    },
    settings: { read: async () => settings },
    clock: {
      after: (_ms, fn) => {
        fn();
        return { cancel: () => {} };
      },
      sleep: (_ms, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
    },
    http: { fetch: (...args) => http(...args) },
    ui: {
      log: () => {},
      copy: async (args) => copied.push(args),
      toast: (text) => toasts.push(text),
      open: async () => ({}),
      close: async () => {},
      resolve: () => {
        const element = (type) => (props) => ({ type, props });
        return { Box: element('Box'), Text: element('Text'), Button: element('Button'), Select: element('Select') };
      },
    },
  };
  register(
    (event, matcher, hook) =>
      hooks.push({
        event,
        matcher: typeof matcher === 'function' ? null : matcher,
        hook: typeof matcher === 'function' ? matcher : hook,
      }),
    options,
  );
  function handler(event, input) {
    return hooks.find(
      (item) =>
        item.event === event &&
        (!item.matcher ||
          Object.entries(item.matcher).every(([key, value]) =>
            Array.isArray(value) ? value.includes(input[key]) : value === input[key],
          )),
    )?.hook;
  }
  const next = (input) => input;
  next.signal = new AbortController().signal;
  return {
    state,
    env,
    requests,
    files,
    preferences,
    usage: (value) => {
      usage = value;
    },
    model: (value) => {
      model = value;
    },
    draft: (value) => {
      if (value !== undefined) draft = value;
      return draft;
    },
    commandCalls: () => commandCalls,
    copied,
    toasts,
    surfaces: (value) => {
      surfaces = value;
    },
    version: (value) => {
      version = value;
    },
    settings: (value) => {
      settings = value;
    },
    view: () => state.get('view:')?.value,
    loop: () => state.get('loops:main')?.value,
    http: (fn) => {
      http = fn;
    },
    messages: (fn) => {
      messages = fn;
    },
    event: async (name, input) => {
      snapshot = new Map();
      return handler(name, input)($, input, next);
    },
    render: async () => {
      snapshot = new Map();
      return handler('ui.render', { component: 'Pane' })(
        $,
        { component: 'Pane', requestId: 'jev-router' },
        async () => null,
      );
    },
    // Draws one component with these props; `next` echoes its input, so a rewrite shows in the result.
    component: async (component, props = {}) => {
      snapshot = new Map();
      return handler('ui.render', { component })($, { component, requestId: component, props }, async (input) => input);
    },
    step: (input, response = {}) => {
      snapshot = new Map();
      const send = async function* (request) {
        requests.push(request);
        yield { kind: 'text', text: 'ok', index: 0 };
        return {
          turnId: request.turnId,
          index: request.index,
          answer: 'ok',
          toolUses: [],
          stopReason: 'end_turn',
          usage: {
            model: request.model,
            input_tokens: 100,
            cache_read_input_tokens: 800,
            cache_creation_input_tokens: 200,
            output_tokens: 10,
          },
          ...response,
        };
      };
      send.signal = new AbortController().signal;
      return handler('turn.step', input)($, input, send);
    },
    clear: (id = 's2') => {
      state.clear();
      sessionId = id;
    },
  };
}

async function drain(stream) {
  let result = await stream.next();
  while (!result.done) result = await stream.next();
  return result.value;
}

const step = { turnId: 't1', index: 0, model: 'claude-sonnet-5-5', effort: 'medium', messageCount: 1 };
const start = async (h) => {
  await h.event('session.start', { cwd: '/fixture' });
  await h.event('turn.start', { turnId: 't1', text: 'One edit.' });
};

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
      ['claude-sonnet-5-5', 'low'],
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

test('an explicit startup model is preserved unless this conversation chose Auto', async () => {
  const h = harness();
  h.model('claude-opus-5-5');
  await start(h);
  await drain(h.step({ ...step, model: 'claude-opus-5-5' }));
  assert.equal(h.view().mode, 'manual');
  assert.equal(h.requests[0].model, 'claude-opus-5-5');
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

async function press(h, key, ...args) {
  const control = controls(await h.render()).find((node) => node.key === key);
  assert.ok(control, `no control ${key}`);
  return control.onPress ? control.onPress(...args) : control.onSelect(...args);
}

function texts(tree) {
  const out = [];
  (function walk(node) {
    if (!node) return;
    if (node.type === 'Text' && typeof node.props.children === 'string') out.push(node.props.children);
    if (Array.isArray(node.props?.children)) node.props.children.forEach(walk);
  })(tree);
  return out;
}

function controls(tree) {
  const nodes = [];
  function walk(node) {
    if (!node) return;
    if (['Button', 'Select'].includes(node.type)) nodes.push(node.props);
    if (Array.isArray(node.props?.children)) node.props.children.forEach(walk);
  }
  walk(tree);
  return nodes;
}

test('a continuation context-fit publishes the model actually requested', async () => {
  const h = harness();
  await start(h);
  await drain(h.step({ ...step, turnId: 'prime' }));
  await h.event('command.run', { command: 'router', args: 'pin micro' });
  await drain(h.step(step));
  h.usage({ context: { tokens: 1100, breakdown: { totalTokens: 300_000 } } });
  await drain(h.step({ ...step, index: 1, messageCount: 3 }));
  assert.equal(h.view().selectedModel, 'claude-sonnet-5-5');
  assert.equal(h.view().actualModel, 'claude-sonnet-5-5');
  assert.equal(h.view().effort, 'medium');
  assert.equal(h.view().reason, 'context-fit');
  assert.equal(h.view().contextTokens, 300_000);
});

test('Manual requests refresh main metrics without rewriting models or effort', async () => {
  const h = harness();
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

test('clear discards unsaved tuning and preserves active configuration', async () => {
  const h = harness();
  await start(h);
  await press(h, 'tab-tuning');
  await press(h, 'timeoutMs', '3000');
  assert.equal(h.view().tuning.timeoutMs, 3000);
  await h.event('session.end', { reason: 'clear' });
  h.clear();
  await drain(h.step({ ...step, turnId: 't2' }));
  assert.equal(h.view().tuning.timeoutMs, 1500);
});

test('the key button opens the secure plugin dialog and leaves a prompt draft alone', async () => {
  const h = harness();
  await start(h);
  h.draft('unfinished task');
  await press(h, 'key');
  assert.equal(h.commandCalls(), 1);
  assert.equal(h.draft(), 'unfinished task');
});

test('the key button is on the Tuning tab once a key is set', async () => {
  const h = harness({ typesafe_api_key: 'synthetic-key' });
  await start(h);
  assert.equal(
    controls(await h.render()).find((node) => node.key === 'key'),
    undefined,
  );
  await press(h, 'tab-tuning');
  await press(h, 'key');
  assert.equal(h.commandCalls(), 1);
});

test('saved tuning cannot change a classification already in progress', async () => {
  const h = harness({ typesafe_api_key: 'synthetic-key' });
  let resolve;
  h.http(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await start(h);
  const pending = drain(h.step(step));
  for (let i = 0; i < 100 && !resolve; i += 1) await Promise.resolve();
  assert.ok(resolve);
  await press(h, 'tab-tuning');
  await press(h, 'downgradeVotes', '1');
  await press(h, 'save-tuning');
  resolve({
    status: 200,
    ok: true,
    headers: {},
    text: JSON.stringify({
      answers: {
        route: {
          type: 'choice',
          choice: 'micro',
          confidence: 0.999,
          probabilities: { micro: 0.999, low: 0.001, medium: 0, high: 0 },
        },
        continuation: { type: 'noul', noul: 0 },
      },
    }),
  });
  await pending;
  assert.equal(h.requests[0].model, step.model);
  assert.equal(h.view().probabilities.micro, 0.999);
  await press(h, 'tab-now');
  assert.ok(texts(await h.render()).some((line) => /100%/.test(line)));
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

const substituted = {
  usage: {
    model: 'claude-sonnet-5-5',
    input_tokens: 100,
    cache_read_input_tokens: 800,
    cache_creation_input_tokens: 200,
    output_tokens: 10,
  },
};

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
      ['t1', 1, 'claude-sonnet-5-5'],
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

const CONFIG = '/fixture/team/router.json';

test('a saved route edit writes router.json and routes the next turn', async () => {
  const h = harness();
  await start(h);
  await press(h, 'tab-tiers');
  await press(h, 'route-model-medium', 'sonnet');
  await press(h, 'route-effort-medium', 'xhigh');
  assert.ok(texts(await h.render()).some((line) => /\+ routes\.medium\s+Sonnet 5\.5 · xhigh/.test(line)));
  await press(h, 'save-routes');
  assert.deepEqual(JSON.parse(h.files.get(CONFIG)), { routes: { medium: { model: 'sonnet', effort: 'xhigh' } } });
  assert.equal(h.view().routeDraft, null);
  assert.match(h.view().notice, /apply from the next turn/);
  await h.event('turn.start', { turnId: 't2', text: 'Next.' });
  await h.event('command.run', { command: 'router', args: 'pin medium' });
  await drain(h.step({ ...step, turnId: 't2' }));
  assert.deepEqual([h.requests[0].model, h.requests[0].effort], ['claude-sonnet-5-5', 'xhigh']);
});

test('session effort on a tier sends the effort Claude Code asked for', async () => {
  const h = harness();
  await start(h);
  await press(h, 'tab-tiers');
  await press(h, 'route-effort-high', 'session');
  await press(h, 'save-routes');
  assert.deepEqual(JSON.parse(h.files.get(CONFIG)).routes.high, { model: 'opus', effort: null });
  await h.event('turn.start', { turnId: 't2', text: 'Next.' });
  await h.event('command.run', { command: 'router', args: 'pin high' });
  await drain(h.step({ ...step, turnId: 't2', effort: 'low' }));
  assert.deepEqual([h.requests[0].model, h.requests[0].effort], ['claude-opus-5-5', 'low']);
});

test('reset to defaults removes saved route overrides and keeps other settings', async () => {
  const h = harness();
  h.files.set(CONFIG, JSON.stringify({ routes: { low: { model: 'opus' } }, jev: { timeoutMs: 900 } }));
  await start(h);
  await press(h, 'tab-tiers');
  await press(h, 'reset-routes');
  await press(h, 'save-routes');
  assert.deepEqual(JSON.parse(h.files.get(CONFIG)), { jev: { timeoutMs: 900 } });
});

test('a model without effort levels has no effort control and drops the chosen effort', async () => {
  const h = harness();
  await start(h);
  await press(h, 'tab-tiers');
  assert.equal(
    controls(await h.render()).find((node) => node.key === 'route-effort-micro'),
    undefined,
  );
  await press(h, 'route-model-high', 'haiku');
  assert.deepEqual(h.view().routeDraft.routes.high, { model: 'haiku', effort: null });
  assert.equal(
    controls(await h.render()).find((node) => node.key === 'route-effort-high'),
    undefined,
  );
});

test('model choices follow the availableModels allowlist', async () => {
  const h = harness();
  h.settings({ availableModels: ['sonnet'] });
  await start(h);
  await press(h, 'tab-tiers');
  const select = controls(await h.render()).find((node) => node.key === 'route-model-low');
  assert.deepEqual(
    select.options.map((option) => option.value),
    ['sonnet'],
  );
});

test('a save that fails validation names the setting and leaves router.json unchanged', async () => {
  for (const [content, reason] of [
    [JSON.stringify({ policy: { cashCapUsd: -1 } }), /policy\.cashCapUsd must be a non-negative number/],
    ['{ "routes": ', /router\.json is not valid JSON/],
  ]) {
    const h = harness();
    await start(h);
    h.files.set(CONFIG, content);
    await press(h, 'tab-tiers');
    await press(h, 'route-model-medium', 'sonnet');
    await press(h, 'save-routes');
    assert.match(h.view().notice, reason);
    assert.match(h.view().notice, /unchanged/);
    assert.equal(h.files.get(CONFIG), content);
    assert.ok(h.view().routeDraft);
  }
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
  assert.match((await h.event('command.run', { command: 'router', args: 'off' })).text, /Manual/);
  assert.match((await h.event('command.run', { command: 'router', args: 'auto' })).text, /Auto/);
  assert.equal(h.commandCalls(), 0);
  assert.deepEqual(await h.event('command.run', { command: 'router', args: 'setup' }), {});
  assert.equal(h.commandCalls(), 0);
});

const BAND = { hasSurvey: false, isWorking: false, maxRows: 8, bodyColumns: 120, view: {} };
const band = async (h, props = {}) => {
  const tree = await h.component('AbovePrompt', { ...BAND, ...props });
  return { tree, line: texts(tree).join(''), controls: controls(tree) };
};

test('the band shows the tier meter, route, reason and context after a routed reply', async () => {
  const h = harness();
  await start(h);
  await h.event('command.run', { command: 'router', args: 'pin high' });
  await drain(h.step(step));
  const { line, controls: buttons } = await band(h);
  assert.match(line, /▂▄▆█ high Opus 5\.5 · xhigh/);
  assert.match(line, /⏵ pinned/);
  assert.match(line, /ctx \d+% · cache \d+%/);
  assert.ok(buttons.some((node) => node.key === 'details'));
  assert.doesNotMatch(line, /Jev Router/);
});

test('a narrow band drops context and reason before the route', async () => {
  const h = harness();
  await start(h);
  await h.event('command.run', { command: 'router', args: 'pin high' });
  await drain(h.step(step));
  const { line } = await band(h, { bodyColumns: 40 });
  assert.match(line, /high Opus 5\.5 · xhigh/);
  assert.doesNotMatch(line, /ctx|pinned/);
});

test('the band yields to a survey and says subagents keep their model', async () => {
  const h = harness();
  await start(h);
  assert.equal((await band(h, { hasSurvey: true })).tree.component, 'AbovePrompt');
  assert.match((await band(h, { view: { agentId: 'a1' } })).line, /subagents keep their own model/);
});

test('the band offers Auto in Manual mode and a key button without a key', async () => {
  const h = harness();
  await start(h);
  await drain(h.step(step));
  let view = await band(h);
  assert.match(view.line, /⚠ Jev key not set · keeping model/);
  await view.controls.find((node) => node.key === 'band-key').onPress();
  assert.equal(h.commandCalls(), 1);
  await h.event('command.run', { command: 'router', args: 'off' });
  view = await band(h);
  assert.match(view.line, /Router off · keeping Sonnet 5\.5/);
  await view.controls.find((node) => node.key === 'band-auto').onPress();
  assert.equal(h.view().mode, 'auto');
});

test('the band hover row pins, unpins and switches to two rows', async () => {
  const preferences = new Map();
  const h = harness({}, preferences);
  await start(h);
  await (await band(h)).controls.find((node) => node.key === 'band-pin-medium').onPress();
  assert.equal(h.view().pendingPin, 'medium');
  assert.match(h.toasts.at(-1), /medium pinned/);
  await (await band(h)).controls.find((node) => node.key === 'band-unpin').onPress();
  assert.equal(h.view().pendingPin, null);
  await (await band(h)).controls.find((node) => node.key === 'band-detail').onPress();
  assert.equal(preferences.get('band:detail'), true);
  await h.event('command.run', { command: 'router', args: 'pin low' });
  await drain(h.step(step));
  assert.match((await band(h)).line, /replies █/);
});

test('a route change raises one toast with the old and new model; a pin does not', async () => {
  const h = harness();
  await start(h);
  await h.event('command.run', { command: 'router', args: 'pin high' });
  await drain(h.step(step));
  assert.equal(h.toasts.length, 0);
  await h.event('turn.start', { turnId: 't2', text: 'Next.' });
  await drain(h.step({ ...step, turnId: 't2' }));
  assert.equal(h.toasts.length, 1);
  assert.match(h.toasts[0], /^Opus 5\.5 · xhigh → Sonnet 5\.5 .*— /);
});

test('the spinner says Choosing model only while the classifier runs', async () => {
  const h = harness({ typesafe_api_key: 'synthetic-key' });
  let calls = 0;
  h.http(() => {
    calls += 1;
    return new Promise(() => {});
  });
  await start(h);
  const spinner = { word: 'Baking', message: null, suffix: '…', mode: 'requesting' };
  assert.equal((await h.component('Spinner', spinner)).props.message, null);
  drain(h.step(step));
  for (let i = 0; i < 100 && !calls; i += 1) await Promise.resolve();
  assert.equal((await h.component('Spinner', spinner)).props.message, 'Choosing model');
  assert.equal(
    (await h.component('Spinner', { ...spinner, message: 'Waiting for permission' })).props.message,
    'Waiting for permission',
  );
});

test('the footer labels paused routing', async () => {
  const h = harness();
  await start(h);
  assert.deepEqual((await h.component('SessionMode', { modes: ['focus'] })).props.modes, ['focus']);
  await h.event('command.run', { command: 'router', args: 'off' });
  assert.deepEqual((await h.component('SessionMode', { modes: ['focus'] })).props.modes, ['focus', 'router off']);
});
