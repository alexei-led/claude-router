import { expect, mock, test } from 'claude-code/testing';
import { jevResponse, user } from './helpers.mjs';

type Engine = Parameters<Parameters<typeof test>[1]>;

// An Opus session whose classifier answers medium: the models each step sent, the toasts, the loop's holds, and one
// whole turn.
// A model in `failing` gets no reply, as a failed request resolves in a step.
function session(
  $: Engine[0],
  on: Engine[1],
  rateLimits: object[] = [],
  file?: object,
  failing: ReadonlySet<string> = new Set(),
) {
  const store = new Map<string, unknown>();
  on('store.get', (_$, e) => ({ value: store.get(e.key) }));
  on('store.set', (_$, e) => {
    store.set(e.key, e.value);
    return { value: undefined };
  });
  on('store.delete', (_$, e) => {
    store.delete(e.key);
    return { value: undefined };
  });
  on('store.keys', () => ({ value: [...store.keys()] }));
  const state = new Map<string, { value: unknown; version: number }>();
  on('state.get', (_$, e) => ({ value: state.get(`${e.key}:${e.id ?? ''}`) ?? { value: undefined, version: 0 } }));
  on('state.set', (_$, e) => {
    const key = `${e.key}:${e.id ?? ''}`;
    const previous = state.get(key)?.version ?? 0;
    if (e.ifVersion !== undefined && e.ifVersion !== previous) return { value: { isSet: false, version: previous } };
    state.set(key, { value: e.value, version: previous + 1 });
    return { value: { isSet: true, version: previous + 1 } };
  });
  mock.env(on, { HOME: '/fixture', CLAUDE_CONFIG_DIR: '/fixture/team', TYPESAFE_API_KEY: 'synthetic-key' });
  on('fs.exists', (_$, e) => ({ value: file !== undefined && e.path === '/fixture/team/router.json' }));
  on('fs.read', () => ({ value: JSON.stringify(file) }));
  on('command.register', () => ({ value: { command: 'router' } }));
  on('session.id', () => ({ value: 'native-failover' }));
  on('session.model', () => ({ value: 'claude-opus-5-5' }));
  on('session.cwd', () => ({ value: '/fixture/project' }));
  on('session.version', () => ({ value: { version: '2.1.321' } }));
  on('session.messages', () => ({ value: [user('Synthetic task.')] }));
  on('session.usage', () => ({
    value: { context: { tokens: 8000, breakdown: { totalTokens: 8000 } }, rateLimits },
  }));
  on('settings.read', () => ({ value: {} }));
  on('ui.log', () => ({ value: undefined }));
  const toasts: string[] = [];
  on('ui.toast', (_$, e) => {
    toasts.push(e.text);
    return { value: undefined };
  });
  on('http.fetch', () => ({
    value: {
      ok: true,
      status: 200,
      headers: {},
      text: JSON.stringify(jevResponse('medium', { medium: 0.97, high: 0.03 })),
    },
  }));
  on('session.start', (_$, e) => ({ cwd: e.cwd }));
  on('turn.start', (_$, e) => ({ turnId: e.turnId }));
  on('turn.complete', () => ({ text: '' }));
  on('classic.StopFailure', () => ({}));
  const sent: string[] = [];
  on('turn.step', async function* (_$, e) {
    sent.push(e.model);
    yield* [];
    if (failing.has(e.model))
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: null, usage: null };
    return {
      turnId: e.turnId,
      index: e.index,
      answer: 'ok',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage: {
        model: e.model,
        input_tokens: 100,
        cache_read_input_tokens: 800,
        cache_creation_input_tokens: 200,
        output_tokens: 10,
      },
    };
  });
  const request = async (turnId: string) => {
    await $.turn.start({ turnId, text: 'Synthetic task.' });
    const stream = $.turn.step({ turnId, index: 0, model: 'claude-opus-5-5', effort: 'medium', messageCount: 1 });
    let result = await stream.next();
    while (!result.done) result = await stream.next();
    await $.turn.complete({ turnId, answer: 'ok', durationMs: 1, isAborted: false, reason: 'answer' });
  };
  const held = () => (state.get('loops:main')?.value as { held?: object } | undefined)?.held;
  return { sent, toasts, held, request, store };
}

// The engine raises classic.StopFailure for a main turn that ended on an API error: an overloaded model is held out, so
// the next turn runs another; a billing error holds the account, not a model, until it is released.
test('a turn that ends on an overloaded model routes the next turn to another model', async ($, on) => {
  const { sent, toasts, held, request, store } = session($, on);
  await $.session.start({ cwd: '/fixture/project', surface: null, isInteractive: false });
  await request('t1');
  expect(sent.at(-1)).toBe('claude-opus-5-5');
  await $.classic.StopFailure({ error: 'billing_error' });
  expect(held()).toBeUndefined();
  expect((store.get('holds/plan') as { kind: string } | undefined)?.kind).toBe('balance');
  store.delete('holds/plan');
  await $.classic.StopFailure({ error: 'overloaded' });
  expect(Object.keys(held() ?? {})).toEqual(['claude-opus-5-5']);
  expect(toasts.at(-1)).toBe('Opus 5.5 held out of routing: overloaded, 5 min');
  await request('t2');
  expect(sent.at(-1)).toBe('claude-haiku-5-5');
});

