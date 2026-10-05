import {
  activeClassifier,
  DEFAULTS,
  effectiveRoutes,
  loadConfig,
  MIGRATION_HINT,
  TIERS,
  tuningOf,
  withClassifier,
  withClassifierTimeout,
  withRoutes,
  withTuning,
} from '../lib/config.mjs';
import { clip } from '../lib/facts-pure.mjs';
import { resolveCredentials } from '../lib/jev-contract.mjs';
import { renderBand, switchToast } from '../lib/native-band.mjs';
import { classifierStatus, GATEWAY_CLEANUP, GATEWAY_SETTINGS, missingCredentials } from '../lib/native-display.mjs';
import { NativeJev } from '../lib/native-jev.mjs';
import { renderPanel, routeDraftOf } from '../lib/native-panel.mjs';
import {
  chooseRoute,
  continueRoute,
  emptyLoop,
  isModelAllowed,
  isSameModel,
  nativeFacts,
  observeResponse,
  prepareLoop,
  resetHistory,
} from '../lib/native-router.mjs';

const VIEW = { plugin: 'router', key: 'view' };
const LOOP = { plugin: 'router', key: 'loops' };
const PANE = 'jev-router';
const PANE_TITLE = 'Router';
const BAND_DETAIL = 'band:detail';
const MODE_PREFIX = 'mode:';
// Replies kept for the pane's trend and tier strip.
const HISTORY = 30;

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
    credentials: null,
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
    probabilities: null,
    history: [],
    tiers: [],
    configPath: null,
    tuning: null,
    tuningBase: null,
    routeDraft: null,
    classifierUndo: null,
    tab: 'now',
    help: false,
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

// The environment variables that stand in for a classifier option: its upper-case name, then the one Claude Code
// exports for a plugin option. Spelled out because $.env.get takes literal names only. Cases: CLASSIFIER_OPTIONS.
async function envSettingOf($, name) {
  switch (name) {
    case 'typesafe_api_key':
      return (await $.env.get('TYPESAFE_API_KEY')) || (await $.env.get('CLAUDE_PLUGIN_OPTION_TYPESAFE_API_KEY'));
    case 'cloudflare_api_token':
      return (
        (await $.env.get('CLOUDFLARE_API_TOKEN')) || (await $.env.get('CLAUDE_PLUGIN_OPTION_CLOUDFLARE_API_TOKEN'))
      );
    case 'cloudflare_account_id':
      return (
        (await $.env.get('CLOUDFLARE_ACCOUNT_ID')) || (await $.env.get('CLAUDE_PLUGIN_OPTION_CLOUDFLARE_ACCOUNT_ID'))
      );
    default:
      return null;
  }
}

// A plugin option, else its environment variables.
async function settingOf($, options, name) {
  const value = options[name];
  if (typeof value === 'string' && value.trim()) return value.trim();
  return ((await envSettingOf($, name)) ?? '').trim() || null;
}

// The credentials error, or null, of every configured classifier: the pane lists them all.
async function credentialsOf($, options, config) {
  const lookup = (name) => settingOf($, options, name);
  return Object.fromEntries(
    await Promise.all(
      Object.entries(config.classifiers).map(async ([id, entry]) => [
        id,
        (await resolveCredentials(entry, lookup)).missing,
      ]),
    ),
  );
}

// Failures and a pause belong to the classifier that earned them.
const healthOf = (client, id) => ({ ...client.snapshot(), classifier: id });
// The last classification's readings, cleared when another classifier takes over so no label claims them.
const CLEARED_READINGS = { adviceMs: null, adviceChoice: null, probabilities: null, estimate: null };

// The host refuses $.command.run from a hook the turn is holding, so the secure key dialog opens from a timer.
function openKeySettings($) {
  $.clock.after(0, () => $.command.run({ command: 'plugin', args: `configure ${$.plugin.name}` }).catch(() => {}));
}

