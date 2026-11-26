import { expect, mock, test } from 'claude-code/testing';
import { loadConfig, MIN_CLAUDE_CODE } from '../lib/config.mjs';
import { newTrace, observedFromTrace, readTrace, storedTrace, traceBytes, usableTrace } from '../lib/replay-trace.mjs';
import { emptyLoop } from '../lib/route.mjs';
import { assistant, jevResponse, user } from './helpers.mjs';

for (const hasAssistant of [false, true]) {
  test(`shadow ${hasAssistant ? 'resume' : 'startup'}17 and export run without classic events`, async ($, on) => {
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
    // The trace is written from a timer after the turn: the kit's clock runs it when this answers.
    on('clock.after', () => ({ value: undefined }));
    on('command.register', () => ({ value: { command: 'router' } }));
    mock.env(on, { HOME: '/fixture', CLAUDE_CONFIG_DIR: '/fixture/team', TYPESAFE_API_KEY: 'CANARY_KEY' });
    const files = new Map([['/fixture/team/router.json', JSON.stringify({ routingEngine: 'shadow' })]]);
    on('fs.exists', (_$, e) => ({ value: files.has(e.path) }));
    on('fs.stat', () => ({ value: { kind: 'file', size: 0, mtimeMs: 0, isLink: false } }));
    on('fs.read', (_$, e) => ({ value: files.get(e.path) ?? '' }));
    on('fs.write', (_$, e) => {
      files.set(e.path, e.text);
      return { value: undefined };
    });
    on('session.id', () => ({ value: 'native-trace' }));
    on('session.model', () => ({ value: 'claude-haiku-5-5' }));
    on('session.cwd', () => ({ value: '/fixture/project' }));
    on('session.version', () => ({ value: { version: MIN_CLAUDE_CODE } }));
    const messages = Array.from({ length: 17 }, () => user('CANARY_PROMPT'));
    if (hasAssistant) messages[8] = assistant('CANARY_REPLY');
    on('session.messages', () => ({ value: messages }));
    on('session.usage', () => ({
      value: { startedAt: 0, context: { tokens: 8000, breakdown: { totalTokens: 8000 } }, rateLimits: [] },
    }));
    on('settings.read', () => ({ value: {} }));
    on('ui.log', () => ({ value: undefined }));
    on('ui.toast', () => ({ value: undefined }));
    on('http.fetch', () => ({
      value: { ok: true, status: 200, headers: {}, text: JSON.stringify(jevResponse('low', { low: 1 })) },
    }));
    on('session.start', (_$, e) => ({ cwd: e.cwd }));
    on('turn.start', (_$, e) => ({ turnId: e.turnId }));
    on('turn.complete', () => ({ text: '' }));
    on('turn.step', async function* (_$, e) {
      yield* [];
      return {
        turnId: e.turnId,
        index: e.index,
        answer: 'CANARY_REPLY',
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
    await $.session.start({ cwd: '/fixture/project', surface: null, isInteractive: false });
    await $.turn.start({ turnId: 'native-turn', text: 'CANARY_PROMPT' });
    const stream = $.turn.step({
      turnId: 'native-turn',
      index: 0,
      model: 'claude-haiku-5-5',
      effort: 'medium',
      messageCount: 17,
    });
    let next = await stream.next();
    while (!next.done) next = await stream.next();
    const continuation = $.turn.step({
      turnId: 'native-turn',
      index: 1,
      model: 'claude-haiku-5-5',
      effort: 'medium',
      messageCount: 17,
    });
    let continued = await continuation.next();
    while (!continued.done) continued = await continuation.next();
    await $.turn.complete({
      turnId: 'native-turn',
      answer: 'CANARY_REPLY',
      durationMs: 1,
      isAborted: false,
      reason: 'answer',
    });
    // The flush runs from a timer after the turn, so the test waits for its write.
    for (let i = 0; i < 400 && !store.has('trace:v3:native-trace'); i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    expect(store.has('trace:v3:native-trace')).toBe(true);
    const recorded = readTrace(store.get('trace:v3:native-trace'));
    expect(usableTrace(recorded)).toBe(!hasAssistant);
    const projected = JSON.parse(JSON.stringify(recorded));
    const continuedOp = projected.events
      .findLast((event: { type: string }) => event.type === 'request')
      .operations.at(-1);
    expect(continuedOp.actualHasImages).toBe(false);
    expect(continuedOp.taskProgress.lastTool).toBe(-1);
    expect(JSON.stringify(recorded).includes('CANARY')).toBe(false);
    await $.command.run({ command: 'router', args: 'trace export' });
    const exported = JSON.parse(files.get('/fixture/team/router-traces.json') ?? '{}');
    expect(readTrace(exported.sessions['trace:v3:native-trace'])).toEqual(projected);
  });
}

test('replay projection and UTF-8 byte accounting run inside the Mod sandbox', () => {
  const config = loadConfig();
  const loop = emptyLoop(config, config.models.haiku.id);
  const record = newTrace(1000, { configured: config, config, loop });
  expect(usableTrace(record)).toBe(true);
  expect(traceBytes('€')).toBe(5);
  expect(traceBytes(record) > 0).toBe(true);
  expect(readTrace(storedTrace(record))).toEqual(record);
  expect(observedFromTrace({ nonDocEdit: 2, lastTool: 2 }, 0)).toBe('code');
});
