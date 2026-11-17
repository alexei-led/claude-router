import { expect, mock, test } from 'claude-code/testing';
import { jevResponse, user } from './helpers.mjs';

test('auto opt-in rewrites real Mod requests, refits pins and preserves native no-route fallback', async ($, on) => {
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
  const config = {
    routingEngine: 'auto',
    mode: 'quality',
    models: {
      haiku: { capability: { low: 0, medium: 1, high: 1.5, xhigh: 2, max: 2 } },
      opus: { capability: { low: 2, medium: 2.5, high: 2.5, xhigh: 3, max: 3 } },
    },
    routes: { high: { model: 'haiku', effort: 'low' } },
    policy: { reviewEveryRequests: 0 },
  };
  on('fs.exists', (_$, e) => ({ value: e.path === '/fixture/team/router.json' }));
  on('fs.stat', () => ({ value: { kind: 'file', size: 0, mtimeMs: 0, isLink: false } }));
  on('fs.read', () => ({ value: JSON.stringify(config) }));
  on('command.register', () => ({ value: { command: 'router' } }));
  on('session.id', () => ({ value: 'native-auto' }));
  on('session.model', () => ({ value: 'claude-haiku-5-5' }));
  on('session.cwd', () => ({ value: '/fixture/project' }));
  on('session.version', () => ({ value: { version: '2.1.325' } }));
  on('session.messages', () => ({ value: [user('Synthetic task.')] }));
  on('session.usage', () => ({
    value: { context: { tokens: 8000, breakdown: { totalTokens: 8000 } }, rateLimits: [] },
  }));
  let availableModels = ['haiku', 'opus'];
  on('settings.read', () => ({ value: { availableModels } }));
  on('ui.log', () => ({ value: undefined }));
  on('ui.toast', () => ({ value: undefined }));
  on('http.fetch', () => ({
    value: { ok: true, status: 200, headers: {}, text: JSON.stringify(jevResponse('high', { high: 1 })) },
  }));
  on('session.start', (_$, e) => ({ cwd: e.cwd }));
  on('turn.start', (_$, e) => ({ turnId: e.turnId }));
  on('turn.complete', () => ({ text: '' }));
  const sent: { model: string; effort: unknown }[] = [];
  on('turn.step', async function* (_$, e) {
    sent.push({ model: e.model, effort: e.effort });
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
  const request = async (turnId: string, index = 0) => {
    const stream = $.turn.step({ turnId, index, model: 'claude-haiku-5-5', effort: 'medium', messageCount: 1 });
    let result = await stream.next();
    while (!result.done) result = await stream.next();
  };
  await $.session.start({ cwd: '/fixture/project', surface: null, isInteractive: false });
  const view = state.get('view:')?.value as { phase: string; error: string | null };
  expect(view?.phase).toBe('ready');
  expect(view?.error).toBe(null);
  await $.command.run({ command: 'router', args: 'pin high' });
  await $.turn.start({ turnId: 'normal', text: 'Synthetic task.' });
  await request('normal');
  expect(sent.at(-1)).toEqual({ model: 'claude-opus-5-5', effort: 'xhigh' });
  await $.turn.complete({ turnId: 'normal', answer: 'ok', durationMs: 1, isAborted: false, reason: 'answer' });
  await $.command.run({ command: 'router', args: 'pin micro' });
  await $.turn.start({ turnId: 'pinned', text: 'Synthetic task.' });
  await request('pinned');
  expect(sent.at(-1)).toEqual({ model: 'claude-haiku-5-5', effort: 'medium' });
  availableModels = ['opus'];
  await request('pinned', 1);
  expect(sent.at(-1)).toEqual({ model: 'claude-opus-5-5', effort: 'low' });
  availableModels = [];
  await request('pinned', 2);
  expect(sent.at(-1)).toEqual({ model: 'claude-haiku-5-5', effort: 'medium' });
  const loop = state.get('loops:main')?.value as { decision: { reason: string } };
  expect(loop?.decision?.reason).toBe('no-route-native');
  availableModels = ['opus'];
  await request('pinned', 3);
  expect(sent.at(-1)).toEqual({ model: 'claude-haiku-5-5', effort: 'medium' });
  await $.turn.complete({ turnId: 'pinned', answer: 'ok', durationMs: 1, isAborted: false, reason: 'answer' });
  await $.turn.start({ turnId: 'reentry', text: 'Synthetic task.' });
  await request('reentry');
  expect(sent.at(-1)).toEqual({ model: 'claude-opus-5-5', effort: 'low' });
  const reentered = state.get('loops:main')?.value as { decision: { reason: string } };
  expect(reentered.decision.reason).toBe('reentry');
});
