import { expect, mock, test } from 'claude-code/testing';
import { jevResponse, user } from './helpers.mjs';

test('first routed quality startup uses native capability and survives reload without regranting privilege', async ($, on) => {
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
  mock.env(on, {
    HOME: '/fixture',
    CLAUDE_CONFIG_DIR: '/fixture/team',
    CLAUDE_ROUTER_PROVIDER: 'deepseek',
    TYPESAFE_API_KEY: 'synthetic-key',
  });
  const config = {
    routingEngine: 'auto',
    mode: 'quality',
    baselineTier: 'low',
    models: { flash: { capability: { low: 1, high: 2, max: 3 } } },
    policy: { reviewEveryRequests: 0 },
  };
  on('fs.exists', (_$, e) => ({ value: e.path === '/fixture/team/deepseek-router.json' }));
  on('fs.stat', () => ({ value: { kind: 'file', size: 0, mtimeMs: 0, isLink: false } }));
  on('fs.read', () => ({ value: JSON.stringify(config) }));
  on('command.register', () => ({ value: { command: 'router' } }));
  on('session.id', () => ({ value: 'native-quality-startup' }));
  on('session.model', () => ({ value: 'deepseek-flash[1m]' }));
  on('session.cwd', () => ({ value: '/fixture/project' }));
  on('session.version', () => ({ value: { version: '2.1.289' } }));
  on('session.messages', () => ({ value: [user('Synthetic task.')] }));
  on('session.usage', () => ({
    value: { context: { tokens: 8000, breakdown: { totalTokens: 8000 } }, rateLimits: [] },
  }));
  on('settings.read', () => ({ value: { availableModels: ['deepseek-flash[1m]'] } }));
  on('ui.log', () => ({ value: undefined }));
  on('ui.toast', () => ({ value: undefined }));
  on('http.fetch', () => ({
    value: { ok: true, status: 200, headers: {}, text: JSON.stringify(jevResponse('low', { low: 1 })) },
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
  const request = async (turnId: string) => {
    await $.turn.start({ turnId, text: 'Synthetic task.' });
    const stream = $.turn.step({ turnId, index: 0, model: 'deepseek-flash[1m]', effort: 'low', messageCount: 1 });
    let result = await stream.next();
    while (!result.done) result = await stream.next();
    await $.turn.complete({ turnId, answer: 'ok', durationMs: 1, isAborted: false, reason: 'answer' });
  };
  const reload = () => $.session.start({ cwd: '/fixture/project', surface: null, isInteractive: false });
  await reload();
  await $.command.run({ command: 'router', args: 'off' });
  await request('manual-prefix');
  expect(sent.at(-1)).toEqual({ model: 'deepseek-flash[1m]', effort: 'low' });
  expect(state.get('loops:main')?.value).toMatchObject({ hasRoutedDecision: false, requests: 1 });
  await $.command.run({ command: 'router', args: 'auto' });
  await request('first-routed');
  expect(sent.at(-1)).toEqual({ model: 'deepseek-flash[1m]', effort: 'high' });
  expect(state.get('loops:main')?.value).toMatchObject({
    hasRoutedDecision: true,
    decision: { reason: 'startup', auto: { requirement: 1.5, move: 'startup' } },
    auto: { state: { demand: 1, routedDemand: 1, routeCause: 'startup' } },
  });
  await $.command.run({ command: 'router', args: 'off' });
  await request('manual-after');
  await $.command.run({ command: 'router', args: 'auto' });
  await reload();
  await request('after-reload');
  expect(sent.at(-1)).toEqual({ model: 'deepseek-flash[1m]', effort: 'low' });
  expect(state.get('loops:main')?.value).toMatchObject({
    hasRoutedDecision: true,
    decision: { reason: 'no-evidence' },
  });
});
