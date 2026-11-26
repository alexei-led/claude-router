import { acceptActivity, acceptPhase } from '../lib/activity.mjs';
import {
  ACTIVITY_CONTRACT,
  advanceDown,
  advanceRun,
  emptySession,
  recordMetrics,
  recordStore,
  recordTurn,
  turnActivity,
} from '../lib/activity-stats.mjs';
import { advanceDemand, assessCandidates, initialAutoState, selectTarget } from '../lib/auto-engine.mjs';
import { adviceActivity, autoRoute, observeAutoFallback } from '../lib/auto-route.mjs';
import { renderBand, renderRouteLine, switchToast } from '../lib/band.mjs';
import { ClassifierClient } from '../lib/classifier-client.mjs';
import { classifierDestination, resolveCredentials } from '../lib/classifier-contract.mjs';
import {
  ACTIVITY_MODES,
  activeClassifier,
  CLASSIFY,
  DEFAULTS,
  editActivity,
  effectiveRoutes,
  loadConfig,
  MIGRATION_HINT,
  MIN_CLAUDE_CODE,
  PLAN_ACCOUNT,
  ROUTING_ENGINES,
  ROUTING_MODES,
  supportedVersion,
  TIERS,
  tuningOf,
} from '../lib/config.mjs';
import { billingOf, planLimits } from '../lib/costs.mjs';
import {
  addTurnRow,
  appendDecisions,
  continuedGoal,
  DECISIONS_PREFIX,
  decisionLines,
  decisionRow,
  decisionsAfterReset,
  endRow,
  failureRow,
  isGoalOrigin,
  isProgressOrigin,
  MAX_ROWS,
  originKind,
  progressInput,
  prunedDecisions,
  queueOrigin,
  readDecisions,
  takeOrigin,
} from '../lib/decisions.mjs';
import {
  activityDetailLines,
  classifierStatus,
  classifierTimed,
  GATEWAY_CLEANUP,
  GATEWAY_SETTINGS,
  missingCredentials,
  modelName,
  NOT_A_TIER_REASON,
  pinCard,
  pluginIdOf,
  savingsLine,
  storeAgreementLine,
  unavailableReason,
  unpricedLine,
} from '../lib/display.mjs';
import { applyEvidenceOverlay, parseEvidenceOverlay } from '../lib/evidence-apply.mjs';
import {
  clip,
  currentStepText,
  hasImages,
  historySignature,
  observedActivity,
  progressEvidence,
  promptIndex,
  routingBucket,
  stripReminders,
} from '../lib/facts.mjs';
import {
  accountNames,
  accountOfModel,
  activeHolds,
  classifyFailure,
  clearedModel,
  clearedSince,
  dueProbes,
  failureHold,
  HOLDS_PREFIX,
  heldAsSeen,
  heldIds,
  heldKey,
  holdCause,
  holdModel,
  isActive,
  planAccountsOf,
  probeFailed,
  readHold,
  releaseHold,
} from '../lib/failover.mjs';
import { heldCause, heldRows, holdsText, holdText, releaseRow } from '../lib/holds.mjs';
import { KEYWORDS, keywordRaises, promptKeyword } from '../lib/keywords.mjs';
import {
  absorbedKeys,
  archiveKey,
  archiveValue,
  deadKeys,
  foldChunks,
  settledSessions,
  withoutFolded,
} from '../lib/ledger-fold.mjs';
import { addTurn, checkDue, checkedHeld, heldRecord, historyKeys, LEDGER_KINDS, LEDGERS } from '../lib/ledgers.mjs';
import { applyMode, modeLabel, readProjectMode, resolveRoutingMode } from '../lib/modes.mjs';
import { renderPanel } from '../lib/panel.mjs';
import { sameTaskOf } from '../lib/policy.mjs';
import {
  applyRoutingEdits,
  applyRoutingPatch,
  readRoutingPreference,
  routingConflict,
  routingEdits,
} from '../lib/project-routing.mjs';
import { providerFile, providerName } from '../lib/providers.mjs';
import { startedSince } from '../lib/records.mjs';
import {
  appendTrace,
  bufferTrace,
  isTraceKey,
  mergeTraceExport,
  newTrace,
  readTrace,
  TRACE_ACTIVE_MS,
  TRACE_EXPORT_BYTES,
  TRACE_PREFIX,
  TRACE_SESSION_BYTES,
  TRACE_STORE_BYTES,
  TRACE_VERSION,
  traceAdmission,
  traceBytes,
  traceConfig,
  traceOperation,
  traceResponse,
  traceVictims,
} from '../lib/replay-trace.mjs';
import {
  canMoveUp,
  canTakeOver,
  cellForModel,
  chooseRoute,
  continueRoute,
  economicConfig,
  emptyLoop,
  hasRoutedDecision,
  isModelAllowed,
  isNativeFallback,
  isSameModel,
  nativeFacts,
  observedMove,
  observeResponse,
  ownRoute,
  prepareLoop,
  resetHistory,
  servesOneTurn,
} from '../lib/route.mjs';
import { LINE_MODES, lineId, lineModeOf, lineOf, routeOf, showsLine } from '../lib/route-line.mjs';
import {
  compareModels,
  modelSpec,
  observedReplyUsd,
  SAVINGS_RESET_KEY,
  sessionCacheTtl,
  subagentCacheTtl,
  unpricedCause,
} from '../lib/savings.mjs';
import {
  addAgentReply,
  agentFrontmatter,
  classifiedAlias,
  coreModelOf,
  flushedAgent,
  moveOf,
  passReason,
  RESPAWN_WINDOW_MS,
  recordAgent,
  SPAWN_DEADLINE_MS,
  spawnPrompt,
  spawnRecord,
  typeRoute,
} from '../lib/subagents.mjs';
import { argumentHint, routerSuggestions } from '../lib/subcommands.mjs';
import { POLICY_ROWS, routeDraftOf } from '../lib/ui/model/draft.mjs';
import { keyHelpOf } from '../lib/ui/model/frame.mjs';
import { isGraphical } from '../lib/ui/tokens.mjs';
import { PERIOD_KEY, PERIODS, recordUsage, replyEntry } from '../lib/usage.mjs';
import {
  CLEARED_READINGS,
  continuationView,
  healthOf,
  initialView,
  responseMetrics,
  switchView,
} from '../lib/view.mjs';

// The engine follows $ only into functions declared in this file, never across an import: every helper that takes $
// lives here, and the pure parts live in lib/.

const VIEW = { plugin: 'router', key: 'view' };
const LOOP = { plugin: 'router', key: 'loops' };
// One record per route line placed, by its `$.ui.place` id: what its `Placed` row draws.
const LINES = { plugin: 'router', key: 'lines' };
const PANE = 'jev-router';
const PANE_TITLE = 'Router';
const BAND_DETAIL = 'band:detail';
// Whether and when a turn leaves a route line (lib/route-line.mjs), kept across sessions.
const ROUTE_LINE = 'route:line';
const MODE_PREFIX = 'mode:';
// When the toast for one reason routing cannot run last showed; the reason is appended.
const UNAVAILABLE_NOTICE_PREFIX = 'notice:unavailable:';
const UNAVAILABLE_NOTICE_INTERVAL_MS = 24 * 60 * 60 * 1000;
// The session's routing mode override (lib/modes.mjs), apart from its auto|manual MODE_PREFIX.
const ROUTING_MODE_PREFIX = 'routing-mode:';
const isSet = (value) => /^(1|true|yes|on)$/i.test(String(value ?? '').trim());

// Claude Code runs one plugin's $.store calls one at a time, each reading the whole store file. A bulk read goes
// STORE_SLICE keys at a time, so a press or a turn's store call waits for one slice, not for the whole read.
const STORE_SLICE = 20;

/** The values of `keys`, in order, read STORE_SLICE at a time. */
async function getMany($, keys) {
  const values = [];
  for (let i = 0; i < keys.length; i += STORE_SLICE)
    values.push(...(await Promise.all(keys.slice(i, i + STORE_SLICE).map((key) => $.store.get(key)))));
  return values;
}

/** @typedef {import('../lib/ledger-fold.mjs').LedgerRead} LedgerRead */
/** @typedef {ReturnType<typeof readTrace> | ReturnType<typeof newTrace>} TraceRecord */
/**
 * @typedef {object} TraceHold
 * @property {string} sessionId
 * @property {TraceRecord | null} record
 * @property {unknown} persisted
 * @property {number} lostWrites
 * @property {Set<string>} reasons
 * @property {Map<string, any>} turns
 * @property {number} nextTurn
 * @property {string | null} config
 * @property {{ events: object[], excludedEvents?: number } | null} controls
 * @property {{ bytes: number, at: number } | null} [measured] the store's bytes outside the trace records, and when
 */

/** A main turn an API error ended, with the count of re-runs it belongs to. @typedef {{ turnId: string, model: string, cause: string, reruns: { count: number } }} FailedTurn */

// Everything the hooks change between events, in one object `register()` creates and passes to its helpers. Module
// variables, not $.state: a reload starts them over, and the view is written through to $.state as it changes.
function createRouter(options) {
  return {
    options,
    initialized: false,
    initializing: null,
    // router.json failed to load at this session's start: it is not read again before the next start.
    loadFailed: false,
    config: loadConfig(),
    // Each turn's config, fixed at turn.start, so a pane save mid-turn does not change the turn.
    turnConfigs: new Map(),
    // The main turns whose turn.complete runs and has not yet taken their decision rows: a failure row added meanwhile
    // goes out with them and the turn's end row.
    completing: new Set(),
    // One client per classifier, each with its own breaker and in-flight slot: a turn that started under one
    // classifier finishes with it, and its answer, failures or pause never land on another. Reviews and spawns have
    // clients of their own (reviewClientOf, spawnClientOf).
    clients: new Map(),
    prompts: new Map(),
    decisions: new Map(),
    // Where each turn's prompt came from (originKind), matched at turn.start: the submission running its prompt.submit
    // (`submitting`), else the oldest queued one with the turn's text (`origins`, queueOrigin).
    submitting: null,
    origins: [],
    turnOrigins: new Map(),
    // The session's active goal, the last prompt from a goal origin, clipped, `{ sessionId, text }`, in memory only;
    // and each progress turn's report (`progressNotes`), which the classifier reads as dialogue (progressInput).
    goal: null,
    goalTurnId: null,
    goalEpoch: 0,
    turnGoals: new Map(),
    progressNotes: new Map(),
    // Each turn's decision rows until turn.complete writes them, with the turn's end, to the session's record, held as
    // `{ sessionId, record }` once read (`decisionRecord`).
    turnDecisions: new Map(),
    // The route the last routed turn ran, to tell whether the next one moved it; null at a session's start.
    lastRoute: null,
    // The model of the last main request sent: the one an API error that ends the turn failed on (holdFailedModel).
    lastRequested: /** @type {string | null} */ (null),
    // The latest main turn's id: `StopFailure` carries none, and its failure row belongs to that turn.
    mainTurnId: /** @type {string | null} */ (null),
    // The main turn whose API error held something, and the main turn that completed on an error: the engine raises
    // StopFailure and turn.complete in either order, so whichever comes second runs the turn again (rerunTurn). And
    // how many re-runs in a row were queued: a turn that ends any other way starts a new count, so a failure or a
    // rejected submit that belongs to the old one leaves the new one alone.
    failedTurn: /** @type {FailedTurn | null} */ (null),
    erroredTurn: /** @type {string | null} */ (null),
    reruns: { count: 0 },
    decisionRecord: null,
    trace: /** @type {TraceHold | null} */ (null),
    traceFreshSession: null,
    traceClearSession: null,
    traceStartedSession: null,
    traceFailures: 0,
    // The trace flush in progress (flushTraceLater), so flushes run one at a time and session.end waits for the last;
    // and the starts of flushes whose timer has not fired, which session.end runs at once.
    traceFlushing: /** @type {Promise<void> | null} */ (null),
    traceDue: /** @type {Set<() => void>} */ (new Set()),
    // The account holds a turn read (accountHoldsOf), by the accounts' names; null to read them again.
    accountHolds: /** @type {{ id: string, value: Record<string, import('../lib/failover.mjs').Hold> } | null} */ (
      null
    ),
    // The auto|manual mode this process last wrote or read for each session, so a turn does not write it again.
    storedModes: /** @type {Map<string, string>} */ (new Map()),
    // The read of the counts kept across sessions in progress (readLedgers), a refresh of them due from a timer
    // (refreshLedgersLater), and the pane's refresh (refreshPane).
    ledgerRead: /** @type {{ sessionId: string, read: Promise<{ patch: object, read: LedgerRead[] }> } | null} */ (
      null
    ),
    ledgerRefreshDue: false,
    // The checks of this session's records against the store in progress, by kind (checkOwn), and a fold chain
    // running (foldLater).
    ownChecks: /** @type {Map<string, Promise<void>>} */ (new Map()),
    folding: false,
    paneRefresh: /** @type {Promise<void> | null} */ (null),
    traceOperations: new Map(),
    // The surfaces that showed the unavailable toast this session, so an attach never repeats it on the same one.
    noticeSurfaces: new Set(),
    // Whether this session already said its auto catalog declares no capability, so it says it once.
    capabilityNoticed: false,
    controllers: new Set(),
    turnControllers: new Map(),
    view: /** @type {Record<string, unknown> | null} */ (null),
    modes: new Map(),
    // Each session's routing mode override (null: none), as read from or written to the store.
    routingModes: new Map(),
    project: null,
    projectWrite: /** @type {Promise<unknown> | null} */ (null),
    projectUndo: null,
    // Each routed turn's activity record until turn.complete adds it to the stats, and the session's open run of
    // one activity, flushed to the store when it ends.
    turnActivities: new Map(),
    // Each turn's classifier review in flight or answered (reviewMidTurn): `{ controller, generation, observedUpTo, answer }`.
    reviews: new Map(),
    run: null,
    // The route a cheaper activity move went to, while the turns stay on it (advanceDown); else null.
    afterDown: null,
    // Counts every switch to routing off; a turn compares it with its own start to see routing went off meanwhile.
    offSwitches: 0,
    // Each turn's routed replies (replyEntry) until turn.complete adds them to the session's usage record.
    turnUsage: new Map(),
    // The counts kept across sessions, by LEDGERS kind: this session's record (`own`, `{ sessionId, record }`), held
    // here so a refresh never reads it back from the store while a write of it is pending, and the sum of every other
    // session's (`others`), read on refresh. The view shows their sum.
    // `othersResetAt` is the reset marker the others were read under: a newer one means they are read again.
    ledgers: Object.fromEntries(
      Object.keys(LEDGERS).map((kind) => [kind, { own: null, others: null, othersResetAt: null }]),
    ),
    // Bumped by Reset activity stats, so a store write that read the counts before the reset skips.
    statsResets: 0,
    // The last reset (ms) any store read saw, for what a pane draws without a store read; null for none.
    resetAt: /** @type {number | null} */ (null),
    // Bumped by each pin press, and each pinned turn's count when its route was written: the pin is used up when the
    // first request goes out on that route, unless it was pressed again meanwhile.
    pinPresses: 0,
    turnPins: new Map(),
    // Each spawned agent's record by agentId (spawnRecord, `running` between its steps and its turn's end), and when
    // each parent loop last finished an agent of a type, for respawns.
    agents: new Map(),
    finished: new Map(),
    // The model each agent's last request ran, for holding after a StopFailure, which names no model.
    agentRequests: new Map(),
    // Main steps in flight, and the agent's hold clears they must merge into their own loop write (clearAgentHeld).
    mainInFlight: 0,
    agentClears: new Map(),
    // Each agent type's definition frontmatter by provider and type, read once per session (agentDefinition).
    definitions: new Map(),
  };
}

// These writes share the main-turn lifecycle with decision rows. There is no background writer.
// Quota scans fail closed; the host has no transaction spanning scans, deletes and a set.
function traceFailed(router) {
  if (router.trace) {
    router.trace.lostWrites++;
    router.trace.reasons.add('recorder-error');
  } else router.traceFailures++;
}

async function ensureTrace($, router, e, turn, loop, loaded, fresh) {
  try {
    if (turn.config.routingEngine !== 'shadow' || router.config.routingEngine !== 'shadow') {
      if (router.trace) router.trace.reasons.add('mode-gap');
      return;
    }
    const sessionId = await $.session.id();
    if (router.trace?.sessionId === sessionId && router.trace.record) return;
    const previous = router.trace?.sessionId === sessionId ? router.trace : null;
    const at = Date.now();
    /** @type {TraceHold} */
    const held = {
      sessionId,
      record: null,
      persisted: null,
      lostWrites: (previous?.lostWrites ?? 0) + router.traceFailures,
      reasons: new Set(previous?.reasons ?? []),
      turns: new Map(),
      nextTurn: 1,
      config: null,
      controls: null,
      measured: null,
    };
    router.trace = held;
    router.traceFailures = 0;
    try {
      const raw = await $.store.get(`${TRACE_PREFIX}${sessionId}`);
      held.record = readTrace(raw);
      held.persisted = raw;
      if (raw !== undefined) held.reasons.add(loaded ? 'reload' : 'resume');
    } catch {
      held.lostWrites++;
      held.reasons.add('lost-write');
    }
    let freshHistory = false;
    if (fresh && e.index === 0 && !loaded && held.persisted === undefined) {
      // API history is normalized for this request; startup reminders are user rows, not prior assistant work.
      const messages = await transcript($);
      freshHistory =
        Array.isArray(messages) &&
        messages.length > 0 &&
        messages.every(
          (message) =>
            message?.role === 'user' &&
            Array.isArray(message.content) &&
            message.content.length > 0 &&
            message.content.every((block) => block && typeof block.type === 'string' && block.type.length > 0),
        );
    }
    if (!freshHistory) held.reasons.add('mid-session');
    held.record ??= newTrace(at, { configured: turn.configured, config: turn.config, loop }, [...held.reasons]);
    if (traceBytes(held.record) > TRACE_SESSION_BYTES - 1024) {
      held.record = {
        version: TRACE_VERSION,
        startedAt: at,
        updatedAt: at,
        active: true,
        incomplete: ['mid-session', 'store-guard'],
        lostWrites: 0,
        capped: { at, turns: 0, events: 0 },
        events: [],
      };
      held.reasons.add('store-guard');
    }
    held.config = JSON.stringify({ configured: traceConfig(turn.configured), config: traceConfig(turn.config) });
  } catch {
    traceFailed(router);
  }
}

function traceTurn(router, e) {
  const held = router.trace;
  if (!held) return null;
  if (!held.turns.has(e.turnId)) held.turns.set(e.turnId, { number: held.nextTurn++, buffer: null });
  return held.turns.get(e.turnId);
}

function addTrace(router, e, event) {
  try {
    const held = router.trace;
    if (!held || router.config.routingEngine !== 'shadow') return;
    const turn = traceTurn(router, e);
    if (held.record.capped || turn.buffer?.excludedEvents) {
      turn.buffer = { events: [], bytes: 2, excludedEvents: (turn.buffer?.excludedEvents ?? 0) + 1 };
      return;
    }
    const remaining = Math.max(0, TRACE_SESSION_BYTES - traceBytes(held.record) - 1024);
    turn.buffer = bufferTrace(turn.buffer, { ...event, turn: turn.number, index: e.index }, remaining);
  } catch {
    traceFailed(router);
  }
}

function traceOp(router, e, cfg, kind, input, selected, messages = null) {
  try {
    if (cfg.routingEngine !== 'shadow' || !router.trace || router.config.routingEngine !== 'shadow') return;
    if (router.trace.record.capped || traceTurn(router, e).buffer?.excludedEvents) return;
    const operations = router.traceOperations.get(e.turnId) ?? [];
    operations.push(
      traceOperation(
        kind,
        input.now ?? Date.now(),
        { ...input, taskProgress: messages ? progressEvidence(messages) : null },
        selected,
      ),
    );
    router.traceOperations.set(e.turnId, operations);
  } catch {
    traceFailed(router);
  }
}

function traceRequest(router, e, turn, request, mode, loop) {
  try {
    if (turn.config.routingEngine !== 'shadow' || router.config.routingEngine !== 'shadow' || !router.trace) return;
    const cfg = { configured: traceConfig(turn.configured), config: traceConfig(turn.config) };
    const fingerprint = JSON.stringify(cfg);
    if (router.trace.config !== fingerprint) {
      addTrace(router, e, { type: 'config', at: Date.now(), ...cfg });
      router.trace.config = fingerprint;
    }
    if (router.trace.controls) {
      const controls = router.trace.controls;
      router.trace.controls = null;
      if (controls.excludedEvents) {
        const active = traceTurn(router, e);
        active.buffer = {
          events: [],
          bytes: 2,
          excludedEvents: controls.excludedEvents + (active.buffer?.events.length ?? 0),
        };
      } else for (const event of controls.events) addTrace(router, e, event);
    }
    addTrace(router, e, {
      type: 'request',
      at: Date.now(),
      model: request.model,
      effort: request.effort,
      engineModel: e.model,
      engineEffort: e.effort,
      mode,
      messageCount: e.messageCount,
      reviewedAt: loop.reviewedAt,
      observedFrom: loop.observedFrom,
      operations: router.traceOperations.get(e.turnId) ?? [],
    });
    router.traceOperations.delete(e.turnId);
  } catch {
    traceFailed(router);
  }
}

function recordTraceResponse(router, e, request, response, ttl, at) {
  try {
    addTrace(router, e, traceResponse(at, request, response, ttl));
  } catch {
    traceFailed(router);
  }
}

function traceReset(router, event) {
  try {
    router.trace.controls = bufferTrace(router.trace.controls, event, 4096);
  } catch {
    traceFailed(router);
  }
}

function traceControl(router) {
  try {
    if (router.config.routingEngine !== 'shadow' || !router.trace) return;
    const view = router.view;
    const event = {
      type: 'control',
      at: Date.now(),
      mode: view?.routingMode,
      pin: view?.pendingPin,
      enabled: view?.mode !== 'manual',
    };
    router.trace.controls = bufferTrace(router.trace.controls, event, 4096);
  } catch {
    traceFailed(router);
  }
}

// `captured`: a completed turn flushTraceLater took when the turn ended, written even after the engine left shadow.
async function flushTrace($, router, turnId = null, ending = false, captured = null) {
  try {
    const held = router.trace;
    if (!held || (router.config.routingEngine !== 'shadow' && !captured)) return;
    const turn = captured ?? held.turns.get(turnId);
    held.turns.delete(turnId);
    try {
      const at = Date.now();
      // Only the trace records are read each time; the rest of the store is measured now and then (measureStore).
      const keys = await $.store.keys();
      let traces = await readTraces($, keys);
      if (traces.some(([, value]) => value === undefined)) throw new Error('store-guard');
      const traceTotal = traceBytes(Object.fromEntries(traces));
      const measured = held.measured;
      if (
        !measured ||
        at - measured.at > TRACE_MEASURE_MS ||
        measured.bytes + traceTotal > TRACE_STORE_BYTES - TRACE_MEASURE_MARGIN
      )
        held.measured = { bytes: await measureStore($, keys), at };
      const otherBytes = held.measured?.bytes ?? 0;
      if (otherBytes + traceTotal > TRACE_STORE_BYTES) throw new Error('store-guard');
      const resetAt = await $.store.get(SAVINGS_RESET_KEY);
      if (Number.isFinite(resetAt) && held.record.startedAt < resetAt) {
        held.record = {
          version: TRACE_VERSION,
          startedAt: at,
          updatedAt: at,
          active: true,
          incomplete: ['reset', 'mid-session'],
          lostWrites: 0,
          capped: null,
          events: [],
        };
        held.persisted = undefined;
        held.reasons.add('reset');
      }
      const key = `${TRACE_PREFIX}${held.sessionId}`;
      const raw = traces.find(([name]) => name === key)?.[1];
      if (raw !== undefined && !readTrace(raw)) throw new Error('conflict');
      // A stored trace from before the last reset is history it deleted, though another session's background delete
      // may not have reached it yet: it is written over, never merged back.
      const deleted = raw !== undefined && Number.isFinite(resetAt) && !startedSince(raw, resetAt);
      if (!deleted && JSON.stringify(raw) !== JSON.stringify(held.persisted)) {
        held.reasons.add('conflict');
        if (raw)
          held.record = mergeTraceExport(null, [
            [key, held.record],
            [key, raw],
          ]).sessions[key];
      }
      if (held.record.events.length === 1 && traceBytes(held.record) > TRACE_SESSION_BYTES - 1024)
        throw new Error('store-guard');
      // Nothing from before the last reset is written: a turn whose flush waited across a reset in another session
      // keeps only what came after it.
      const sinceReset = (event) => !(Number.isFinite(resetAt) && event.at < resetAt);
      const events = (turn?.buffer?.events ?? []).filter(sinceReset);
      if (ending && held.controls && !held.controls.excludedEvents)
        events.push(...held.controls.events.filter(sinceReset));
      const candidate = appendTrace(held.record, events, at, {
        lostWrites: held.lostWrites,
        reasons: [...held.reasons],
        excludedEvents: turn?.buffer?.excludedEvents ?? held.controls?.excludedEvents ?? 0,
      });
      candidate.active = !ending;
      for (const victim of traceVictims(traces, at, key, candidate)) {
        const previous = traces.find(([name]) => name === victim)?.[1];
        const current = await $.store.get(victim);
        if (
          readTrace(current) &&
          JSON.stringify(current) === JSON.stringify(previous) &&
          !(current.active && at - current.updatedAt <= TRACE_ACTIVE_MS)
        )
          await $.store.delete(victim);
      }
      // Read the traces again after eviction: missing/unreadable values never become a quota undercount.
      traces = await readTraces($, await $.store.keys());
      if (traces.some(([, value]) => value === undefined) || !traceAdmission(traces, key, candidate, otherBytes))
        throw new Error('store-guard');
      await $.store.set(key, candidate);
      held.record = candidate;
      held.persisted = candidate;
      held.lostWrites = 0;
      held.reasons.clear();
      if (ending) held.controls = null;
    } catch (error) {
      held.lostWrites++;
      const message = /** @type {Error} */ (error).message;
      held.reasons.add(message === 'conflict' ? 'conflict' : message === 'store-guard' ? 'store-guard' : 'lost-write');
    }
  } catch {
    traceFailed(router);
  }
}