test('the hold is on the model the failed request ran, not on the session’s model', async ($, on) => {
  const { sent, held, request } = session($, on);
  await $.session.start({ cwd: '/fixture/project', surface: null, isInteractive: false });
  await $.command.run({ command: 'router', args: 'pin low' });
  await request('t1');
  expect(sent.at(-1)).toBe('claude-haiku-5-5');
  await $.classic.StopFailure({ error: 'overloaded' });
  expect(Object.keys(held() ?? {})).toEqual(['claude-haiku-5-5']);
});

test('a used-up 5h plan window holds the plan account in the engine’s store, not a model in the loop', async ($, on) => {
  const resetsAt = new Date(Date.now() + 3 * 60 * 60_000).toISOString();
  const { held, toasts, request, store } = session($, on, [{ kind: 'five_hour', percentUsed: 100, resetsAt }]);
  await $.session.start({ cwd: '/fixture/project', surface: null, isInteractive: false });
  await request('t1');
  await $.classic.StopFailure({ error: 'rate_limit' });
  const stored = store.get('holds/plan') as { kind: string; until: number } | undefined;
  expect(stored?.kind).toBe('window');
  expect(stored?.until).toBe(Date.parse(resetsAt) + 60_000);
  expect(held()).toBeUndefined();
  expect(toasts.at(-1)).toMatch(/^Claude plan held out of routing: usage limit, /);
});

// A spend cap reaches the plugin only as the synthetic error message: Claude Code gives no error_details for it.
test('a spend cap named only in the last assistant message holds the account until its calendar reset', async ($, on) => {
  const { held, request, store } = session($, on, [], { models: { opus: { account: 'work-claude' } } });
  await $.session.start({ cwd: '/fixture/project', surface: null, isInteractive: false });
  await request('t1');
  await $.classic.StopFailure({
    error: 'rate_limit',
    last_assistant_message:
      "You've hit your individual spend limit · run /usage-credits to ask your admin for a higher limit",
  });
  expect((store.get('holds/work-claude') as { kind: string } | undefined)?.kind).toBe('calendar');
  expect(held()).toBeUndefined();
});

test('a held account whose probe is due runs again, and its answer ends the hold', async ($, on) => {
  const { sent, toasts, request, store } = session($, on);
  const now = Date.now();
  store.set('holds/plan', {
    kind: 'calendar',
    error: 'rate_limit',
    since: now - 2 * 60 * 60_000,
    until: now + 60 * 60_000,
    streak: 1,
    probeAt: now - 60 * 60_000,
  });
  await $.session.start({ cwd: '/fixture/project', surface: null, isInteractive: false });
  await request('t1');
  expect(sent.at(-1)).toBe('claude-opus-5-5');
  expect(store.has('holds/plan')).toBe(false);
  expect(toasts).toContain('Claude plan answered again: routing may use it');
});

test('a due probe that gets no reply is answered by another model in the same step', async ($, on) => {
  const glm = {
    id: 'zai-org/GLM-5.3',
    input: 1,
    output: 2,
    cacheRead: 0.1,
    contextWindow: 1_000_000,
    billing: 'credits',
    efforts: ['high', 'max'],
  };
  const file = { models: { glm }, fallbacks: { opus: ['glm@max'] } };
  const { sent, toasts, request, store } = session($, on, [], file, new Set(['claude-opus-5-5']));
  const now = Date.now();
  store.set('holds/plan', {
    kind: 'calendar',
    error: 'rate_limit',
    since: now - 2 * 60 * 60_000,
    until: now + 24 * 60 * 60_000,
    streak: 1,
    probeAt: now - 60 * 60_000,
  });
  await $.session.start({ cwd: '/fixture/project', surface: null, isInteractive: false });
  await request('t1');
  expect(sent).toEqual(['claude-opus-5-5', glm.id]);
  expect((store.get('holds/plan') as { streak: number } | undefined)?.streak).toBe(2);
  expect(toasts).toContain('Opus 5.5 still limited → Zai Org/GLM 5.3');
});

test('a model with no failure history is not sent again in the step', async ($, on) => {
  const { sent, request } = session($, on, [], undefined, new Set(['claude-opus-5-5']));
  await $.session.start({ cwd: '/fixture/project', surface: null, isInteractive: false });
  await request('t1');
  expect(sent).toEqual(['claude-opus-5-5']);
});
