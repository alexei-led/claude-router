import { loadConfig, TIERS } from '../lib/config.mjs';
import { clip } from '../lib/facts-pure.mjs';
import { REASONS } from '../lib/native-display.mjs';
import { NativeJev } from '../lib/native-jev.mjs';
import { renderPanel } from '../lib/native-panel.mjs';
import {
  chooseRoute,
  continueRoute,
  emptyLoop,
  nativeFacts,
  observeResponse,
  prepareLoop,
  resetHistory,
  SNAPSHOTS,
} from '../lib/native-router.mjs';

const VIEW = { plugin: 'router', key: 'view' };
const LOOP = { plugin: 'router', key: 'loops' };
const PANE = 'jev-router';
const MODE_PREFIX = 'mode:';
const GATEWAY_SETTINGS = 'v0.8 gateway settings remain · see /router status';

function initialView(model) {
  return {
    phase: 'ready',
    activeTurnId: null,
    mode: 'auto',
    nativeModel: model,
    selectedModel: null,
    actualModel: null,
    tier: null,
    effort: null,
    reason: 'ready',
    error: null,
    pendingPin: null,
    keySet: false,
    contextTokens: null,
    contextKnown: false,
    cacheRead: null,
    cacheWrite: null,
    health: { failures: 0, pausedUntil: 0 },
    inputTokens: null,
    outputTokens: null,
    adviceMs: null,
    adviceChoice: null,
    estimate: null,
    comparison: null,
    history: [],
    configPath: null,
    tuning: null,
    notice: null,
  };
}

async function readView($, runtime) {
  return (await $.state.get(VIEW)).value ?? runtime.view ?? initialView(await $.session.model());
}

async function modeOf($, runtime, fallback = 'auto') {
  const sessionId = await $.session.id();
  if (runtime.modes.has(sessionId)) return runtime.modes.get(sessionId);
  try {
    const saved = await $.store.get(`${MODE_PREFIX}${sessionId}`);
    const mode = saved === 'manual' || saved === 'auto' ? saved : fallback;
    runtime.modes.set(sessionId, mode);
    return mode;
  } catch {
    return 'manual';
  }
}

async function rememberMode($, mode) {
  try {
    await $.store.set(`${MODE_PREFIX}${await $.session.id()}`, mode);
    return true;
  } catch {
    return false;
  }
}

async function updateView($, runtime, patch) {
  const value = runtime.view ?? (await readView($, runtime));
  runtime.view = { ...value, ...patch };
  await $.state.set(VIEW, runtime.view);
}

async function changeMode($, runtime, mode) {
  const view = runtime.view ?? (await readView($, runtime));
  for (const controller of runtime.controllers) controller.abort();
  runtime.modes.set(await $.session.id(), mode);
  const saved = await rememberMode($, mode);
  await updateView($, runtime, {
    mode,
    pendingPin: null,
    phase: view.phase === 'unavailable' ? 'unavailable' : mode === 'manual' ? 'manual' : 'ready',
    reason: mode === 'manual' ? 'routing paused' : 'ready',
    ...(!saved ? { notice: 'Mode changed for this session. Resume preference could not be saved.' } : {}),
  });
}

async function setPin($, runtime, tier) {
  const view = runtime.view ?? (await readView($, runtime));
  if (view.phase === 'unavailable') return `Routing unavailable: ${view.error}.`;
  const mode = await modeOf($, runtime, view.mode);
  if (mode === 'manual') return 'Routing is paused. Select Auto before pinning a turn.';
  await updateView($, runtime, { pendingPin: tier });
  return `${tier} pinned for the next turn and its tool continuations.`;
}

async function apiKeyOf($, options) {
  return typeof options.typesafe_api_key === 'string' && options.typesafe_api_key.trim()
    ? options.typesafe_api_key.trim()
    : (await $.env.get('TYPESAFE_API_KEY')) || (await $.env.get('CLAUDE_PLUGIN_OPTION_TYPESAFE_API_KEY'));
}

async function configureKey($) {
  return $.command.run({ command: 'plugin', args: `configure ${$.plugin.name}` });
}

function modelLabel(id) {
  if (!id) return 'native model';
  return id.replace(/^claude-/, '').replace(/-([0-9])-([0-9])/, ' $1.$2');
}

