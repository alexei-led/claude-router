import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from '../hooks/native-router.mjs';
import { MIN_CLAUDE_CODE } from '../lib/config.mjs';
import { readTrace, TRACE_PREFIX } from '../lib/replay-trace.mjs';
import { jevResponse } from './helpers.mjs';

// The engine refuses a prop it cannot read, and the whole pane with it, so the stubs refuse the same cheap cases: a
// spacing that is neither a finite number nor a named step, a size that is not a finite number, a missing required
// prop. The step names are the ones the router draws with; add a name here once an engine accepts it.
export const SPACING_STEPS = ['xs', 'sm', 'md', 'lg'];
const SPACING = /^(gap|rowGap|columnGap|padding[A-Za-z]*|margin[A-Za-z]*)$/;
const SIZE = /^(width|height|flexGrow|flexShrink)$/;
const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const isPercent = (value) => typeof value === 'string' && /^\d+(\.\d+)?%$/.test(value);
const REQUIRED = { Select: { value: 'string', options: 'array', onSelect: 'function' } };
// The documented Box border names: the engine draws no border for any other, and says nothing.
export const BORDER_STYLES = [
  'single',
  'double',
  'round',
  'bold',
  'singleDouble',
  'doubleSingle',
  'classic',
  'arrow',
  'dashed',
  'quote',
];

export function validateProps(type, props) {
  assert.ok(props && typeof props === 'object', `${type} takes a props object`);
  for (const [name, value] of Object.entries(props)) {
    if (value === undefined) continue;
    if (SPACING.test(name))
      assert.ok(
        isFiniteNumber(value) || SPACING_STEPS.includes(value),
        `${type} ${name}: ${JSON.stringify(value)} is neither a number nor one of ${SPACING_STEPS.join(', ')}`,
      );
    if (SIZE.test(name))
      assert.ok(
        isFiniteNumber(value) || (name === 'width' && isPercent(value)),
        `${type} ${name}: ${JSON.stringify(value)} is not a finite number`,
      );
    if (name === 'borderStyle')
      assert.ok(BORDER_STYLES.includes(value), `${type} borderStyle: ${JSON.stringify(value)} draws no border`);
  }
  if (type === 'Button') {
    assert.ok(typeof props.label === 'string' || props.children !== undefined, 'Button needs a label or children');
    // The engine types `plain` as `true`: a Button that is not plain leaves it out.
    assert.ok(props.plain === undefined || props.plain === true, `Button ${props.key}: plain is true or absent`);
  }
  for (const [name, kind] of Object.entries(REQUIRED[type] ?? {})) {
    const value = props[name];
    const ok = kind === 'array' ? Array.isArray(value) : typeof value === kind;
    assert.ok(ok, `${type} needs ${name} as a ${kind}, got ${JSON.stringify(value)}`);
  }
}

const element = (type) => (props) => {
  validateProps(type, props);
  return { type, props };
};
export const ELEMENTS = {
  Box: element('Box'),
  Text: element('Text'),
  Button: element('Button'),
  Select: element('Select'),
  Svg: element('Svg'),
  Code: element('Code'),
  Progress: element('Progress'),
  Input: element('Input'),
  Link: element('Link'),
};

