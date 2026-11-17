import type { PluginState } from 'claude-code';
import { expect, mock, test } from 'claude-code/testing';
import { compareRoutes } from '../lib/activity.mjs';
import { loadConfig } from '../lib/config.mjs';
import { extractFacts } from '../lib/facts.mjs';
import { applyMode } from '../lib/modes.mjs';
import { chooseRoute, emptyLoop, nativeFacts } from '../lib/route.mjs';
import { emptyUsage, recordUsage, replyEntry } from '../lib/usage.mjs';
import { assistant, body, memory, toolResult, user } from './helpers.mjs';

test('provider-aware ops floors and Haiku quality preferences run inside the Mod engine', () => {
  const configured = loadConfig();
  const config = applyMode(configured, { mode: 'quality', source: 'session' });
  expect(config.routes.low.effort).toBe('high');
  expect(config.activities.ops.medium.effort).toBe('xhigh');
  for (const [phase, activity] of [
    ['reason', 'debug'],
    ['produce', 'code'],
    ['execute', 'ops'],
  ] as const) {
    const loop = { ...emptyLoop(configured, configured.models.opus.id), lastRoute: 'medium' };
    const facts = nativeFacts(config, loop, {
      messages: [user('Complete the operational task.')],
      prompt: 'Complete the operational task.',
      effort: 'high',
      turnId: phase,
      contextTokens: 8000,
    });
    const { decision } = chooseRoute(config, loop, {
      facts,
      advice: {
        choice: 'medium',
        probabilities: { micro: 0, low: 0, medium: 1, high: 0, uncertain: 0 },
        activity: { choice: 'ops', probabilities: { ops: 1 } },
        phase: { choice: phase, probabilities: { [phase]: 1 } },
        continuation: 0,
      },
      pin: null,
      nativeModel: configured.models.opus.id,
      contextKnown: true,
      now: 1000,
    });
    expect(decision.goal).toBe('ops');
    expect(decision.activity).toBe(activity);
    expect(decision.route).toEqual(config.activities[activity]?.medium ?? config.routes.medium);
  }
  const reversed = {
    ...config,
    models: {
      ...config.models,
      opus: { ...config.models.opus, output: 0.01 },
      sonnet: { ...config.models.sonnet, output: 1000 },
    },
  };
  expect(compareRoutes(reversed, { model: 'opus', effort: 'low' }, { model: 'sonnet', effort: 'max' }, 'high')).toBe(1);
});

test('full failure fingerprints distinguish test failures inside the Mod engine', () => {
  const header =
    '> @alexeiled/claude-router@1.10.0 test\n' +
    '> node --test --test-timeout=8000 test/*.test.mjs experiments/mod-router/scripts/*.test.mjs\n\n';
  const failure = (name: string) => `${header}not ok 1 - ${name}\n  error: 'unauthorized'\n`;
  for (const [nextTest, repeated] of [
    ['logout', false],
    ['login', true],
  ] as const) {
    const facts = extractFacts(
      body([
        user('fix the tests'),
        assistant('running', ['Bash']),
        toolResult(failure('login'), { isError: true }),
        assistant('editing', ['Edit']),
        toolResult(failure(nextTest), { isError: true }),
      ]),
      memory(),
      { recentTurns: 6, maxTextChars: 1200 },
    );
    expect(facts.failure !== null).toBe(repeated);
  }
});

test('observed-only replies render in native terminal and desktop Usage panes', async ($, on) => {
  mock.store(on);
  on('session.id', () => ({ value: 'observed-only-ui' }));
  on('session.model', () => ({ value: 'claude-sonnet-5-5' }));
  on('session.usage', () => ({ value: { context: { tokens: 1000 }, rateLimits: [] } }));
  on('ui.log', () => ({ value: undefined }));
  const now = Date.now();
  const usage = recordUsage(
    emptyUsage(),
    [
      replyEntry({
        at: now,
        mode: 'cost',
        activity: 'code',
        tier: 'low',
        route: 'claude-haiku-5-5@high',
        yours: 'claude-sonnet-5-5',
        reply: null,
        replies: {},
        observedUsd: 0.42,
        usage: { input_tokens: 100, cache_read_input_tokens: 800, cache_creation_input_tokens: 200, output_tokens: 10 },
      }),
    ],
    { now },
  );
  let view: PluginState['router']['view'] = {
    phase: 'routed',
    mode: 'auto',
    nativeModel: 'claude-sonnet-5-5',
    credentials: { jev: null },
    usageSession: usage,
    usageStore: usage,
  };
  on('state.get', { plugin: 'router', key: 'view' }, () => ({ value: { value: view, version: 1 } }));
  on('state.set', { plugin: 'router', key: 'view' }, (_$, e) => {
    view = e.value;
    return { value: { isSet: true, version: 2 } };
  });
  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({
      plugin: 'router',
      surface,
      component: 'Pane',
      requestId: 'jev-router',
      viewport: { columns: 60, rows: 32 },
      props: {
        title: 'Router',
        isFocused: true,
        bodyColumns: 60,
        placement: 'dock',
        scroll: { offset: 0, bodyRows: 32 },
        view: {},
      },
    });
    await pane.press({ key: 'tab-usage' });
    await pane.redraw();
    expect(await pane.find({ type: 'Text', text: /^No reply has a comparison: no saving is shown\.$/ })).toBeDefined();
    expect(await pane.find({ type: 'Text', text: /\$0\.42$/ })).toBeDefined();
    expect(await pane.find({ type: 'Text', text: /input 1\.1K/ })).toBeDefined();
    expect(await pane.find({ type: 'Text', text: /No routed replies/ })).toBeUndefined();
    await pane.unmount();
  }
});

