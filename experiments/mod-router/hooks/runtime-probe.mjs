// Probe reloads are intentional: outstanding host work must be cancelled.
function report($, value) {
  $.ui.log(`RUNTIME_PROBE ${JSON.stringify(value)}`, { to: 'debug' });
}

export function registerProbe(on, options) {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'router-probe', description: 'Run isolated router runtime checks.' });
    report($, { event: 'start', root: $.plugin.root, session: await $.session.id() });
    return next(e);
  });

  on('session.end', ($, e, next) => {
    report($, { event: 'end', reason: e.reason, session: e.sessionId });
    return next(e);
  });

  on('session.compact', async ($, e, next) => {
    const result = await next(e);
    report($, { event: 'compact', trigger: e.trigger, skipped: Boolean(result.skip), agent: e.agentId ?? null });
    return result;
  });

  on('command.run', { command: 'model' }, async ($, e, next) => {
    const result = await next(e);
    await $.env.set('JEV_ROUTER_MODE', 'manual');
    report($, { event: 'model-command', model: await $.session.model() });
    return result;
  });

  on('command.run', { command: 'router-probe' }, async ($, e) => {
    const action = e.args.trim();
    if (action === 'manual') await $.env.set('JEV_ROUTER_MODE', 'manual');
    if (action === 'auto') await $.env.set('JEV_ROUTER_MODE', 'auto');
    const key =
      typeof options.typesafe_api_key === 'string'
        ? options.typesafe_api_key
        : (await $.env.get('TYPESAFE_API_KEY')) || (await $.env.get('CLAUDE_PLUGIN_OPTION_TYPESAFE_API_KEY'));
    if (action === 'inspect' || action === 'manual' || action === 'auto') {
      const value = {
        event: 'inspect',
        session: await $.session.id(),
        model: await $.session.model(),
        mode: (await $.env.get('JEV_ROUTER_MODE')) ?? null,
        baseURL: (await $.env.get('ANTHROPIC_BASE_URL')) ?? null,
        optionKeyPresent: Boolean(options.typesafe_api_key),
        keyPresent: Boolean(key),
        root: $.plugin.root,
      };
      report($, value);
      return { text: JSON.stringify(value) };
    }
    const started = await $.clock.now();
    if (action === 'process') {
      try {
        await $.process.run(['node', '-e', 'setTimeout(() => {}, 60000)'], { timeoutMs: 1500 });
        return { text: 'unexpected process completion', exitCode: 1 };
      } catch {
        const value = { event: 'process-timeout', elapsedMs: (await $.clock.now()) - started };
        report($, value);
        return { text: JSON.stringify(value) };
      }
    }
    const base = await $.env.get('ROUTER_PROBE_URL');
    if (!base || !['hang', 'delay', 'slow', 'retry'].includes(action))
      return { text: 'Use inspect, manual, auto, process, hang, delay, slow or retry.' };
    const request = $.http.fetch(`${base}/${action}`, { headers: { authorization: 'Bearer synthetic-probe-key' } });
    request.then(
      (r) => report($, { event: 'http-settled', status: r.status, elapsedMs: Date.now() - started }),
      () => report($, { event: 'http-settled', rejected: true, elapsedMs: Date.now() - started }),
    );
    const timer = new AbortController();
    const deadline = $.clock.sleep(1500, { signal: timer.signal }).then(() => null);
    const response = await Promise.race([request, deadline]);
    timer.abort();
    const value = {
      event: 'http-return',
      timeout: response === null,
      status: response?.status ?? null,
      elapsedMs: (await $.clock.now()) - started,
    };
    report($, value);
    return { text: JSON.stringify(value) };
  });
}