// The trace records of `keys`, read.
const readTraces = ($, keys) =>
  Promise.all(keys.filter((key) => isTraceKey(key)).map(async (key) => [key, await $.store.get(key)]));

// The shared-store guard needs the bytes of every record, but each store read waits behind every other store call of
// the router and reads the whole file: the records outside the traces are measured once per session, again when the
// figure is older than TRACE_MEASURE_MS, and again whenever the guard would be within TRACE_MEASURE_MARGIN of its
// limit, so a store that shrank lets traces back at once.
const TRACE_MEASURE_MS = 15 * 60 * 1000;
const TRACE_MEASURE_MARGIN = 256 * 1024;

// The bytes of the records of `keys` outside the traces. A record deleted since the listing counts nothing; one that
// cannot be read throws.
async function measureStore($, keys) {
  const names = keys.filter((key) => !isTraceKey(key));
  const values = await getMany($, names);
  return values.reduce(
    (bytes, value, i) => (value === undefined ? bytes : bytes + traceBytes(names[i]) + traceBytes(value) + 2),
    2,
  );
}

// A turn's trace is written after the turn, from a timer, one flush at a time: the next prompt does not wait on it.
// The flush joins the queue at once, so session.end, which starts any whose timer has not fired, waits for it.
function flushTraceLater($, router, turnId) {
  // The turn is taken now: a switch away from shadow before the flush clears what the trace holds.
  const turn = router.trace?.turns.get(turnId) ?? null;
  router.trace?.turns.delete(turnId);
  /** @type {() => void} */
  let start = () => {};
  const due = new Promise((resolve) => {
    start = () => resolve(undefined);
  });
  router.traceDue.add(start);
  const flushed = (router.traceFlushing ?? Promise.resolve())
    .then(() => due)
    .then(() => flushTrace($, router, turnId, false, turn));
  router.traceFlushing = flushed;
  $.clock.after(0, () => {
    router.traceDue.delete(start);
    start();
    return flushed;
  });
}

// The queued trace flushes started at once and awaited (flushTraceLater): what completed turns hold is written.
async function drainTraces(router) {
  for (const start of router.traceDue) start();
  router.traceDue.clear();
  await router.traceFlushing?.catch(() => {});
}