test('terminal and desktop panes show observed usage, cost scenarios and native controls', async ($, on) => {
  mock.store(on);
  on('session.id', () => ({ value: 'ui-controls' }));
  on('session.model', () => ({ value: 'claude-sonnet-5-5' }));
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { tokens: 150_000, window: 1_000_000 },
      rateLimits: [],
      cost: { usd: 0.25 },
    },
  }));
  on('ui.log', () => ({ value: undefined }));
  let view: PluginState['router']['view'] = {
    phase: 'routed',
    mode: 'auto',
    nativeModel: 'claude-sonnet-5-5',
    selectedModel: 'claude-haiku-5-5',
    actualModel: 'claude-haiku-5-5',
    effort: null,
    reason: 'pinned',
    error: null,
    credentials: { jev: null, clef: 'missing-key', 'clef-flash': 'missing-account' },
    pendingPin: null,
    inputTokens: 150_000,
    outputTokens: 500,
    contextTokens: 150_000,
    contextKnown: true,
    cacheRead: 120_000,
    cacheWrite: 25_000,
    history: [100_000, 150_000, 120_000],
    tiers: ['low', 'micro', 'low'],
    strip: { per: 1, cells: [{ low: 1 }, { micro: 1 }, { low: 1 }] },
    adviceMs: 390,
    comparison: {
      incumbent: 'low',
      candidate: 'micro',
      minUsd: -0.02,
      maxUsd: 0.03,
      paybackTurns: 3,
      outputTokens: 500,
    },
  };
  on('state.get', { plugin: 'router', key: 'view' }, () => ({ value: { value: view, version: 1 } }));
  on('state.set', { plugin: 'router', key: 'view' }, (_$, e) => {
    view = e.value;
    return { value: { isSet: true, version: 2 } };
  });
  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({
      plugin: 'router',
      surface,
      component: 'Pane',
      requestId: 'jev-router',
      viewport: { columns: 60, rows: 32 },
      props: {
        title: 'Router',
        isFocused: true,
        bodyColumns: 60,
        placement: 'dock',
        scroll: { offset: 0, bodyRows: 32 },
        view: {},
      },
    });
    // The terminal writes padded rows; the desktop draws cards with the figure beside each bar.
    const terminal = surface === 'terminal';
    expect(await pane.find({ type: 'Text', text: terminal ? / 15%$/ : '15%' })).toBeDefined();
    expect(await pane.find({ type: 'Text', text: /~150\.5K \/ 1\.00M/ })).toBeDefined();
    expect(await pane.find({ type: 'Text', text: terminal ? '80%' : /^80% last reply/ })).toBeDefined();
    expect(
      await pane.find({
        type: 'Text',
        text: terminal ? /no priced replies: cost unknown/ : 'No priced replies: cost unknown',
      }),
    ).toBeDefined();
    expect(await pane.find({ type: 'Text', text: terminal ? ' 2   ' : 'low 2' })).toBeDefined();
    expect(await pane.find({ type: 'Text', text: /\/cost|0\.25/ })).toBeUndefined();
    await pane.press({ key: 'usage-detail' });
    await pane.redraw();
    expect(
      await pane.find({
        type: 'Text',
        text: terminal ? /Next-turn difference\s+−\$0.02 to \+\$0.03/ : '−$0.02 to +$0.03',
      }),
    ).toBeDefined();
    await pane.press({ key: 'usage-detail' });
    await pane.redraw();
    expect(await pane.find({ type: 'Text', text: /Next-turn difference/ })).toBeUndefined();
    await pane.press({ key: 'tab-usage' });
    await pane.redraw();
    expect(await pane.find({ key: 'period-7d' })).toBeDefined();
    expect(await pane.find({ type: 'Text', text: /No routed replies this session/ })).toBeDefined();
    expect(await pane.find({ key: 'delete-history' })).toBeDefined();
    await pane.press({ key: 'help' });
    await pane.redraw();
    expect(await pane.find({ type: 'Text', text: /Answer quality is not measured/ })).toBeDefined();
    await pane.press({ key: 'help' });
    await pane.redraw();
    expect(await pane.find({ type: 'Text', text: /Answer quality is not measured/ })).toBeUndefined();
    await pane.press({ key: 'tab-classifier' });
    await pane.redraw();
    expect(await pane.find({ key: 'classifier-jev' })).toBeDefined();
    expect(await pane.find({ key: 'classifier-clef-flash' })).toBeDefined();
    expect(await pane.find({ key: 'key-clef' })).toBeDefined();
    expect(await pane.find({ key: 'timeoutMs' })).toBeDefined();
    expect(await pane.find({ type: 'Text', text: /no account ID/ })).toBeDefined();
    await pane.press({ key: 'tab-routes' });
    await pane.redraw();
    await pane.press({ key: 'cell-tier-medium' });
    await pane.redraw();
    expect(await pane.find({ key: 'route-medium-model' })).toBeDefined();
    expect(await pane.find({ type: 'Text', text: /prompt caches in use/ })).toBeDefined();
    await pane.press({ key: 'tab-policy' });
    await pane.redraw();
    expect(await pane.find({ key: 'downgradeVotes' })).toBeDefined();
    await pane.press({ key: 'tab-now' });
    await pane.redraw();
    await pane.press({ key: 'manual' });
    expect(view.mode).toBe('manual');
    await pane.press({ key: 'auto' });
    expect(view.mode).toBe('auto');
    await pane.press({ key: 'pin-high' });
    expect(view.pendingPin).toBe('high');
    // Pressing the pending pin again unpins it.
    await pane.redraw();
    await pane.press({ key: 'pin-high' });
    expect(view.pendingPin).toBeNull();
    await pane.unmount();
  }
});

