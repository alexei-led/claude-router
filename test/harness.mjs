import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from '../hooks/native-router.mjs';

const element = (type) => (props) => ({ type, props });
export const ELEMENTS = {
  Box: element('Box'),
  Text: element('Text'),
  Button: element('Button'),
  Select: element('Select'),
};

export function harness(options = {}, preferences = new Map()) {
  const hooks = [];
  const state = new Map();
  const env = new Map([
    ['HOME', '/fixture'],
    ['CLAUDE_CONFIG_DIR', '/fixture/team'],
  ]);
  const requests = [];
  const files = new Map();
  const links = new Set();
  let model = 'claude-haiku-5-5';
  let usage = { startedAt: 0, context: { tokens: 8000, breakdown: { totalTokens: 9000 } }, rateLimits: [] };
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
    store: {
      get: async (key) => preferences.get(key),
      set: async (key, value) => preferences.set(key, value),
      delete: async (key) => preferences.delete(key),
      keys: async () => [...preferences.keys()],
    },
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
      exists: async (path) => files.has(path) || [...files.keys()].some((file) => file.startsWith(`${path}/`)),
      read: async (path) => files.get(path),
      stat: async (path) => ({ isLink: links.has(path) }),
      write: async (path, text) => files.set(path, text),
      list: async (dir) =>
        [...files.keys()]
          .filter((path) => path.startsWith(`${dir}/`) && !path.slice(dir.length + 1).includes('/'))
          .map((path) => ({ name: path.slice(dir.length + 1), kind: 'file' })),
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
      cwd: async () => '/fixture/project',
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
      resolve: () => ELEMENTS,
    },
  };
  register((event, matcher, hook) => {
    const entry = {
      event,
      matcher: typeof matcher === 'function' ? null : matcher,
      hook: typeof matcher === 'function' ? matcher : hook,
      onError: null,
    };
    hooks.push(entry);
    // `.catch` answers in the hook's place when it throws, as the engine's handler does.
    return {
      catch: (fn) => {
        entry.onError = fn;
      },
    };
  }, options);
  function handler(event, input) {
    const entry = hooks.find(
      (item) =>
        item.event === event &&
        (!item.matcher ||
          Object.entries(item.matcher).every(([key, value]) =>
            Array.isArray(value) ? value.includes(input[key]) : value === input[key],
          )),
    );
    if (!entry?.onError) return entry?.hook;
    return async ($, e, next) => {
      try {
        return await entry.hook($, e, next);
      } catch {
        return entry.onError($, e, next);
      }
    };
  }
  const next = (input) => input;
  next.signal = new AbortController().signal;
  return {
    $,
    state,
    env,
    requests,
    files,
    links,
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
    render: async (props = PANE) => {
      snapshot = new Map();
      return handler('ui.render', { component: 'Pane' })(
        $,
        { component: 'Pane', requestId: 'jev-router', props },
        async () => null,
      );
    },
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
    // An agent.spawn dispatch: `result` (or `result(sent)`) is what core answers. Returns the hook's answer and the
    // input it passed on, or null when it answered without next.
    spawn: async (input, result = (sent) => ({ model: sent.model ?? input.parentModel, agentId: 'a1' })) => {
      snapshot = new Map();
      let sent = null;
      const core = async (e) => {
        sent = e;
        return typeof result === 'function' ? result(e) : result;
      };
      core.signal = new AbortController().signal;
      const answer = await handler('agent.spawn', input)($, input, core);
      return { answer, sent };
    },
    clear: (id = 's2') => {
      state.clear();
      sessionId = id;
    },
  };
}

export async function drain(stream) {
  let result = await stream.next();
  while (!result.done) result = await stream.next();
  return result.value;
}

export const CONFIG = '/fixture/team/router.json';

export const TINY_ROUTER = JSON.stringify({
  models: {
    tiny: {
      id: 'claude-haiku-4-5',
      input: 1,
      output: 5,
      cacheRead: 0.1,
      contextWindow: 200_000,
      billing: 'plan',
      efforts: [],
    },
  },
  routes: { micro: { model: 'tiny' } },
});

