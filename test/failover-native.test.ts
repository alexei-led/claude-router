import { expect, mock, test } from 'claude-code/testing';
import { jevResponse, user } from './helpers.mjs';

type Engine = Parameters<Parameters<typeof test>[1]>;

// One whole step of a subagent's request.
async function agentStep($: Engine[0], model = 'claude-haiku-5-5') {
  const stream = $.turn.step({ turnId: 'a1-t', agentId: 'a1', index: 0, model, effort: 'medium', messageCount: 1 });
  let result = await stream.next();
  while (!result.done) result = await stream.next();
}

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
  on('session.version', () => ({ value: { version: '2.1.332' } }));
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
  // The prompts the router queues. `submission` is what the engine answers each with: it resolves when its turn starts.
  const prompts: string[] = [];
  const submission = { answer: async () => {} };
  on('prompt.submit', async (_$, e) => {
    prompts.push(e.text);
    await submission.answer();
    return { text: e.text, origin: e.origin };
  });
  const run = async (turnId: string) => {
    await $.turn.start({ turnId, text: 'Synthetic task.' });
    const stream = $.turn.step({ turnId, index: 0, model: 'claude-opus-5-5', effort: 'medium', messageCount: 1 });
    let result = await stream.next();
    while (!result.done) result = await stream.next();
  };
  const request = async (turnId: string) => {
    await run(turnId);
    await $.turn.complete({ turnId, answer: 'ok', durationMs: 1, isAborted: false, reason: 'answer' });
  };
  // One turn that an API error ends, in the engine's order: StopFailure, then turn.complete.
  const fail = async (turnId: string, error: 'overloaded' | 'billing_error' | 'invalid_request', text?: string) => {
    await run(turnId);
    await $.classic.StopFailure({ error, ...(text === undefined ? {} : { last_assistant_message: text }) });
    await $.turn.complete({ turnId, answer: '', durationMs: 1, isAborted: false, reason: 'error' });
  };
  const held = () => (state.get('loops:main')?.value as { held?: object } | undefined)?.held;
  return { sent, toasts, held, request, store, prompts, submission, run, fail };
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

const SPEND_TEXT = "You've hit your individual spend limit · run /usage-credits to ask your admin for a higher limit";
const rerunText = (model: string, cause: string) =>
  `The last request failed on ${model} (${cause}), so the router held it out of routing. Continue the task from where it stopped.`;
const WORK_OPUS = { models: { opus: { account: 'work-claude' } } };
const START = { cwd: '/fixture/project', surface: null, isInteractive: false };

test('a turn that a spend cap ends is run again, once, on another model', async ($, on) => {
  const { sent, toasts, prompts, request, fail } = session($, on, [], WORK_OPUS);
  await $.session.start(START);
  await fail('t1', 'billing_error', SPEND_TEXT);
  expect(prompts).toEqual([rerunText('Opus 5.5', 'spend limit')]);
  expect(toasts).toContain('Retrying on another model: spend limit');
  await request('t2');
  expect(sent.at(-1) === 'claude-opus-5-5').toBe(false);
  expect(prompts.length).toBe(1);
});

test('an error that holds nothing is not run again', async ($, on) => {
  const { prompts, fail } = session($, on);
  await $.session.start(START);
  await fail('t1', 'invalid_request', "API Error: Opus 5.5's safeguards flagged this message");
  expect(prompts).toEqual([]);
});

test('the third turn in a row that fails is not run again, and the router says it stopped', async ($, on) => {
  const { toasts, prompts, fail } = session($, on);
  await $.session.start(START);
  await fail('t1', 'overloaded');
  await fail('t2', 'overloaded');
  expect(prompts.length).toBe(2);
  await fail('t3', 'overloaded');
  expect(prompts.length).toBe(2);
  expect(toasts.at(-1)).toBe('Stopped retrying after 2 re-runs in a row: overloaded');
});