function bandText(view) {
  if (view.phase === 'unavailable') return `Jev Router · ${view.error}`;
  if (view.mode === 'manual') return `Jev Router · Manual · ${modelLabel(view.nativeModel)}`;
  if (view.pendingPin) return `Jev Router · ${view.pendingPin} pinned for next turn`;
  if (view.phase === 'ready') return 'Jev Router · Auto · ready';
  if (view.phase === 'choosing') return 'Jev Router · choosing for this turn…';
  if (view.error === 'missing-key')
    return `Jev Router · key not set · keeping ${modelLabel(view.actualModel ?? view.nativeModel)}`;
  if (view.error === 'paused')
    return `Jev Router · Jev paused until ${new Date(view.health.pausedUntil).toLocaleTimeString()}`;
  if (view.error) return `Jev Router · Jev ${view.error} · keeping ${modelLabel(view.actualModel ?? view.nativeModel)}`;
  if (view.reason === 'context-unknown') return 'Jev Router · context unknown · keeping native model';
  if (
    view.actualModel &&
    view.selectedModel &&
    view.actualModel !== view.selectedModel &&
    !view.actualModel.startsWith(`${view.selectedModel}-`)
  ) {
    return `Jev Router · ${modelLabel(view.selectedModel)} → ${modelLabel(view.actualModel)} · native fallback`;
  }
  return `Jev Router · ${view.actualModel ? 'last reply' : 'selected'} ${modelLabel(view.actualModel ?? view.selectedModel ?? view.nativeModel)}${view.effort ? ` · ${view.effort}` : ''} · ${REASONS[view.reason] ?? view.reason}`;
}

function detailText(view) {
  return [
    `Jev Router — ${view.mode === 'auto' ? 'Auto' : 'Manual'}`,
    `Native model: ${view.nativeModel}`,
    `Selected: ${view.selectedModel ?? 'not selected'}`,
    `Observed: ${view.actualModel ?? 'no response yet'}`,
    `Reason: ${view.reason}`,
    `Jev: ${view.error ?? (view.keySet ? 'ready' : 'key not set')}`,
    `Context: ${view.contextKnown ? `${view.contextTokens} tokens (estimate)` : 'unknown'}`,
    `Observed cache: ${view.cacheRead ?? 'unknown'} read, ${view.cacheWrite ?? 'unknown'} written tokens`,
    view.pendingPin ? `Next turn pin: ${view.pendingPin}` : 'No next-turn pin.',
    'Auto enables routing. Manual preserves Claude’s model. Pins serve one turn only.',
    'Cache lifetime is an estimate. Claude’s cost ledger owns session totals.',
    ...(view.error === GATEWAY_SETTINGS
      ? [
          'Remove from settings.json, then restart: model jev-router[1m], its modelPicker row,',
          'env.ANTHROPIC_BASE_URL for 127.0.0.1:43170, env.CLAUDE_CODE_GATEWAY_HINT_HEADERS,',
          'and a statusLine that runs the router scripts/statusline.mjs.',
        ]
      : []),
  ].join('\n');
}