test('unknown readings remain unknown and the band preserves other Mods', async ($, on) => {
  on('env.get', { name: 'JEV_ROUTER_MODE' }, () => ({ value: undefined }));
  mock.store(on);
  on('session.id', () => ({ value: 'ui-empty' }));
  on('session.model', () => ({ value: 'claude-sonnet-5-5' }));
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000 }, rateLimits: [] } }));
  on('state.get', { plugin: 'router', key: 'view' }, () => ({ value: { value: undefined, version: 0 } }));
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['other mod'] }));
  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({
      plugin: 'router',
      surface,
      component: 'Pane',
      requestId: 'jev-router',
      viewport: { columns: 48, rows: 24 },
      props: {
        title: 'Router',
        isFocused: true,
        bodyColumns: 48,
        placement: 'dock',
        scroll: { offset: 0, bodyRows: 24 },
        view: {},
      },
    });
    const terminal = surface === 'terminal';
    expect(
      await pane.find({ type: 'Text', text: terminal ? /no replies yet/ : 'No routed replies yet' }),
    ).toBeDefined();
    expect(await pane.find({ type: 'Text', text: terminal ? 'no reading yet' : 'No reading yet' })).toBeDefined();
    expect(await pane.find({ type: 'Text', text: terminal ? 'no reply yet' : 'No reply yet' })).toBeDefined();
    await pane.unmount();
    const band = await $.ui.mount({
      plugin: 'router',
      surface,
      component: 'AbovePrompt',
      requestId: 'band',
      viewport: { columns: 60, rows: 24 },
      props: {
        hasSurvey: false,
        isWorking: false,
        maxRows: 4,
        bodyColumns: 60,
        scroll: { offset: 0, bodyRows: 4 },
        view: {},
      },
    });
    expect(await band.find({ type: 'Text', text: 'other mod' })).toBeDefined();
    expect(await band.find({ key: 'details' })).toBeDefined();
    // The terminal band has the hover row's Turn off; the graphical band keeps it in the pane header only.
    if (surface === 'terminal') expect(await band.find({ key: 'band-manual' })).toBeDefined();
    else expect(await band.find({ key: 'band-manual' })).toBeUndefined();
    await band.unmount();
  }
});