export const step = { turnId: 't1', index: 0, model: 'claude-haiku-5-5', effort: 'medium', messageCount: 1 };

export const start = async (h) => {
  await h.event('session.start', { cwd: '/fixture' });
  await h.event('turn.start', { turnId: 't1', text: 'One edit.' });
};

export async function press(h, key, ...args) {
  const control = controls(await h.render()).find((node) => node.key === key);
  assert.ok(control, `no control ${key}`);
  return control.onPress ? control.onPress(...args) : control.onSelect(...args);
}

export function texts(tree) {
  const out = [];
  (function walk(node) {
    if (!node) return;
    if (node.type === 'Text' && typeof node.props.children === 'string') out.push(node.props.children);
    if (Array.isArray(node.props?.children)) node.props.children.forEach(walk);
  })(tree);
  return out;
}

// The tree as the lines a terminal shows, trailing spaces trimmed: Text and Button as their words, a row Box side by
// side, a column Box stacked, a `width` padded. Hidden boxes (`display: none`) are left out.
export function screen(tree) {
  const width = (line) => [...line].length;
  function lay(node) {
    if (!node) return [];
    const { type, props } = node;
    if (type === 'Text') return [String(props.children ?? '')];
    if (type === 'Button') return [props.plain ? props.label : `[ ${props.label} ]`];
    if (type === 'Select') return [`${props.label ? `${props.label}: ` : ''}${props.value} ▾`];
    if (props.display === 'none') return [];
    const children = (Array.isArray(props.children) ? props.children : [props.children]).filter(Boolean);
    let lines;
    if (props.flexDirection === 'column') lines = children.flatMap(lay);
    else {
      const blocks = children.map(lay).filter((block) => block.length);
      lines = Array.from({ length: Math.max(1, ...blocks.map((block) => block.length)) }, () => '');
      for (const block of blocks) {
        const w = Math.max(0, ...block.map(width));
        lines = lines.map((line, i) => line + (block[i] ?? '').padEnd(w));
      }
    }
    return props.width ? lines.map((line) => line.padEnd(props.width)) : lines;
  }
  return lay(tree).map((line) => line.trimEnd());
}

export function controls(tree) {
  const nodes = [];
  function walk(node) {
    if (!node) return;
    if (['Button', 'Select'].includes(node.type)) nodes.push(node.props);
    if (Array.isArray(node.props?.children)) node.props.children.forEach(walk);
  }
  walk(tree);
  return nodes;
}

export const substituted = {
  usage: {
    model: 'claude-sonnet-5-5',
    input_tokens: 100,
    cache_read_input_tokens: 800,
    cache_creation_input_tokens: 200,
    output_tokens: 10,
  },
};

const PANE = { title: 'Router', isFocused: true, bodyColumns: 100, placement: 'dock' };
const BAND = { hasSurvey: false, isWorking: false, maxRows: 8, bodyColumns: 120, view: {} };

export const band = async (h, props = {}) => {
  const tree = await h.component('AbovePrompt', { ...BAND, ...props });
  return { tree, line: texts(tree).join(''), controls: controls(tree) };
};

export const CLEF_FLASH_ANSWER = readFileSync(new URL('./fixtures/clef-flash-response.json', import.meta.url), 'utf8');

export const CLOUDFLARE_KEYS = { cloudflare_api_token: 'synthetic-token', cloudflare_account_id: 'acct-1' };

// A classifier answering each request with the next of `answers`, the last one repeating. Returns the request bodies.
export function answering(h, ...answers) {
  const bodies = [];
  h.http(async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    const answer = answers[Math.min(bodies.length, answers.length) - 1];
    return { ok: true, status: 200, text: JSON.stringify(answer), headers: {} };
  });
  return bodies;
}

export const JEV_KEY = { typesafe_api_key: 'synthetic-key' };