async function loadNativeConfig($) {
  for (const source of ['project', 'local']) {
    const settings = await $.settings.read({ source });
    if (settings.env && ['HOME', 'CLAUDE_CONFIG_DIR'].some((key) => Object.hasOwn(settings.env, key)))
      throw new Error('project settings cannot redirect the router profile');
  }
  const home = await $.env.get('HOME');
  const profile = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${home}/.claude`;
  const path = `${profile}/router.json`;
  const userFile = (await $.fs.exists(path)) ? JSON.parse(await $.fs.read(path)) : null;
  return { ...loadConfig({ userFile }), nativePath: path };
}

function supportedVersion(version) {
  const parts = /^(\d+)\.(\d+)\.(\d+)(?:$|-)/.exec(version ?? '');
  if (!parts) return false;
  const [major, minor, patch] = parts.slice(1).map(Number);
  return major > 2 || (major === 2 && (minor > 1 || (minor === 1 && patch >= 289)));
}

async function contextOf($, loop, agentId) {
  const previous = loop.lastRequest ? loop.lastRequest.tokens + loop.lastRequest.outputTokens : null;
  if (agentId) return { tokens: previous, known: previous !== null };
  try {
    const usage = await $.session.usage({ breakdown: 'summary' });
    const estimate = usage.context.breakdown?.totalTokens;
    const observed = usage.context.tokens;
    const values = [previous, estimate, observed].filter((n) => Number.isFinite(n) && n >= 0);
    return { tokens: values.length ? Math.max(...values) : null, known: Number.isFinite(estimate) };
  } catch {
    return { tokens: previous, known: false };
  }
}

function tuningOf(config) {
  return {
    timeoutMs: config.jev.timeoutMs,
    downgradeVotes: config.policy.downgradeVotes,
    horizon: config.policy.downgradeHorizonTurns,
  };
}

function responseMetrics(view, response) {
  const usage = response.usage;
  const counters = usage ? [usage.input_tokens, usage.cache_read_input_tokens, usage.cache_creation_input_tokens] : [];
  const inputTokens =
    counters.length && counters.every(Number.isFinite) ? counters.reduce((sum, n) => sum + n, 0) : null;
  return {
    actualModel: usage?.model ?? null,
    cacheRead: usage?.cache_read_input_tokens ?? null,
    cacheWrite: usage?.cache_creation_input_tokens ?? null,
    inputTokens,
    outputTokens: usage?.output_tokens ?? null,
    history: Number.isFinite(inputTokens) ? [...(view?.history ?? []), inputTokens].slice(-10) : (view?.history ?? []),
  };
}

// The engine may echo our own routed model on a continuation; any third model is its fallback.
function isNativeFallback(loop, model) {
  if (loop.suspended) return true;
  const known = [loop.engineModel, loop.decision?.model].filter(Boolean);
  return known.length > 0 && !known.some((id) => id === model || SNAPSHOTS[id] === model);
}

async function* passMain($, e, next, loop, version, nativeModel, reason, config, runtime) {
  const ref = { ...LOOP, id: 'main' };
  const context = await contextOf($, loop);
  await updateView($, runtime, {
    nativeModel,
    selectedModel: e.model,
    effort: e.effort ?? null,
    reason,
    contextTokens: context.tokens,
    contextKnown: context.known,
  });
  const sessionId = await $.session.id();
  const response = yield* next(e);
  if (!next.signal.aborted && (await $.session.id()) === sessionId) {
    const observed = observeResponse(config, loop, {
      usage: response.usage,
      requestedModel: e.model,
      effort: e.effort ?? null,
      stopReason: response.stopReason,
      now: Date.now(),
    });
    const written = await $.state.set(ref, observed, { ifVersion: version });
    if (written.isSet) await updateView($, runtime, responseMetrics(runtime.view, response));
  }
  return response;
}

export function register(on, options) {
  let config = loadConfig();
  const turnConfigs = new Map();
  const classifier = new NativeJev();
  const prompts = new Map();
  const decisions = new Map();
  const controllers = new Set();
  const turnControllers = new Map();
  const runtime = { view: null, controllers, modes: new Map() };

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'router',
      description: 'Jev routing, next-turn pins and model controls.',
      argumentHint: '[auto|off|pin <tier>|status|setup]',
      immediate: true,
    });
    const model = await $.session.model();
    try {
      config = await loadNativeConfig($);
      const existing = await readView($, runtime);
      runtime.view = existing;
      classifier.restore(existing.health);
      const base = await $.env.get('ANTHROPIC_BASE_URL');
      const version = await $.session.version().catch(() => null);
      const supported = supportedVersion(version?.version);
      const baselineModel = config.models[config.routes[config.baselineTier].model].id;
      const gateway =
        ['jev-router', 'jev-router[1m]'].includes(model) ||
        model === 'router' ||
        Boolean(base?.includes('127.0.0.1:43170') || base?.includes('localhost:43170'));
      await updateView($, runtime, {
        nativeModel: model,
        mode: await modeOf($, runtime, model === baselineModel ? 'auto' : 'manual'),
        phase: gateway || !supported ? 'unavailable' : 'ready',
        error: !supported ? 'requires Claude Code 2.1.289 or newer' : gateway ? GATEWAY_SETTINGS : null,
        keySet: Boolean(await apiKeyOf($, options)),
        configPath: config.nativePath,
        tuning: tuningOf(config),
      });
    } catch (error) {
      await updateView($, runtime, {
        phase: 'unavailable',
        error: error.message?.startsWith('router.json uses gateway settings;')
          ? 'router.json needs migration; run the plugin scripts/migrate-config.mjs with your router.json path'
          : 'invalid router configuration',
      });
    }
    return next(e);
  });

  on('command.run', { command: 'model' }, async ($, e, next) => {
    const result = await next(e);
    if (e.origin.kind !== 'plugin') {
      for (const controller of controllers) controller.abort();
      await changeMode($, runtime, 'manual');
      await updateView($, runtime, { nativeModel: await $.session.model(), reason: 'model selected manually' });
    }
    return result;
  });

  on('config.set', { key: 'model' }, async ($, e, next) => {
    const result = await next(e);
    if (!result.deny && e.origin.kind !== 'plugin') {
      await changeMode($, runtime, 'manual');
      await updateView($, runtime, { nativeModel: await $.session.model() });
    }
    return result;
  });

  on('command.run', { command: 'router' }, async ($, e) => {
    const [action, tier] = e.args.trim().split(/\s+/);
    if (action === 'auto' || action === 'off') {
      for (const controller of controllers) controller.abort();
      await changeMode($, runtime, action === 'auto' ? 'auto' : 'manual');
      return { text: action === 'auto' ? 'Auto routing enabled.' : 'Manual mode: Claude’s model is preserved.' };
    }
    if (action === 'pin')
      return { text: TIERS.includes(tier) ? await setPin($, runtime, tier) : `Choose ${TIERS.join(', ')}.` };
    if (action === 'setup') return configureKey($);
    const storedView = await readView($, runtime);
    const view = { ...storedView, mode: await modeOf($, runtime, storedView.mode) };
    if (action === 'status' || !(await $.session.surfaces()).length) return { text: detailText(view) };
    await $.ui.open({ id: PANE, title: 'Jev Router', focus: true, closeOnEscape: true });
    return {};
  });

  on('turn.start', (_$, e, next) => {
    turnConfigs.set(e.turnId, config);
    prompts.set(e.turnId, clip(e.text, config.context.maxTextChars));
    return next(e);
  });

  on('turn.step', async function* ($, e, next) {
    const cfg = turnConfigs.get(e.turnId) ?? config;
    const sessionId = await $.session.id();
    const nativeModel = await $.session.model();
    const view = await readView($, runtime);
    if (e.agentId) return yield* next(e);
    const mode = await modeOf($, runtime, view.mode);
    if (e.index === 0) {
      const saved = await rememberMode($, mode);
      await updateView($, runtime, {
        mode,
        ...(!saved ? { notice: 'Resume preference could not be saved. Current mode remains active.' } : {}),
      });
    }
    const ref = { ...LOOP, id: 'main' };
    const loaded = await $.state.get(ref);
    let loopVersion = loaded.version;
    let loop = prepareLoop(loaded.value ?? emptyLoop(cfg, e.model), e.messageCount);
    if (view.phase === 'unavailable' || mode === 'manual') {
      return yield* passMain($, e, next, loop, loopVersion, nativeModel, 'manual', cfg, runtime);
    }
    if (loop.turnId === e.turnId && isNativeFallback(loop, e.model)) {
      return yield* passMain($, e, next, loop, loopVersion, nativeModel, 'native-fallback', cfg, runtime);
    }
    const context = await contextOf($, loop, e.agentId);
    const settings = await $.settings.read();
    const availableModels = settings.availableModels;
    const key = `${sessionId}:${e.agentId ?? 'main'}:${e.turnId}:${loop.generation}`;
    if (loop.turnId !== e.turnId) {
      let job = decisions.get(key);
      if (!job) {
        job = (async () => {
          const controller = new AbortController();
          const cancel = () => controller.abort();
          next.signal.addEventListener('abort', cancel, { once: true });
          controllers.add(controller);
          turnControllers.set(e.turnId, controller);
          const live = async () => !controller.signal.aborted && (await $.session.id()) === sessionId;
          try {
            const pin = view.pendingPin;
            const apiKey = await apiKeyOf($, options);
            const messages = await $.session.messages({ as: 'api' });
            if (!(await live())) return null;
            const facts = nativeFacts(cfg, loop, {
              messages,
              prompt: prompts.get(e.turnId),
              effort: e.effort,
              turnId: e.turnId,
              contextTokens: context.tokens,
            });
            await updateView($, runtime, {
              phase: 'choosing',
              activeTurnId: e.turnId,
              nativeModel,
              pendingPin: null,
              keySet: Boolean(apiKey),
            });
            const adviceStarted = Date.now();
            const result = pin
              ? { advice: null, error: null }
              : await classifier.ask({
                  request: (url, init) => $.http.fetch(url, init),
                  sleep: (ms, args) => $.clock.sleep(ms, args),
                  config: cfg,
                  apiKey,
                  prompt: facts.prompt,
                  turns: facts.turns,
                  signal: controller.signal,
                });
            if (
              controller.signal.aborted ||
              (await $.session.id()) !== sessionId ||
              (await modeOf($, runtime)) !== 'auto'
            )
              return null;
            const selected = chooseRoute(cfg, loop, {
              facts,
              advice: result.advice,
              pin,
              nativeModel,
              contextKnown: context.known,
              availableModels,
              now: Date.now(),
            });
            selected.engineModel = e.model;
            const written = await $.state.set(ref, selected, { ifVersion: loopVersion });
            if (!written.isSet) return null;
            await updateView($, runtime, {
              phase: 'routed',
              selectedModel: selected.decision.model,
              actualModel: null,
              tier: selected.decision.tier,
              effort: selected.decision.effort,
              reason: selected.decision.reason,
              error: result.error,
              health: classifier.snapshot(),
              contextTokens: context.tokens,
              contextKnown: context.known,
              adviceMs:
                pin || ['missing-key', 'busy', 'paused'].includes(result.error) ? null : Date.now() - adviceStarted,
              adviceChoice: result.advice?.choice ?? null,
              estimate: selected.decision.estimate ?? null,
              comparison: selected.decision.comparison,
            });
            return { loop: selected, version: written.version };
          } finally {
            next.signal.removeEventListener('abort', cancel);
            controllers.delete(controller);
            if (turnControllers.get(e.turnId) === controller) turnControllers.delete(e.turnId);
          }
        })();
        decisions.set(key, job);
      }
      const selected = await job;
      if (!selected) {
        if (!next.signal.aborted && (await $.session.id()) === sessionId && runtime.view?.activeTurnId === e.turnId) {
          const reserved = await $.state.set(ref, loop, { ifVersion: loopVersion });
          if (reserved.isSet)
            return yield* passMain($, e, next, loop, reserved.version, nativeModel, 'manual', cfg, runtime);
        }
        return yield* next(e);
      }
      loop = selected.loop;
      loopVersion = selected.version;
    } else {
      loop = continueRoute(cfg, loop, {
        nativeModel,
        contextTokens: context.tokens,
        contextKnown: context.known,
        availableModels,
        effort: e.effort,
      });
      await updateView($, runtime, {
        selectedModel: loop.decision.model,
        effort: loop.decision.effort,
        tier: loop.decision.tier,
        reason: loop.decision.reason,
        contextTokens: context.tokens,
        contextKnown: context.known,
      });
    }
    const request = { ...e, model: loop.decision.model };
    if (loop.decision.effort === null) delete request.effort;
    else request.effort = loop.decision.effort;
    const response = yield* next(request);
    if (!next.signal.aborted && (await $.session.id()) === sessionId) {
      const observed = observeResponse(cfg, loop, {
        usage: response.usage,
        requestedModel: request.model,
        effort: request.effort ?? null,
        stopReason: response.stopReason,
        now: Date.now(),
      });
      if (response.stopReason === null) observed.suspended = true;
      const written = await $.state.set(ref, observed, { ifVersion: loopVersion });
      if (written.isSet) await updateView($, runtime, responseMetrics(runtime.view, response));
    }
    return response;
  });

  on('turn.complete', async ($, e, next) => {
    turnConfigs.delete(e.turnId);
    turnControllers.get(e.turnId)?.abort();
    if (runtime.view?.activeTurnId === e.turnId && runtime.view.phase === 'choosing') {
      runtime.view = { ...runtime.view, activeTurnId: null };
      const mode = await modeOf($, runtime);
      if (runtime.view.activeTurnId === null)
        await updateView($, runtime, { phase: mode === 'manual' ? 'manual' : 'ready', reason: 'interrupted' });
    }
    prompts.delete(e.turnId);
    for (const key of decisions.keys()) if (key.includes(`:${e.turnId}:`)) decisions.delete(key);
    return next(e);
  });

  on('session.compact', async ($, e, next) => {
    const result = await next(e);
    if (!result.skip && e.trigger !== 'precompute') {
      const ref = { ...LOOP, id: e.agentId ?? 'main' };
      const loop = (await $.state.get(ref)).value;
      if (loop) await $.state.set(ref, resetHistory(loop));
      if (!e.agentId) for (const controller of controllers) controller.abort();
    }
    return result;
  });

  on('session.end', (_$, e, next) => {
    for (const controller of controllers) controller.abort();
    decisions.clear();
    prompts.clear();
    turnConfigs.clear();
    runtime.view = {
      ...initialView(runtime.view?.nativeModel ?? ''),
      mode: 'auto',
      keySet: runtime.view?.keySet ?? false,
      health: classifier.snapshot(),
      configPath: config.nativePath,
      tuning: tuningOf(config),
      phase: runtime.view?.phase === 'unavailable' ? 'unavailable' : 'ready',
      error: runtime.view?.phase === 'unavailable' ? runtime.view.error : null,
    };
    return next(e);
  });

  on('ui.render', { component: ['AbovePrompt', 'Pane'] }, async ($, e, next) => {
    if (e.component === 'Pane' && e.requestId !== PANE) return next(e);
    const storedView = await readView($, runtime);
    const view = { ...storedView, mode: await modeOf($, runtime, storedView.mode) };
    const elements = $.ui.resolve(e);
    const { Box, Text, Button } = elements;
    if (e.component === 'AbovePrompt')
      return Box({
        flexDirection: 'column',
        children: [
          await next(e),
          Box({
            children: [
              Text({ color: view.error ? 'yellow' : 'cyan', children: bandText(view) }),
              Text({ children: '  ' }),
              Button({
                key: 'details',
                label: 'Router',
                plain: true,
                onPress: () => $.ui.open({ id: PANE, title: 'Jev Router', focus: true, closeOnEscape: true }),
              }),
            ],
          }),
        ],
      });
    const usage = await $.session.usage().catch(() => null);
    return renderPanel(elements, config, view, usage, {
      mode: (mode) => changeMode($, runtime, mode),
      pin: async (tier) => {
        $.ui.log(await setPin($, runtime, tier));
      },
      key: async () => {
        const command = `/plugin configure ${$.plugin.name}`;
        const draft = await $.prompt.read();
        await updateView($, runtime, {
          notice: `Run ${command} to edit the secure key. Your existing prompt is preserved.`,
        });
        await $.ui.close({ id: PANE });
        if (!draft.text) {
          const filled = await $.prompt.fill({ text: command });
          $.ui.log(
            filled.isFilled
              ? 'Press Enter to open secure Jev key configuration.'
              : `Run ${command} to configure the secure key.`,
          );
        } else $.ui.log(`Run ${command} after finishing your current draft.`);
      },
      close: () => $.ui.close({ id: PANE }),
      tune: async (key, value) => {
        await updateView($, runtime, {
          tuning: { ...tuningOf(config), ...runtime.view?.tuning, [key]: value },
          notice: 'Draft — select Save tuning to apply.',
        });
      },
      save: async () => {
        try {
          const draft = runtime.view.tuning;
          const path = config.nativePath;
          if ((await $.fs.exists(path)) && (await $.fs.stat(path)).isLink) {
            await updateView($, runtime, { notice: 'Config is a symlink. Edit its maintained source instead.' });
            return;
          }
          const previous = (await $.fs.exists(path)) ? JSON.parse(await $.fs.read(path)) : {};
          const file = {
            ...previous,
            jev: { ...previous.jev, timeoutMs: draft.timeoutMs },
            policy: { ...previous.policy, downgradeVotes: draft.downgradeVotes, downgradeHorizonTurns: draft.horizon },
          };
          const checked = loadConfig({ userFile: file });
          await $.fs.write(path, `${JSON.stringify(file, null, 2)}\n`);
          config = { ...checked, nativePath: path };
          await updateView($, runtime, { notice: 'Saved. New tuning applies to future turns.' });
        } catch {
          await updateView($, runtime, { notice: 'Could not save valid tuning. Existing configuration is unchanged.' });
        }
      },
    });
  });
}
