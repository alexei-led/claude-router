import { loadConfig } from '../lib/config.mjs';
import { NativeJev } from '../lib/native-jev.mjs';

export function registerAcceptance(on) {
  const classifier = new NativeJev();
  const lifecycle = [];
  on('session.start', { isInteractive: [true, false] }, async ($, e, next) => {
    await $.command.register({
      name: 'router-accept',
      description: 'Isolated native acceptance checks.',
      immediate: true,
    });
    lifecycle.push({ event: 'start', session: await $.session.id() });
    return next(e);
  });
  on('session.end', { reason: ['clear', 'resume', 'prompt_input_exit', 'logout', 'other'] }, (_$, e, next) => {
    lifecycle.push({ event: 'end', session: e.sessionId, reason: e.reason });
    return next(e);
  });
  on('command.run', { command: 'router-accept' }, async ($, e, next) => {
    const [action, scenario] = e.args.trim().split(/\s+/);
    if (action === 'inspect') {
      const state = await $.state.get({ plugin: 'router', key: 'view' });
      return {
        text: JSON.stringify({
          session: await $.session.id(),
          viewMode: state.value?.mode ?? null,
          phase: state.value?.phase ?? null,
          reason: state.value?.reason ?? null,
          health: classifier.snapshot(),
          pending: classifier.pending !== null,
          lifecycle,
        }),
      };
    }
    const base = await $.env.get('ROUTER_PROBE_URL');
    if (action !== 'ask' || !base || !['hang', 'delay', 'slow', 'retry', 'malformed'].includes(scenario))
      return { text: 'Use inspect or ask hang|delay|slow|retry|malformed.' };
    const endpoint = `${base}/${scenario}`;
    const config = loadConfig({ userFile: { classifiers: { jev: { endpoint, timeoutMs: 1500 } } } });
    const started = Date.now();
    const result = await classifier.ask({
      request: (url, init) => $.http.fetch(url, init),
      sleep: (ms, args) => $.clock.sleep(ms, args),
      config,
      apiKey: 'synthetic-probe-key',
      endpoint,
      prompt: 'synthetic fixture',
      turns: [],
      signal: next.signal,
    });
    return {
      text: JSON.stringify({
        elapsedMs: Date.now() - started,
        error: result.error,
        choice: result.advice?.choice ?? null,
        health: classifier.snapshot(),
        pending: classifier.pending !== null,
      }),
    };
  });
}