export function harness(options = {}, preferences = new Map(), state = new Map()) {
  const hooks = [];
  const env = new Map([
    ['HOME', '/fixture'],
    ['CLAUDE_CONFIG_DIR', '/fixture/team'],
  ]);
  const requests = [];
  // The models of the request streams closed before they were read to their end.
  const abandoned = [];
  const files = new Map();
  const links = new Set();
  let model = 'claude-haiku-5-5';
  let usage = { startedAt: 0, context: { tokens: 8000, breakdown: { totalTokens: 9000 } }, rateLimits: [] };
  let draft = '';
  let commandCalls = 0;
  let surfaces = ['terminal'];
  let opened = {};
  const copied = [];
  const toasts = [];
  // The prompts the router submits with `$.prompt.submit`, in order.
  const submitted = [];
  const views = [];
  const places = [];
  let placeResult = { isPlaced: true, requestId: 'placed-1' };
  let agents = [];
  let viewResult = {};
  let version = MIN_CLAUDE_CODE;
  let settings = {};
  let sessionId = 's1';
  let snapshot = new Map();
  let messages = async () => [{ role: 'user', content: [{ type: 'text', text: 'One edit.' }] }];
  let http = async () => {
    throw new Error('unexpected HTTP');
  };
  const keyOf = (ref) => `${ref.key}:${ref.id ?? ''}`;
  // What `$.clock.after` callbacks left running: an event resolves once they settle, as in the engine's test kit.
  const timers = [];
  const settleTimers = async () => {
    while (timers.length) await Promise.allSettled(timers.splice(0));
  };
  // Where `$.clock.after` callbacks wait, unrun, after `holdTimers`.
  let heldTimers = null;
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
      stat: async (path) => {
        const isLink = links.has(path);
        if (files.has(path)) return { kind: 'file', realPath: path, isLink };
        if (
          ['/fixture/project', env.get('HOME'), env.get('CLAUDE_CONFIG_DIR') ?? `${env.get('HOME')}/.claude`].includes(
            path,
          ) ||
          [...files.keys()].some((file) => file.startsWith(`${path}/`))
        )
          return { kind: 'dir', realPath: path, isLink };
        if (isLink) return { kind: 'other', isLink };
        throw new Error('not found');
      },
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
      submit: async (input) => {
        submitted.push(input.text);
        return { text: input.text };
      },
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
      root: async () => '/fixture/project',
      surfaces: async () => surfaces,
      messages: (...args) => messages(...args),
      usage: async () => usage,
    },
    settings: { read: async () => settings },
    clock: {
      after: (_ms, fn) => {
        if (heldTimers) heldTimers.push(fn);
        else timers.push(Promise.resolve(fn()));
        return { cancel: () => {} };
      },
      sleep: (_ms, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
    },
    http: { fetch: (...args) => http(...args) },
    // `agents` as `$.agent.list()` lists them.
    agent: { list: async () => agents },
    ui: {
      // A graphical renderer that falls back to the terminal tree is a failure in a test.
      log: (text) => {
        if (String(text).startsWith('graphical ')) throw new Error(text);
      },
      copy: async (args) => copied.push(args),
      toast: (text) => toasts.push(text),
      place: async (args) => {
        places.push(args);
        return placeResult;
      },
      view: async (view) => {
        views.push(view);
        return viewResult;
      },
      open: async () => opened,
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
    abandoned,
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
    submitted,
    // The calls of `$.ui.place`, in order; `placeAnswer` is what it resolves to next (`{ isPlaced: false, reason }` where
    // no surface is attached).
    places,
    placeAnswer: (value) => {
      placeResult = value;
    },
    // The calls of `$.ui.view`, in order; `viewAnswer` is what it resolves to next (`{}` or `{ deny }`).
    views,
    viewAnswer: (value) => {
      viewResult = value;
    },
    // What `$.agent.list()` returns: `{ id, type, description, status }` each.
    agents: (value) => {
      agents = value;
    },
    // What `$.ui.open` resolves: `{ isPlaced: true }`, or `{ isPlaced: false, reason }` where the pane waits undrawn.
    opens: (value) => {
      opened = value;
    },
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
      const result = await handler(name, input)($, input, next);
      await settleTimers();
      return result;
    },
    // What `$.clock.after` callbacks left running, settled: a press returns before them, as in the engine.
    settle: settleTimers,
    // From now on `$.clock.after` callbacks run only when the test calls them from the returned list.
    holdTimers: () => {
      heldTimers = [];
      return heldTimers;
    },
    render: async (props = PANE, surface = undefined) => {
      snapshot = new Map();
      return handler('ui.render', { component: 'Pane' })(
        $,
        { component: 'Pane', requestId: 'jev-router', props, surface },
        async () => null,
      );
    },
    component: async (component, props = {}, { next = async (input) => input, surface, viewport } = {}) => {
      snapshot = new Map();
      const event = {
        component,
        requestId: component,
        props,
        ...(surface ? { surface } : {}),
        ...(viewport ? { viewport } : {}),
      };
      return handler('ui.render', { component })($, event, next);
    },
    // A prompt.autocomplete dispatch: `engine` is what core's typeahead already holds. Returns the rows after the hook.
    autocomplete: async (input, engine = []) => {
      snapshot = new Map();
      const core = async () => ({ suggestions: engine });
      return (await handler('prompt.autocomplete', input)($, input, core)).suggestions;
    },
    // `response` overrides the reply's fields; a function gets each request, for one that answers some of them. Its
    // `chunks` replace the items the request streams.
    step: (input, response = {}, signal = new AbortController().signal) => {
      snapshot = new Map();
      const send = async function* (request) {
        requests.push(request);
        const { chunks, ...fields } = (typeof response === 'function' ? response(request) : response) ?? {};
        const reply = {
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
          ...fields,
        };
        // A request that failed streams only the engine's own items, as Claude Code's does (an API error, no answer).
        let read = false;
        try {
          if (chunks) yield* chunks;
          else if (reply.stopReason === null && reply.usage === null) yield { kind: 'engine', ref: requests.length };
          else yield { kind: 'text', text: 'ok', index: 0 };
          read = true;
          return reply;
        } finally {
          if (!read) abandoned.push(request.model);
        }
      };
      send.signal = signal;
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
    // A prompt.submit dispatch: `during(e)` runs inside core's next, where an idle submission starts its turn, and
    // `answer` is what core returns (default: the prompt entered). Returns the hook's answer.
    submit: async (input, during = null, answer = null) => {
      snapshot = new Map();
      const core = async (e) => {
        if (during) await during(e);
        return answer ?? { text: e.text, origin: e.origin };
      };
      core.signal = new AbortController().signal;
      return handler('prompt.submit', input)($, input, core);
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
export const projectRecord = (h) => [...h.preferences].find(([key]) => key.startsWith('project-routing:v1:'));
export const projectPatch = (h) => projectRecord(h)?.[1].patch;

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

// A bordered Box's corners; any other border is drawn as single.
const CORNERS = { single: '┌┐└┘', round: '╭╮╰╯' };
// `lines` inside a border, `padding` cells from it on each side, as wide as the widest line.
function bordered(lines, style, padding) {
  const [tl, tr, bl, br] = CORNERS[style] ?? CORNERS.single;
  const w = Math.max(0, ...lines.map((line) => [...line].length)) + 2 * padding;
  const space = ' '.repeat(padding);
  return [
    `${tl}${'─'.repeat(w)}${tr}`,
    ...lines.map((line) => `│${space}${line.padEnd(w - 2 * padding)}${space}│`),
    `${bl}${'─'.repeat(w)}${br}`,
  ];
}

// The tree as the lines a terminal shows, trailing spaces trimmed: Text and Button as their words, a row Box side by
// side, a column Box stacked, a `width` padded, a `borderStyle` drawn around its padding (at its content's width, where
// the terminal stretches it to the pane's). Hidden boxes (`display: none`) are left out.
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
    if (props.borderStyle) {
      const padding = props.paddingX ?? props.padding;
      lines = bordered(lines, props.borderStyle, isFiniteNumber(padding) ? padding : 0);
    }
    return props.width ? lines.map((line) => line.padEnd(props.width)) : lines;
  }
  return lay(tree).map((line) => line.trimEnd());
}

// Screen lines with the boxes taken away: a top border goes, a bottom border becomes the blank line an unboxed section
// ends with, and a side bar and its padding go from each line inside.
export const unboxed = (lines) =>
  lines.flatMap((line) => {
    if (/^[┌╭]─*[┐╮]$/.test(line)) return [];
    if (/^[└╰]─*[┘╯]$/.test(line)) return [''];
    const inside = /^│ (.*) │$/.exec(line);
    return [inside ? (inside[1] ?? '').trimEnd() : line];
  });

// The element tree as plain JSON for golden files: function props (handlers) dropped, every other prop kept, children
// serialized in place. Two trees that draw and answer alike serialize alike; a changed key, label, variant, hotkey or
// style shows as a diff.
export function serialize(tree) {
  if (Array.isArray(tree)) return tree.map(serialize);
  if (tree === null || typeof tree !== 'object') return tree;
  const entries = Object.entries(tree).filter(([, value]) => typeof value !== 'function' && value !== undefined);
  const isElement = typeof tree.type === 'string' && tree.props && typeof tree.props === 'object';
  if (!isElement) return Object.fromEntries(entries.map(([key, value]) => [key, serialize(value)]));
  return { type: tree.type, props: serialize(tree.props) };
}

// The tree as indented lines for golden files, far smaller than its JSON: `Type key=value ...` with props sorted by
// name and function props dropped, a string child as its own JSON-quoted line, `children` never a prop.
export function goldenText(tree) {
  const lines = [];
  const value = (v) => JSON.stringify(v);
  (function walk(node, depth) {
    const pad = '  '.repeat(depth);
    if (node === null || node === undefined || node === false) return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child, depth);
      return;
    }
    if (typeof node !== 'object') return void lines.push(`${pad}${JSON.stringify(node)}`);
    const { children, ...props } = node.props;
    const shown = Object.entries(serialize(props))
      .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
      .map(([key, v]) => `${key}=${value(v)}`);
    lines.push([`${pad}${node.type}`, ...shown].join(' '));
    walk(children, depth + 1);
  })(tree, 0);
  return `${lines.join('\n')}\n`;
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