// Writes router.json through `change(previousFile)` once the result validates. Returns the new config or an error
// line for the pane; a failure leaves the file untouched.
async function saveConfig($, path, change) {
  try {
    if ((await $.fs.exists(path)) && (await $.fs.stat(path)).isLink)
      return { error: 'Not saved: router.json is a symlink. Edit its maintained source instead.' };
    const previous = (await $.fs.exists(path)) ? JSON.parse(await $.fs.read(path)) : {};
    const file = change(previous);
    const checked = loadConfig({ userFile: file });
    await $.fs.write(path, `${JSON.stringify(file, null, 2)}\n`);
    return { config: { ...checked, nativePath: path } };
  } catch (error) {
    // A JSON parse message quotes the file; the loadConfig messages name the setting only.
    const reason = error instanceof SyntaxError ? 'router.json is not valid JSON' : error.message;
    return { error: `Not saved: ${reason}. router.json is unchanged.` };
  }
}

function detailText(config, view) {
  const missing = missingCredentials(view, config.classifier);
  return [
    `Router — ${view.mode === 'auto' ? 'Auto' : 'Manual'}`,
    `Native model: ${view.nativeModel}`,
    `Selected: ${view.selectedModel ?? 'not selected'}`,
    `Observed: ${view.actualModel ?? 'no response yet'}`,
    `Reason: ${view.reason}`,
    view.error || missing ? classifierStatus(config, view.error ?? missing) : `${activeClassifier(config).label} ready`,
    `Context: ${view.contextKnown ? `${view.contextTokens} tokens (estimate)` : 'unknown'}`,
    `Observed cache: ${view.cacheRead ?? 'unknown'} read, ${view.cacheWrite ?? 'unknown'} written tokens`,
    view.pendingPin ? `Next turn pin: ${view.pendingPin}` : 'No next-turn pin.',
    'Auto enables routing. Manual preserves Claude’s model. Pins serve one turn only.',
    'Cache lifetime is an estimate. Claude’s cost ledger owns session totals.',
    ...(view.error === GATEWAY_SETTINGS ? GATEWAY_CLEANUP : []),
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

async function contextOf($, loop) {
  const previous = loop.lastRequest ? loop.lastRequest.tokens + loop.lastRequest.outputTokens : null;
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

function responseMetrics(view, response, tier) {
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
    // Appended together so the Usage trend can color each reading by its tier.
    ...(Number.isFinite(inputTokens)
      ? {
          history: [...(view?.history ?? []), inputTokens].slice(-HISTORY),
          tiers: [...(view?.tiers ?? []), tier ?? null].slice(-HISTORY),
        }
      : {}),
  };
}

// The engine may echo our own routed model on a continuation; any third model is its fallback.
function isNativeFallback(loop, model) {
  if (loop.suspended) return true;
  const known = [loop.engineModel, loop.decision?.model].filter(Boolean);
  return known.length > 0 && !known.some((id) => isSameModel(id, model));
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
    if (written.isSet) await updateView($, runtime, responseMetrics(runtime.view, response, null));
  }
  return response;
}

export function register(on, options) {
  let config = loadConfig();
  const turnConfigs = new Map();
  // One client per classifier, each with its own breaker and in-flight slot: a turn that started under one
  // classifier finishes with it, and its answer, failures or pause never land on another.
  const clients = new Map();
  const clientOf = (id) => {
    if (!clients.has(id)) clients.set(id, new NativeJev());
    return clients.get(id);
  };
  const prompts = new Map();
  const decisions = new Map();
  const controllers = new Set();
  const turnControllers = new Map();
  const runtime = { view: null, controllers, modes: new Map() };

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'router',
      description: 'Open the Router pane, or switch routing: auto, off, pin <tier>.',
      argumentHint: '[auto|off|pin <tier>]',
      immediate: true,
    });
    const model = await $.session.model();
    try {
      config = await loadNativeConfig($);
      const existing = await readView($, runtime);
      runtime.view = existing;
      const sameClassifier = existing.health?.classifier === config.classifier;
      clientOf(config.classifier).restore(sameClassifier ? existing.health : null);
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
        ...(sameClassifier ? {} : CLEARED_READINGS),
        credentials: await credentialsOf($, options, config),
        health: healthOf(clientOf(config.classifier), config.classifier),
        configPath: config.nativePath,
        tuning: null,
        tuningBase: null,
        bandDetail: (await $.store.get(BAND_DETAIL).catch(() => false)) === true,
      });
    } catch (error) {
      await updateView($, runtime, {
        phase: 'unavailable',
        error: error.message?.endsWith(MIGRATION_HINT)
          ? 'router.json needs migration; run the plugin scripts/migrate-config.mjs with your router.json path'
          : 'invalid router configuration',
      });
    }
    return next(e);
  });

  on('command.run', { command: 'model' }, async ($, e, next) => {
    const result = await next(e);
    if (e.origin.kind !== 'plugin') {
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
      await changeMode($, runtime, action === 'auto' ? 'auto' : 'manual');
      return { text: action === 'auto' ? 'Auto routing enabled.' : 'Manual mode: Claude’s model is preserved.' };
    }
    if (action === 'pin')
      return { text: TIERS.includes(tier) ? await setPin($, runtime, tier) : `Choose ${TIERS.join(', ')}.` };
    const storedView = await readView($, runtime);
    const view = { ...storedView, mode: await modeOf($, runtime, storedView.mode) };
    if (!(await $.session.surfaces()).length) return { text: detailText(config, view) };
    await $.ui.open({ id: PANE, title: PANE_TITLE, focus: true, closeOnEscape: true });
    return {};
  });

  on('turn.start', (_$, e, next) => {
    turnConfigs.set(e.turnId, config);
    prompts.set(e.turnId, clip(e.text, config.context.maxTextChars));
    return next(e);
  });

  on('turn.step', async function* ($, e, next) {
    if (e.agentId) return yield* next(e);
    const cfg = turnConfigs.get(e.turnId) ?? config;
    const sessionId = await $.session.id();
    const nativeModel = await $.session.model();
    const view = await readView($, runtime);
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
    const context = await contextOf($, loop);
    const settings = await $.settings.read();
    const availableModels = settings.availableModels;
    const key = `${sessionId}:${e.turnId}:${loop.generation}`;
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
            const credentials = await resolveCredentials(activeClassifier(cfg), (name) => settingOf($, options, name));
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
              credentials: { ...runtime.view?.credentials, [cfg.classifier]: credentials.missing },
            });
            const adviceStarted = Date.now();
            const result = pin
              ? { advice: null, error: null }
              : await clientOf(cfg.classifier).ask({
                  request: (url, init) => $.http.fetch(url, init),
                  sleep: (ms, args) => $.clock.sleep(ms, args),
                  config: cfg,
                  apiKey: credentials.apiKey,
                  endpoint: credentials.endpoint,
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
            const previous = loop.decision;
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
            // Manual, /clear and turn completion abort the controller; one may land during the write.
            if (!written.isSet || controller.signal.aborted) return null;
            if (previous?.model && previous.model !== selected.decision.model && !selected.decision.pinned)
              $.ui.toast(switchToast(cfg, previous, selected.decision, selected.decision.estimate));
            await updateView($, runtime, {
              phase: 'routed',
              selectedModel: selected.decision.model,
              actualModel: null,
              tier: selected.decision.tier,
              effort: selected.decision.effort,
              reason: selected.decision.reason,
              contextTokens: context.tokens,
              contextKnown: context.known,
              comparison: selected.decision.comparison,
              // A turn that started before a classifier switch routes on its own classifier's answer, but the
              // pane now labels the new one: its readings stay off the view.
              ...(cfg.classifier === config.classifier
                ? {
                    error: result.error,
                    health: healthOf(clientOf(cfg.classifier), cfg.classifier),
                    adviceMs:
                      pin || ['missing-key', 'missing-account', 'busy', 'paused'].includes(result.error)
                        ? null
                        : Date.now() - adviceStarted,
                    adviceChoice: result.advice?.choice ?? null,
                    probabilities: result.advice?.probabilities ?? null,
                    estimate: selected.decision.estimate ?? null,
                  }
                : {}),
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
      // A substituted reply is not the tier's: the strip and trend must not count it as one.
      const tier = isSameModel(request.model, response.usage?.model) ? loop.decision.tier : null;
      if (written.isSet) await updateView($, runtime, responseMetrics(runtime.view, response, tier));
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
    // Only the main conversation is routed, so an agent compaction changes nothing here.
    if (!result.skip && e.trigger !== 'precompute' && !e.agentId) {
      const ref = { ...LOOP, id: 'main' };
      const loop = (await $.state.get(ref)).value;
      if (loop) await $.state.set(ref, resetHistory(loop));
      for (const controller of controllers) controller.abort();
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
      credentials: runtime.view?.credentials ?? null,
      health: healthOf(clientOf(config.classifier), config.classifier),
      configPath: config.nativePath,
      phase: runtime.view?.phase === 'unavailable' ? 'unavailable' : 'ready',
      error: runtime.view?.phase === 'unavailable' ? runtime.view.error : null,
    };
    return next(e);
  });

  // While the classifier runs, the turn's spinner says so; the engine's own word returns once the route is set.
  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    if (e.props.message !== null) return next(e);
    const view = await readView($, runtime);
    return view.phase === 'choosing' ? next({ ...e, props: { ...e.props, message: 'Choosing model' } }) : next(e);
  });

  // Paused or broken routing stays visible in the prompt footer even when the band is collapsed.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const view = await readView($, runtime);
    const label =
      view.phase === 'unavailable'
        ? 'router unavailable'
        : (await modeOf($, runtime, view.mode)) === 'manual'
          ? 'router off'
          : null;
    return label ? next({ ...e, props: { ...e.props, modes: [...e.props.modes, label] } }) : next(e);
  });

  on('ui.render', { component: ['AbovePrompt', 'Pane'] }, async ($, e, next) => {
    if (e.component === 'Pane' && e.requestId !== PANE) return next(e);
    const storedView = await readView($, runtime);
    const view = { ...storedView, mode: await modeOf($, runtime, storedView.mode) };
    const elements = $.ui.resolve(e);
    const { Box } = elements;
    const usage = await $.session.usage().catch(() => null);
    const openPane = () => $.ui.open({ id: PANE, title: PANE_TITLE, focus: true, closeOnEscape: true });
    if (e.component === 'AbovePrompt') {
      if (e.props.hasSurvey) return next(e);
      return Box({
        flexDirection: 'column',
        children: [
          await next(e),
          renderBand(
            elements,
            config,
            view,
            usage,
            { columns: e.props.bodyColumns, agentId: e.props.view?.agentId },
            {
              open: openPane,
              mode: (mode) => changeMode($, runtime, mode),
              pin: async (tier) => $.ui.toast(await setPin($, runtime, tier)),
              unpin: () => updateView($, runtime, { pendingPin: null }),
              key: () => openKeySettings($),
              toggleDetail: async () => {
                const bandDetail = !view.bandDetail;
                await $.store.set(BAND_DETAIL, bandDetail).catch(() => {});
                await updateView($, runtime, { bandDetail });
              },
            },
          ),
        ],
      });
    }
    const settings = await $.settings.read().catch(() => ({}));
    const modelOptions = Object.keys(config.models).filter((alias) =>
      isModelAllowed(config.models[alias].id, settings.availableModels, view.nativeModel),
    );
    const editRoute = (tier, change) => {
      const draft = routeDraftOf(config, runtime.view ?? view);
      const current = effectiveRoutes(draft, config).routes[tier];
      return updateView($, runtime, {
        routeDraft: { ...draft, routes: { ...draft.routes, [tier]: change(current) } },
        notice: null,
      });
    };
    // Every pane save adopts the file as written, which may name another classifier than before: a hand edit
    // meanwhile, or a row press. Then the new classifier starts clean and the old one's readings leave the view;
    // an unavailable reason stays.
    const adopt = async (loaded) => {
      const switched = loaded.classifier !== config.classifier;
      config = loaded;
      if (!switched) return {};
      clientOf(config.classifier).restore(null);
      const current = runtime.view ?? view;
      return {
        ...CLEARED_READINGS,
        error: current.phase === 'unavailable' ? current.error : null,
        credentials: await credentialsOf($, options, config),
        health: healthOf(clientOf(config.classifier), config.classifier),
      };
    };
    const save = async (change, saved) => {
      const result = await saveConfig($, config.nativePath, change);
      if (result.error) return updateView($, runtime, { notice: result.error });
      const reset = await adopt(result.config);
      return updateView($, runtime, { ...reset, ...saved(config) });
    };
    // A classifier choice applies at once; `undo` is the one Undo returns to, null after an Undo.
    const activateClassifier = (id, undo) =>
      !id || id === config.classifier || !Object.hasOwn(config.classifiers, id)
        ? undefined
        : save(
            (file) => withClassifier(file, id),
            () => ({ classifierUndo: undo, notice: null }),
          );
    return renderPanel(
      elements,
      config,
      view,
      usage,
      {
        mode: (mode) => changeMode($, runtime, mode),
        tab: (tab) => updateView($, runtime, { tab, notice: null, classifierUndo: null }),
        help: () => updateView($, runtime, { help: !view.help }),
        pin: async (tier) => {
          await updateView($, runtime, { notice: await setPin($, runtime, tier) });
        },
        unpin: () => updateView($, runtime, { pendingPin: null, notice: null }),
        key: async () => {
          openKeySettings($);
          await $.ui.close({ id: PANE });
        },
        copyPath: async (press) => {
          await $.ui.copy({ text: config.nativePath, surface: press?.surface });
          await updateView($, runtime, { notice: 'Path copied.' });
        },
        close: () => $.ui.close({ id: PANE }),
        routeModel: (tier, alias) =>
          editRoute(tier, (route) => ({
            model: alias,
            effort: config.models[alias]?.efforts.includes(route.effort) ? route.effort : null,
          })),
        routeEffort: (tier, effort) => editRoute(tier, (route) => ({ model: route.model, effort })),
        baseline: async (tier) => {
          const draft = routeDraftOf(config, runtime.view ?? view);
          await updateView($, runtime, { routeDraft: { ...draft, baselineTier: tier }, notice: null });
        },
        saveRoutes: async () => {
          const draft = (runtime.view ?? view).routeDraft;
          if (!draft) return updateView($, runtime, { notice: 'No route changes to save.' });
          return save(
            (file) => withRoutes(file, draft),
            () => ({ routeDraft: null, notice: 'Saved routes. They apply from the next turn.' }),
          );
        },
        discardRoutes: () => updateView($, runtime, { routeDraft: null, notice: null }),
        resetRoutes: () =>
          updateView($, runtime, {
            routeDraft: {
              ...structuredClone({ routes: DEFAULTS.routes, baselineTier: DEFAULTS.baselineTier }),
              base: routeDraftOf(config, {}).base,
            },
            notice: 'Defaults loaded. Save routes to remove your overrides from router.json.',
          }),
        tune: (key, value) =>
          updateView($, runtime, {
            tuning: { ...(runtime.view ?? view).tuning, [key]: value },
            tuningBase: (runtime.view ?? view).tuningBase ?? tuningOf(config),
            notice: null,
          }),
        saveTuning: async () => {
          const current = runtime.view ?? view;
          const base = current.tuningBase ?? tuningOf(config);
          const draft = { ...base, ...current.tuning };
          if (Object.keys(base).every((key) => draft[key] === base[key]))
            return updateView($, runtime, { notice: 'No tuning changes to save.' });
          return save(
            (file) => withTuning(file, draft, base),
            () => ({ tuning: null, tuningBase: null, notice: 'Saved. New tuning applies to future turns.' }),
          );
        },
        resetTuning: () => updateView($, runtime, { tuning: null, tuningBase: null, notice: null }),
        classifier: (id) => activateClassifier(id, config.classifier),
        undoClassifier: () => activateClassifier((runtime.view ?? view).classifierUndo, null),
        classifierTimeout: (timeoutMs) =>
          save(
            (file) => withClassifierTimeout(file, config.classifier, timeoutMs),
            (saved) => ({
              notice: `Saved. ${activeClassifier(saved).label} waits ${timeoutMs} ms from the next turn.`,
            }),
          ),
      },
      { modelOptions },
    );
  });
}