async function exportTraces($, router) {
  try {
    // The turns that completed are written first, so the export ends at the last of them.
    await drainTraces(router);
    const keys = (await $.store.keys()).filter((key) => isTraceKey(key));
    const resetAt = await $.store.get(SAVINGS_RESET_KEY);
    // A trace from before the last reset is history Delete history removed, though its background delete may not have
    // run yet.
    const entries = (await Promise.all(keys.map(async (key) => [key, await $.store.get(key)]))).filter(
      ([, value]) => !Number.isFinite(resetAt) || startedSince(value, resetAt),
    );
    const root = router.config.nativePath.slice(0, router.config.nativePath.lastIndexOf('/'));
    let path = `${root}/router-traces.json`;
    if ((await $.fs.exists(path)) && (await $.fs.stat(path)).isLink) throw new Error('linked export');
    const previous = (await $.fs.exists(path)) ? JSON.parse(await $.fs.read(path)) : null;
    let merged = mergeTraceExport(previous, entries);
    if (traceBytes(merged) > TRACE_EXPORT_BYTES) {
      path = `${root}/router-traces-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      if ((await $.fs.exists(path)) && (await $.fs.stat(path)).isLink) throw new Error('linked export');
      const prior = (await $.fs.exists(path)) ? JSON.parse(await $.fs.read(path)) : null;
      merged = mergeTraceExport(prior, entries);
    }
    if (traceBytes(merged) > TRACE_EXPORT_BYTES) return 'Trace export exceeds the file budget; no file changed.';
    await $.fs.write(path, JSON.stringify(merged));
    return `Exported ${Object.keys(merged.sessions).length} retained trace sessions to ${path}.`;
  } catch {
    return 'Trace export failed; retained traces and existing exports were not intentionally removed.';
  }
}

function clientOf(router, id) {
  if (!router.clients.has(id)) router.clients.set(id, new ClassifierClient({ now: Date.now }));
  return router.clients.get(id);
}

// The mid-turn review's classifier client: an in-flight slot of its own, since a review's HTTP call cannot be aborted
// and outlives the turn that asked it; on the turn's client it would answer the next turn's decision `busy`.
function reviewClientOf(router, id) {
  const key = `review:${id}`;
  if (!router.clients.has(key)) router.clients.set(key, new ClassifierClient({ now: Date.now }));
  return router.clients.get(key);
}

// `router.view` is a write-through cache of $.state, because state reads are frozen within one dispatch.
async function readView($, router) {
  return (await $.state.get(VIEW)).value ?? router.view ?? initialView(await $.session.model());
}

// The session's mode as held or saved: null when none is saved, undefined when the store cannot be read. Only a saved
// mode is cached: the engine can draw the band before session.start, and a cached fallback from that render would
// override the start rule.
async function savedMode($, router) {
  const sessionId = await $.session.id();
  if (router.modes.has(sessionId)) return router.modes.get(sessionId);
  let saved;
  try {
    saved = await $.store.get(`${MODE_PREFIX}${sessionId}`);
  } catch {
    return undefined;
  }
  if (saved !== 'manual' && saved !== 'auto') return null;
  router.modes.set(sessionId, saved);
  router.storedModes.set(sessionId, saved);
  return saved;
}

// A store that cannot be read gives `fallback`, as no saved mode does: one failed read never turns routing off.
async function modeOf($, router, fallback = /** @type {string | null} */ ('auto')) {
  return (await savedMode($, router)) ?? fallback;
}

// A saved preference wins. A fresh auto-engine session starts on for any catalog model; table/shadow require a tier
// route or, with activity routing on, an activity override. Other models start with routing off. A mode the store could
// not give is not held, so a later read can still find the saved one.
async function startMode($, router, model) {
  const listed =
    router.config.routingEngine === 'auto'
      ? Object.values(router.config.models).some((spec) => isSameModel(spec.id, model))
      : cellForModel(router.config, model) !== null;
  const saved = await savedMode($, router);
  const mode = saved ?? (listed ? 'auto' : 'manual');
  if (saved !== undefined) router.modes.set(await $.session.id(), mode);
  return mode;
}

// A fresh Manual start on a non-tier model gets a reason the band can show; a saved mode carries none.
async function startView($, router, model) {
  const fresh = (await savedMode($, router)) == null;
  const mode = await startMode($, router, model);
  return fresh && mode === 'manual' ? { mode, reason: NOT_A_TIER_REASON } : { mode };
}

// The Usage tab's period as last chosen in any session; Session when none was or the store cannot be read.
async function periodOf($) {
  const saved = await $.store.get(PERIOD_KEY).catch(() => null);
  return PERIODS.includes(saved) ? saved : 'session';
}

async function rememberMode($, mode) {
  try {
    await $.store.set(`${MODE_PREFIX}${await $.session.id()}`, mode);
    return true;
  } catch {
    return false;
  }
}

// The routing mode a turn starts with and where it comes from. A store that cannot be read counts as no override.
async function routingModeOf($, router) {
  const { project } = router;
  const active = {
    preference: project?.preference.record?.patch.mode,
    local: project?.localMode,
    project: project?.sharedMode,
    profile: project?.profileMode,
  };
  const sessionId = await $.session.id();
  if (!router.routingModes.has(sessionId)) {
    const saved = await $.store.get(`${ROUTING_MODE_PREFIX}${sessionId}`).catch(() => null);
    router.routingModes.set(sessionId, ROUTING_MODES.includes(saved) ? saved : null);
  }
  return resolveRoutingMode({ ...active, session: router.routingModes.get(sessionId) });
}

// The prompt footer's word for the router: paused or broken routing, or a routing mode other than balanced, which
// changes what every routed turn costs. Null for none.
async function footerLabel($, router, view) {
  if (view.phase === 'unavailable') return 'routing unavailable';
  if ((await modeOf($, router, view.mode)) === 'manual') return 'routing off';
  const routingMode = view.routingMode;
  return routingMode && routingMode.mode !== 'balanced' ? `${routingMode.mode} mode (${routingMode.source})` : null;
}

const sameMode = (a, b) => a?.mode === b?.mode && a?.source === b?.source;

// A turn's configs when turn.start did not record them, as after a reload of the Mod mid-turn.
async function turnConfigOf($, router) {
  const configured = router.config;
  const routingMode = await routingModeOf($, router);
  return {
    config: configured.routingEngine === 'auto' ? { ...configured, routingMode } : applyMode(configured, routingMode),
    configured,
  };
}

// The turn routes on the configured routes as its routing mode moves them, fixed now so a change mid-turn waits for
// the next turn; a pin uses `configured` (decideTurn).
async function fixTurnConfig($, router, turnId) {
  const turn = await turnConfigOf($, router);
  router.turnConfigs.set(turnId, turn);
  const { routingMode } = turn.config;
  if (router.view && !sameMode(router.view.routingMode, routingMode)) await updateView($, router, { routingMode });
}

// `/router mode <mode|default>`: the session's override, kept for a resume of this session only. It changes the
// preferred route from the next turn; the route in use moves through the gates. No turn is aborted.
async function setRoutingMode($, router, value) {
  const sessionId = await $.session.id();
  const key = `${ROUTING_MODE_PREFIX}${sessionId}`;
  let saved = true;
  try {
    if (value === 'default') await $.store.delete(key);
    else await $.store.set(key, value);
  } catch {
    saved = false;
  }
  router.routingModes.set(sessionId, value === 'default' ? null : value);
  const routingMode = await routingModeOf($, router);
  await updateView($, router, { routingMode });
  if (router.config.routingEngine === 'shadow') traceControl(router);
  const unsaved =
    value === 'default'
      ? 'A resume of this session may bring the cleared mode back: the store could not be written.'
      : 'A resume of this session will not keep it: the store could not be written.';
  return [`Routing mode: ${modeLabel(routingMode)}, from the next turn.`, ...(saved ? [] : [unsaved])].join(' ');
}

function projectPath(dir, name) {
  const separator = dir.startsWith('/') ? '/' : '\\';
  return `${dir}${dir.endsWith(separator) ? '' : separator}${name}`;
}
const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const digest = async (text) =>
  hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))));

/** @param {string | null | undefined} path */
async function canonicalDirectory($, path) {
  if (!path) return null;
  const stat = await $.fs.stat(path, { resolve: true });
  return stat.kind === 'dir' && typeof stat.realPath === 'string' && stat.realPath ? stat.realPath : null;
}

// An existence probe can report false for both absence and denial (and for dangling links). Only a successful
// listing can establish absence after a failed stat on the floor; reject entries reported as links.
async function projectEntry($, parent, name) {
  try {
    return await $.fs.stat(projectPath(parent, name), { resolve: true });
  } catch (error) {
    if ((await $.fs.list(parent)).some((entry) => entry.name === name)) throw error;
    return null;
  }
}

async function projectScope($, profilePath, provider) {
  try {
    const [root, home, profile] = await Promise.all([
      canonicalDirectory($, await $.session.root()),
      canonicalDirectory($, await $.env.get('HOME')),
      canonicalDirectory($, profilePath),
    ]);
    if (!root || !home || !profile || root === home || root === profile) return null;
    const dir = projectPath(root, '.claude');
    const entry = await projectEntry($, root, '.claude').catch(() => undefined);
    if (entry === undefined)
      return { error: 'project .claude could not be verified; check its access and reload plugins' };
    if (entry?.realPath === profile) return null;
    if (entry?.isLink && !entry.realPath)
      return { error: 'project .claude is an unresolved symlink; remove it and reload plugins' };
    const id = JSON.stringify([root, profile, provider]);
    return {
      root,
      dir: entry ? dir : null,
      dirError: entry && (entry.isLink || entry.kind !== 'dir' || entry.realPath !== dir),
      localFile: providerFile(provider).replace(/\.json$/, '.local.json'),
      key: `project-routing:v1:${await digest(`key:${id}`)}`,
      identity: await digest(`identity:${id}`),
    };
  } catch {
    return null;
  }
}

async function readProjectFile($, scope, name, parse) {
  if (!scope?.dir) return { value: null, error: null };
  const label = `project .claude/${name}`;
  const recovery = 'edit or remove it and reload plugins';
  const ignored = (why) => ({ value: null, error: `${label} ${why}; ${recovery}` });
  if (scope.dirError) return ignored('is outside a regular, unlinked .claude directory');
  let text;
  try {
    const stat = await projectEntry($, scope.dir, name);
    if (!stat) return { value: null, error: null };
    const path = projectPath(scope.dir, name);
    if (stat.isLink) return ignored('is a symlink');
    if (stat.kind !== 'file' || stat.realPath !== path) return ignored('is not a regular file in the project scope');
    // The floor reads by path, so the link check is best effort if the filesystem changes before the read.
    text = await $.fs.read(path);
    if (typeof text !== 'string') return ignored('could not be read');
  } catch {
    return ignored('could not be read');
  }
  try {
    return { value: parse(text), error: null };
  } catch {
    return ignored('has invalid or unsupported routing settings');
  }
}

async function projectPreference($, scope, base) {
  if (!scope) return readRoutingPreference(undefined, '', base);
  try {
    const raw = await $.store.get(scope.key);
    return { ...readRoutingPreference(raw, scope.identity, base), raw };
  } catch {
    return {
      record: null,
      config: base,
      resettable: false,
      error: 'project routing preferences could not be read. Check plugin storage and refresh',
    };
  }
}

async function loadProjectRouting($, { config, profile, userFile }, overlay) {
  const resolved = await projectScope($, profile, config.provider);
  const scope = resolved?.key ? resolved : null;
  const trusted = applyEvidenceOverlay(config, overlay, userFile);
  const shared = await readProjectFile($, scope, 'router.json', readProjectMode);
  const sharedMode = shared.value?.mode ?? null;
  const inherited = sharedMode === null ? trusted : { ...trusted, mode: sharedMode };
  const local = await readProjectFile($, scope, scope?.localFile, (text) => {
    const patch = JSON.parse(text);
    return { config: applyRoutingPatch(inherited, patch), mode: patch.mode ?? null };
  });
  const base = local.value?.config ?? inherited;
  return {
    scope,
    base,
    sharedMode,
    profileMode: userFile?.mode ?? null,
    localMode: local.value?.mode ?? null,
    fileErrors: [
      resolved?.error,
      shared.error ?? (shared.value?.error && `${shared.value.error}; edit or remove it and reload plugins`),
      local.error,
    ].filter(Boolean),
    preference: await projectPreference($, scope, base),
  };
}

function projectRoutingView(project) {
  return {
    projectRoot: project.scope?.root ?? null,
    projectLocalFile: project.scope?.localFile ?? null,
    projectError: project.fileErrors.join(' · ') || null,
    projectPreferenceError: project.preference.error,
    projectClearDestination:
      project.preference.config.classifier !== project.base.classifier
        ? classifierDestination(activeClassifier(project.base).endpoint).text
        : null,
    canClearProject:
      project.preference.resettable &&
      Boolean(project.preference.error || Object.keys(project.preference.record?.patch ?? {}).length),
  };
}

async function updateView($, router, patch) {
  // Read the stored view only when none is held, and merge into whatever is held once it arrives: a patch applied
  // during that read stays.
  const stored = router.view ? null : await readView($, router);
  router.view = { ...(router.view ?? stored), ...patch };
  await $.state.set(VIEW, router.view);
}

// This session's record of `kind`, read from the store once per session (heldRecord), and the last reset (ms) from any
// session, read each time: a Reset in another session empties a record held from before it. The reset is kept in
// `router.resetAt` too, for what a pane draws without a store read.
async function ownRecord($, router, kind) {
  const spec = LEDGERS[kind];
  const held = router.ledgers[kind];
  const sessionId = await $.session.id();
  const resetAt = await $.store.get(SAVINGS_RESET_KEY);
  // biome-ignore lint/nursery/useAtomicUpdates: the newest read of the one marker wins; any order of reads is right
  router.resetAt = resetAt ?? null;
  if (held.own?.sessionId !== sessionId) {
    const stored = await $.store.get(`${spec.prefix}${sessionId}`);
    // Another call may have read it meanwhile and a turn added to it: that one stands.
    if (held.own?.sessionId !== sessionId) held.own = heldRecord(spec, sessionId, stored);
  }
  held.own.record = spec.afterReset(held.own.record, resetAt);
  return { own: held.own, resetAt };
}

// Deletes each of `keys`, unless `keep(value, key)` holds for its value read just before (no `keep`: no read). $.store
// has no conditional delete, so a write between that read and the delete is still lost; a key at a time keeps that
// window to one read. A failed read or delete leaves its key. Returns the keys deleted.
/**
 * @param {string[]} keys
 * @param {((value: unknown, key: string) => boolean) | null} [keep]
 * @returns {Promise<Set<string>>}
 */
async function deleteUnless($, keys, keep = null) {
  /** @type {Set<string>} */
  const deleted = new Set();
  for (const key of keys) {
    try {
      if (keep?.(await $.store.get(key), key)) continue;
      await $.store.delete(key);
      deleted.add(key);
    } catch {}
  }
  return deleted;
}

// Every other session's record of `kind` since the last reset, added up and held. `keys` is one $.store.keys() listing.
// Returns what it read, for a fold.
/** @returns {Promise<Pick<LedgerRead, 'entries' | 'absorbed'>>} */
async function readOthers($, router, kind, { sessionId, resetAt, keys }) {
  const { prefix, legacy, merge, prune, read } = LEDGERS[kind];
  const own = `${prefix}${sessionId}`;
  const names = keys.filter((key) => (key.startsWith(prefix) && key !== own) || key === legacy);
  const values = new Map((await getMany($, names)).map((value, i) => [names[i], value]));
  if (prune) {
    // An expired record holds nothing a period shows, a capped one only the oldest days; a session still running
    // writes its own again at its next turn. One its session wrote since stays, and counts as written.
    const gone = prune([...values], Date.now());
    const deleted = await deleteUnless($, [...gone], (current, key) => {
      const changed = JSON.stringify(current) !== JSON.stringify(values.get(key));
      if (changed) values.set(key, current);
      return changed;
    });
    for (const key of deleted) values.delete(key);
  }
  /** @type {Array<[string, unknown]>} */
  const entries = [...values];
  // A record an archive holds, left by a fold cut off before its delete, counts in the archive alone.
  const absorbed = absorbedKeys(entries, { prefix, read });
  const others = merge(
    entries.filter(([key]) => !absorbed.has(key)).map(([, value]) => withoutFolded(value)),
    resetAt,
  );
  router.ledgers[kind] = { ...router.ledgers[kind], others, othersResetAt: resetAt ?? null };
  return { entries, absorbed };
}

// This session's record of `kind` checked against the store right before its write (checkDue): its stored value and
// the archives of its kind, read fresh, as only an archive lists what it holds. A record a fold took, or one an archive
// holds, starts over (checkedHeld). A few reads; one check of a kind at a time, which every write of it shares. A
// failed check leaves the record as held: the write goes ahead, and the next write checks again.
function checkOwn($, router, kind) {
  if (!router.ownChecks.has(kind))
    router.ownChecks.set(
      kind,
      checkOwnNow($, router, kind)
        .catch(() => {})
        .finally(() => router.ownChecks.delete(kind)),
    );
  return router.ownChecks.get(kind);
}

async function checkOwnNow($, router, kind) {
  const held = router.ledgers[kind].own;
  const { prefix, read } = LEDGERS[kind];
  const own = `${prefix}${held.sessionId}`;
  const keys = await $.store.keys();
  const resetAt = await $.store.get(SAVINGS_RESET_KEY);
  const archives = keys.filter((key) => key.startsWith(archiveKey(prefix, '')));
  const values = await getMany($, [...archives, own]);
  const value = keys.includes(own) ? values.at(-1) : undefined;
  const entries = [...archives.map((key, i) => /** @type {[string, unknown]} */ ([key, values[i]])), [own, value]];
  const absorbed = value !== undefined && absorbedKeys(entries, { prefix, read }).has(own);
  // A reset or another session replaced the held record meanwhile: that one is checked at its own write.
  if (router.ledgers[kind].own === held) Object.assign(held, checkedHeld(LEDGERS[kind], { value, absorbed, resetAt }));
}

// Claude Code runs one plugin's $.store calls one at a time, each reading the whole store file, and a delete writes it
// again: a fold in one go held every other store call (a pane's draw, a turn's records) for seconds. It goes a chunk at
// a time (foldChunks), FOLD_PAUSE_MS apart, from a timer.
const FOLD_PAUSE_MS = 1000;

// Folds `chunks` (foldChunks) one at a time into this session's archive of each kind, while this session holds the
// lease. A chunk with `drop` deletes keys: with `held`, records an archive already holds, each only if unchanged since
// read; without, keys nothing reads. `done`: the records this chain saw deleted, which archives stop listing
// (archiveValue). The chain stops at a Reset in this session.
function foldLater($, router, chunks, sessionId, resets = router.statsResets, done = new Set()) {
  const [chunk, ...rest] = chunks;
  if (!chunk || router.statsResets !== resets) {
    endFold($, router, sessionId);
    return;
  }
  $.clock.after(FOLD_PAUSE_MS, async () => {
    try {
      if (router.statsResets !== resets || !(await renewFoldLease($, sessionId))) {
        endFold($, router, sessionId);
        return;
      }
      if (chunk.drop) {
        const changed =
          chunk.held && ((current, key) => JSON.stringify(current) !== JSON.stringify(chunk.held.get(key)));
        for (const key of await deleteUnless($, chunk.drop, changed)) done.add(key);
      } else await foldChunk($, chunk, archiveKey(LEDGERS[chunk.kind].prefix, sessionId), done);
      foldLater($, router, rest, sessionId, resets, done);
    } catch {
      endFold($, router, sessionId);
    }
  });
}

// A fold chain's end: the lease goes back, and this process may fold again.
function endFold($, router, sessionId) {
  router.folding = false;
  releaseFoldLease($, sessionId).catch(() => {});
}

// One chunk of a kind's settled records folded into `own`, this session's archive of the kind. Each record is read
// again first, as in readOthers: one its session wrote since stays out. The archive is written before the records are
// deleted and lists them until their deletes are seen to finish, so a reader in between, or after a fold cut off,
// counts each record once; the sums do not move, as the archive adds up to what it replaces.
async function foldChunk($, chunk, own, done) {
  const { prefix, read } = LEDGERS[chunk.kind];
  const current = await Promise.all(chunk.keys.map((key) => $.store.get(key)));
  // The archives as they stand now: another start may have folded a record of this chunk since it was planned, and
  // been cut off before its delete; that record is the other archive's.
  const listing = await $.store.keys();
  const archiveKeys = listing.filter((key) => key.startsWith(archiveKey(prefix, '')));
  const archives = await getMany($, archiveKeys);
  const held = absorbedKeys(
    [
      ...archiveKeys.map((key, i) => /** @type {[string, unknown]} */ ([key, archives[i]])),
      ...chunk.keys.map((key, i) => /** @type {[string, unknown]} */ ([key, current[i]])),
    ],
    { prefix, read },
  );
  // An undated record folds while its session is done (settledSessions): its usage record read again, as the session
  // may have resumed since the read that planned the fold. A usage record gone since was folded, by this chain first.
  const dated = Boolean(LEDGERS[chunk.kind].dated);
  const sessionOf = (key) => (key.startsWith(prefix) ? key.slice(prefix.length) : null);
  const ids = dated ? [] : chunk.keys.map(sessionOf).filter((id) => id !== null);
  const usageKeys = ids.map((id) => `${LEDGERS.usage.prefix}${id}`);
  const usage = await getMany($, usageKeys);
  const finished = settledSessions(
    usageKeys.map((key, i) => /** @type {[string, unknown]} */ ([key, usage[i]])),
    { prefix: LEDGERS.usage.prefix, read: LEDGERS.usage.read, now: Date.now() },
  );
  const gone = new Set(ids.filter((_, i) => usage[i] === undefined));
  const settled = (key) => {
    const id = sessionOf(key);
    return dated || id === null || finished.has(id) || gone.has(id);
  };
  const keys = chunk.keys.filter(
    (key, i) => !held.has(key) && settled(key) && JSON.stringify(current[i]) === JSON.stringify(chunk.held.get(key)),
  );
  if (!keys.length) return;
  const values = keys.map((key) => current[chunk.keys.indexOf(key)]);
  const archive = archives[archiveKeys.indexOf(own)];
  await $.store.set(
    own,
    archiveValue(LEDGERS[chunk.kind], {
      archive,
      keys,
      values,
      resetAt: chunk.resetAt,
      now: Date.now(),
      present: chunk.present,
      done,
    }),
  );
  const deletes = await Promise.allSettled(keys.map((key) => $.store.delete(key)));
  deletes.forEach((one, i) => {
    if (one.status === 'fulfilled') done.add(keys[i]);
  });
}

// Only one session folds at a time: two folding the same record would each keep it in their archive. A session claims
// the lease and renews it before each chunk, folding only while it is still its own, so a start that claimed it
// meanwhile wins. A lease older than FOLD_LEASE_MS is a session that stopped while folding.
const FOLD_LEASE = 'ledger:fold:v1';
const FOLD_LEASE_MS = 2 * 60 * 1000;

async function claimFoldLease($, sessionId) {
  const held = await $.store.get(FOLD_LEASE);
  if (held?.sessionId !== sessionId && Number.isFinite(held?.at) && Date.now() - held.at < FOLD_LEASE_MS) return false;
  await $.store.set(FOLD_LEASE, { sessionId, at: Date.now() });
  return true;
}

async function renewFoldLease($, sessionId) {
  if ((await $.store.get(FOLD_LEASE))?.sessionId !== sessionId) return false;
  await $.store.set(FOLD_LEASE, { sessionId, at: Date.now() });
  return true;
}

async function releaseFoldLease($, sessionId) {
  if ((await $.store.get(FOLD_LEASE))?.sessionId === sessionId) await $.store.delete(FOLD_LEASE);
}

// The view's sums of `kinds`, this session's record and the others', from what the router holds; a kind whose others
// were never read gives nothing.
// The replies of turns still running, in the view, so the band and the pane count them before the turn is recorded.
const liveUsage = (router) => [...router.turnUsage.values()].flat();

function ledgerView(router, kinds = LEDGER_KINDS) {
  // The running turns' replies always go with the usage sums: a turn moves from one to the other, so a view written
  // with only one of them would count it twice or miss it.
  const patch = { usageLive: liveUsage(router) };
  for (const kind of new Set([...kinds, 'usage'])) {
    const { others, own } = router.ledgers[kind];
    const { field, ownField, merge, empty } = LEDGERS[kind];
    if (!others) continue;
    patch[field] = merge([others, own?.record]);
    if (ownField) patch[ownField] = own?.record ?? empty();
  }
  return patch;
}

// Adds a turn to this session's record of `kind` (addTurn) and writes it. A record read before a Reset is never written
// back: the reset counter is compared after the reads. The record is added to in memory before the write, so a refresh
// during the write counts it once. True when the view may show the new sums: no reset ran meanwhile.
async function addToLedger($, router, kind, add) {
  const resets = router.statsResets;
  const { own, resetAt } = await ownRecord($, router, kind);
  const held = router.ledgers[kind];
  // The others' sums are only for the view, and reading them takes a store read per record: the turn writes its own
  // record without them. They are read from a timer when not yet read, or held from before a reset in another session
  // (a record from before 1.10.3 has no `since` to tell).
  if (!held.others || held.othersResetAt !== (resetAt ?? null)) refreshLedgersLater($, router);
  if (router.statsResets !== resets) return false;
  const key = `${LEDGERS[kind].prefix}${own.sessionId}`;
  // A stored record another session's fold may hold is checked right before the write (checkDue), so its counts are
  // never written beside an archive that holds them.
  if (checkDue(LEDGERS[kind], own, Date.now(), router.ledgers.usage.own)) await checkOwn($, router, kind);
  if (router.statsResets !== resets || router.ledgers[kind].own !== own) return false;
  const { patch, write } = addTurn(own, add, Date.now());
  Object.assign(own, patch);
  if (write) {
    await $.store.set(key, write);
    own.stored = true;
  }
  return router.statsResets === resets;
}

// The counts kept across sessions for the view, read when the session starts and the pane opens: another session
// may have added to them. A failed read keeps what the view has; it never breaks a turn or a render. The sums are
// taken from the router after the reads, so a turn that finished meanwhile counts once; a Reset meanwhile gives
// nothing, as the reset view stands. `read`: what each kind read, for a fold. One read runs at a time: a pane opened
// or a refresh asked while one runs shares it.
async function readLedgers($, router) {
  // A read another session started (before a /clear or a resume) counts that session's records as others.
  const sessionId = await $.session.id();
  if (router.ledgerRead?.sessionId !== sessionId) {
    const read = readLedgersNow($, router).finally(() => {
      if (router.ledgerRead?.read === read) router.ledgerRead = null;
    });
    router.ledgerRead = { sessionId, read };
  }
  return router.ledgerRead.read;
}

// The counts kept across sessions read again for the view from a timer, once however many turns' writes ask.
function refreshLedgersLater($, router) {
  if (router.ledgerRefreshDue) return;
  router.ledgerRefreshDue = true;
  $.clock.after(0, async () => {
    // A write asking while this read runs shares it (readLedgers), and its record is in the sums taken at the end.
    router.ledgerRefreshDue = false;
    await updateView($, router, (await readLedgers($, router)).patch).catch(() => {});
  });
}

/** @returns {Promise<{ patch: object, read: LedgerRead[] }>} */
async function readLedgersNow($, router) {
  const resets = router.statsResets;
  /** @type {LedgerRead[]} */
  const read = [];
  try {
    const keys = await $.store.keys();
    for (const kind of LEDGER_KINDS) {
      try {
        const { own, resetAt } = await ownRecord($, router, kind);
        const { entries, absorbed } = await readOthers($, router, kind, { sessionId: own.sessionId, resetAt, keys });
        read.push({ kind, entries, absorbed, resetAt, listing: new Set(keys) });
      } catch {}
    }
  } catch {}
  return { patch: router.statsResets === resets ? ledgerView(router) : {}, read };
}

const storeView = async ($, router) => (await readLedgers($, router)).patch;

// What a session start reads from the store, from a timer so the start does not wait on it (a press and the first
// prompt wait on session.start): the counts kept across sessions, this session's decision record and the holds; then
// it prunes old decision records and folds settled ledger records in the background.
async function refreshAfterStart($, router) {
  // The session this start is for: a /clear or a resume during the reads makes another one current, whose own start
  // reads and folds for it.
  const sessionId = await $.session.id();
  // The holds first: the sums go to the view as soon as they are read, so no turn's newer sums are written over.
  const holds = await readHolds($, router);
  const { patch, read } = await readLedgers($, router);
  await updateView($, router, { ...patch, holds }).catch(() => {});
  await loadDecisionRecord($, router).catch(() => {});
  await pruneDecisionRecords($);
  // One fold chain per process: the lease names a session, and two chains of one session would both pass it.
  if ((await $.session.id()) !== sessionId || router.folding) return;
  const dead = deadKeys(await $.store.keys(), { modePrefix: MODE_PREFIX, ownMode: `${MODE_PREFIX}${sessionId}` });
  const chunks = foldChunks(read, { sessionId, now: Date.now(), dead });
  if (!chunks.length || router.folding) return;
  // biome-ignore lint/nursery/useAtomicUpdates: read and set with no await between, so no other chain starts in between
  router.folding = true;
  if (await claimFoldLease($, sessionId).catch(() => false)) foldLater($, router, chunks, sessionId);
  else endFold($, router, sessionId);
}

// A notice answers the last press in the pane, so the pane opens without one; the last write keeps its Undo in the
// status bar. The pane shows from what the router holds, and the press returns: the holds, the decision record and
// the counts kept across sessions are read again from a timer (refreshPane), as they take a store read per record.
async function openPane($, router) {
  await updateView($, router, { notice: null, confirmDelete: false, confirmProjectClear: false });
  const opened = await $.ui.open({ id: PANE, title: PANE_TITLE, focus: true, closeOnEscape: true });
  // The pane is open but undrawn, as where no surface places panes or the terminal is too narrow for it; saying why beats
  // a press that shows nothing.
  if (opened?.isPlaced === false) $.ui.toast(`The Router pane is not shown: ${opened.reason}`);
  $.clock.after(0, () => refreshPane($, router));
}

// What the pane shows beyond the view, read again; one refresh at a time, so opening the pane twice reads once.
function refreshPane($, router) {
  router.paneRefresh ??= refreshPaneNow($, router)
    .catch(() => {})
    .finally(() => {
      router.paneRefresh = null;
    });
  return router.paneRefresh;
}

async function refreshPaneNow($, router) {
  await loadDecisionRecord($, router).catch(() => {});
  await updateView($, router, { holds: await readHolds($, router), ...(await storeView($, router)) });
}

async function changeMode($, router, mode) {
  const view = router.view ?? (await readView($, router));
  for (const controller of router.controllers) controller.abort();
  // Turns with routing off run on Claude's model, off the cheaper move's route: the escalation watch ends.
  if (mode === 'manual') {
    router.afterDown = null;
    router.offSwitches += 1;
    if (
      router.config.routingEngine === 'auto' ||
      [...router.turnConfigs.values()].some((turn) => turn.config.routingEngine === 'auto')
    ) {
      for (const review of router.reviews.values()) review.controller.abort();
      router.reviews.clear();
      router.decisions.clear();
      const ref = { ...LOOP, id: 'main' };
      const loaded = await $.state.get(ref);
      if (loaded.value)
        await $.state.set(
          ref,
          {
            ...loaded.value,
            hasRoutedDecision: hasRoutedDecision(loaded.value),
            auto: null,
            turnId: null,
            decision: null,
            route: null,
            generation: loaded.value.generation + 1,
          },
          { ifVersion: loaded.version },
        );
    }
  }
  router.modes.set(await $.session.id(), mode);
  // The band redraws before the save, which can wait behind other store calls; a failed save then says so.
  await updateView($, router, {
    mode,
    pendingPin: null,
    phase: view.phase === 'unavailable' ? 'unavailable' : mode === 'manual' ? 'manual' : 'ready',
    reason: mode === 'manual' ? 'routing off' : 'ready',
  });
  if (await rememberMode($, mode)) router.storedModes.set(await $.session.id(), mode);
  else await updateView($, router, { notice: 'Mode changed for this session. Resume preference could not be saved.' });
  if (router.config.routingEngine === 'shadow') traceControl(router);
}

async function setPin($, router, tier) {
  const view = router.view ?? (await readView($, router));
  if (view.phase === 'unavailable') return unavailableText(view);
  const mode = await modeOf($, router, view.mode);
  if (mode === 'manual') return 'Routing is off. Turn routing on before pinning a turn.';
  router.pinPresses += 1;
  await updateView($, router, { pendingPin: tier });
  if (router.config.routingEngine === 'shadow') traceControl(router);
  return `${tier} pinned for the next turn and its tool continuations.`;
}

// What each word of the SUBCOMMANDS table does: a switch, since the engine reads `$` only where it is passed to a
// function it can name. A word with no case, or one that answers nothing, leaves the command to open the pane.
async function runSubcommand($, router, action, value) {
  switch (action) {
    case 'on':
      return switchRouting($, router, 'auto');
    case 'off':
      return switchRouting($, router, 'manual');
    case 'engine':
      return {
        text: ROUTING_ENGINES.includes(value)
          ? await setEngine($, router, value)
          : `Choose engine ${ROUTING_ENGINES.join(', ')}.`,
      };
    case 'trace':
      return value === 'export' ? { text: await exportTraces($, router) } : undefined;
    case 'line':
      return {
        text: LINE_MODES.includes(value) ? await setRouteLine($, value) : `Choose line ${LINE_MODES.join(', ')}.`,
      };
    case 'decisions':
      return { text: await decisionsText($, router, value) };
    case 'holds':
      return { text: holdsText(router.config, await readHolds($, router), Date.now()) };
    case 'release':
      return { text: await releaseCommand($, router, value) };
    case 'pin':
      return { text: TIERS.includes(value) ? await setPin($, router, value) : `Choose ${TIERS.join(', ')}.` };
    case 'mode':
      return {
        text: [...ROUTING_MODES, 'default'].includes(value)
          ? await setRoutingMode($, router, value)
          : `Choose mode ${[...ROUTING_MODES, 'default'].join(', ')}.`,
      };
    case 'activities':
      return {
        text: ACTIVITY_MODES.includes(value)
          ? await setActivityRouting($, router, value)
          : `Choose activities ${ACTIVITY_MODES.join(', ')}.`,
      };
    default:
      return undefined;
  }
}

// `/router line <mode>`: a preference like the band's second row, kept across sessions and never in router.json.
async function setRouteLine($, mode) {
  const saved = await $.store.set(ROUTE_LINE, mode).then(
    () => true,
    () => false,
  );
  const says = {
    off: 'no route line after a turn',
    moves: 'a route line after a turn that ran another model or effort than the last',
    all: 'a route line after every turn',
  };
  return `Route line ${mode}: ${says[mode]}.${saved ? '' : ' It could not be saved for later sessions.'}`;
}

async function switchRouting($, router, mode) {
  const view = router.view ?? (await readView($, router));
  if (view.phase === 'unavailable') return { text: unavailableText(view) };
  await changeMode($, router, mode);
  return { text: mode === 'auto' ? 'Routing on.' : 'Routing off: Claude’s model is kept.' };
}

// `/router [word [value]]`, the words of SUBCOMMANDS; with none, the pane, or the status text without a surface.
async function routerCommand($, router, args) {
  const [action, value] = args.trim().split(/\s+/);
  const answer = await runSubcommand($, router, action, value);
  if (answer) return answer;
  const storedView = await readView($, router);
  const view = { ...storedView, mode: await modeOf($, router, storedView.mode) };
  if (!(await $.session.surfaces()).length)
    return { text: detailText(router.config, view, await $.session.usage().catch(() => null)) };
  await openPane($, router);
  return {};
}

// `/router engine <name>` and `/router activities <mode>` share the pane's project write and Undo.
async function setEngine($, router, engine) {
  const view = router.view ?? (await readView($, router));
  if (view.phase === 'unavailable') return unavailableText(view);
  if (engine === router.config.routingEngine) return `Engine is already ${engine}.`;
  await paneActions($, router, view).engine(engine);
  return router.view.notice;
}

async function setActivityRouting($, router, mode) {
  const view = router.view ?? (await readView($, router));
  if (view.phase === 'unavailable') return unavailableText(view);
  if (mode === router.config.activityRouting) return `Activity routing is already ${mode}.`;
  await paneActions($, router, view).activityRouting(mode);
  return router.view.notice;
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
    case 'openai_api_key':
      return (await $.env.get('OPENAI_API_KEY')) || (await $.env.get('CLAUDE_PLUGIN_OPTION_OPENAI_API_KEY'));
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

// A Set up or Edit press: in the terminal, the secure key dialog of `/plugin configure`; a graphical surface, which
// has no such dialog (the command does nothing there), shows how to add the credentials from a terminal instead, in
// the pane, for classifier `id`.
async function keySetup($, router, press, id) {
  if (!isGraphical(press?.surface)) {
    openKeySettings($);
    return $.ui.close({ id: PANE });
  }
  await updateView($, router, { keyHelp: keyHelpFor(router, id ?? router.config.classifier), notice: null });
}

// A graphical band or pane that throws draws the terminal tree; the error goes to the debug log, never the transcript.
const logFallback = ($, what) => (error) =>
  $.ui.log(`graphical ${what} failed, drew the terminal one: ${error instanceof Error ? error.message : error}`, {
    to: 'debug',
  });

// The key help to open for classifier `id`: an Edit, when nothing is missing, stays open until Done.
const keyHelpFor = (router, id) => ({
  id,
  edit: !missingCredentials(router.config, router.view ?? {}, id),
});

// The plugin's id for `claude plugin configure`: from its install path, else settings' enabledPlugins.
async function pluginIdFor($) {
  const plugin = { name: $.plugin.name, root: $.plugin.root };
  const settings = await $.settings.read().catch(() => ({}));
  return pluginIdOf(plugin, settings?.enabledPlugins ?? null);
}

// The pane's credential handlers: Set up or Edit, and the key help's Copy command and Done.
function keyActions($, router, view) {
  return {
    key: (press, id) => keySetup($, router, press, id),
    copyKeyHelp: async (press) => {
      const open = (router.view ?? view).keyHelp;
      const help = open && keyHelpOf(router.config, open.id, await pluginIdFor($), { edit: open.edit });
      if (!help) return;
      await $.ui.copy({ text: help.command, surface: press?.surface });
      await updateView($, router, { notice: 'Copied' });
    },
    keyHelpDone: () => updateView($, router, { keyHelp: null, notice: null }),
  };
}

// The host refuses $.command.run from a hook the turn is holding, so the secure key dialog opens from a timer.
function openKeySettings($) {
  $.clock.after(0, () => $.command.run({ command: 'plugin', args: `configure ${$.plugin.name}` }).catch(() => {}));
}

// Whether this session's provider gives each effort its own prompt cache (effortSharesCache in lib/cost.mjs): Amazon
// Bedrock, Google Cloud, Microsoft Foundry, a custom ANTHROPIC_BASE_URL (it may be a Claude apps gateway) or
// CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS. A HIPAA configuration is not visible to a Mod. $.env.get takes literal names.
async function effortSplitsCacheOf($) {
  const flags = [
    await $.env.get('CLAUDE_CODE_USE_BEDROCK'),
    await $.env.get('CLAUDE_CODE_USE_VERTEX'),
    await $.env.get('CLAUDE_CODE_USE_FOUNDRY'),
    await $.env.get('CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS'),
  ];
  return flags.some(isSet) || Boolean(await $.env.get('ANTHROPIC_BASE_URL'));
}

// The Claude Code profile directory this session runs under.
async function profileDir($) {
  return (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${await $.env.get('HOME')}/.claude`;
}

// A router.json that does not validate, a redirect or a missing provider file stays so until it is edited: the failure is
// held in `router.loadFailed` until the next session start. A read that failed is tried again at the next event.
async function loadNativeConfig($, router) {
  const invalid = (error) => {
    router.loadFailed = true;
    return error;
  };
  for (const source of ['project', 'local']) {
    const settings = await $.settings.read({ source });
    if (
      settings.env &&
      ['HOME', 'CLAUDE_CONFIG_DIR', 'CLAUDE_ROUTER_PROVIDER'].some((key) => Object.hasOwn(settings.env, key))
    )
      throw invalid(new Error('project settings cannot redirect the router profile'));
  }
  const profile = await profileDir($);
  const provider = providerName(await $.env.get('CLAUDE_ROUTER_PROVIDER'));
  const path = `${profile}/${providerFile(provider)}`;
  const exists = await $.fs.exists(path);
  if (provider !== 'anthropic' && !exists) throw invalid(new Error('selected provider router file is missing'));
  const text = exists ? await $.fs.read(path) : null;
  const effortSplitsCache = await effortSplitsCacheOf($);
  try {
    const userFile = text === null ? null : JSON.parse(text);
    return {
      config: { ...loadConfig({ userFile, provider }), nativePath: path, effortSplitsCache },
      userFile,
      profile,
    };
  } catch (error) {
    throw invalid(error);
  }
}

// The private local evidence overlay is optional and user-owned: a missing or malformed file never fails a session or
// a turn. The hooks runtime refuses a dynamic import, and a static one would fail while the file is absent, so the
// generated JSON export is read and parsed instead. It is re-read when a session starts or the Mod is reloaded.
async function loadEvidenceOverlay($) {
  try {
    const home = await $.env.get('HOME');
    if (!home) return null;
    const path = `${home}/.config/claude-router/evidence.local.mjs`;
    if (!(await $.fs.exists(path))) return null;
    return parseEvidenceOverlay(await $.fs.read(path));
  } catch {
    return null;
  }
}

const keywordList = (up) =>
  Object.keys(KEYWORDS)
    .filter((word) => keywordRaises(word) === up)
    .join(', ');

const unavailableText = (view) => `Routing unavailable: ${unavailableReason(view)}. Claude’s model is kept.`;

function detailText(config, view, usage) {
  if (view.phase === 'unavailable')
    return [
      unavailableText(view),
      `Model: ${view.nativeModel}`,
      ...(view.error === GATEWAY_SETTINGS ? GATEWAY_CLEANUP : []),
    ].join('\n');
  const missing = missingCredentials(config, view, config.classifier);
  return [
    `Router — routing ${view.mode === 'auto' ? 'on' : 'off'}`,
    ...(config.provider !== 'anthropic' ? [`Provider: ${config.provider} · ${config.nativePath}`] : []),
    ...(view.routingMode ? [`Mode: ${modeLabel(view.routingMode)}`] : []),
    ...(view.projectError ? [`Ignored: ${view.projectError}`] : []),
    ...(view.projectPreferenceError ? [`Ignored: ${view.projectPreferenceError}`] : []),
    `Native model: ${view.nativeModel}`,
    `Selected: ${view.selectedModel ?? 'not selected'} · effort ${view.effort ?? 'session/default'}`,
    `Last recorded completed engine request: ${view.delegatedModel ?? 'none'} · effort ${view.delegatedEffort ?? 'session/default'}`,
    `Response-reported model: ${view.actualModel ?? 'no response yet'}`,
    'API-transmitted and served effort: unknown (engine delegation is not wire evidence).',
    'Cost basis: configured API-rate estimates (list/custom), not bills or measured quota savings.',
    `Reason: ${view.reason}`,
    ...activityDetailLines(config, view),
    storeAgreementLine(view),
    ...[unpricedLine(view.activityMetrics)].filter(Boolean),
    savingsLine(config, view, usage, Date.now()),
    view.error || missing ? classifierStatus(config, view.error ?? missing) : `${activeClassifier(config).label} ready`,
    `Context: ${view.contextKnown ? `${view.contextTokens} tokens (estimate)` : 'unknown'}`,
    `Observed cache: ${view.cacheRead ?? 'unknown'} read, ${view.cacheWrite ?? 'unknown'} written tokens`,
    view.pendingPin ? `Next turn pin: ${view.pendingPin}` : 'No next-turn pin.',
    'Routing on picks a model for each turn. Routing off keeps Claude’s model. Pins serve one turn only.',
    `Prompt keywords, as the first word, move one turn: ${keywordList(true)} up; ${keywordList(false)} down.`,
    'Cache lifetime is an estimate. Claude’s cost ledger owns session totals.',
  ].join('\n');
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

async function* passMain($, e, next, previous, version, nativeModel, reason, router) {
  // A turn routing did not choose is a turn on another route: it ends the watch for escalations after a cheaper
  // activity move, including one a turn started before routing was turned off mid-turn.
  if (reason === 'manual') router.afterDown = null;
  const ref = { ...LOOP, id: 'main' };
  const turn = router.turnConfigs.get(e.turnId) ?? { config: router.config, configured: router.config };
  const auto = turn.config.routingEngine === 'auto';
  const loop =
    reason === 'manual' && auto ? { ...previous, auto: null, route: null, decision: null, turnId: null } : previous;
  const context = await contextOf($, loop);
  await updateView($, router, {
    nativeModel,
    selectedModel: e.model,
    effort: e.effort ?? null,
    reason,
    fallback: null,
    contextTokens: context.tokens,
    contextKnown: context.known,
  });
  const sessionId = await $.session.id();
  if (turn.config.routingEngine === 'shadow')
    traceRequest(router, e, turn, e, reason === 'manual' ? 'manual' : 'auto', loop);
  const response = yield* sendMain($, router, e, next, turn.config);
  if (!next.signal.aborted && (await $.session.id()) === sessionId) {
    const at = Date.now();
    const cfg = auto ? turn.config : router.config;
    let observed = observeResponse(cfg, loop, {
      usage: response.usage,
      requestedModel: e.model,
      effort: e.effort ?? null,
      stopReason: response.stopReason,
      now: at,
    });
    if (auto && ['no-route-native', 'native-fallback'].includes(reason))
      observed = {
        ...observeAutoFallback(cfg, observed, {
          requestedModel: e.model,
          effort: e.effort,
          usage: response.usage,
        }),
        suspended: true,
      };
    if (reason === 'no-route-native' && loop.auto?.savedPin) {
      observed.switchedAt = loop.auto.savedPin.switchedAt;
      observed.servedRoute = loop.auto.savedPin.servedRoute;
    }
    // Before routing has chosen a route, the one in use is the model serving now: /model can change it with routing
    // off. Once a decision exists, the last routed route is kept, as for every model.
    if (reason === 'manual' && !loop.decision && !auto) observed.route = ownRoute(router.config, e.model);
    // Routing chose nothing here, so the reply is not counted; your model's cache still follows it.
    const compared = await compareYours($, router, loop, response, e.effort ?? null, nativeModel, cfg);
    if (compared) observed.yoursBy = compared.states;
    const pending = mergeAgentClears(router, observed);
    observed = pending.loop;
    const written = await $.state.set(ref, observed, { ifVersion: version });
    if (written.isSet && pending.applied) {
      router.agentClears.clear();
      await updateView($, router, { holds: await holdsAfter($, router, observed.held) }).catch(() => {});
    }
    if (turn.config.routingEngine === 'shadow') {
      if (written.isSet) recordTraceResponse(router, e, e, response, compared?.ttl, at);
      else router.trace?.reasons.add('gap');
    }
    if (written.isSet)
      await updateView($, router, {
        ...responseMetrics(router.view, response, null, Date.now()),
        delegatedModel: e.model,
        delegatedEffort: e.effort ?? null,
      });
  } else if (turn.config.routingEngine === 'shadow') router.trace?.reasons.add('aborted');
  return response;
}

// Shadow retains demand evidence only; target selection sees the actual incumbent and cache. The proposal
// respects the holds in force now, as a live auto session would, so the recorded alt never names a held model.
function shadowProposal(
  config,
  loop,
  selected,
  { facts, advice, pin, nativeModel, contextKnown, availableModels, accountHolds, now, mode, offSwitches },
) {
  if (config.routingEngine !== 'shadow') {
    delete selected.shadow;
    return null;
  }
  try {
    const projected = economicConfig(config, loop);
    const oneTurn = servesOneTurn(loop.decision);
    const beforePin = oneTurn ? loop.route : null;
    const model = oneTurn && !beforePin ? nativeModel : (loop.decision?.model ?? nativeModel);
    const alias = Object.keys(config.models).find(
      (key) => isSameModel(config.models[key].id, model) || isSameModel(projected.models[key].id, model),
    );
    const incumbent = beforePin ?? {
      model: alias ?? model,
      effort: oneTurn ? (facts.effort ?? null) : (loop.decision?.effort ?? facts.effort ?? null),
    };
    const initial = TIERS.indexOf(config.baselineTier);
    const state =
      loop.shadow?.generation === loop.generation && loop.shadow.offSwitches === offSwitches
        ? loop.shadow.state
        : initialAutoState({ demand: initial });
    const demand = advanceDemand({
      config,
      state,
      advice,
      facts,
      pin,
      boundedExecute:
        config.activityRouting === 'on' &&
        acceptActivity(config, advice) !== null &&
        acceptPhase(config, advice) === 'execute',
    });
    const candidates = assessCandidates({
      config: projected,
      facts: { ...facts, ineligible: loop.ineligible.map((id) => loop.resolutions[id] ?? id) },
      now,
      incumbent,
      contextKnown,
      availableModels,
      nativeModel,
      // The shadow alternative ranks by the same capability column the live auto decision would use.
      activity: adviceActivity(config, advice),
      held: heldAsSeen(heldIds(projected, loop.held, accountHolds ?? {}, now), loop.resolutions),
    });
    const target = selectTarget({
      candidates,
      demand: demand.level,
      mode: pin ? 'balanced' : mode,
      headroom: demand.headroom,
      escalation: demand.escalated,
    });
    if (demand.escalated || demand.headroom) demand.state = { ...demand.state, headroom: target.headroom };
    const { routedDemand: _routed, routeCause: _cause, ...demandState } = pin ? state : demand.state;
    selected.shadow = { generation: loop.generation, offSwitches, state: demandState };
    return {
      demand: demand.level,
      reason: demand.reason,
      headroom: target.headroom,
      targetReason: target.reason,
      requirement: target.requirement,
      outcome: target.outcome,
      route: target.route
        ? `${target.route.model}@${typeof target.route.effort === 'string' ? target.route.effort : 'session'}`
        : null,
      capability: target.capability,
      minUsd: target.estimate?.minUsd,
      maxUsd: target.estimate?.maxUsd,
    };
  } catch {
    delete selected.shadow;
    return { reason: 'error' };
  }
}

// One turn's classification and route, written to the loop at `loopVersion`: the loop and its new version, or null
// when the turn was aborted, left the session or Auto, lost the write, or its transcript could not be read. `signal` is the step's: its abort cancels
// the classifier call. The pin is the one in `view`, the view as the step read it; it is used up only once the route
// is written, so a turn interrupted before then leaves it for the next.
async function decideTurn($, router, e, signal, step) {
  const { sessionId, view, loop, loopVersion, context, nativeModel, availableModels } = step;
  // A pin runs its tier's configured route: the routing mode moves only routes the router chooses.
  const cfg = view.pendingPin && step.cfg.routingEngine !== 'auto' ? step.configured : step.cfg;
  const ref = { ...LOOP, id: 'main' };
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal.addEventListener('abort', cancel, { once: true });
  router.controllers.add(controller);
  router.turnControllers.set(e.turnId, controller);
  const live = async () => !controller.signal.aborted && (await $.session.id()) === sessionId;
  try {
    const pin = view.pendingPin;
    const pinPresses = router.pinPresses;
    const [credentials, messages] = await Promise.all([
      resolveCredentials(activeClassifier(cfg), (name) => settingOf($, router.options, name)),
      transcript($),
    ]);
    // A turn whose transcript cannot be read has no facts to route on: its step goes out as Claude Code built it.
    if (!messages || !(await live())) return null;
    validateGoal(router, e.turnId, messages);
    const origin = router.turnOrigins.get(e.turnId) ?? 'unknown';
    // A progress turn is the same task (sameTaskOf).
    const facts = stepFacts(cfg, router, loop, e, messages, context);
    const asked = progressInput(
      facts,
      { goal: router.prompts.get(e.turnId), note: router.progressNotes.get(e.turnId) },
      cfg.context.recentTurns,
    );
    await updateView($, router, {
      phase: 'choosing',
      activeTurnId: e.turnId,
      nativeModel,
      credentials: { ...router.view?.credentials, [cfg.classifier]: credentials.missing },
    });
    const adviceStarted = Date.now();
    const result = pin
      ? { advice: null, error: null }
      : await clientOf(router, cfg.classifier).ask({
          request: (url, init) => $.http.fetch(url, init),
          sleep: (ms, args) => $.clock.sleep(ms, args),
          config: cfg,
          apiKey: credentials.apiKey,
          endpoint: credentials.endpoint,
          prompt: asked.prompt,
          turns: asked.turns,
          activeGoal: router.turnGoals.get(e.turnId)?.goal,
          currentStep: router.progressNotes.get(e.turnId) ?? facts.prompt,
          signal: controller.signal,
        });
    // The wait for advice alone, comparable with the activity probe's p95; the routing after it is not the classifier's.
    const adviceMs = pin || !classifierTimed(result.error) ? null : Date.now() - adviceStarted;
    if (controller.signal.aborted || (await $.session.id()) !== sessionId || (await modeOf($, router)) !== 'auto')
      return null;
    const previous = loop.decision;
    if (pin)
      router.turnConfigs.set(e.turnId, { config: { ...cfg, routingMode: step.cfg.routingMode }, configured: cfg });
    // A keyword is read from a prompt a person or an agent sent, never from a progress report or a pinned turn.
    const keyword = pin || isProgressOrigin(origin) ? null : promptKeyword(router.prompts.get(e.turnId));
    const accountHolds = await routingHoldsOf($, cfg, router);
    const traceInput = {
      facts,
      advice: result.advice,
      pin,
      keyword,
      nativeModel,
      contextKnown: context.known,
      availableModels,
      accountHolds,
      now: Date.now(),
    };
    traceInput.held = heldIds(cfg, loop.held, accountHolds, traceInput.now);
    const selected =
      cfg.routingEngine === 'auto'
        ? autoRoute(cfg, loop, { ...traceInput, engineModel: e.model })
        : chooseRoute(cfg, loop, traceInput);
    const alt = shadowProposal(step.configured, loop, selected, {
      facts,
      advice: result.advice,
      pin,
      nativeModel,
      contextKnown: context.known,
      availableModels,
      accountHolds: traceInput.accountHolds,
      now: Date.now(),
      mode: step.cfg.routingMode.mode,
      offSwitches: router.offSwitches,
    });
    selected.engineModel = e.model;
    const written = await $.state.set(ref, selected, { ifVersion: loopVersion });
    // The written route serves the turn's next steps, even if an abort lands now.
    if (written.isSet && pin) router.turnPins.set(e.turnId, pinPresses);
    // Manual, /clear and turn completion abort the controller; one may land during the write.
    if (!written.isSet || controller.signal.aborted) return null;
    if (cfg.routingEngine === 'shadow') traceOp(router, e, cfg, 'choose', traceInput, selected, messages);
    // A catalog that declares no capability anywhere cannot rank candidates: every selection falls to the cheapest
    // unknown. Say so once, so the degenerate order is never silent (2026-11-22-auto-holds-design.md).
    if (
      cfg.routingEngine === 'auto' &&
      !router.capabilityNoticed &&
      Object.values(cfg.models).every((model) => Object.keys(model.capability ?? {}).length === 0)
    ) {
      // biome-ignore lint/nursery/useAtomicUpdates: a one-time notice flag, raced at worst into a second toast
      router.capabilityNoticed = true;
      $.ui.toast('Auto cannot rank models: declare models.<alias>.capability; selection falls back to cheapest.');
    }
    rememberGoal(router, e.turnId, result.advice, cfg.policy.continuationMass, messages);
    // Every hold, a due one too: routing may try that account, while the pane still lists it and offers its Release.
    const holds = { accounts: await accountHoldsOf($, cfg, router), models: selected.held ?? {} };
    if (previous?.model && previous.model !== selected.decision.model && !selected.decision.pinned)
      $.ui.toast(
        switchToast(
          cfg,
          previous,
          selected.decision,
          selected.decision.estimate,
          selected.decision.reason === 'model-held'
            ? heldCause(cfg, { holds, fallback: selected.decision.fallback }, Date.now())
            : null,
        ),
      );
    const activity = turnActivity(cfg, result.advice, previous, selected.decision);
    const routingMode = step.cfg.routingMode;
    addDecision(
      router,
      e.turnId,
      decisionRow({
        at: Date.now(),
        kind: 'start',
        origin,
        mode: pin ? null : routingMode.mode,
        advice: result.advice,
        error: result.error,
        decision: selected.decision,
        facts,
        sameTask: sameTaskOf(cfg, result.advice, facts),
        engine: cfg.routingEngine,
        alt,
      }),
    );
    // One line per decision in Claude Code's debug log, so a later replay can compare modes. No prompt text.
    $.ui.log(
      `router decision ${JSON.stringify({
        mode: routingMode.mode,
        modeSource: routingMode.source,
        origin,
        classified: result.advice?.choice ?? null,
        tier: selected.decision.tier,
        reason: selected.decision.reason,
        route: `${selected.decision.model}@${selected.decision.effort ?? 'session'}`,
        pinned: selected.decision.pinned,
        ...(selected.decision.keyword ? { keyword: selected.decision.keyword } : {}),
      })}`,
      { to: 'debug' },
    );
    router.turnActivities.set(e.turnId, {
      ...activity,
      reason: selected.decision.reason,
      escalated: Boolean(selected.decision.escalated),
      pinned: selected.decision.pinned,
      route: `${selected.decision.model}@${selected.decision.effort ?? 'session'}`,
      // A pinned turn ran the configured routes, which balanced runs: its replies count there.
      routingMode: pin ? DEFAULTS.mode : routingMode.mode,
      modeSource: pin ? 'pin' : routingMode.source,
      classifier: cfg.classifier,
      offSwitches: router.offSwitches,
      adviceMs,
      sessionId,
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      routedUsd: null,
      pricedRequests: 0,
      unpriced: {},
      routes: {},
    });
    await updateView($, router, {
      ...(activity.switched ? switchView(previous, selected.decision, activity.label, Date.now()) : {}),
      phase: 'routed',
      // The session's mode, not this turn's: a `/router mode` sent while the classifier answered names the next turn.
      routingMode: await routingModeOf($, router),
      selectedModel: selected.decision.model,
      actualModel: null,
      tier: selected.decision.tier,
      effort: selected.decision.effort,
      reason: selected.decision.reason,
      fallback: selected.decision.fallback ?? null,
      holds,
      activity: activity.label,
      goal: selected.decision.goal,
      taskPhase: selected.decision.taskPhase,
      phaseChoice: result.advice?.phase?.choice ?? null,
      phaseProbabilities: result.advice?.phase?.probabilities ?? null,
      contextTokens: context.tokens,
      contextKnown: context.known,
      comparison: selected.decision.comparison,
      // A turn that started before a classifier switch routes on its own classifier's answer, but the
      // pane now labels the new one: its readings stay off the view.
      ...(cfg.classifier === router.config.classifier
        ? {
            error: result.error,
            health: healthOf(clientOf(router, cfg.classifier), cfg.classifier),
            adviceMs,
            adviceChoice: result.advice?.choice ?? null,
            probabilities: result.advice?.probabilities ?? null,
            estimate: selected.decision.estimate ?? null,
            activityChoice: activity.predicted,
            activityProbabilities: result.advice?.activity?.probabilities ?? null,
          }
        : {}),
    });
    return { loop: selected, version: written.version };
  } finally {
    signal.removeEventListener('abort', cancel);
    router.controllers.delete(controller);
    if (router.turnControllers.get(e.turnId) === controller) router.turnControllers.delete(e.turnId);
  }
}

// Facts for a step of the running turn, read from the transcript as it is now; `progress` on a progress turn.
function stepFacts(cfg, router, loop, e, messages, context) {
  return nativeFacts(cfg, loop, {
    messages,
    prompt: router.prompts.get(e.turnId),
    effort: e.effort,
    turnId: e.turnId,
    contextTokens: context.tokens,
    progress: isProgressOrigin(router.turnOrigins.get(e.turnId)),
  });
}

// The transcript, or null when it cannot be read: a continuation then keeps its route.
async function transcript($) {
  try {
    return await $.session.messages({ as: 'api' });
  } catch {
    return null;
  }
}

// The activity a route runs for, as the view labels it: only activity routing `on` applies one.
const activityLabel = (cfg, decision) => (cfg.activityRouting === 'on' ? (decision.activity ?? null) : null);

// A tool continuation whose turn shows stronger work than its route was chosen for moves up once (observedMove). Only
// tool calls after the last applied review count (`loop.observedFrom`): the review judged the ones before. The
// transcript is read only when some activity's route at this tier is stronger than the running one.
async function moveOnObserved($, router, cfg, loop, e, context) {
  if (cfg.routingEngine === 'auto' || !canMoveUp(cfg, loop.decision, e.effort)) return loop;
  const messages = await transcript($);
  if (!messages) return loop;
  const facts = stepFacts(cfg, router, loop, e, messages, context);
  const observed = routingBucket(
    observedActivity(messages, Math.max(promptIndex(messages), (loop.observedFrom ?? 0) - 1)),
  );
  const observedHolds = await routingHoldsOf($, cfg, router);
  const now = Date.now();
  const traceInput = {
    observed,
    facts,
    contextKnown: context.known,
    accountHolds: observedHolds,
    // The holds in force for this move, recorded so replay reaches the same conclusion the live turn did.
    held: heldAsSeen(heldIds(cfg, loop.held, observedHolds, now), loop.resolutions),
    now,
  };
  const moved = observedMove(cfg, loop, traceInput);
  if (cfg.routingEngine === 'shadow') traceOp(router, e, cfg, 'observed', traceInput, moved, messages);
  if (moved === loop) return loop;
  addDecision(
    router,
    e.turnId,
    decisionRow({
      at: Date.now(),
      kind: 'observed',
      engine: cfg.routingEngine,
      origin: router.turnOrigins.get(e.turnId) ?? 'unknown',
      mode: cfg.routingMode?.mode ?? null,
      decision: moved.decision,
      facts,
    }),
  );
  $.ui.toast(switchToast(cfg, loop.decision, moved.decision, moved.decision.estimate));
  // Replies from here on are labelled with the moved activity; the classifier's answer stays as recorded.
  const turn = router.turnActivities.get(e.turnId);
  if (turn) router.turnActivities.set(e.turnId, { ...turn, label: moved.decision.activity });
  await updateView($, router, {
    estimate: moved.decision.estimate ?? null,
    comparison: null,
    ...switchView(loop.decision, moved.decision, activityLabel(cfg, moved.decision), Date.now()),
  });
  return moved;
}

// Inside a turn the classifier is asked again every `policy.reviewEveryRequests` requests, in the background: a step
// never waits for it. The answer applies at the first step after it arrives, as a decision on the same task
// (sameTaskOf), so the tier and the activity can move either way: up on the usual votes, down only past the dwell and a
// checkpoint (completedSince). Pinned turns and a native fallback are left alone; a failed read or ask changes nothing.
async function reviewMidTurn($, router, cfg, loop, e, { context, nativeModel, availableModels }) {
  const review = router.reviews.get(e.turnId);
  if (review?.answer) {
    router.reviews.delete(e.turnId);
    // An answer about a history that compaction or a rewind replaced is dropped.
    if (!review.answer.advice || servesOneTurn(loop.decision) || review.generation !== loop.generation) return loop;
    // Only the advice is from the review; the checkpoint, context and cache facts are read now.
    const messages = await transcript($);
    if (!messages || historySignature(messages, review.observedUpTo) !== review.prefix) return loop;
    // Appends preserve the task evidence, but a command-only phase cannot authorize work after its snapshot.
    const advice =
      messages.length === review.observedUpTo ? review.answer.advice : { ...review.answer.advice, phase: null };
    const facts = { ...stepFacts(cfg, router, loop, e, messages, context), midTurn: true };
    const reviewHolds = await routingHoldsOf($, cfg, router);
    const traceInput = {
      facts,
      advice,
      pin: null,
      nativeModel,
      contextKnown: context.known,
      availableModels,
      accountHolds: reviewHolds,
      now: Date.now(),
    };
    traceInput.held = heldIds(cfg, loop.held, reviewHolds, traceInput.now);
    const selected =
      cfg.routingEngine === 'auto' ? autoRoute(cfg, loop, traceInput) : chooseRoute(cfg, loop, traceInput);
    if (cfg.routingEngine === 'shadow') traceOp(router, e, cfg, 'choose', traceInput, selected, messages);
    const previous = loop.decision;
    const configured = router.turnConfigs.get(e.turnId)?.configured ?? router.config;
    const alt = shadowProposal(configured, loop, selected, {
      facts,
      advice,
      pin: null,
      nativeModel,
      contextKnown: context.known,
      availableModels,
      accountHolds: traceInput.accountHolds,
      now: Date.now(),
      mode: cfg.routingMode?.mode ?? DEFAULTS.mode,
      offSwitches: router.offSwitches,
    });
    addDecision(
      router,
      e.turnId,
      decisionRow({
        at: Date.now(),
        kind: 'review',
        origin: router.turnOrigins.get(e.turnId) ?? 'unknown',
        mode: cfg.routingMode?.mode ?? null,
        advice,
        decision: selected.decision,
        facts,
        sameTask: sameTaskOf(cfg, advice, facts),
        engine: configured.routingEngine,
        alt,
      }),
    );
    if (previous && (previous.model !== selected.decision.model || previous.effort !== selected.decision.effort)) {
      $.ui.toast(switchToast(cfg, previous, selected.decision, selected.decision.estimate));
      const turn = router.turnActivities.get(e.turnId);
      if (turn) router.turnActivities.set(e.turnId, { ...turn, label: selected.decision.activity ?? null });
      await updateView(
        $,
        router,
        switchView(previous, selected.decision, activityLabel(cfg, selected.decision), Date.now()),
      );
    }
    // The pane shows the readings behind the route; a review by a classifier the pane no longer labels keeps them off.
    if (cfg.classifier === router.config.classifier)
      await updateView($, router, {
        comparison: selected.decision.comparison,
        adviceChoice: advice.choice ?? null,
        probabilities: advice.probabilities ?? null,
        estimate: selected.decision.estimate ?? null,
        activityChoice: advice.activity?.choice ?? null,
        activityProbabilities: advice.activity?.probabilities ?? null,
        goal: selected.decision.goal,
        taskPhase: selected.decision.taskPhase,
        phaseChoice: advice.phase?.choice ?? null,
        phaseProbabilities: advice.phase?.probabilities ?? null,
      });
    // Tool calls up to the review's snapshot were judged by it; later ones can still move the route up.
    return { ...selected, observedFrom: review.observedUpTo };
  }
  const every = cfg.policy.reviewEveryRequests;
  if (review || every === 0 || !loop.decision?.tier || servesOneTurn(loop.decision)) return loop;
  if ((loop.requests ?? 0) - (loop.reviewedAt ?? 0) < every) return loop;
  const job = {
    controller: new AbortController(),
    generation: loop.generation,
    observedUpTo: 0,
    prefix: null,
    answer: null,
  };
  router.reviews.set(e.turnId, job);
  try {
    const [credentials, messages] = await Promise.all([
      resolveCredentials(activeClassifier(cfg), (name) => settingOf($, router.options, name)),
      $.session.messages({ as: 'api' }),
    ]);
    Object.assign(job, { observedUpTo: messages.length, prefix: historySignature(messages) });
    const facts = stepFacts(cfg, router, loop, e, messages, context);
    reviewClientOf(router, cfg.classifier)
      .ask({
        request: (url, init) => $.http.fetch(url, init),
        sleep: (ms, args) => $.clock.sleep(ms, args),
        config: cfg,
        apiKey: credentials.apiKey,
        endpoint: credentials.endpoint,
        prompt: facts.prompt,
        turns: facts.turns,
        activeGoal: router.turnGoals.get(e.turnId)?.goal,
        currentStep: currentStepText(messages, facts.prompt, cfg.context.maxTextChars),
        signal: job.controller.signal,
      })
      .then((answer) => {
        if (router.reviews.get(e.turnId) === job) job.answer = answer;
      })
      .catch(() => {
        if (router.reviews.get(e.turnId) === job) router.reviews.delete(e.turnId);
      });
  } catch {
    router.reviews.delete(e.turnId);
    return loop;
  }
  return { ...loop, reviewedAt: loop.requests ?? 0 };
}

// A routed reply's metrics in the view, with the tier that served it, and added to the turn's activity record with its list price (`routedUsd`, null when unpriced) and, when its tier served it, its route.
async function publishReply(
  $,
  router,
  turnId,
  request,
  response,
  tier,
  route,
  routedUsd,
  cause = /** @type {string | null} */ (null),
) {
  const turn = router.turnActivities.get(turnId);
  const metrics = responseMetrics(router.view, response, tier, Date.now());
  await updateView($, router, {
    ...metrics,
    delegatedModel: request.model,
    delegatedEffort: request.effort ?? null,
  });
  if (turn)
    router.turnActivities.set(turnId, {
      ...turn,
      requests: turn.requests + 1,
      inputTokens: turn.inputTokens + (metrics.inputTokens ?? 0),
      outputTokens: turn.outputTokens + (metrics.outputTokens ?? 0),
      routedUsd: Number.isFinite(routedUsd) ? (turn.routedUsd ?? 0) + routedUsd : turn.routedUsd,
      pricedRequests: turn.pricedRequests + (Number.isFinite(routedUsd) ? 1 : 0),
      unpriced: cause ? { ...turn.unpriced, [cause]: (turn.unpriced?.[cause] ?? 0) + 1 } : turn.unpriced,
      routes: tier ? { ...turn.routes, [route]: (turn.routes[route] ?? 0) + 1 } : turn.routes,
    });
}

// A routed reply written to the loop at `loopVersion`, then published: the view's metrics and the reply's usage entry
// for routing vs your model. A lost write publishes nothing.
async function observeRouted($, router, { turnId, cfg, loop, loopVersion, request, response, nativeModel }) {
  // When the reply arrived: the awaits below can cross midnight or the hour it is kept under.
  const at = Date.now();
  let observed = observeResponse(cfg, loop, {
    usage: response.usage,
    requestedModel: request.model,
    effort: request.effort ?? null,
    stopReason: response.stopReason,
    now: at,
  });
  if (response.stopReason === null) observed.suspended = true;
  if (cfg.routingEngine === 'auto' && response.usage?.model && !isSameModel(request.model, response.usage.model))
    observed = observeAutoFallback(cfg, observed, {
      requestedModel: request.model,
      effort: request.effort,
      usage: response.usage,
    });
  if (cfg.routingEngine === 'auto' && loop.auto?.savedPin) {
    observed.switchedAt = loop.auto.savedPin.switchedAt;
    observed.servedRoute = loop.auto.savedPin.servedRoute;
  }
  const compared = await compareYours($, router, loop, response, request.effort ?? null, nativeModel, cfg);
  if (compared) observed.yoursBy = compared.states;
  // A model replied while this request was in flight (clearAgentHeld): its streak ends in the same write, so the
  // pending clear never loses this reply's usage to a version conflict.
  const pending = mergeAgentClears(router, observed);
  observed = pending.loop;
  const written = await $.state.set({ ...LOOP, id: 'main' }, observed, { ifVersion: loopVersion });
  if (!written.isSet) {
    if (cfg.routingEngine === 'shadow') router.trace?.reasons.add('gap');
    return;
  }
  if (pending.applied) {
    router.agentClears.clear();
    await updateView($, router, { holds: await holdsAfter($, router, observed.held) }).catch(() => {});
  }
  if (cfg.routingEngine === 'shadow') recordTraceResponse(router, request, request, response, compared?.ttl, at);
  // A substituted reply is not the tier's: the strip and trend must not count it as one.
  const tier = isSameModel(request.model, response.usage?.model) ? loop.decision.tier : null;
  const route = `${request.model}@${request.effort ?? 'session'}`;
  // Why the usage record leaves this reply out, when it does (UNPRICED_CAUSES).
  const observedUsd = compared?.reply?.routedUsd ?? observedReplyUsd(cfg, response.usage, compared?.ttl, at);
  const cause = !compared
    ? response.usage?.model
      ? 'error'
      : 'usage'
    : compared.reply
      ? null
      : observedUsd !== null
        ? 'comparison'
        : (unpricedCause(cfg, {
            usage: response.usage,
            served: { model: response.usage.model, effort: request.effort ?? null },
            yours: { model: nativeModel },
            ttl: compared.ttl,
          }) ?? 'error');
  await publishReply($, router, turnId, request, response, tier, route, observedUsd, cause);
  // Kept by model id, under the model that served it: a substitute's cost is not the requested model's, and a models
  // key can name another model later.
  const idOf = (model) => modelSpec(cfg, model)?.id ?? model;
  if (compared || observedUsd !== null)
    await addUsageEntry($, router, {
      turnId,
      compared: compared ?? { reply: null },
      observedUsd,
      tier,
      route: `${idOf(response.usage?.model ?? request.model)}@${request.effort ?? 'session'}`,
      yours: idOf(nativeModel),
      byId: Object.fromEntries(Object.entries(compared?.replies ?? {}).map(([alias, r]) => [cfg.models[alias].id, r])),
      usage: response.usage,
      at,
    });
}

// The main conversation's prompt-cache lifetime by Claude Code's rule (sessionCacheTtl), or null when a reading
// fails. $.env.get takes literal names only. A plan subscriber is one whose replies report plan rate limits; a usage
// without them is not one.
async function cacheTtlOf($) {
  try {
    const settings = await $.settings.read();
    const usage = await $.session.usage();
    return sessionCacheTtl({
      force5m: await $.env.get('FORCE_PROMPT_CACHING_5M'),
      envTtl: await $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL'),
      settingTtl: settings.promptCacheTtl,
      enable1h: await $.env.get('ENABLE_PROMPT_CACHING_1H'),
      subscriber: (usage?.rateLimits ?? []).some((limit) => limit.kind === 'five_hour' || limit.kind === 'seven_day'),
    });
  } catch {
    return null;
  }
}

// A main reply against every configured model (compareModels): the loop's next states, the reply's prices by models
// key, and `reply`, its prices against your model now, or null. The readout never breaks a turn. A reply whose cache
// lifetime cannot be read still moves the models' caches and is not counted; any other failure leaves the loop's
// states as they were and counts nothing.
async function compareYours($, router, loop, response, servedEffort, nativeModel, cfg = router.config) {
  try {
    if (!response.usage?.model) return null;
    const view = router.view ?? (await readView($, router));
    const ttl = await cacheTtlOf($);
    const compared = compareModels(cfg, loop.yoursBy ?? {}, {
      usage: response.usage,
      served: { model: response.usage.model, effort: servedEffort },
      effort: view.nativeEffort ?? null,
      ttl,
      now: Date.now(),
      yours: nativeModel,
    });
    return { ...compared, ttl };
  } catch {
    return null;
  }
}

// A routed reply, priced against your model now, added to the turn's running replies, which the view counts at once
// and turn.complete adds to the usage record. `route` is the served model's `id@effort`, `yours` your model's id,
// `byId` the reply priced against each model as yours, keyed by model id; `at` when the reply arrived (ms).
async function addUsageEntry($, router, { turnId, compared, observedUsd, tier, route, yours, byId, usage, at }) {
  try {
    const view = router.view ?? (await readView($, router));
    if (compared.reply || Number.isFinite(observedUsd)) {
      const turn = router.turnActivities.get(turnId);
      const entry = replyEntry({
        at,
        mode: turn?.routingMode ?? view.routingMode?.mode ?? DEFAULTS.mode,
        activity: tier ? (turn?.label ?? null) : null,
        tier,
        route,
        yours,
        reply: compared.reply,
        observedUsd,
        replies: byId,
        usage,
      });
      router.turnUsage.set(turnId, [...(router.turnUsage.get(turnId) ?? []), entry]);
      await updateView($, router, ledgerView(router, ['usage']));
    }
  } catch {}
}

// A finished turn's replies, and the switch that started it, added to this session's usage record. The turn leaves
// the running replies in the tick it enters the held record, so a view written at any point counts it once. A failed
// store write keeps it in the held record, which the next turn writes; a failed read or a Reset before that drops it
// from both.
async function flushUsage($, router, turnId, switched) {
  try {
    await addToLedger($, router, 'usage', (record, now) => {
      // Read here, not before the awaits: a reply can still join the turn while the record is read.
      const entries = router.turnUsage.get(turnId) ?? [];
      router.turnUsage.delete(turnId);
      return recordUsage(record, entries, { switched, now });
    });
  } catch {
  } finally {
    router.turnUsage.delete(turnId);
    await updateView($, router, ledgerView(router, ['usage'])).catch(() => {});
  }
}

// A turn's prompt, its origin and the classifier's request text. A progress turn asks about the goal it serves, with
// its report as dialogue (progressInput); without a goal from this session it reads as before. A goal origin's prompt
// becomes the goal.
async function startTurn($, router, e) {
  // Each turn reads the account holds again, another session's included (accountHoldsOf).
  router.accountHolds = null;
  if (!(await ensureInitialized($, router))) return;
  const epoch = ++router.goalEpoch;
  router.goalTurnId = e.turnId;
  router.mainTurnId = e.turnId;
  await fixTurnConfig($, router, e.turnId);
  const text = clip(stripReminders(e.text), router.config.context.maxTextChars);
  const origin = originOfTurn(router, e.text);
  router.turnOrigins.set(e.turnId, origin);
  const sessionId = await $.session.id();
  // A turn started meanwhile owns the goal; this turn still asks the classifier about its own prompt.
  router.prompts.set(e.turnId, text);
  if (router.goalEpoch !== epoch || router.goalTurnId !== e.turnId) return;
  const previous = router.goal?.sessionId === sessionId ? router.goal.text : null;
  const candidate = isGoalOrigin(origin) ? text : null;
  router.turnGoals.set(e.turnId, {
    sessionId,
    previous,
    previousRecord: previous ? router.goal : null,
    candidate,
    goal: previous,
  });
  if (isProgressOrigin(origin) && previous) {
    router.prompts.set(e.turnId, router.goal.text);
    router.progressNotes.set(e.turnId, text);
  }
}

function validateGoal(router, turnId, messages) {
  const pending = router.turnGoals.get(turnId);
  const record = pending?.previousRecord;
  if (!record || historySignature(messages, record.prefixCount) === record.prefix) return;
  if (router.goal === record) router.goal = null;
  const note = router.progressNotes.get(turnId);
  if (note) {
    router.prompts.set(turnId, note);
    router.progressNotes.delete(turnId);
  }
  router.turnGoals.set(turnId, { ...pending, previous: null, previousRecord: null, goal: null });
}

function rememberGoal(router, turnId, advice, threshold, messages) {
  const pending = router.turnGoals.get(turnId);
  if (!pending?.candidate || router.goalTurnId !== turnId) return;
  const text = continuedGoal(pending.previous, pending.candidate, advice?.continuation, threshold);
  const retained = text && text === pending.previous && advice?.continuation > 0.5;
  router.goal = text
    ? retained
      ? pending.previousRecord
      : {
          sessionId: pending.sessionId,
          text,
          prefixCount: messages.length,
          prefix: historySignature(messages),
        }
    : null;
  router.turnGoals.set(turnId, { ...pending, goal: text });
}

function clearGoal(router) {
  router.goal = null;
  router.goalTurnId = null;
  router.goalEpoch += 1;
  router.turnGoals.clear();
  // A notification must not keep a goal that a rewind/compaction invalidated.
  for (const [turnId, note] of router.progressNotes) router.prompts.set(turnId, note);
  router.progressNotes.clear();
}

// The engine stamps each prompt with where it came from (PromptOrigin); turn.start does not carry it. An idle
// submission starts its turn inside next(e), so the turn takes `submitting`; one queued behind a running turn starts
// later, or is delivered into it, and waits in `origins` under the text that entered. Bookkeeping only: the prompt
// passes on unchanged, and nothing here throws after next(e).
async function submitPrompt(router, e, next) {
  const entry = { kind: originKind(e.origin), started: false };
  const outer = router.submitting;
  router.submitting = entry;
  try {
    const result = await next(e);
    // biome-ignore lint/suspicious/noUnnecessaryConditions: turn.start sets `started` through router.submitting, an alias Biome cannot follow
    if (!entry.started && typeof result?.text === 'string' && !result.drop)
      router.origins = queueOrigin(router.origins, { kind: entry.kind, text: result.text, at: Date.now() });
    return result;
  } finally {
    // Only the submission still current restores: a later one that started meanwhile keeps its entry.
    if (router.submitting === entry) router.submitting = outer;
  }
}

// One decision row added to the turn's, bounded per turn (addTurnRow).
function addDecision(router, turnId, row) {
  router.turnDecisions.set(turnId, addTurnRow(router.turnDecisions.get(turnId) ?? [], row));
}

// The origin of a turn starting with `text`: the submission whose next(e) is running, once, else the oldest queued one
// with that text, else 'unknown'.
function originOfTurn(router, text) {
  if (router.submitting && !router.submitting.started) {
    router.submitting.started = true;
    return router.submitting.kind;
  }
  const taken = takeOrigin(router.origins, text, Date.now());
  router.origins = taken.queue;
  return taken.kind;
}

// A routed turn's route line: one record in `$.state`, one row placed at the transcript's end. Not for an interrupted
// turn, a subagent's, or a turn with routing off, which has no route of its own to say. Display only, so a failure
// here never breaks the turn, and a surface that cannot draw the row now is logged, not told.
async function placeRouteLine($, router, e, turn) {
  try {
    const view = router.view;
    const route = routeOf(view);
    if (!turn || e.isAborted || !route || !view || view.phase === 'unavailable') return;
    if ((await modeOf($, router, view.mode)) === 'manual') return;
    const previous = router.lastRoute;
    router.lastRoute = route;
    const mode = lineModeOf(await $.store.get(ROUTE_LINE).catch(() => undefined));
    if (!showsLine(mode, previous, route)) return;
    const id = lineId(e.turnId);
    await $.state.set({ ...LINES, id }, lineOf(router.config, view, route));
    const placed = await $.ui.place({ id });
    if (!placed.isPlaced) $.ui.log(`router route line not drawn: ${placed.reason}`, { to: 'debug' });
  } catch {}
}

// A finished turn's decision rows and its end row, added to this session's record. Telemetry never breaks a turn: a
// failed read or write loses this turn's rows. A record from before the last reset reads as empty, and rows read
// before a Reset in this session are not written back.
async function flushDecisions($, router, turnId, turn) {
  const rows = router.turnDecisions.get(turnId) ?? [];
  router.turnDecisions.delete(turnId);
  router.turnOrigins.delete(turnId);
  router.progressNotes.delete(turnId);
  router.turnGoals.delete(turnId);
  if (!rows.length) return;
  try {
    const resets = router.statsResets;
    const sessionId = await $.session.id();
    if (turn && turn.sessionId !== sessionId) return;
    const key = `${DECISIONS_PREFIX}${sessionId}`;
    const resetAt = await $.store.get(SAVINGS_RESET_KEY);
    // biome-ignore lint/nursery/useAtomicUpdates: the newest read of the one marker wins; any order of reads is right
    router.resetAt = resetAt ?? null;
    if (router.decisionRecord?.sessionId !== sessionId) {
      const record = readDecisions(await $.store.get(key));
      // Another flush may have read it meanwhile and added its rows to it: that one stands.
      if (router.decisionRecord?.sessionId !== sessionId) router.decisionRecord = { sessionId, record };
    }
    const held = router.decisionRecord;
    const now = Date.now();
    const end = turn
      ? [
          endRow({
            at: now,
            // With activity routing off recordActivity does not run, so the bucket is read here.
            observed: turn.observed ?? (await turnBucket($)),
            requests: turn.requests,
            priced: turn.pricedRequests,
            unpriced: turn.unpriced,
          }),
        ]
      : [];
    const record = appendDecisions(decisionsAfterReset(held.record, resetAt), [...rows, ...end], now);
    if (router.statsResets !== resets || router.decisionRecord !== held) return;
    held.record = record;
    await $.store.set(key, record);
  } catch {}
}

// The bucket of the turn the transcript ends with (observedActivity), or null when it cannot be read.
async function turnBucket($) {
  const messages = await transcript($);
  const start = messages ? promptIndex(messages) : -1;
  return start < 0 ? null : observedActivity(messages, start);
}

// Other sessions' decision records past their retention or the record bound (prunedDecisions), each read again just
// before its delete, so a session that wrote meanwhile keeps its record.
async function pruneDecisionRecords($) {
  try {
    const own = `${DECISIONS_PREFIX}${await $.session.id()}`;
    const keys = (await $.store.keys()).filter((key) => key.startsWith(DECISIONS_PREFIX) && key !== own);
    const values = await Promise.all(keys.map((key) => $.store.get(key)));
    const gone = prunedDecisions(
      keys.map((key, i) => [key, values[i]]),
      Date.now(),
    );
    await Promise.allSettled(
      [...gone].map(async (key) => {
        const current = await $.store.get(key);
        if (JSON.stringify(current) === JSON.stringify(values[keys.indexOf(key)])) await $.store.delete(key);
      }),
    );
  } catch {}
}

// This session's decision record, read from the store once per session, as a turn's flush reads it.
async function loadDecisionRecord($, router) {
  const sessionId = await $.session.id();
  if (router.decisionRecord?.sessionId === sessionId) return;
  const record = readDecisions(await $.store.get(`${DECISIONS_PREFIX}${sessionId}`));
  if (router.decisionRecord?.sessionId !== sessionId) router.decisionRecord = { sessionId, record };
}

// The pane's routing decisions, this session's newest, the running turn's included. Drawn from memory, never the
// store: a store read waits behind every other store call of the router, and the pane would stay blank meanwhile. The
// record is read as the session starts and as the pane opens (loadDecisionRecord).
async function paneDecisionRows($, router) {
  if (!['shadow', 'auto'].includes(router.config.routingEngine)) return [];
  const sessionId = await $.session.id();
  const record = router.decisionRecord?.sessionId === sessionId ? router.decisionRecord.record : readDecisions(null);
  return [...decisionsAfterReset(record, router.resetAt).rows, ...[...router.turnDecisions.values()].flat()];
}

async function decisionsText($, router, value) {
  const asked = value === undefined ? 20 : /^\d+$/.test(value) ? Number(value) : 0;
  if (asked < 1) return `Choose decisions 1 to ${MAX_ROWS}, or none for 20.`;
  const n = Math.min(MAX_ROWS, asked);
  try {
    const sessionId = await $.session.id();
    const stored =
      router.decisionRecord?.sessionId === sessionId
        ? router.decisionRecord.record
        : readDecisions(await $.store.get(`${DECISIONS_PREFIX}${sessionId}`));
    const resetAt = await $.store.get(SAVINGS_RESET_KEY);
    const pending = [...router.turnDecisions.values()].flat();
    return decisionLines([...decisionsAfterReset(stored, resetAt).rows, ...pending], n).join('\n');
  } catch {
    return 'Routing decisions could not be read.';
  }
}

// A finished turn's activity stats: the session counts in the view and the counts kept across sessions. Stats never
// break a turn: a failed read or write loses this turn's counts. Readings already in the session's metrics record stay
// in memory after a failed write and go out with the next turn that adds a reading.
async function recordActivity($, router, turn) {
  try {
    if ((await $.session.id()) !== turn.sessionId) return;
    const messages = await $.session.messages({ as: 'api' });
    const start = promptIndex(messages);
    if (start < 0) return;
    const observed = observedActivity(messages, start);
    const view = router.view ?? (await readView($, router));
    const manual = (await modeOf($, router)) === 'manual';
    // The session may have changed during the reads; this turn is not the new session's.
    if ((await $.session.id()) !== turn.sessionId) return;
    // The turn's end row reads it (flushDecisions).
    turn.observed = observed;
    // Advanced before any further await, so a session change meanwhile cannot carry this run into the new session.
    const { run, ended } = advanceRun(router.run, turn.answer);
    router.run = run;
    // Routing turned off while this turn ran ends the watch here, even when it is back on by now, so the move is not
    // inherited. The counter is read after the last await: a switch during any of them counts.
    const off = manual || turn.offSwitches !== router.offSwitches;
    const down = advanceDown(router.afterDown, turn);
    router.afterDown = off ? null : down.after;
    await updateView($, router, {
      activityStats: recordTurn(view.activityStats ?? emptySession(), {
        activity: turn.label,
        answer: turn.answer,
        observed,
        requests: turn.requests,
        inputTokens: turn.inputTokens,
        outputTokens: turn.outputTokens,
        routedUsd: turn.routedUsd,
        pricedRequests: turn.pricedRequests,
        routes: turn.routes,
        tierSwitches: turn.switched === 'tier' ? 1 : 0,
        activitySwitches: turn.switched === 'activity' ? 1 : 0,
        lateral: turn.lateral,
      }),
    });
    // Writing counts read before a reset would bring them back; this turn's are lost instead. A reset during a write
    // empties the view; these counts are older than it. Each record is written on its own: a failed write of one
    // keeps the other.
    const stats = { predicted: turn.predicted, observed, runEnded: ended, lateral: turn.lateral };
    const metrics = {
      classifier: turn.classifier,
      adviceMs: turn.adviceMs,
      downMove: down.event,
      unpriced: turn.unpriced,
    };
    const shown = await Promise.all([
      addToLedger($, router, 'activity', (record, now) => recordStore(record, stats, now)).catch(() => false),
      addToLedger($, router, 'metrics', (record, now) => recordMetrics(record, { ...metrics, now })).catch(() => false),
    ]);
    const kinds = ['activity', 'metrics'].filter((_, i) => shown[i]);
    if (kinds.length) await updateView($, router, ledgerView(router, kinds));
  } catch {}
}

// The session's open run ends with it; without this flush it is never counted.
async function flushRun($, router, run) {
  try {
    const ended = { predicted: null, observed: null, runEnded: run, lateral: null };
    await addToLedger($, router, 'activity', (record, now) => recordStore(record, ended, now));
  } catch {}
}

// The frontmatter of the agent file a spawn starts (agentFrontmatter), or null when it cannot be found or read. Read
// once per provider and type in a session, and never for a built-in, whose definition is not on disk. A read that
// failed is not kept: the next spawn of the type reads again.
async function agentDefinition($, router, e) {
  const plugin = e.provider?.plugin;
  if (typeof plugin !== 'string' || plugin === 'engine' || typeof e.subagentType !== 'string') return null;
  const key = `${plugin} ${e.subagentType}`;
  if (!router.definitions.has(key)) {
    try {
      router.definitions.set(key, await findDefinition($, plugin, e.subagentType));
    } catch {
      return null;
    }
  }
  return router.definitions.get(key);
}

// A plugin agent (provider `plugin@marketplace`) is looked up under each install path installed_plugins.json gives
// that plugin, the files Claude Code itself loads; any other agent under the session's .claude/agents, then the
// profile's agents. Every match must agree on the model, or the definition is unknown. Limit: a plugin that keeps its
// agents outside `agents/` reads as unknown, so its agents pass through. Throws when a file cannot be read.
async function findDefinition($, plugin, type) {
  const profile = await profileDir($);
  const name = type.slice(type.indexOf(':') + 1);
  const fromPlugin = plugin.includes('@');
  const dirs = fromPlugin
    ? (JSON.parse(await $.fs.read(`${profile}/plugins/installed_plugins.json`)).plugins?.[plugin] ?? []).map(
        (entry) => `${entry.installPath}/agents`,
      )
    : [`${await $.session.cwd()}/.claude/agents`, `${profile}/agents`];
  const found = [];
  for (const dir of dirs) {
    if (!(await $.fs.exists(dir))) continue;
    for (const entry of await $.fs.list(dir)) {
      if (entry.kind === 'dir' || !entry.name.endsWith('.md')) continue;
      const definition = agentFrontmatter(await $.fs.read(`${dir}/${entry.name}`));
      if (definition && (definition.name ?? entry.name.slice(0, -3)) === name) found.push(definition);
    }
    // A project agent replaces a user agent of the same name.
    if (found.length && !fromPlugin) break;
  }
  const agree = found.every((d) => d.model === found[0].model && d.modelRouting === found[0].modelRouting);
  return found.length && agree ? found[0] : null;
}

// The spawn path's classifier client: a breaker of its own, so spawn failures never pause main-turn routing, and no
// in-flight slot, so a parent that spawns several agents at once gets an answer for each.
function spawnClientOf(router, id) {
  const key = `spawn:${id}`;
  if (!router.clients.has(key)) router.clients.set(key, new ClassifierClient({ now: Date.now, exclusive: false }));
  return router.clients.get(key);
}

// A listed spawn's model: the models key its type names, or the classifier's pick for a `classify` type from the task
// text alone. `choice: 'core'` keeps core's model: no advice (`failed`), or a model availableModels blocks.
async function decideSpawn($, router, cfg, e, definition, signal) {
  let alias = typeRoute(cfg, e, definition).route;
  let failed = false;
  if (alias === CLASSIFY) {
    const entry = activeClassifier(cfg);
    const credentials = await resolveCredentials(entry, (name) => settingOf($, router.options, name));
    // The wait delays the subagent's start, so it is the classifier's deadline capped at SPAWN_DEADLINE_MS.
    const timeoutMs = Math.min(entry.timeoutMs, SPAWN_DEADLINE_MS);
    const result = await spawnClientOf(router, cfg.classifier).ask({
      request: (url, init) => $.http.fetch(url, init),
      sleep: (ms, args) => $.clock.sleep(ms, args),
      config: { ...cfg, classifiers: { ...cfg.classifiers, [cfg.classifier]: { ...entry, timeoutMs } } },
      apiKey: credentials.apiKey,
      endpoint: credentials.endpoint,
      prompt: spawnPrompt(cfg, e),
      turns: [],
      signal,
    });
    alias = classifiedAlias(cfg, result.advice);
    failed = !result.advice;
  }
  // The full id, not an alias: a family alias would resolve to the parent's exact model when the families match.
  const model = alias ? cfg.models[alias].id : null;
  // Settings that cannot be read may hold an availableModels list, so the model is not sent.
  const settings = await $.settings.read().catch(() => null);
  if (!model || !settings || !isModelAllowed(model, settings.availableModels, e.parentModel))
    return { choice: 'core', model: null, failed };
  // The router's own override is suppressed when its chosen model is held out right now: the spawn keeps Claude
  // Code's model, which may itself be the held one (main routing reaches the same conclusion for its own requests).
  const { value: loop } = await $.state.get({ ...LOOP, id: 'main' });
  const held = heldIds(cfg, loop?.held, await accountHoldsOf($, cfg, router), Date.now());
  if (held.some((id) => isSameModel(id, model))) return { choice: 'core', model: null, failed };
  return { choice: alias, model, failed };
}

// One model per subagent, chosen before its cache exists. `on` waits for the decision and sends its model, which
// Claude Code uses in place of the Agent call's `model` and the agent's frontmatter. Routing off or unavailable keeps
// every model Claude Code chooses, and records nothing.
async function spawnAgent($, router, e, next) {
  // A resumed agent keeps the model and the record of its first spawn: a hook can only refuse a resume. It runs again
  // from here, so the band's rows show it before its first reply.
  if (e.resume) {
    const result = await next(e);
    const agent = router.agents.get(e.resume.agentId);
    if (agent && !agent.running) {
      router.agents.set(e.resume.agentId, { ...agent, running: true });
      await showRunning($, router);
    }
    return result;
  }
  if (!(await ensureInitialized($, router))) return next(e);
  const cfg = router.config;
  if (cfg.subagentRouting === 'off') return next(e);
  const view = router.view ?? (await readView($, router));
  if (view.phase === 'unavailable' || (await modeOf($, router, view.mode)) === 'manual') return next(e);
  const definition = await agentDefinition($, router, e);
  const pass = passReason(cfg, e, definition);
  const decision = pass ? null : await decideSpawn($, router, cfg, e, definition, next.signal).catch(() => null);
  const routed = Boolean(decision?.model);
  const result = await next(decision?.model ? { ...e, model: decision.model } : e);
  if (result.agentId && (pass || decision))
    await noteSpawn($, router, { cfg, e, pass, decision, routed, result, definition }).catch(() => {});
  return result;
}

// The spawn's record, kept until the session ends. When routed, core's model is an estimate (coreModelOf); otherwise it
// is the model the agent started on.
async function noteSpawn($, router, { cfg, e, pass, decision, routed, result, definition }) {
  const parentKey = `${e.parentAgentId ?? 'main'} ${e.subagentType}`;
  const finishedAt = router.finished.get(parentKey);
  const coreModel = routed
    ? coreModelOf(cfg, e, {
        envModel: await $.env.get('CLAUDE_CODE_SUBAGENT_MODEL'),
        force: isSet(await $.env.get('CLAUDE_CODE_SUBAGENT_MODEL_FORCE')),
        definition,
      })
    : result.model;
  const routedModel = decision?.model ?? result.model;
  const record = spawnRecord({
    sessionId: await $.session.id(),
    spawn: e,
    pass,
    choice: decision?.choice ?? null,
    routedModel,
    coreModel,
    move: routed ? moveOf(cfg, routedModel, coreModel) : null,
    failed: decision?.failed,
    respawn: Number.isFinite(finishedAt) && Date.now() - finishedAt < RESPAWN_WINDOW_MS,
  });
  router.agents.set(result.agentId, { ...record, parentKey, running: true });
  await showRunning($, router);
}

// Which of the agents with a record are between their start or a step and their turn's end, and how many, in the view
// when the set changes: the band draws a row for each. An agent spawned with routing off has no record and is not
// listed.
async function showRunning($, router) {
  const ids = [...router.agents].filter(([, agent]) => agent.running).map(([id]) => id);
  if ((router.view?.subagentIds ?? []).join(' ') !== ids.join(' '))
    await updateView($, router, { subagentsRunning: ids.length, subagentIds: ids });
}

// The band's rows: the agents with a record that Claude Code still lists as running, never a teammate, whose own
// session the person opens from the tasks list. The list names the type and the task; the record the model.
async function runningAgents($, router) {
  const listed = await $.agent.list().catch(() => []);
  return listed.flatMap((agent) => {
    const record = router.agents.get(agent.id);
    return record?.running && !agent.teammateId && ['running', 'waiting'].includes(agent.status)
      ? [{ id: agent.id, type: agent.type, description: agent.description, record }]
      : [];
  });
}

// A press on an agent's row, or on Back, shows that transcript in the main view. Claude Code allows it only while the
// call answers the person's own input, so a press is the one place to ask; a refusal is told.
async function showView($, view) {
  const shown = await $.ui.view(view).catch(() => ({ deny: 'Could not switch the view.' }));
  if (shown.deny) $.ui.toast(shown.deny);
}

// A subagent's prompt-cache lifetime, by Claude Code's rule for requests outside the main conversation.
async function subagentTtlOf($) {
  const settings = await $.settings.read();
  return subagentCacheTtl({
    force5m: await $.env.get('FORCE_PROMPT_CACHING_5M'),
    envTtl: await $.env.get('CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL'),
    settingTtl: settings.subagentPromptCacheTtl,
    enable1h: await $.env.get('ENABLE_PROMPT_CACHING_1H'),
  });
}

// A subagent's step runs exactly as Claude Code sent it: a model switch between its steps would rewrite its context
// cold. Its reply is added to its spawn record; the record never breaks the step.
async function* stepAgent($, router, e, next) {
  // The model this agent's request ran, for a failure's hold: StopFailure names no model and `lastRequested` is the
  // main conversation's request.
  if (typeof e.model === 'string') router.agentRequests.set(e.agentId, e.model);
  const sentAt = Date.now();
  const sentHolds = router.accountHolds?.value;
  const response = yield* next(e);
  if (response?.usage)
    await endAnsweredHold($, router, router.config, e.model, response.usage, { at: sentAt, holds: sentHolds });
  if (router.agents.has(e.agentId) && response?.usage) {
    try {
      const ttl = await subagentTtlOf($);
      const agent = router.agents.get(e.agentId);
      if (agent)
        router.agents.set(e.agentId, {
          ...addAgentReply(router.config, agent, response.usage, ttl, Date.now()),
          running: true,
        });
      if (agent && !agent.running) await showRunning($, router);
    } catch {}
  }
  // A reply from the model itself clears its failure streak, as a main reply does (observeResponse): a hold written
  // from this agent's failure is over, and the next one starts at the base time again.
  if (response?.usage && typeof e.model === 'string' && isSameModel(e.model, response.usage.model))
    await clearAgentHeld($, router, e.model);
  return response;
}

// The model holds without `model`'s, as a main reply leaves them: the model answered, so its streak starts over. The
// view is refreshed after the write, so the pane and `/router release` stop naming a hold routing no longer keeps; a
// write that lost to another leaves both the loop and the view as they are. While a main request is in flight its
// reply owns the loop write, so the clear is queued and merged into that write (observeRouted).
async function clearAgentHeld($, router, model) {
  try {
    if (router.mainInFlight > 0) {
      // The moment of the answer travels with the clear: a hold set after it is a later failure and stays.
      router.agentClears.set(model, Date.now());
      return;
    }
    const ref = { ...LOOP, id: 'main' };
    const { value: loop, version } = await $.state.get(ref);
    if (!loop?.held) return;
    const held = clearedModel(loop.held, model);
    if (held === loop.held) return;
    const written = await $.state.set(ref, { ...loop, held }, { ifVersion: version });
    if (written.isSet) await updateView($, router, { holds: await holdsAfter($, router, held) });
  } catch {}
}

// The loop with the queued agent clears merged: an answer made after a hold was set ends it; a hold set after the
// answer is a later failure and stays. Entries remain queued until a successful main write applies whatever they
// cleared.
function mergeAgentClears(router, loop) {
  if (!router.agentClears.size) return { loop, applied: false };
  let held = loop.held;
  for (const [model, at] of router.agentClears) held = clearedSince(held, model, at);
  if (held === loop.held) return { loop, applied: false };
  return { loop: { ...loop, held }, applied: true };
}

// A subagent's turn ended: its counts since the last flush go to this session's record kept across sessions.
async function finishAgent($, router, agentId) {
  const agent = router.agents.get(agentId);
  if (!agent) return;
  router.finished.set(agent.parentKey, Date.now());
  router.agents.set(agentId, { ...flushedAgent(agent), running: false });
  await showRunning($, router).catch(() => {});
  await flushSubagents($, router, [agent]);
}

// This session's agents' counts added to its record kept across sessions. Stats never break a turn: a failed read or
// write loses these counts.
async function flushSubagents($, router, agents) {
  try {
    const sessionId = await $.session.id();
    const mine = agents.filter((agent) => agent.sessionId === sessionId);
    if (!mine.length) return;
    const add = (record, now) => mine.reduce((sum, agent) => recordAgent(sum, agent, now), record);
    if (await addToLedger($, router, 'subagents', add)) await updateView($, router, ledgerView(router, ['subagents']));
  } catch {}
}

function traceConfigAdopted(router, loaded) {
  try {
    if (router.config.routingEngine !== 'shadow' || loaded.routingEngine === 'shadow' || !router.trace) return;
    router.trace.reasons.add('mode-gap');
    router.trace.turns.clear();
    router.traceOperations.clear();
    router.trace.controls = null;
  } catch {
    traceFailed(router);
  }
}

// The session row under the band, on or off. The band's button and the pane's setting share it; `view` is the view the
// caller was drawn from, and `router.view` holds any press since.
// The band redraws first; the choice is then saved, as a store write can wait behind other store calls.
async function toggleBandDetail($, router, view) {
  const bandDetail = !(router.view ?? view).bandDetail;
  await updateView($, router, { bandDetail });
  await $.store.set(BAND_DETAIL, bandDetail).catch(() => {});
}

const EMPTY_PROJECT_PATCH = {};
const EMPTY_ROUTING_DRAFT = { routeDraft: null, tuning: null, tuningBase: null };

// Rebasing is safe only across a change made here from the held revision. Never rebase an edit across an
// unseen external write or a refresh: keep its original expected values for the next conflict check.
function rebaseProjectDraft(view, config) {
  const routeDraft = view?.routeDraft;
  const next = routeDraftOf(config, {});
  const base = tuningOf(config);
  const tuning = Object.fromEntries(
    Object.entries(view?.tuning ?? {}).filter(
      ([key, value]) => value !== view?.tuningBase?.[key] && value !== base[key],
    ),
  );
  const { base: original, ...desired } = routeDraft ?? {};
  const { base: current, ...draft } = next;
  const edits = original ? routingEdits(original, desired) : [];
  return {
    routeDraft: edits.length ? { ...applyRoutingEdits(draft, edits), base: current } : null,
    tuning: Object.keys(tuning).length ? tuning : null,
    tuningBase: Object.keys(tuning).length ? base : null,
  };
}

async function adoptProjectPreference($, router, project, preference, patch) {
  const loaded = preference.config;
  const switched = loaded.classifier !== router.config.classifier;
  if (switched) clientOf(router, loaded.classifier).restore(null);
  traceConfigAdopted(router, loaded);
  project.preference = preference;
  router.config = loaded;
  const routingMode = await routingModeOf($, router);
  return updateView($, router, {
    ...(switched
      ? {
          ...CLEARED_READINGS,
          error: router.view?.phase === 'unavailable' ? router.view.error : null,
          credentials: await credentialsOf($, router.options, loaded).catch(() => router.view?.credentials ?? null),
          health: healthOf(clientOf(router, loaded.classifier), loaded.classifier),
        }
      : {}),
    ...projectRoutingView(project),
    projectReloadNeeded: false,
    routingMode,
    confirmProjectClear: false,
    ...patch,
    ...(switched && patch.notice
      ? {
          notice: `${patch.notice} Classifier prompts go to ${classifierDestination(activeClassifier(loaded).endpoint).text}.`,
        }
      : {}),
  });
}

// Null means the intent no longer applies to the store record the user acted on.
function intendedProjectPatch(intent, held, current, before) {
  if (intent.clearAll)
    return JSON.stringify(intent.clearAll.raw) === JSON.stringify(current.raw) ? EMPTY_PROJECT_PATCH : null;
  if (intent.undo) {
    // An intervening writer may have replaced a value and later set it back. Do not undo their edit.
    return current.record?.revision === intent.undo.revision ? intent.undo.patch : null;
  }
  if (intent.clearFields) {
    if (intent.clearFields.some((key) => JSON.stringify(held.record?.patch[key]) !== JSON.stringify(before[key])))
      return null;
    return Object.fromEntries(Object.entries(before).filter(([key]) => !intent.clearFields.includes(key)));
  }
  const { edits, base } = intent;
  if (
    routingConflict(edits, held.record?.patch ?? EMPTY_PROJECT_PATCH, before) ||
    routingConflict(edits, base, current.config)
  )
    return null;
  return applyRoutingEdits(before, edits);
}

// One store mutation path for pane and commands. No caller-side timeout: even a timed-out host request may commit.
// Each intent checks the record it reads; only acknowledged writes are adopted. With no store CAS, overlapping
// writes from other Mod instances are last-write-wins, even when their intents touch different fields.
async function changeProjectPreference($, router, intent) {
  const project = router.project;
  const scope = project?.scope;
  const notice = (message, extra = {}) => updateView($, router, { notice: message, ...extra });
  if (router.view?.phase === 'unavailable')
    return notice('Not saved: routing is unavailable. Resolve the routing warning first.');
  if (!scope)
    return notice(
      'Not saved: no verified project routing scope. Launch Claude Code in a project and reload the plugin.',
    );
  if (router.projectWrite) return notice('A project routing change is already in progress.');
  const run = Promise.resolve().then(async () => {
    const current = await projectPreference($, scope, project.base);
    if (intent.refresh)
      return adoptProjectPreference($, router, project, current, {
        notice: current.error ? `Ignored: ${current.error}.` : 'Project routing preferences refreshed.',
      });
    const conflict = () =>
      notice('Not saved: project routing overrides changed elsewhere. Use Reload, then review your changes.', {
        confirmProjectClear: false,
        projectReloadNeeded: true,
      });
    if (current.error && !(intent.clearAll && current.resettable)) return notice(`Not saved: ${current.error}.`);
    const before = current.record?.patch ?? EMPTY_PROJECT_PATCH;
    const patch = intendedProjectPatch(intent, project.preference, current, before);
    if (patch === null) return conflict();
    let config;
    try {
      config = applyRoutingPatch(project.base, patch, true);
    } catch {
      return notice('Not saved: the overrides do not make a valid routing configuration. Review the pending changes.');
    }
    if (!current.error && JSON.stringify(before) === JSON.stringify(patch))
      return notice('No stored overrides changed.', { confirmProjectClear: false });
    // Keep an empty stamped record after a clear so a later Undo cannot resurrect a superseded edit.
    const record = {
      version: 1,
      identity: scope.identity,
      revision: hex(crypto.getRandomValues(new Uint8Array(16))),
      patch,
    };
    try {
      await $.store.set(scope.key, record);
    } catch {
      return notice('Save status unknown: the store did not confirm the change. Use Reload before retrying.', {
        projectReloadNeeded: true,
      });
    }
    const drafts = router.view;
    const ownRevision = project.preference.record?.revision === current.record?.revision;
    const rebased = ownRevision ? rebaseProjectDraft(drafts, config) : {};
    const committedDraft =
      intent.draft && drafts?.routeDraft === intent.draft.routeDraft && drafts?.tuning === intent.draft.tuning;
    router.projectUndo = intent.undo || current.error ? null : { revision: record.revision, patch: before };
    return adoptProjectPreference(
      $,
      router,
      project,
      { config, record, raw: record, error: null, resettable: true },
      {
        ...rebased,
        ...(committedDraft ? EMPTY_ROUTING_DRAFT : {}),
        lastWrite: router.projectUndo ? { label: intent.label } : null,
        notice: intent.undo
          ? `Undid: ${intent.label}. Applies from the next turn.`
          : `Saved: ${intent.label}. Applies from the next turn in this project.`,
      },
    );
  });
  router.projectWrite = run;
  try {
    return await run;
  } finally {
    if (router.projectWrite === run) router.projectWrite = null;
  }
}

// The pane's handlers. `view` is the view the pane was drawn from; a handler reads `router.view` first, which holds
// any press since.
function paneActions($, router, view) {
  const editRoute = (tier, change) => {
    const draft = routeDraftOf(router.config, router.view ?? view);
    const current = effectiveRoutes(draft, router.config).routes[tier];
    return updateView($, router, {
      routeDraft: { ...draft, routes: { ...draft.routes, [tier]: change(current) } },
      notice: null,
    });
  };
  const editCell = (activity, tier, kind, value) =>
    updateView($, router, {
      routeDraft: editActivity(
        routeDraftOf(router.config, router.view ?? view),
        router.config,
        activity,
        tier,
        kind,
        value,
      ),
      notice: null,
    });
  const save = (intent) => changeProjectPreference($, router, intent);
  const write = (label, desired) => {
    const { config } = router;
    return save({ label, base: config, edits: routingEdits(config, { ...config, ...desired }) });
  };
  // The Usage tab's period, kept across sessions; a failed save keeps it for this session.
  const showPeriod = async (period, patch = {}) => {
    if (!PERIODS.includes(period)) return;
    await updateView($, router, { usagePeriod: period, usageOpen: null, ...patch });
    await $.store.set(PERIOD_KEY, period).catch(() => {});
  };
  return {
    mode: (mode) => changeMode($, router, mode),
    tab: (tab) => updateView($, router, { tab, notice: null, confirmDelete: false, confirmProjectClear: false }),
    help: () => updateView($, router, { help: !(router.view ?? view).help }),
    toggleDetail: () => toggleBandDetail($, router, view),
    pin: async (tier) => {
      await updateView($, router, { notice: await setPin($, router, tier) });
    },
    unpin: () => updateView($, router, { pendingPin: null, notice: null }),
    ...keyActions($, router, view),
    copyPath: async (press) => {
      await $.ui.copy({ text: router.config.nativePath, surface: press?.surface });
      await updateView($, router, { notice: 'Path copied.' });
    },
    close: () => $.ui.close({ id: PANE }),
    routeModel: (tier, alias) =>
      editRoute(tier, (route) => ({
        model: alias,
        effort: router.config.models[alias]?.efforts.includes(route.effort) ? route.effort : null,
      })),
    routeEffort: (tier, effort) => editRoute(tier, (route) => ({ model: route.model, effort })),
    baseline: async (tier) => {
      const draft = routeDraftOf(router.config, router.view ?? view);
      await updateView($, router, { routeDraft: { ...draft, baselineTier: tier }, notice: null });
    },
    saveRouting: () => {
      const current = router.view ?? view;
      const draft = routeDraftOf(router.config, current);
      const tuned = current.tuningBase ?? tuningOf(router.config);
      const policy = Object.fromEntries(
        POLICY_ROWS.map(([key, , , path]) => [path.slice('policy.'.length), tuned[key]]),
      );
      const after = { ...policy };
      for (const [key, , , path] of POLICY_ROWS) {
        if (Object.hasOwn(current.tuning ?? {}, key)) after[path.slice('policy.'.length)] = current.tuning[key];
      }
      const { base: initial, ...edited } = draft;
      const base = { ...initial, policy };
      const edits = routingEdits(base, { ...edited, policy: after });
      if (!edits.length) return updateView($, router, { notice: 'No routing changes to save.' });
      return save({ label: 'routing changes', base, edits, draft: current });
    },
    activityMode: (mode) =>
      updateView($, router, {
        routeDraft: { ...routeDraftOf(router.config, router.view ?? view), activityRouting: mode },
        notice: null,
      }),
    activityModel: (activity, tier, alias) => editCell(activity, tier, 'model', alias),
    activityEffort: (activity, tier, effort) => editCell(activity, tier, 'effort', effort),
    // Restore puts the built-in default back; Use tier model drops the cell, a built-in one saved as the tier's route.
    restoreActivity: (activity, tier) => editCell(activity, tier, 'add'),
    removeActivity: (activity, tier) => editCell(activity, tier, 'remove'),
    selectCell: (cell) => updateView($, router, { routeCell: cell, notice: null }),
    usageDetail: () => updateView($, router, { usageDetail: !(router.view ?? view).usageDetail }),
    period: (period) => showPeriod(period),
    // The Now tab's Usage links: the Usage tab on the period the line sums.
    usageFor: (period) => showPeriod(period, { tab: 'usage', notice: null, confirmDelete: false }),
    usageGroup: (group) => updateView($, router, { usageGroup: group, usageOpen: null }),
    usageCompare: () => updateView($, router, { usageCompare: !(router.view ?? view).usageCompare }),
    usageOpen: (row) => updateView($, router, { usageOpen: row }),
    // An insight's link: the Routes tab with the grid cell it names open.
    openRoute: (cell) => updateView($, router, { tab: 'routes', routeCell: cell, notice: null }),
    confirmDelete: (asked) => updateView($, router, { confirmDelete: asked }),
    routingMode: (mode) => {
      const from = router.config.mode;
      if (mode === from || !ROUTING_MODES.includes(mode)) return undefined;
      return write(`routing mode ${from} → ${mode}`, { mode });
    },
    activityRouting: (mode) => {
      const from = router.config.activityRouting;
      if (mode === from || !ACTIVITY_MODES.includes(mode)) return undefined;
      return write(`activity routing ${from} → ${mode}`, { activityRouting: mode });
    },
    engine: (engine) => {
      const from = router.config.routingEngine;
      if (engine === from || !ROUTING_ENGINES.includes(engine)) return undefined;
      return write(`routing engine ${from} → ${engine}`, { routingEngine: engine });
    },
    refreshProject: () => save({ refresh: true }),
    confirmProjectClear: (asked) => {
      if (router.project) router.project.confirmedClear = asked ? { raw: router.project.preference.raw } : null;
      return updateView($, router, { confirmProjectClear: asked, notice: null });
    },
    clearProject: () => {
      if (!(router.view ?? view).confirmProjectClear || !router.project?.confirmedClear) return undefined;
      return save({
        label: 'cleared stored project routing overrides',
        clearAll: router.project.confirmedClear,
        draft: router.view ?? view,
      });
    },
    // Delete history: every record kept across sessions (usage, the undated savings, activity stats and metrics,
    // subagents) and this session's counts.
    resetStats: async () => {
      router.statsResets += 1;
      router.run = null;
      router.afterDown = null;
      router.turnUsage.clear();
      router.turnDecisions.clear();
      router.decisionRecord = null;
      for (const [id, agent] of router.agents) router.agents.set(id, flushedAgent(agent));
      // Every session's records. The marker is written first, so a session still holding its record from before the
      // reset drops it, unless that record's first count has the reset's millisecond or the clock moved back across
      // the reset.
      const clearRecords = async () => {
        const resetAt = Date.now();
        await $.store.set(SAVINGS_RESET_KEY, resetAt);
        router.resetAt = resetAt;
        const { now, later } = historyKeys(await $.store.keys(), await $.session.id());
        // This session's own records go now, as a delete without a read races none of its writes, with the shared
        // record from before 1.10.3, which the marker cannot hide. Every other session's go from a timer, so the press
        // does not wait on a whole-file rewrite per key; the marker already empties them for every reader. Each is read
        // again first: one its session started over after the reset holds counts the reset left, and stays.
        const deleted = await deleteUnless($, now);
        $.clock.after(0, () => deleteUnless($, later, (current) => startedSince(current, resetAt)));
        for (const kind of LEDGER_KINDS)
          router.ledgers[kind] = { own: null, others: LEDGERS[kind].empty(), othersResetAt: resetAt };
        // A record that stays may come back: the shared one from before 1.10.3 has no first count for the marker.
        return now.every((key) => deleted.has(key));
      };
      router.trace = null;
      router.traceFreshSession = null;
      router.traceClearSession = null;
      router.traceOperations.clear();
      const cleared = await clearRecords().catch(() => false);
      // The store kept the history: this session's records start over, and its next write replaces the stored one.
      if (!cleared)
        for (const kind of LEDGER_KINDS) {
          const held = router.ledgers[kind];
          if (held.own)
            held.own = { ...heldRecord(LEDGERS[kind], held.own.sessionId, undefined), stored: held.own.stored };
        }
      await updateView($, router, {
        activityStats: null,
        confirmDelete: false,
        usageOpen: null,
        ...ledgerView(router),
        notice: cleared
          ? 'History deleted: usage, activity and subagent records of every session.'
          : 'This session’s counts cleared. The saved history could not be deleted.',
      });
    },
    discardRouting: () => updateView($, router, { ...EMPTY_ROUTING_DRAFT, notice: null }),
    resetRoutes: () =>
      save({ label: 'cleared stored tier routes and start tier', clearFields: ['routes', 'baselineTier'] }),
    tune: (key, value) =>
      updateView($, router, {
        tuning: { ...(router.view ?? view).tuning, [key]: value },
        tuningBase: (router.view ?? view).tuningBase ?? tuningOf(router.config),
        notice: null,
      }),
    resetPolicy: () => save({ label: 'cleared stored policy overrides', clearFields: ['policy', 'modes'] }),
    classifier: (id) => {
      const { config } = router;
      if (!id || id === config.classifier || !Object.hasOwn(config.classifiers, id)) return undefined;
      return write(`classifier ${config.classifiers[config.classifier].label} → ${config.classifiers[id].label}`, {
        classifier: id,
      });
    },
    classifierTimeout: (timeoutMs) => {
      const { classifier, classifiers } = router.config;
      const active = classifiers[classifier];
      if (timeoutMs === active.timeoutMs) return undefined;
      return write(`${active.label} deadline ${active.timeoutMs} → ${timeoutMs} ms`, {
        classifiers: { ...classifiers, [classifier]: { ...active, timeoutMs } },
      });
    },
    release: (scope, key) => releaseKey($, router, scope, key),
    undo: async () => {
      const last = (router.view ?? view).lastWrite;
      if (!last) return undefined;
      if (last.restore) return undoRelease($, router, last);
      if (!router.projectUndo) return undefined;
      return save({ label: last.label, undo: router.projectUndo });
    },
  };
}

// The session's turns, open run and running agents end with it; the view starts the next session from the counts kept
// across sessions.
async function endSession($, router) {
  for (const controller of router.controllers) controller.abort();
  router.decisions.clear();
  clearGoal(router);
  router.prompts.clear();
  router.turnOrigins.clear();
  router.progressNotes.clear();
  router.turnDecisions.clear();
  router.origins = [];
  router.submitting = null;
  router.goal = null;
  router.decisionRecord = null;
  router.turnConfigs.clear();
  router.turnPins.clear();
  router.turnActivities.clear();
  for (const review of router.reviews.values()) review.controller.abort();
  router.reviews.clear();
  router.turnUsage.clear();
  const run = router.run;
  router.run = null;
  router.afterDown = null;
  if (run) await flushRun($, router, run);
  // Agents still running when the session ends: what they did so far is counted.
  const agents = [...router.agents.values()];
  router.agents.clear();
  router.finished.clear();
  await flushSubagents($, router, agents);
  router.view = {
    ...initialView(router.view?.nativeModel ?? ''),
    // The effort carries over /clear until the next turn reads it again, so "your model" keeps its effort.
    nativeEffort: router.view?.nativeEffort ?? null,
    mode: 'auto',
    credentials: router.view?.credentials ?? null,
    // Counts kept across sessions: the next session starts from them.
    activityStore: router.view?.activityStore ?? null,
    activityMetrics: router.view?.activityMetrics ?? null,
    savingsStore: router.view?.savingsStore ?? null,
    subagentStore: router.view?.subagentStore ?? null,
    usageStore: router.view?.usageStore ?? null,
    usagePeriod: router.view?.usagePeriod ?? 'session',
    health: healthOf(clientOf(router, router.config.classifier), router.config.classifier),
    configPath: router.config.nativePath,
    phase: router.view?.phase === 'unavailable' ? 'unavailable' : 'ready',
    error: router.view?.phase === 'unavailable' ? router.view.error : null,
  };
}

async function imagesOf($, config, decision) {
  if (modelSpec(config, decision?.model)?.imageInput !== false) return false;
  const messages = await transcript($);
  return messages === null || hasImages(messages);
}

function startError(supported, gateway) {
  if (!supported) return `requires Claude Code ${MIN_CLAUDE_CODE} or newer`;
  if (gateway) return GATEWAY_SETTINGS;
  return null;
}

function configurationError(error) {
  if (error.message?.endsWith(MIGRATION_HINT))
    return 'router.json needs migration; run the plugin scripts/migrate-config.mjs with your router.json path';
  return error.message === 'selected provider router file is missing' ? error.message : 'invalid router configuration';
}

// A request's stream with the engine's own items kept in `withheld` until the first item of an answer, which passes
// them on first. A failed request streams those items alone, and passing them on records its API error in the turn
// (and opens Claude Code's usage-limit menu): one sent again leaves them out.
async function* untilAnswered(stream, withheld) {
  let answering = false;
  let item;
  try {
    item = await stream.next();
    while (!item.done) {
      if (!answering && item.value.kind === 'engine') withheld.push(item.value);
      else {
        if (!answering) yield* withheld.splice(0);
        answering = true;
        yield item.value;
      }
      item = await stream.next();
    }
    return item.value;
  } finally {
    // Read by hand, so, unlike under `yield*`, a caller that stops early closes the stream only here.
    if (!item?.done) await stream.return?.(undefined);
  }
}

// A main request on its way to the API. A reply ends a hold on the account of its model; a request to an account whose
// probe is due is that probe, and one that gets no reply (a failed request resolves empty) waits longer for the next.
// With `withheld`, the failed request's engine items wait there for the caller (untilAnswered).
/** @param {unknown[] | null} [withheld] */
async function* sendMain($, router, request, next, cfg, withheld = null) {
  const sentAt = Date.now();
  // Taken now: opening the pane before the reply drops the turn's reading (readHolds).
  const sentHolds = router.accountHolds?.value;
  const probe = dueProbeOf(router, cfg, request.model, sentAt);
  const response = withheld ? yield* untilAnswered(next(request), withheld) : yield* next(request);
  if (response?.usage)
    await endAnsweredHold($, router, cfg, request.model, response.usage, { at: sentAt, holds: sentHolds });
  else if (probe && response?.stopReason === null && !next.signal.aborted)
    await rescheduleProbe($, router, probe.account);
  return response;
}

// What a main request to `model` tries again: its account, held with a probe due, or the model itself, whose
// availability hold ended with no answer since. Null for a model with no failure to try again.
function probationOf(router, cfg, loop, model, now) {
  const probe = dueProbeOf(router, cfg, model, now);
  const key = heldKey(loop.held, model);
  const hold = key === undefined ? undefined : loop.held[key];
  const ended = hold?.kind === 'availability' && !isActive(hold, now) ? { key, hold } : null;
  return probe || ended ? { probe, ended } : null;
}

// The route of the second request for a step whose try of a model on probation got no reply: the model or its account
// is held again and the step's route is computed around it. Null when no other model can serve, and the failure stands.
// Only a model on probation: a step does not see why a request failed, so any other failure ends the turn, where
// StopFailure names it, and a request the provider refused is not sent to another model.
async function standInStep($, router, e, { cfg, loop, failed, probation, nativeModel, context, availableModels }) {
  try {
    const { probe, ended } = probation;
    const now = Date.now();
    const held = ended
      ? holdModel(loop.held, ended.key, { kind: 'availability', scope: 'model', until: null }, ended.hold.error, now)
      : loop.held;
    const holds = await routingHoldsOf($, cfg, router);
    // The probed account stays held for this step even when its next probe could not be written.
    const accountHolds = probe ? { ...holds, [probe.account]: probe.hold } : holds;
    const messages = await transcript($);
    const input = {
      nativeModel,
      contextTokens: context.tokens,
      contextKnown: context.known,
      availableModels,
      effort: e.effort,
      // An unreadable transcript cannot establish that a stand-in without image input is safe.
      hasImages: messages === null || hasImages(messages),
      accountHolds,
      now,
    };
    const renewed = { ...loop, held };
    const moved = continueRoute(cfg, renewed, input);
    const { model } = moved.decision;
    if (isSameModel(model, failed) || !canTakeOver(cfg, renewed, model, input)) return null;
    return moved;
  } catch {
    return null;
  }
}

// The model holds a failed try renewed, written before the stand-in is sent: an aborted stand-in writes no reply, and
// the next turn would try the failed model at once. Returns the loop and the version its reply is written at.
async function keepRenewedHold($, router, loop, held, loopVersion) {
  const renewed = { ...loop, held };
  const written = await $.state.set({ ...LOOP, id: 'main' }, renewed, { ifVersion: loopVersion }).catch(() => null);
  const shown = /** @type {import('../lib/holds.mjs').HoldSet | null | undefined} */ (router.view?.holds);
  if (written?.isSet && shown) await updateView($, router, { holds: { ...shown, models: held } }).catch(() => {});
  return { loop: renewed, loopVersion: written?.isSet ? written.version : loopVersion };
}

// The row, toast and view of a step sent again as `decision` routes it. Everything but the view's save is done when it
// returns, so nothing waits between the caller's checks and its request.
function announceStandIn($, router, e, { cfg, decision, failed, probation, context }) {
  const { probe, ended } = probation;
  const { model, effort } = decision;
  addDecision(
    router,
    e.turnId,
    failureRow({
      at: Date.now(),
      failure: probe ? probe.hold.kind : 'availability',
      scope: probe ? 'account' : 'model',
      held: probe ? probe.account : ended.key,
      route: `${model}@${effort ?? 'session'}`,
    }),
  );
  $.ui.toast(`${modelName(failed)} still limited → ${modelName(model)}`);
  return updateView($, router, continuationView(cfg, decision, context)).catch(() => {});
}

// Whether routing is off now: unavailable, or turned off, which can happen while a request is on its way.
async function routingOff($, router) {
  const view = router.view;
  return view?.phase === 'unavailable' || (await modeOf($, router, view?.mode)) === 'manual';
}

// The step's request as `decision` routes it.
function routedRequest(e, decision) {
  const request = { ...e, model: decision.model };
  if (decision.effort === null) delete request.effort;
  else request.effort = decision.effort;
  return request;
}

async function* sendRouted($, router, e, next, step) {
  const { cfg, sessionId, nativeModel, context, availableModels, turn } = step;
  let { loop, loopVersion } = step;
  const pinPresses = router.turnPins.get(e.turnId);
  if (pinPresses !== undefined) {
    router.turnPins.delete(e.turnId);
    if (pinPresses === router.pinPresses) await updateView($, router, { pendingPin: null });
  }
  if (cfg.routingEngine === 'auto' && !loop.decision.route)
    return yield* passMain($, e, next, loop, loopVersion, nativeModel, 'no-route-native', router);
  let request = routedRequest(e, loop.decision);
  // Read again, not `turn`: a pinned turn's decision (decideTurn) fixed its pin's configs during this step.
  if (cfg.routingEngine === 'shadow' && !next.signal.aborted && (await $.session.id()) === sessionId)
    traceRequest(router, e, router.turnConfigs.get(e.turnId) ?? turn, request, 'auto', loop);
  // biome-ignore lint/nursery/useAtomicUpdates: the request sent last names the model, whatever ran before it
  router.lastRequested = request.model;
  // `auto` keeps a failed step as it is: its turn ends, and the failure holds what it names.
  const probation = cfg.routingEngine === 'auto' ? null : probationOf(router, cfg, loop, request.model, Date.now());
  // Only a request on probation can be sent again, so only its failure's items are held back.
  const withheld = probation ? /** @type {unknown[]} */ ([]) : null;
  let response = yield* sendMain($, router, request, next, cfg, withheld);
  const unanswered = response?.stopReason === null && response.usage === null;
  if (probation && unanswered && !next.signal.aborted && (await $.session.id()) === sessionId) {
    const failed = request.model;
    const retry = { cfg, loop, failed, probation, nativeModel, context, availableModels };
    const moved = await standInStep($, router, e, retry);
    if (moved) {
      if (probation.ended) ({ loop, loopVersion } = await keepRenewedHold($, router, loop, moved.held, loopVersion));
      // Read last: routing turned off or a new session since the try sends the conversation nowhere else.
      const live = (await $.session.id()) === sessionId && !(await routingOff($, router));
      if (live && !next.signal.aborted) {
        withheld?.splice(0);
        loop = moved;
        request = routedRequest(e, loop.decision);
        // A trace holds one request per step, so a replay cannot follow this one.
        traceGap(router, cfg.routingEngine);
        router.lastRequested = request.model;
        const published = announceStandIn($, router, e, { ...retry, decision: loop.decision });
        response = yield* sendMain($, router, request, next, cfg);
        await published;
      }
    }
  }
  // Not sent again: the failure stands as Claude Code reported it.
  if (withheld?.length) yield* withheld.splice(0);
  if (!next.signal.aborted && (await $.session.id()) === sessionId)
    await observeRouted($, router, { turnId: e.turnId, cfg, loop, loopVersion, request, response, nativeModel });
  else if (cfg.routingEngine === 'shadow') router.trace?.reasons.add('aborted');
  return response;
}

function resetEngine(router, cfg, configured, model, messageCount, previous) {
  let loop = previous;
  // Engine state is incompatible, but physical cache/usage observations remain valid across engine changes.
  if ((cfg.routingEngine === 'auto' || loop.activeEngine === 'auto') && loop.activeEngine !== cfg.routingEngine) {
    const fresh = emptyLoop(configured, model);
    loop = {
      ...loop,
      lastRoute: fresh.lastRoute,
      lastActivity: fresh.lastActivity,
      route: fresh.route,
      state: fresh.state,
      turnId: null,
      decision: null,
      suspended: false,
      reviewedAt: loop.requests,
      observedFrom: messageCount,
      auto: null,
      shadow: undefined,
      generation: loop.generation + 1,
      activeEngine: cfg.routingEngine,
    };
    for (const review of router.reviews.values()) review.controller.abort();
    router.reviews.clear();
    router.decisions.clear();
  }
  return loop;
}

async function continueAuto($, router, cfg, prior, e, context, traceInput) {
  let loop = prior;
  const messages = await transcript($);
  const facts = { ...stepFacts(cfg, router, loop, e, messages ?? [], context), midTurn: true };
  // An unreadable transcript cannot establish that an image-ineligible request is safe.
  facts.hasImages = messages ? hasImages(messages) : true;
  const observed = messages
    ? routingBucket(observedActivity(messages, Math.max(promptIndex(messages), (loop.observedFrom ?? 0) - 1)))
    : null;
  const previous = loop.decision;
  loop = autoRoute(cfg, loop, { ...traceInput, facts, now: Date.now() }, { continuation: true, observed });
  if (JSON.stringify(previous.auto) !== JSON.stringify(loop.decision.auto))
    addDecision(
      router,
      e.turnId,
      decisionRow({
        at: Date.now(),
        kind: 'observed',
        engine: 'auto',
        mode: cfg.routingMode.mode,
        decision: loop.decision,
        facts,
      }),
    );

  return loop;
}

async function traceContinuation($, router, cfg, loop, e, traceInput) {
  if (cfg.routingEngine === 'shadow') {
    // Replay's incumbent may differ from the table's: retain unconditional modality and checkpoint evidence.
    // Failure stays unknown, never a false assertion that the hypothetical route can accept this history.
    let replayMessages;
    let actualHasImages = null;
    try {
      replayMessages = await transcript($);
      if (replayMessages) actualHasImages = hasImages(replayMessages);
    } catch {
      replayMessages = null;
    }
    traceOp(router, e, cfg, 'continue', { ...traceInput, actualHasImages }, loop, replayMessages);
  }
}

// The turn's decision, made once for the steps that wait on it. Only a route serves the turn's later steps: a decision
// that failed, was dropped or lost its write is made again at the next step, so routing turned off and on meanwhile
// routes it.
function decisionOf($, router, e, signal, step) {
  const key = `${step.sessionId}:${e.turnId}:${step.loop.generation}`;
  const held = router.decisions.get(key);
  if (held) return held;
  const job = decideTurn($, router, e, signal, step);
  const forget = () => {
    if (router.decisions.get(key) === job) router.decisions.delete(key);
  };
  job.then((selected) => selected || forget(), forget);
  router.decisions.set(key, job);
  return job;
}

// A main step sent as Claude Code built it leaves no trace request, though the trace may already hold the turn.
function traceGap(router, engine) {
  if (engine === 'shadow') router.trace?.reasons.add('gap');
}

// The guard covers the whole main step, from before its loop read to its reply's write: an agent's hold clear queues
// for that window and is merged into that write (clearAgentHeld), so it cannot move the version this step's own
// decision and reply writes need.
async function* stepMain($, router, e, next) {
  if (!(await ensureInitialized($, router))) return yield* next(e);
  if (e.agentId) return yield* stepAgent($, router, e, next);
  router.mainInFlight += 1;
  try {
    return yield* mainStep($, router, e, next);
  } finally {
    router.mainInFlight -= 1;
  }
}

async function* mainStep($, router, e, next) {
  // A main request goes out as Claude Code built it unless sendRouted routes it, so its model is the one a failure
  // holds (holdFailedModel) until sendRouted names another.
  router.lastRequested = e.model;
  const turn = router.turnConfigs.get(e.turnId) ?? (await turnConfigOf($, router));
  const cfg = turn.config;
  const [sessionId, nativeModel, view] = await Promise.all([$.session.id(), $.session.model(), readView($, router)]);
  const saved = await savedMode($, router);
  const mode = saved ?? view.mode;
  const freshTrace =
    router.traceFreshSession === sessionId ||
    (router.traceClearSession !== null && router.traceClearSession !== sessionId);
  router.traceFreshSession = null;
  router.traceClearSession = null;
  if (e.index === 0) {
    // A mode the store could not give is not written over the saved one it may hide; one already saved is not
    // written again, as each write rewrites the whole store before the request goes.
    const remembered =
      saved === undefined || router.storedModes.get(sessionId) === mode || (await rememberMode($, mode));
    if (remembered && saved !== undefined) router.storedModes.set(sessionId, mode);
    await updateView($, router, {
      mode,
      nativeEffort: e.effort ?? null,
      ...(!remembered ? { notice: 'Resume preference could not be saved. Current mode remains active.' } : {}),
    });
  }
  const ref = { ...LOOP, id: 'main' };
  const loaded = await $.state.get(ref);
  let loopVersion = loaded.version;
  // The session's model names its tier in the configured routes: a mode's table can run it at another tier.
  let loop = prepareLoop(loaded.value ?? emptyLoop(turn.configured, e.model), e.messageCount);
  loop = resetEngine(router, cfg, turn.configured, e.model, e.messageCount, loop);
  if (loaded.value && loop.generation !== loaded.value.generation) clearGoal(router);
  if (cfg.routingEngine === 'shadow' && router.config.routingEngine === 'shadow') {
    await ensureTrace($, router, e, turn, loop, Boolean(loaded.value), freshTrace);
    router.traceOperations.delete(e.turnId);
    if (loaded.value && loop.generation !== loaded.value.generation)
      addTrace(router, e, { type: 'reset', at: Date.now(), cause: 'history', loop, generation: loop.generation });
  } else if (router.trace) router.trace.reasons.add('mode-gap');
  if (view.phase === 'unavailable' || mode === 'manual') {
    return yield* passMain($, e, next, loop, loopVersion, nativeModel, 'manual', router);
  }
  if (loop.turnId === e.turnId && isNativeFallback(loop, e.model)) {
    return yield* passMain($, e, next, loop, loopVersion, nativeModel, 'native-fallback', router);
  }
  // Settings that cannot be read may hold an availableModels list, so the step goes out as Claude Code built it.
  const [context, settings] = await Promise.all([contextOf($, loop), $.settings.read().catch(() => null)]);
  if (!settings) {
    traceGap(router, cfg.routingEngine);
    return yield* next(e);
  }
  const availableModels = settings.availableModels;
  if (loop.turnId !== e.turnId) {
    const selected = await decisionOf($, router, e, next.signal, {
      sessionId,
      view,
      cfg,
      configured: turn.configured,
      loop,
      loopVersion,
      context,
      nativeModel,
      availableModels,
    });
    if (!selected) {
      if (!next.signal.aborted && (await $.session.id()) === sessionId && router.view?.activeTurnId === e.turnId) {
        const reserved = await $.state.set(ref, loop, { ifVersion: loopVersion });
        if (reserved.isSet) return yield* passMain($, e, next, loop, reserved.version, nativeModel, 'manual', router);
      }
      traceGap(router, cfg.routingEngine);
      return yield* next(e);
    }
    loop = selected.loop;
    loopVersion = selected.version;
  } else {
    // A review answer applies first, so tool calls made after its snapshot can still move the route up.
    loop = await reviewMidTurn($, router, cfg, loop, e, { context, nativeModel, availableModels });
    loop = await moveOnObserved($, router, cfg, loop, e, context);
    const stepHolds = await routingHoldsOf($, cfg, router);
    const traceInput = {
      hasImages: cfg.routingEngine === 'auto' ? false : await imagesOf($, cfg, loop.decision),
      nativeModel,
      contextTokens: context.tokens,
      contextKnown: context.known,
      availableModels,
      effort: e.effort,
      accountHolds: stepHolds,
      now: Date.now(),
    };
    traceInput.held = heldIds(cfg, loop.held, stepHolds, traceInput.now);
    loop =
      cfg.routingEngine === 'auto'
        ? await continueAuto($, router, cfg, loop, e, context, traceInput)
        : continueRoute(cfg, loop, traceInput);
    await traceContinuation($, router, cfg, loop, e, traceInput);
    await updateView($, router, continuationView(cfg, loop.decision, context));
  }
  if (
    cfg.routingEngine === 'auto' &&
    (next.signal.aborted || (await $.session.id()) !== sessionId || (await modeOf($, router)) !== 'auto')
  )
    return yield* next(e);
  const step = { cfg, loop, loopVersion, sessionId, nativeModel, context, availableModels, turn };
  return yield* sendRouted($, router, e, next, step);
}

async function initializeSession($, router) {
  router.definitions.clear();
  try {
    // A command that fails to register leaves routing as it is: the band still opens the pane.
    try {
      await $.command.register({
        name: 'router',
        description:
          'Open the Router pane, or switch routing: on, off, engine <table|shadow|auto>, pin <tier>, activities <mode>, mode <mode>, line <mode>; decisions [n] lists the last routing decisions; holds lists what is held out of routing, release <model|account> ends a hold.',
        argumentHint: argumentHint(),
        immediate: true,
      });
    } catch {}
    const model = await $.session.model();
    const loaded = await loadNativeConfig($, router);
    // The optional private overlay seeds capability where the profile declares none. It is read when a session starts
    // or the Mod is reloaded (/reload-plugins). Project settings compose on that evidence-enriched profile.
    const overlay = await loadEvidenceOverlay($);
    const project = await loadProjectRouting($, loaded, overlay);
    const { config } = project.preference;
    const existing = await readView($, router);
    // A successful reload adopts this config even for the current turn; stale jobs must not route with the old engine.
    Object.assign(router, { config, project, view: existing, projectUndo: null });
    for (const controller of router.controllers) controller.abort();
    router.decisions.clear();
    router.turnConfigs.clear();
    for (const review of router.reviews.values()) review.controller.abort();
    router.reviews.clear();
    const sameClassifier = existing.health?.classifier === router.config.classifier;
    clientOf(router, router.config.classifier).restore(sameClassifier ? existing.health : null);
    const base = await $.env.get('ANTHROPIC_BASE_URL');
    const version = await $.session.version().catch(() => null);
    const supported = supportedVersion(version?.version);
    const gateway =
      ['jev-router', 'jev-router[1m]'].includes(model) ||
      model === 'router' ||
      Boolean(base?.includes('127.0.0.1:43170') || base?.includes('localhost:43170'));
    await updateView($, router, {
      nativeModel: model,
      ...(existing.activityContract !== ACTIVITY_CONTRACT
        ? { activityContract: ACTIVITY_CONTRACT, activityStats: null }
        : {}),
      ...(await startView($, router, model)),
      phase: gateway || !supported ? 'unavailable' : 'ready',
      error: startError(supported, gateway),
      ...(sameClassifier ? {} : CLEARED_READINGS),
      credentials: await credentialsOf($, router.options, router.config),
      health: healthOf(clientOf(router, router.config.classifier), router.config.classifier),
      configPath: router.config.nativePath,
      routingMode: await routingModeOf($, router),
      ...projectRoutingView(project),
      projectReloadNeeded: false,
      confirmProjectClear: false,
      tuning: null,
      tuningBase: null,
      routeDraft: null,
      lastWrite: null,
      bandDetail: (await $.store.get(BAND_DETAIL).catch(() => false)) === true,
      usagePeriod: await periodOf($),
    });
    // biome-ignore lint/nursery/useAtomicUpdates: ensureInitialized runs this once at a time, and the flag marks it done
    router.initialized = true;
    return true;
  } catch (error) {
    await updateView($, router, {
      phase: 'unavailable',
      error: configurationError(error),
    }).catch(() => {});
    return false;
  }
}

// What made routing unavailable, as the notice keys it: an old Claude Code, the v0.8 gateway settings, or a router.json
// that did not load.
function unavailableCause(error) {
  if (error?.startsWith('requires Claude Code')) return 'version';
  return error === GATEWAY_SETTINGS ? 'gateway' : 'config';
}

// One toast when a session starts with routing unavailable, at most once a day per cause: the band says it too, but not
// once it is collapsed or scrolled away. Not for a headless run, which has no one to read it. The day is recorded before
// the toast, so a toast no surface draws is not retried until tomorrow. A surface that attaches later (desktop, VS Code,
// mobile) gets it too, once per surface, once this session has shown it: it was not there to see the first. The day
// record still gates the session's first toast, on whichever surface asks first.
async function noticeUnavailable($, router, e) {
  const view = router.view;
  if (view?.phase !== 'unavailable' || !e.isInteractive || !e.surface) return;
  if (router.noticeSurfaces.has(e.surface)) return;
  try {
    if (router.noticeSurfaces.size === 0) {
      const key = `${UNAVAILABLE_NOTICE_PREFIX}${unavailableCause(view.error)}`;
      const last = await $.store.get(key);
      const now = Date.now();
      if (Number.isFinite(last) && now - last >= 0 && now - last < UNAVAILABLE_NOTICE_INTERVAL_MS) return;
      await $.store.set(key, now);
    }
    router.noticeSurfaces.add(e.surface);
    $.ui.toast(`Routing off: ${unavailableReason(view)}. Claude’s model is kept.`);
  } catch {}
}

const MODEL_SELECTED_MANUALLY = 'model selected manually';
// The most turns in a row that an API error ended which the router runs again on its own.
const MAX_RERUNS = 2;
const MANUAL_SWITCH_SOURCES = new Set(['picker', 'sdk']);

// A person chose the session's model: routing turns off and keeps it.
async function keepChosenModel($, router, reason) {
  await changeMode($, router, 'manual');
  await updateView($, router, { nativeModel: await $.session.model(), ...(reason ? { reason } : {}) });
}

// The request an API error ended, read as `StopFailure` arrives: by the time its hold is written, the next turn can
// have started. Null for an agent whose request is unknown.
function failedRequestOf(router, e) {
  if (e.agent_id === undefined) return { agent: false, turnId: router.mainTurnId, model: router.lastRequested };
  const model = router.agentRequests.get(e.agent_id);
  return model === undefined ? null : { agent: true, turnId: null, model };
}

// A turn ended on an API error (`StopFailure`): the request is lost, and Claude Code reports neither the model nor a
// retry-after. The failure goes into the turn's decision rows with what Claude Code gave and the plan's readings, then
// classifies (classifyFailure) and holds: an error that is the model's holds the model the last request ran, which can
// be a stand-in, out of routing for a while in the loop; a used-up quota holds its account in $.store, where every
// session and restart sees it (lib/failover.mjs). Every engine holds: table and shadow stand a stand-in in for the held
// route, auto excludes the held model from its candidates. `failedRequest` names the model and the main turn as the
// failure found them (failedRequestOf). An agent's failure holds its model too, but belongs to the agent's turn: the
// main turn's decision rows are not where its evidence goes.
async function holdFailedModel($, router, e, failedRequest) {
  // A failed hold changes no route; the turn's result stands.
  try {
    if (!(await ensureInitialized($, router))) return;
    const { config } = router;
    const { agent, turnId } = failedRequest;
    const model = failedRequest.model ?? (await $.session.model());
    const usage = await $.session.usage().catch(() => null);
    const limits = planLimits(usage);
    const now = Date.now();
    const account = accountOfModel(config, model);
    // Some failures, a spend cap among them, carry no error_details: only the synthetic message names the cause.
    const details = [e.error_details, e.last_assistant_message].find((text) => typeof text === 'string' && text !== '');
    const failure = classifyFailure({
      error: e.error,
      details,
      limits,
      billing: billingOf(config, usage),
      planAccounts: planAccountsOf(config),
      account,
      accounts: config.accounts,
      now,
    });
    const held =
      failure.kind === null
        ? null
        : await applyHold($, router, failure, e.error, failure.scope === 'account' ? account : model, now).catch(
            () => null,
          );
    if (held) await updateView($, router, { holds: await holdsAfter($, router, held.models) });
    if (agent || turnId === null) return;
    if (held?.hold) {
      const failed = { turnId, model, cause: holdCause(held.hold), reruns: router.reruns };
      // turn.complete came first. A StopFailure hook may not submit a prompt (it would wait on the turn), so a timer does.
      if (router.erroredTurn === turnId) {
        router.erroredTurn = null;
        $.clock.after(0, () => rerunTurn($, router, failed).catch(() => {}));
      } else router.failedTurn = failed;
    }
    addDecision(
      router,
      turnId,
      failureRow({
        at: now,
        error: e.error,
        details,
        limits,
        failure: held ? failure.kind : null,
        scope: held ? failure.scope : null,
        held: held?.key ?? null,
      }),
    );
    // A turn that already completed will not flush its rows again; one completing now flushes them with its end row.
    if (!router.turnConfigs.has(turnId) && !router.completing.has(turnId))
      await flushDecisions($, router, turnId, null);
  } catch {}
}

// The account holds of `cfg`'s accounts in $.store, account name to hold, for routing to skip the models they cover. A
// hold that cannot be read holds nothing: a turn is never blocked on the store. Every engine reads them, as the pane and
// `/router holds` do. With `router`, as a turn's requests and spawns read them, they are read once per turn and held, so
// a hold another session writes mid-turn counts from the next turn: a hold changes only when a turn fails on a window or
// a balance, and each store read waits behind every other store call of the router. A turn's start, this session's own
// hold writes and readHolds drop what is held.
/** @param {ReturnType<typeof createRouter> | null} [router] */
async function accountHoldsOf($, cfg, router = null) {
  const names = accountNames(cfg);
  const id = names.join('\n');
  if (router?.accountHolds?.id === id) return router.accountHolds.value;
  const read = await Promise.all(
    names.map(async (name) => [name, readHold(await $.store.get(`${HOLDS_PREFIX}${name}`).catch(() => null))]),
  );
  const value = Object.fromEntries(read.filter(([, hold]) => hold));
  if (router) router.accountHolds = { id, value };
  return value;
}

// The account holds main routing skips: one whose probe is due is left out, so a main turn may try its account.
// Spawns, the pane, the band and `/router holds` read every hold.
async function routingHoldsOf($, cfg, router) {
  const holds = await accountHoldsOf($, cfg, router);
  const due = dueProbes(holds, Date.now());
  return Object.fromEntries(Object.entries(holds).filter(([account]) => !due.includes(account)));
}

// The running hold, with a probe due, on `model`'s account among those already read, so a request to `model` is the
// probe; or null. Never a store read.
function dueProbeOf(router, cfg, model, now) {
  const account = accountOfModel(cfg, model);
  const hold = account === null ? undefined : router.accountHolds?.value[account];
  return account !== null && hold && dueProbes({ [account]: hold }, now).length > 0 ? { account, hold } : null;
}

// `account`'s hold as now known, in the holds read for this turn and in the view; null when it has none.
async function showAccountHold($, router, account, hold) {
  const patched = (holds) => (hold ? { ...holds, [account]: hold } : releaseHold(holds, account));
  const read = router.accountHolds;
  if (read) router.accountHolds = { ...read, value: patched(read.value) };
  const shown = /** @type {import('../lib/holds.mjs').HoldSet | null | undefined} */ (router.view?.holds);
  if (shown) await updateView($, router, { holds: { ...shown, accounts: patched(shown.accounts) } });
}

// A model of a held account answered: the limit was raised or reset early. `sent` is when the request left and the
// account holds read by then; a reply never waits on a store read for one it did not have. A dated snapshot is the
// requested model, and any other reply names the model, and so the account, that answered. The store is read before the
// delete, as another session may have held the account again since; only a reply that ends a hold pays that.
async function endAnsweredHold($, router, cfg, model, usage, sent) {
  try {
    if (!usage.model) return;
    const account = accountOfModel(cfg, isSameModel(model, usage.model) ? model : usage.model);
    const hold = account === null ? undefined : sent.holds?.[account];
    if (!hold || !isActive(hold, Date.now())) return;
    // Another reply ended it meanwhile. No reading at all says nothing: opening the pane drops it.
    if (router.accountHolds && !router.accountHolds.value[account]) return;
    // The view and the turn's holds drop it before the delete, so a reply that lands meanwhile does not end it again.
    // A view that cannot be saved still lets the stored hold go.
    await showAccountHold($, router, account, null).catch(() => {});
    const store = `${HOLDS_PREFIX}${account}`;
    const current = readHold(await $.store.get(store));
    if (!current) return;
    if (current.since > sent.at) return await showAccountHold($, router, account, current);
    await $.store.delete(store);
    $.ui.toast(`${accountLabel(account)} answered again: routing may use it`);
  } catch {}
}

// A probe got no reply. The hold is read again: another session may have released it or already put its probe off.
async function rescheduleProbe($, router, account) {
  try {
    const store = `${HOLDS_PREFIX}${account}`;
    const current = readHold(await $.store.get(store));
    const now = Date.now();
    const due = current !== null && dueProbes({ [account]: current }, now).length > 0;
    const hold = due ? probeFailed(current, now) : current;
    if (due) await $.store.set(store, hold);
    await showAccountHold($, router, account, hold);
  } catch {}
}

// The holds in force now, as the pane, the band and `/router holds` read them: each account's from $.store and the models'
// from the loop. A read that fails shows none. The read replaces what a turn holds.
async function readHolds($, router) {
  const loaded = await $.state.get({ ...LOOP, id: 'main' }).catch(() => null);
  router.accountHolds = null;
  return { accounts: await accountHoldsOf($, router.config), models: loaded?.value?.held ?? {} };
}

// The holds after a write in this event: a loop read in the same event sees the loop from before it, so the model holds
// just written (`models`, when the write was to the loop) stand in for the ones read.
async function holdsAfter($, router, models) {
  const read = await readHolds($, router);
  return models ? { ...read, models } : read;
}

// Writes the hold of an account (in $.store) or a model (in the loop), or ends it with null, and returns `{ models }`:
// the loop's model holds as written, or null when the loop was not written. With `keepRunning`, a hold running now is
// not replaced: returns null then. A loop write that lost to another throws: reads are frozen for the event, so reading
// the loop again would only lose again.
async function writeHold($, scope, key, hold, keepRunning = false) {
  const runs = (current) => keepRunning && current && isActive(current, Date.now());
  if (scope === 'account') {
    const store = `${HOLDS_PREFIX}${key}`;
    if (runs(readHold(await $.store.get(store)))) return null;
    await (hold ? $.store.set(store, hold) : $.store.delete(store));
    return { models: null };
  }
  const ref = { ...LOOP, id: 'main' };
  const { value: loop, version } = await $.state.get(ref);
  if (!loop) return { models: null };
  if (runs(loop.held?.[heldKey(loop.held, key) ?? key])) return null;
  const held = hold ? { ...loop.held, [key]: hold } : releaseHold(loop.held, key);
  if (!(await $.state.set(ref, { ...loop, held }, { ifVersion: version })).isSet)
    throw new Error('the hold changed while it was written');
  return { models: held };
}

// Ends the hold of `row` (lib/holds.mjs) and keeps it for Undo in the pane. Returns what happened, in words.
async function releaseHeld($, router, row) {
  let written;
  try {
    written = await writeHold($, row.scope, row.key, null);
  } catch {
    return `${row.name} could not be released.`;
  }
  const notice = `Released ${row.name}: routing may use it from the next turn.`;
  await updateView($, router, {
    holds: await holdsAfter($, router, written?.models),
    lastWrite: {
      label: `released ${row.name}`,
      restore: { scope: row.scope, key: row.key, hold: row.hold },
    },
    notice,
  });
  return notice;
}

// The Now tab's Release: the hold is read again, since another session may have ended it.
async function releaseKey($, router, scope, key) {
  const holds = await readHolds($, router);
  const row = heldRows(router.config, holds, Date.now()).find((one) => one.scope === scope && one.key === key);
  if (!row) return updateView($, router, { holds, notice: 'Already released.' });
  await releaseHeld($, router, row);
  return undefined;
}

// Undo of a release puts the hold back as it was, unless another hold on the same name was set since.
async function undoRelease($, router, last) {
  const { scope, key, hold } = last.restore;
  const written = await writeHold($, scope, key, hold, true).catch(() => undefined);
  const outcome = written === undefined ? 'failed' : written ? 'done' : 'held';
  const name = last.label.replace(/^released /, '');
  const notices = {
    done: `Undid: ${last.label}.`,
    held: `Not undone: ${name} is held again.`,
    failed: `Not saved: ${last.label} could not be undone.`,
  };
  return updateView($, router, {
    holds: await holdsAfter($, router, written?.models),
    lastWrite: outcome === 'failed' ? last : null,
    notice: notices[outcome],
  });
}

// `/router release <model|account>`.
async function releaseCommand($, router, word) {
  const found = releaseRow(router.config, await readHolds($, router), word, Date.now());
  return found.row ? releaseHeld($, router, found.row) : found.text;
}

const accountLabel = (account) => (account === PLAN_ACCOUNT ? 'Claude plan' : account);

// Holds `key`, the account or model a failure names, and returns it with the hold now on it, or null when nothing was
// held. $.store has no atomic update, so two sessions that fail together can each write their own hold; the later write
// stands, and both say the same account is out.
async function applyHold($, router, failure, error, key, now) {
  if (failure.scope === 'account') {
    const store = `${HOLDS_PREFIX}${key}`;
    const running = readHold(await $.store.get(store)) ?? undefined;
    const hold = failureHold(failure, error, running, now);
    if (!hold) return null;
    router.accountHolds = null;
    if (hold !== running) await $.store.set(store, hold);
    if ((await modeOf($, router)) === 'auto')
      $.ui.toast(`${accountLabel(key)} held out of routing: ${holdText(hold, now)}`);
    return { key, hold, models: null };
  }
  const ref = { ...LOOP, id: 'main' };
  // A write that lost to another holds nothing: reads are frozen for the event, so reading the loop again would only
  // lose again.
  const { value: loop, version } = await $.state.get(ref);
  if (!loop) return null;
  const at = Date.now();
  const held = holdModel(loop.held, key, failure, error, at);
  const written = await $.state.set(ref, { ...loop, held }, { ifVersion: version });
  if (!written.isSet) return null;
  const hold = activeHolds(held, at)[heldKey(held, key) ?? key];
  if (hold && (await modeOf($, router)) === 'auto')
    $.ui.toast(`${modelName(key)} held out of routing: ${holdText(hold, at)}`);
  return { key, hold, models: held };
}

// Whether routing is on and some model the session may select is not held now, so a turn run again can go to another.
async function canRerun($, router) {
  const [{ accounts, models }, settings, nativeModel] = await Promise.all([
    readHolds($, router),
    $.settings.read().catch(() => null),
    $.session.model(),
  ]);
  // Settings that cannot be read may hold an availableModels list. The mode is read last, after the waits.
  if (!settings || (await routingOff($, router))) return false;
  const held = heldIds(router.config, models, accounts, Date.now());
  return Object.values(router.config.models).some(
    (spec) =>
      isModelAllowed(spec.id, settings.availableModels, nativeModel) && !held.some((id) => isSameModel(id, spec.id)),
  );
}

// A main turn's end: one that an API error ended runs again once its StopFailure has held the cause, now or when the
// StopFailure comes later; any other end starts a new count of re-runs.
async function completeFailedTurn($, router, e) {
  const failed = router.failedTurn;
  router.failedTurn = null;
  if (e.reason !== 'error') {
    router.erroredTurn = null;
    router.reruns = { count: 0 };
    return;
  }
  if (failed?.turnId === e.turnId) return rerunTurn($, router, failed);
  router.erroredTurn = e.turnId;
}

// A main turn that an API error ended, after the router held its cause, is run again as a new prompt, so the work goes on
// without the person; at most MAX_RERUNS in a row, as a task that fails on every model would never stop.
/** @param {FailedTurn} failed */
async function rerunTurn($, router, failed) {
  const { reruns } = failed;
  if (!(await canRerun($, router)) || reruns !== router.reruns) return;
  if (reruns.count >= MAX_RERUNS) {
    $.ui.toast(`Stopped retrying after ${MAX_RERUNS} re-runs in a row: ${failed.cause}`);
    return;
  }
  reruns.count += 1;
  $.ui.toast(`Retrying on another model: ${failed.cause}`);
  const text = `The last request failed on ${modelName(failed.model)} (${failed.cause}), so the router held it out of routing. Continue the task from where it stopped.`;
  // Not awaited: it resolves when the queued turn starts, which waits for this turn.complete to return.
  $.prompt.submit({ text }).catch((error) => {
    // Nothing was queued, so it does not count.
    reruns.count -= 1;
    $.ui.log(`router re-run not queued: ${error}`, { to: 'debug' });
  });
}

async function ensureInitialized($, router) {
  if (router.initialized) return true;
  if (router.loadFailed) return false;
  router.initializing ??= initializeSession($, router).finally(() => {
    router.initializing = null;
  });
  return router.initializing;
}

// A main turn's end: its pins, reviews and decision jobs go, and its route line, activity, usage, decisions and trace
// are recorded. A subagent's end flushes its record.
async function completeTurn($, router, e) {
  if (e.agentId) {
    await finishAgent($, router, e.agentId);
    return;
  }
  // Until flushDecisions takes the rows, which it does before its first await, a failure row joins them.
  router.completing.add(e.turnId);
  const turn = router.turnActivities.get(e.turnId);
  try {
    router.turnConfigs.delete(e.turnId);
    router.turnPins.delete(e.turnId);
    router.reviews.get(e.turnId)?.controller.abort();
    router.reviews.delete(e.turnId);
    router.turnControllers.get(e.turnId)?.abort();
    const held = router.view;
    if (held !== null && held.activeTurnId === e.turnId && held.phase === 'choosing') {
      router.view = { ...held, activeTurnId: null };
      const mode = await modeOf($, router);
      if (router.view?.activeTurnId === null)
        await updateView($, router, { phase: mode === 'manual' ? 'manual' : 'ready', reason: 'interrupted' });
    }
    router.prompts.delete(e.turnId);
    for (const key of router.decisions.keys()) if (key.includes(`:${e.turnId}:`)) router.decisions.delete(key);
    // `off` asks nothing, so it records nothing; it only ends the watch after a cheaper activity move.
    router.turnActivities.delete(e.turnId);
    await placeRouteLine($, router, e, turn);
    if (turn?.mode === 'off') {
      if ((await $.session.id()) === turn.sessionId) router.afterDown = advanceDown(router.afterDown, turn).after;
    } else if (turn) await recordActivity($, router, turn);
    if (router.turnUsage.has(e.turnId)) await flushUsage($, router, e.turnId, turn?.switched ?? null);
  } finally {
    // The turn's rows leave it even when its bookkeeping failed, so none stay pending for the rest of the session.
    router.completing.delete(e.turnId);
    await flushDecisions($, router, e.turnId, turn);
  }
  if (router.config.routingEngine === 'shadow' && router.trace?.turns.has(e.turnId)) {
    addTrace(router, e, { type: 'end', at: Date.now() });
    flushTraceLater($, router, e.turnId);
  }
  router.traceOperations.delete(e.turnId);
}

// A session start loads router.json again, a failed load included, and toasts when routing is unavailable.
async function startSession($, router, e) {
  router.trace = null;
  router.traceOperations.clear();
  router.lastRoute = null;
  router.lastRequested = null;
  router.mainTurnId = null;
  router.failedTurn = null;
  router.erroredTurn = null;
  router.reruns = { count: 0 };
  router.initialized = false;
  router.loadFailed = false;
  router.noticeSurfaces.clear();
  router.capabilityNoticed = false;
  // A clear queued by a previous session's agent says nothing about this session's holds.
  router.agentClears.clear();
  const sessionId = await $.session.id();
  // Lazy profile loading is not a lifecycle signal; only a real Mod start can establish freshness.
  router.traceFreshSession = router.traceStartedSession !== sessionId ? sessionId : null;
  router.traceStartedSession = sessionId;
  await ensureInitialized($, router);
  await noticeUnavailable($, router, e);
}

export function register(on, options) {
  const router = createRouter(options);

  // The router's bookkeeping never keeps a session or a turn from starting. What the session reads from the store
  // beyond its settings (refreshAfterStart) runs from a timer: it takes a store read per record, Claude Code waits for
  // session.start before the first prompt and drops a press on the band meanwhile, and the band shows the mode and a
  // turn routes without it.
  on('session.start', async ($, e, next) => {
    await router.projectWrite?.catch(() => {});
    await startSession($, router, e).catch(() => {});
    $.clock.after(0, () => refreshAfterStart($, router).catch(() => {}));
    return next(e);
  });

  // The terminal's own attachment raises nothing; a desktop, VS Code or mobile surface attaches after session.start.
  on('session.attach', async ($, e, next) => {
    const result = await next(e);
    await noticeUnavailable($, router, { isInteractive: true, surface: e.surface });
    return result;
  });

  on('command.run', { command: 'model' }, async ($, e, next) => {
    const result = await next(e);
    if (e.origin.kind !== 'plugin') await keepChosenModel($, router, MODEL_SELECTED_MANUALLY);
    return result;
  });

  on('config.set', { key: 'model' }, async ($, e, next) => {
    const result = await next(e);
    if (!result.deny && e.origin.kind !== 'plugin') await keepChosenModel($, router);
    return result;
  });

  // A switch the two hooks above never see: the model picker's shortcut, or set_model from the SDK, an IDE or Remote
  // Control. A 'command' switch is theirs (they know a plugin's own /model); 'auto' and 'resume' are no one's choice.
  on('classic.PostModelSwitch', async ($, e, next) => {
    const result = await next(e);
    if (MANUAL_SWITCH_SOURCES.has(e.source)) await keepChosenModel($, router, MODEL_SELECTED_MANUALLY);
    return result;
  });

  on('command.run', { command: 'router' }, ($, e) => routerCommand($, router, e.args));

  // The words after `/router `, once one character is typed (the token is never empty). A matcher tests the token
  // alone, so the hook reads the text before it. Nothing is read or written but the router's own view.
  on('prompt.autocomplete', async (_$, e, next) => {
    const mine = routerSuggestions(e, {
      describe: (name, value) => (name === 'pin' && router.view ? pinCard(router.config, value) : undefined),
      sources: {
        held: heldRows(
          router.config,
          /** @type {import('../lib/holds.mjs').HoldSet | null | undefined} */ (router.view?.holds),
          Date.now(),
        ).map((row) => row.word),
      },
    });
    if (!mine.length) return next(e);
    return { suggestions: [...(await next(e)).suggestions, ...mine] };
  });

  // Since 2.1.321 a subagent's loop raises turn.start too, with its agentId; the goal and prompt state is the main loop's.
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) await startTurn($, router, e).catch(() => {});
    return next(e);
  });

  on('prompt.submit', (_$, e, next) => submitPrompt(router, e, next));

  // A hook failure spawns the agent as Claude Code would; next(e) replays a spawn already made.
  on('agent.spawn', ($, e, next) => spawnAgent($, router, e, next)).catch((_$, e, next) => next(e));

  // A hook failure before the request goes out sends it as Claude Code built it; once it went out, no step sends twice.
  on('turn.step', async function* ($, e, next) {
    let sent = false;
    const send = async function* (request) {
      sent = true;
      return yield* next(request);
    };
    send.signal = next.signal;
    try {
      return yield* stepMain($, router, e, send);
    } catch (error) {
      if (sent) throw error;
      if (!e.agentId) traceGap(router, router.config.routingEngine);
      return yield* next(e);
    }
  });

  on('turn.complete', async ($, e, next) => {
    // The router's bookkeeping never keeps the turn from completing.
    await completeTurn($, router, e).catch(() => {});
    if (e.agentId === undefined) await completeFailedTurn($, router, e).catch(() => {});
    return next(e);
  });

  // Since 2.1.296 (present at the floor): a turn that ended on an API error. A subagent's holds the model its
  // agent ran, when that request is known. A hook failure leaves the event to the hooks beneath, as without the router.
  on('classic.StopFailure', async ($, e, next) => {
    const failed = failedRequestOf(router, e);
    const result = await next(e);
    if (failed) await holdFailedModel($, router, e, failed);
    return result;
  }).catch((_$, e, next) => next(e));

  on('session.compact', async ($, e, next) => {
    const result = await next(e);
    // Only the main conversation is routed, so an agent compaction changes nothing here.
    if (!result.skip && e.trigger !== 'precompute' && !e.agentId) {
      // biome-ignore lint/suspicious/noUnnecessaryConditions: router.trace is set by helpers that take `router`, which Biome cannot follow
      if (!router.trace) {
        router.traceFreshSession = null;
        router.traceClearSession = null;
      }
      const ref = { ...LOOP, id: 'main' };
      const { value: loop, version } = await $.state.get(ref);
      // A reset that lost to a newer write is not written over it: the next step finds the history shorter
      // (prepareLoop) and resets it then.
      const reset = loop ? resetHistory(loop) : null;
      if (reset && (await $.state.set(ref, reset, { ifVersion: version })).isSet) {
        if (router.config.routingEngine === 'shadow' && router.trace) {
          const event = { type: 'reset', at: Date.now(), cause: 'compact', loop: reset, generation: reset.generation };
          traceReset(router, event);
        }
      }
      clearGoal(router);
      for (const controller of router.controllers) controller.abort();
      if (router.config.routingEngine === 'auto') {
        for (const review of router.reviews.values()) review.controller.abort();
        router.reviews.clear();
        router.decisions.clear();
      }
    }
    return result;
  });

  // The session's own counts go first; Claude Code bounds session.end, and the trace is closed after them.
  on('session.end', async ($, e, next) => {
    await endSession($, router);
    // A completed shadow turn's queued flush writes it even after a switch to another engine.
    await drainTraces(router);
    if (router.config.routingEngine === 'shadow') {
      // The completed turns are flushed by now; any left never completed.
      if (router.trace?.turns.size) router.trace.reasons.add('aborted');
      await flushTrace($, router, null, true);
    }
    // biome-ignore lint/nursery/useAtomicUpdates: the session is over, so whatever trace the final flush held or created is dropped
    router.trace = null;
    router.traceOperations.clear();
    router.traceFreshSession = null;
    router.traceClearSession = e.reason === 'clear' && typeof e.sessionId === 'string' ? e.sessionId : null;
    return next(e);
  });

  // While the classifier runs, the turn's spinner says so; the engine's own word returns once the route is set.
  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    if (e.props.message !== null) return next(e);
    const view = await readView($, router);
    return view.phase === 'choosing' ? next({ ...e, props: { ...e.props, message: 'Choosing model' } }) : next(e);
  });

  // Paused or broken routing stays visible in the prompt footer even when the band is collapsed.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const label = await footerLabel($, router, await readView($, router));
    return label ? next({ ...e, props: { ...e.props, modes: [...e.props.modes, label] } }) : next(e);
  });

  // A route line: drawn from the record the turn's end kept under the row's id. Rows other plugins placed pass.
  on('ui.render', { component: 'Placed' }, async ($, e, next) => {
    if (e.props.plugin !== $.plugin.name) return next(e);
    const { value: line } = await $.state.get({ ...LINES, id: e.props.id });
    if (!line) return next(e);
    return renderRouteLine($.ui.resolve(e), router.config, line, {
      columns: e.viewport?.columns,
      surface: e.surface,
      onFallback: logFallback($, 'route line'),
    });
  });

  on('ui.render', { component: ['AbovePrompt', 'Pane'] }, async ($, e, next) => {
    if (e.component === 'Pane' && e.requestId !== PANE) return next(e);
    const storedView = await readView($, router);
    const view = { ...storedView, mode: await modeOf($, router, storedView.mode) };
    const elements = $.ui.resolve(e);
    const { Box } = elements;
    const usage = await $.session.usage().catch(() => null);
    if (e.component === 'AbovePrompt') {
      if (e.props.hasSurvey) return next(e);
      return Box({
        flexDirection: 'column',
        children: [
          await next(e),
          renderBand(
            elements,
            router.config,
            view,
            usage,
            {
              columns: e.props.bodyColumns,
              surface: e.surface,
              onFallback: logFallback($, 'band'),
              agentId: e.props.view?.agentId,
              agent: router.agents.get(e.props.view?.agentId) ?? null,
              agents: e.props.view?.agentId ? [] : await runningAgents($, router),
              back: true,
              now: Date.now(),
            },
            {
              open: () => openPane($, router),
              viewAgent: (agentId) => showView($, { agentId }),
              back: () => showView($, {}),
              mode: (mode) => changeMode($, router, mode),
              pin: async (tier) => $.ui.toast(await setPin($, router, tier)),
              unpin: () => updateView($, router, { pendingPin: null }),
              // On a graphical surface the band's Set up opens the pane on how to add the credentials.
              key: async (press) => {
                if (!isGraphical(press?.surface ?? e.surface)) return openKeySettings($);
                await openPane($, router);
                await updateView($, router, { keyHelp: keyHelpFor(router, router.config.classifier) });
              },
              toggleDetail: () => toggleBandDetail($, router, view),
            },
          ),
        ],
      });
    }
    view.decisionRows = await paneDecisionRows($, router);
    // A Set up's key help hides by itself once the credentials it asks for are there; an Edit's waits for Done.
    const open = view.keyHelp;
    const keyHelp =
      open?.id && router.config.classifiers[open.id] && (open.edit || missingCredentials(router.config, view, open.id))
        ? open
        : null;
    const settings = await $.settings.read().catch(() => ({}));
    const modelOptions = Object.keys(router.config.models).filter((alias) =>
      isModelAllowed(router.config.models[alias].id, settings.availableModels, view.nativeModel),
    );
    return renderPanel(elements, router.config, { ...view, keyHelp }, usage, paneActions($, router, view), {
      modelOptions,
      columns: e.props.bodyColumns,
      surface: e.surface,
      onFallback: logFallback($, 'pane'),
      now: Date.now(),
      pluginId: pluginIdOf({ name: $.plugin.name, root: $.plugin.root }, settings?.enabledPlugins ?? null),
    });
  });
}