// A shadow-engine router with a key, no periodic review and a classifier that always answers `answer`.
export function shadowHarness(
  config = {},
  preferences = new Map(),
  answer = jevResponse('low', { low: 1 }, 0, { code: 1 }, 'produce'),
) {
  const h = harness(JEV_KEY, preferences);
  h.files.set(CONFIG, JSON.stringify({ routingEngine: 'shadow', policy: { reviewEveryRequests: 0 }, ...config }));
  answering(h, answer);
  return h;
}

// A session's stored replay trace as readers see it, its events unpacked.
export const traceOf = (h, id = 's1') => readTrace(h.preferences.get(`${TRACE_PREFIX}${id}`)) ?? undefined;

// An element's children as a list, nulls dropped.
export const kids = (node) =>
  (Array.isArray(node?.props?.children) ? node.props.children : [node?.props?.children]).filter(Boolean);

// Every element in the tree that `match` accepts, in document order.
export function find(tree, match) {
  const out = [];
  (function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (node.props && match(node)) out.push(node);
    for (const child of kids(node)) walk(child);
  })(tree);
  return out;
}

// The first element with this key.
export const byKey = (tree, key) => find(tree, (n) => n.props.key === key)[0];

// The keys and the hotkeys the tree holds more than once: a Button with no key is addressed by its label. One owner
// per key and per hotkey, so a press or a key always reaches the control it names.
export function duplicates(tree) {
  const keys = new Map();
  const hotkeys = new Map();
  const count = (map, name) => map.set(name, (map.get(name) ?? 0) + 1);
  for (const node of find(tree, () => true)) {
    const key = node.props.key ?? (node.type === 'Button' ? node.props.label : undefined);
    if (key !== undefined) count(keys, `${node.type === 'Box' ? 'Box ' : ''}${key}`);
    if (node.props.hotkey !== undefined) count(hotkeys, node.props.hotkey);
  }
  const many = (map) => [...map].filter(([, n]) => n > 1).map(([name]) => name);
  return { keys: many(keys), hotkeys: many(hotkeys) };
}