test('a turn that ends any other way starts the count of re-runs over', async ($, on) => {
  const { prompts, request, fail } = session($, on);
  await $.session.start(START);
  await fail('t1', 'overloaded');
  await fail('t2', 'overloaded');
  await request('t3');
  await fail('t4', 'overloaded');
  expect(prompts.length).toBe(3);
});

test('nothing is run again when every configured model is held', async ($, on) => {
  const { prompts, fail } = session($, on);
  await $.session.start(START);
  await fail('t1', 'billing_error', SPEND_TEXT);
  expect(prompts).toEqual([]);
});

test('nothing is run again with routing off', async ($, on) => {
  const { prompts, fail } = session($, on);
  await $.session.start(START);
  await $.command.run({ command: 'router', args: 'off' });
  await fail('t1', 'overloaded');
  expect(prompts).toEqual([]);
});

test('an aborted turn and a subagent’s failure are not run again', async ($, on) => {
  const { held, prompts, run } = session($, on);
  await $.session.start(START);
  await run('t1');
  await $.classic.StopFailure({ error: 'overloaded' });
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 1, isAborted: true, reason: 'aborted' });
  await run('t2');
  await agentStep($);
  await $.classic.StopFailure({ error: 'overloaded', agent_id: 'a1' });
  expect(Object.keys(held() ?? {})).toEqual(['claude-opus-5-5', 'claude-haiku-5-5']);
  await $.turn.complete({
    turnId: 'a1-t',
    agentId: 'a1',
    answer: '',
    durationMs: 1,
    isAborted: false,
    reason: 'error',
  });
  await $.turn.complete({ turnId: 't2', answer: '', durationMs: 1, isAborted: false, reason: 'error' });
  expect(prompts).toEqual([]);
});

// The submission resolves only when its turn starts, which cannot happen while this turn.complete runs.
test('the turn completes without waiting for the re-run to start', async ($, on) => {
  const { prompts, submission, fail } = session($, on);
  await $.session.start(START);
  submission.answer = () => new Promise<void>(() => {});
  await fail('t1', 'overloaded');
  expect(prompts.length).toBe(1);
});

test('a re-run the engine refuses leaves the turn as it ended', async ($, on) => {
  const { prompts, submission, fail } = session($, on);
  await $.session.start(START);
  submission.answer = async () => {
    throw new Error('refused');
  };
  await fail('t1', 'overloaded');
  expect(prompts.length).toBe(1);
});

test('a subagent that answers does not start the count of re-runs over', async ($, on) => {
  const { prompts, fail } = session($, on);
  await $.session.start(START);
  await fail('t1', 'overloaded');
  await fail('t2', 'overloaded');
  await $.turn.complete({
    turnId: 'a1-t',
    agentId: 'a1',
    answer: 'ok',
    durationMs: 1,
    isAborted: false,
    reason: 'answer',
  });
  await fail('t3', 'overloaded');
  expect(prompts.length).toBe(2);
});

test('a failure is run again only when its own turn completes', async ($, on) => {
  const { prompts, run } = session($, on);
  await $.session.start(START);
  await run('t1');
  await $.classic.StopFailure({ error: 'overloaded' });
  await $.turn.complete({ turnId: 'other', answer: '', durationMs: 1, isAborted: false, reason: 'error' });
  expect(prompts).toEqual([]);
});

test('a new session forgets the last one’s failed turn and its count of re-runs', async ($, on) => {
  const { prompts, run, fail } = session($, on);
  await $.session.start(START);
  await run('t1');
  await $.classic.StopFailure({ error: 'overloaded' });
  await $.session.start(START);
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 1, isAborted: false, reason: 'error' });
  expect(prompts).toEqual([]);
  await fail('t2', 'overloaded');
  await fail('t3', 'overloaded');
  await $.session.start(START);
  await fail('t4', 'overloaded');
  expect(prompts.length).toBe(3);
});
