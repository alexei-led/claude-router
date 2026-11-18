import { expect, mock, test } from 'claude-code/testing';
import { jevResponse, user } from './helpers.mjs';

type Engine = Parameters<Parameters<typeof test>[1]>;

// An Opus session whose classifier answers medium: the models each step sent, the toasts, the loop's holds, and one
// whole turn.
function session($: Engine[0], on: Engine[1]) {
  mock.store(on);
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
  on('fs.exists', () => ({ value: false }));
  on('command.register', () => ({ value: { command: 'router' } }));
  on('session.id', () => ({ value: 'native-failover' }));
  on('session.model', () => ({ value: 'claude-opus-5-5' }));
  on('session.cwd', () => ({ value: '/fixture/project' }));
  on('session.version', () => ({ value: { version: '2.1.321' } }));
  on('session.messages', () => ({ value: [user('Synthetic task.')] }));
  on('session.usage', () => ({
    value: { context: { tokens: 8000, breakdown: { totalTokens: 8000 } }, rateLimits: [] },
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
  return { sent, toasts, held, request };
}

// The engine raises classic.StopFailure for a main turn that ended on an API error: an overloaded model is held out, so
// the next turn runs another; a billing error holds nothing.
test('a turn that ends on an overloaded model routes the next turn to another model', async ($, on) => {
  const { sent, toasts, held, request } = session($, on);
  await $.session.start({ cwd: '/fixture/project', surface: null, isInteractive: false });
  await request('t1');
  expect(sent.at(-1)).toBe('claude-opus-5-5');
  await $.classic.StopFailure({ error: 'billing_error' });
  expect(held()).toBeUndefined();
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