// The tree, after failing on any key or hotkey it holds twice: a graphical test's draw passes every tree through it.
export function unique(tree) {
  assert.deepEqual(duplicates(tree), { keys: [], hotkeys: [] });
  return tree;
}

// Every action a pane or band may call, doing nothing.
export const quiet = new Proxy({}, { get: () => () => {} });

// Actions that record each call as [name, ...args].
export function recorder() {
  const calls = [];
  const actions = new Proxy(
    {},
    {
      get:
        (_target, name) =>
        (...args) =>
          calls.push([name, ...args]),
    },
  );
  return { actions, calls };
}

// The element whose children include `target`.
export const parentOf = (tree, target) => find(tree, (node) => kids(node).includes(target))[0];

// The words the tree draws, in document order: a Text's string, a Button as `[ label ]`.
export const textOf = (tree) =>
  find(tree, () => true)
    .map((node) =>
      node.type === 'Text' ? String(node.props.children) : node.type === 'Button' ? `[ ${node.props.label} ]` : '',
    )
    .join('');

// The line's Text hangs when it wraps inside the field's value column, which sits beside the fixed-width label.
export function hangs(tree, words, labelWidth) {
  const [text] = find(tree, (node) => node.type === 'Text' && node.props.children === words);
  if (!text) return 'no such line';
  if (text.props.wrap !== 'wrap') return 'does not wrap';
  const column = parentOf(tree, text);
  const { flexDirection, flexGrow, flexShrink } = column.props;
  if (flexDirection !== 'column' || flexGrow !== 1 || flexShrink !== 1) return 'not in a value column';
  const [label, value] = kids(parentOf(tree, column));
  if (label.props.width !== labelWidth || label.props.flexShrink !== 0) return 'no fixed-width label beside it';
  return value === column ? 'hangs' : 'not beside its label';
}
