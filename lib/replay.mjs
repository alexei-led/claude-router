// Offline only: all inputs are frozen, text-free recorder projections.
import { assessCandidates, decideMove, initialIncumbentState, proposeAutoRoute, selectTarget } from './auto-engine.mjs';
import {
  autoCatalogKey,
  externalIncumbent,
  keepKeywordRoute,
  keywordPin,
  keywordSent,
  takeAutoAdvice,
  takeObservedActivity,
} from './auto-route.mjs';
import { TIERS } from './config.mjs';
import * as costs from './cost.mjs';
import { heldAsSeen } from './failover.mjs';
import {
  completedFromTrace,
  mergeTraceExport,
  observedFromTrace,
  traceDecision,
  traceProblems,
} from './replay-trace.mjs';
import {
  chooseRoute,
  continueRoute,
  economicConfig,
  HISTORY_SHRINK,
  hasRoutedDecision,
  isNativeFallback,
  isSameModel,
  observedMove,
  observeResponse,
  ownRoute,
  prepareLoop,
  resetHistory,
} from './route.mjs';

const samePair = (a, b) => a?.model === b?.model && (a?.effort ?? null) === (b?.effort ?? null);
const fail = (message) => {
  throw new Error(`Invalid replay input: ${message}`);
};
const countTurns = (events) => new Set(events.filter((e) => e.type === 'request').map((e) => e.turn)).size;

// Validate before projecting: malformed data must not quietly turn into a successful scenario.
export function mergeExports(exports) {
  /** @type {{ version: number, sessions: object } | null} */
  let merged = null;
  for (const value of exports) {
    if (value?.version !== 1 || !value.sessions || Array.isArray(value.sessions) || typeof value.sessions !== 'object')
      fail('expected version 1 sessions object');
    for (const record of Object.values(value.sessions)) {
      if (!Array.isArray(record?.events)) fail('expected events array');
      for (const event of record.events) {
        if (!Number.isFinite(event.at)) fail('event timestamp required');
        if (event.type === 'request') {
          if (
            !Array.isArray(event.operations) ||
            !['auto', 'manual'].includes(event.mode) ||
            typeof event.model !== 'string' ||
            !Number.isSafeInteger(event.messageCount)
          )
            fail('invalid request');
          for (const op of event.operations) {
            if (!Number.isFinite(op.at) || !['choose', 'observed', 'continue'].includes(op.kind))
              fail('operation timestamp/kind required');
          }
        }
        if (
          event.type === 'response' &&
          event.usage &&
          Object.values(event.usage).some((n) => !Number.isFinite(n) || n < 0)
        )
          fail('invalid token counter');
      }
    }
    try {
      merged = mergeTraceExport(merged, Object.entries(value.sessions));
    } catch {
      fail('invalid trace export or record');
    }
  }
  return merged ?? { version: 1, sessions: {} };
}

function factsFor(config, loop, op, turn) {
  const input = op.facts ?? { effort: op.effort, contextTokens: op.contextTokens, hasImages: op.hasImages };
  const since = loop.switchedAt ?? { requests: 0, messageCount: 0 };
  const dwellAllowed = !loop.switchedAt || loop.requests - since.requests >= config.policy.minDwellRequests;
  return {
    ...input,
    turnKey: turn,
    lastRoute: loop.lastRoute,
    models: loop.models,
    lastRequest: loop.lastRequest,
    historyMeasured: loop.historyMeasured,
    ineligible: loop.ineligible,
    dwellAllowed,
    downAllowed:
      !input.progress &&
      loop.requests - since.requests >= config.policy.minDwellRequests &&
      completedFromTrace(
        op.taskProgress,
        since.messageCount,
        config.activityRouting === 'on' ? loop.lastActivity : null,
      ),
  };
}

function resetAt(loop, event, events, index) {
  if (event.cause === 'history' || event.cause === 'rewind') {
    const request = events.slice(index + 1).find((e) => e.type === 'request');
    return request ? prepareLoop(loop, request.messageCount) : resetHistory(loop);
  }
  return resetHistory(loop);
}

const physical = (config, route, effort) =>
  route && {
    model: config.models[route.model]?.id ?? route.model,
    effort:
      typeof route.effort === 'number'
        ? route.effort
        : config.models[route.model]
          ? costs.routeEffort(config, route, effort)
          : (route.effort ?? effort ?? null),
  };
const aliasRoute = (config, pair) => ({
  model: Object.keys(config.models).find((k) => isSameModel(config.models[k].id, pair.model)) ?? pair.model,
  effort: pair.effort ?? null,
});

export function replayTable(record) {
  let config = record.events[0].config;
  let loop = structuredClone(record.events[0].loop);
  loop.turnId = null;
  const requests = new Map();
  const rows = [];
  const mismatches = [];
  const mismatch = (seq, field) => mismatches.push({ seq, field });
  for (const [index, event] of record.events.entries()) {
    if (event.type === 'config') config = event.config;
    if (event.type === 'reset') loop = resetAt(loop, event, record.events, index);
    if (event.type === 'request') {
      loop = prepareLoop(loop, event.messageCount);
      const fallback =
        event.mode !== 'manual' && loop.turnId === event.turn && isNativeFallback(loop, event.engineModel);
      if (event.mode === 'manual' || fallback) {
        if (event.operations.length) mismatch(event.seq, 'unexpected-operations');
      } else {
        for (const op of event.operations) {
          // A trace cannot rebuild holds from the loop: the ids recorded with the operation are the holds in force.
          const input = { ...op, now: op.at, facts: factsFor(config, loop, op, event.turn) };
          if (op.kind === 'choose') {
            const fresh = loop.turnId !== event.turn;
            loop = chooseRoute(config, loop, input);
            if (fresh) loop.engineModel = event.engineModel;
          } else if (op.kind === 'observed') loop = observedMove(config, loop, input);
          else loop = continueRoute(config, loop, input);
          if (JSON.stringify(traceDecision(loop.decision)) !== JSON.stringify(op.expected))
            mismatch(event.seq, op.kind);
        }
      }
      const pair =
        event.mode === 'manual' || fallback ? { model: event.engineModel, effort: event.engineEffort } : loop.decision;
      if (!samePair(pair, event)) mismatch(event.seq, 'request');
      const row = {
        seq: event.seq,
        turn: event.turn,
        generation: loop.generation,
        at: event.at,
        pair: { model: pair?.model, effort: pair?.effort ?? null },
        mode: config.routingMode?.mode ?? config.mode ?? 'balanced',
        manual: event.mode === 'manual',
        fallback,
        pinned: Boolean(loop.decision?.pinned) && event.mode !== 'manual',
        activity: loop.decision?.activity ?? null,
        config,
      };
      rows.push(row);
      requests.set(event.seq, row);
    }
    if (event.type === 'response') {
      const request = requests.get(event.requestSeq);
      if (!request || !samePair({ model: event.requestedModel, effort: event.effort }, request.pair))
        mismatch(event.seq, 'response-request');
      loop = observeResponse(config, loop, {
        usage: event.usage && { ...event.usage, model: event.servedModel },
        requestedModel: event.requestedModel,
        effort: event.effort,
        stopReason: event.stopReason,
        now: event.at,
      });
      if (!request?.manual && !request?.fallback && event.stopReason === null) loop.suspended = true;
      if (request?.manual && !loop.decision) loop.route = ownRoute(config, event.requestedModel);
    }
  }
  return { rows, mismatches };
}

// Cost and cache on a frozen transcript: total prompt and output lengths are observed; hit tokens are NOT copied.
function simulatedReply(config, loop, pair, event) {
  const usage = event.usage;
  const counts = ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'output_tokens'];
  if (!usage || !counts.every((k) => Number.isFinite(usage[k]) && usage[k] >= 0)) return { range: null, usage: null };
  const tokens = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens;
  const route = aliasRoute(config, pair);
  const model = config.models[route.model];
  if (!model || !Number.isFinite(model.input) || !Number.isFinite(model.cacheRead) || !Number.isFinite(model.output))
    return { range: null, usage: null };
  // A shortened transcript invalidates the replay's own warmth, independently of the table cache.
  const models = loop.lastRequest && tokens < loop.lastRequest.tokens * HISTORY_SHRINK ? {} : loop.models;
  const pricedRoute = typeof route.effort === 'number' ? { ...route, effort: null } : route;
  const bounds = costs.inputBounds(config, pricedRoute, tokens, { models, effort: pair.effort }, event.at);
  const rates = costs.ratesAt(model, tokens, event.at);
  if (rates.output === undefined) return { range: null, usage: null };
  const output = (usage.output_tokens * rates.output) / 1e6;
  const key = costs.cacheKey(config, pair.model, pair.effort);
  const prefix =
    config.cache.mode === 'explicit' && costs.isWarm(models[key], event.at, config.cache)
      ? Math.min(models[key].prefixTokens, tokens)
      : 0;
  // Explicit caches build a full-prefix scenario; automatic caches retain uncertainty in pricing.
  return {
    range: { minUsd: bounds.min + output, maxUsd: bounds.max + output },
    usage: {
      model: pair.model,
      input_tokens: config.cache.mode === 'disabled' ? tokens : 0,
      cache_read_input_tokens: prefix,
      cache_creation_input_tokens: config.cache.mode === 'disabled' ? 0 : tokens - prefix,
      output_tokens: usage.output_tokens,
    },
  };
}

function acceptAutoAdvice(replay, event, op) {
  const { config } = replay;
  replay.advice = op.advice;
  takeAutoAdvice(config, replay, op.advice);
  replay.observedFrom = op.facts?.midTurn
    ? Math.max(op.taskProgress?.prompt ?? 0, (event.observedFrom ?? 0) - 1)
    : (op.taskProgress?.prompt ?? event.messageCount - 1);
}

// A turn's first step: a pin or a keyword runs as a temporary pin, as live Auto runs it (autoRoute); any other turn moves
// the incumbent and the demand state.
function autoChoose(replay, op, input) {
  const { loop } = replay;
  // A keyword turn runs as live Auto runs it (autoRoute): a pin to the keyword's tier that keeps the mode.
  const keyed =
    !op.pin && op.keyword
      ? keywordPin(input.config, replay.state, {
          keyword: op.keyword,
          advice: op.advice,
          facts: input.facts,
          boundedExecute: replay.boundedExecute,
        })
      : null;
  const pin = op.pin ?? keyed?.pin ?? null;
  const proposal = proposeAutoRoute({
    ...input,
    startup: !hasRoutedDecision(loop),
    advice: op.advice,
    pin,
    ...(keyed ? { keyword: op.keyword, pinDiscount: keyed.pinDiscount } : {}),
    boundedExecute: replay.boundedExecute,
  });
  const route = proposal.move.route;
  replay.reason = keyed && route ? op.keyword : proposal.move.reason;
  const sent = keyed && route ? keywordSent(input.config, op.keyword, route, proposal.candidates) : route;
  if (pin) {
    replay.savedPin ??= {
      incumbent: replay.incumbent,
      pin,
      ...(keyed ? { keyword: op.keyword, discount: keyed.pinDiscount, route } : {}),
      switchedAt: replay.loop.switchedAt,
      servedRoute: replay.loop.servedRoute,
    };
  } else {
    replay.demandResult = proposal.demand;
    replay.state = proposal.state;
    if (['reentry', 'same-route'].includes(proposal.move.reason) && input.incumbentOrigin)
      replay.incumbentOrigin = null;
    replay.incumbent = route ?? replay.incumbent;
  }
  return sent;
}

// A continuation of a pinned or keyword turn: the pin again, from the route the turn selected.
function autoPinnedStep(replay, input) {
  const { config, loop } = replay;
  const { keyword, discount = 0 } = replay.savedPin;
  const selected = keyword ? replay.savedPin.route : null;
  const proposal = proposeAutoRoute({
    ...input,
    incumbent: selected ?? aliasRoute(config, loop.decision),
    pin: replay.savedPin.pin,
    ...(keyword ? { keyword, pinDiscount: discount } : {}),
  });
  if (keyword) keepKeywordRoute(proposal, selected);
  const route = proposal.move.route;
  if (keyword) replay.savedPin.route = route;
  replay.reason = keyword && route ? keyword : proposal.move.reason;
  return keyword && route ? keywordSent(config, keyword, route, proposal.candidates) : route;
}

function autoOperation(replay, event, op, mode) {
  const { config, loop } = replay;
  if (op.kind === 'observed') return null;
  if (op.kind === 'continue' && !replay.savedPin)
    takeObservedActivity(replay, observedFromTrace(op.taskProgress, replay.observedFrom));
  // Live facts read the prior turn's accepted activity; the new advice's activity only chooses this decision's column.
  const lastActivity = replay.activity;
  if (op.kind === 'choose' && !op.pin) acceptAutoAdvice(replay, event, op);
  const facts = factsFor(config, { ...loop, lastActivity }, op, event.turn);
  if (op.kind !== 'choose') facts.midTurn = true;
  if (op.kind === 'continue') facts.hasImages = op.actualHasImages;
  const projected = economicConfig(config, loop);
  if (!replay.state) replay.activeMode = mode;
  replay.state ??= initialIncumbentState({
    config: projected,
    incumbent: replay.incumbent,
    facts,
    activity: replay.activity,
  });
  const catalog = autoCatalogKey(config, {
    models: projected.models,
    availableModels: op.availableModels,
    nativeModel: op.nativeModel,
  });
  const changeCause =
    mode !== replay.activeMode ? 'mode' : replay.catalog !== undefined && replay.catalog !== catalog ? 'catalog' : null;
  const input = {
    config: projected,
    state: replay.state,
    incumbent: replay.incumbent,
    advice: replay.advice,
    facts: {
      ...facts,
      ...(replay.incumbentOrigin === 'external-fallback' && replay.incumbent.effort === null ? { effort: null } : {}),
    },
    now: op.at,
    mode,
    contextKnown: op.contextKnown,
    availableModels: op.availableModels,
    nativeModel: op.nativeModel,
    // The held ids the live proposal saw, as the trace recorded them, named the way replay prices candidates.
    held: heldAsSeen(op.held ?? [], replay.loop.resolutions),
    activity: replay.activity ?? null,
    changeCause,
    incumbentOrigin: op.kind === 'choose' && !op.facts?.midTurn ? replay.incumbentOrigin : null,
  };
  let route;
  if (op.kind === 'choose') route = autoChoose(replay, op, input);
  else if (replay.savedPin) route = autoPinnedStep(replay, input);
  else {
    const level = Math.max(
      0,
      replay.state.demand -
        (replay.boundedExecute && !replay.state.headroom && replay.state.turn > replay.state.holdUntilTurn ? 0.5 : 0),
    );
    const demand = {
      ...replay.demandResult,
      level,
      state: replay.state,
      escalated: false,
      headroom: replay.state.headroom,
    };
    const candidates = assessCandidates(input);
    const target = selectTarget({ candidates, demand: level, mode, headroom: replay.state.headroom });
    const state = replay.state.headroom ? { ...replay.state, headroom: target.headroom } : replay.state;
    const move = decideMove({ ...input, state, demandResult: demand, candidates, target });
    replay.state = move.state;
    replay.incumbent = move.route ?? replay.incumbent;
    replay.reason = move.reason;
    replay.demandResult = demand;
    route = move.route;
  }
  if (!replay.savedPin) {
    replay.catalog = catalog;
    replay.activeMode = mode;
  }
  if (!route) {
    replay.reason = 'no-route-native';
    return { model: event.engineModel, effort: event.engineEffort ?? null };
  }
  return physical(config, route, facts.effort);
}

function autoRequest(replay, event, table) {
  const generation = replay.loop.generation;
  replay.loop = prepareLoop(replay.loop, event.messageCount);
  if (replay.loop.generation !== generation) {
    replay.state = null;
    replay.demandResult = null;
  }
  replay.incumbent ??=
    replay.loop.route ?? aliasRoute(replay.config, { model: event.engineModel, effort: event.engineEffort });
  if (event.turn !== replay.lastTurn && replay.savedPin) {
    replay.incumbent = replay.savedPin.incumbent;
    if (!replay.pendingFallback) {
      replay.loop.switchedAt = replay.savedPin.switchedAt;
      replay.loop.servedRoute = replay.savedPin.servedRoute;
    }
    replay.savedPin = null;
  }
  const continuedFallback = event.turn === replay.lastTurn && replay.loop.suspended;
  if (event.turn !== replay.lastTurn) replay.loop.suspended = false;
  if (!replay.savedPin && replay.pendingFallback) {
    Object.assign(replay, replay.pendingFallback);
    replay.pendingFallback = null;
  }
  replay.lastTurn = event.turn;
  let pair;
  if (table.manual || table.fallback || continuedFallback) {
    pair = { model: event.engineModel, effort: event.engineEffort };
    replay.reason = table.manual ? 'manual' : 'native-fallback';
    if (table.manual) replay.incumbent = aliasRoute(replay.config, pair);
  } else {
    for (const op of event.operations) {
      pair = autoOperation(replay, event, op, table.mode) ?? pair;
      if (op.kind !== 'observed') replay.loop.hasRoutedDecision = true;
    }
    pair ??= replay.savedPin ? replay.loop.decision : physical(replay.config, replay.incumbent, event.engineEffort);
  }
  replay.loop.decision = { model: pair.model, effort: pair.effort, pinned: Boolean(replay.savedPin) };
  replay.loop.lastActivity = replay.activity;
  return {
    ...table,
    pair,
    fallback: table.fallback || continuedFallback,
    pinned: Boolean(replay.savedPin) && !table.manual,
    activity: replay.activity,
    demand: replay.savedPin
      ? TIERS.indexOf(replay.savedPin.pin)
      : (replay.demandResult?.level ?? replay.state?.demand ?? TIERS.indexOf(replay.config.baselineTier)),
    reason: replay.reason,
    generation: replay.loop.generation,
    config: replay.config,
  };
}

export function replayAuto(record, tableRows) {
  const header = record.events[0];
  const replay = {
    config: header.configured,
    activeMode: header.config.routingMode?.mode ?? header.config.mode,
    loop: { ...structuredClone(header.loop), turnId: null },
    state: null,
    incumbent: null,
    savedPin: null,
    demandResult: null,
    advice: null,
    boundedExecute: false,
    activity: header.loop.lastActivity,
    lastTurn: null,
    reason: null,
    observedFrom: 0,
  };
  const rows = [];
  const requests = new Map();
  const tables = new Map(tableRows.map((row) => [row.seq, row]));
  for (const [index, event] of record.events.entries()) {
    // Evidence comes from the last unpinned accepted mode/catalog, not table-only pin snapshots.
    if (event.type === 'config') replay.config = event.configured;
    if (event.type === 'control' && !event.enabled) {
      replay.state = null;
      replay.demandResult = null;
      replay.savedPin = null;
    }
    if (event.type === 'reset') {
      replay.loop = resetAt(replay.loop, event, record.events, index);
      replay.state = null;
      replay.demandResult = null;
      replay.boundedExecute = false;
      replay.advice = null;
      replay.observedFrom = Math.min(replay.observedFrom, replay.loop.lastMessageCount ?? 0);
    }
    if (event.type === 'request') {
      const row = autoRequest(replay, event, tables.get(event.seq));
      rows.push(row);
      requests.set(event.seq, row);
    }
    if (event.type === 'response') {
      const row = requests.get(event.requestSeq);
      const substituted = event.servedModel && !isSameModel(event.requestedModel, event.servedModel);
      const simulated = simulatedReply(replay.config, replay.loop, row.pair, event);
      row.external = substituted || event.stopReason === null || row.reason === 'no-route-native' || row.fallback;
      row.cost = substituted ? null : simulated.range;
      if (!row.manual && (substituted || row.reason === 'no-route-native' || row.fallback)) {
        const external = externalIncumbent(replay.config, {
          requestedModel: row.pair.model,
          effort: row.pair.effort,
          usage: substituted ? { model: event.servedModel } : simulated.usage,
        });
        // biome-ignore lint/suspicious/noUnnecessaryConditions: savedPin is set in another function through `replay`, which Biome cannot follow
        if (replay.savedPin) replay.pendingFallback = external;
        else Object.assign(replay, external);
      }
      replay.loop = observeResponse(replay.config, replay.loop, {
        requestedModel: row.pair.model,
        effort: row.pair.effort,
        usage: substituted ? null : simulated.usage,
        stopReason: event.stopReason,
        now: event.at,
      });
      if (
        substituted ||
        row.reason === 'no-route-native' ||
        (event.stopReason === null && !row.manual && !row.fallback)
      )
        replay.loop.suspended = true;
    }
  }
  return rows;
}

function markSwitches(rows, window) {
  /** @type {{ from: object, to: object, turn: number, paired: boolean } | null} */
  let prior = null;
  /** @type {{ generation: number, pair: object } | null} */
  let previous = null;
  for (const row of rows) {
    if (row.manual || row.fallback || row.external) {
      previous = null;
      prior = null;
      continue;
    }
    if (previous && row.generation !== previous.generation) {
      previous = null;
      prior = null;
    }
    if (row.pinned) continue;
    if (previous && !samePair(previous.pair, row.pair)) {
      const move = { from: previous.pair, to: row.pair, turn: row.turn, reversal: false, paired: false };
      if (prior && samePair(prior.from, move.to) && samePair(prior.to, move.from) && move.turn - prior.turn <= window) {
        move.reversal = true;
        move.paired = true;
        prior.paired = true;
      }
      row.switchEvent = move;
      prior = move;
    }
    previous = row;
  }
}

function summary(rows) {
  const priced = rows.filter((row) => row.cost);
  const knownRange = {
    minUsd: priced.reduce((n, r) => n + r.cost.minUsd, 0),
    maxUsd: priced.reduce((n, r) => n + r.cost.maxUsd, 0),
  };
  const moves = rows.map((row) => row.switchEvent).filter(Boolean);
  const turns = new Set(rows.map((row) => row.turn)).size;
  const reversals = moves.filter((move) => move.reversal).length;
  return {
    requests: rows.length,
    externalRequests: rows.filter((row) => row.external || row.fallback).length,
    turns,
    conditionalCost: {
      minUsd: priced.length === rows.length ? knownRange.minUsd : null,
      maxUsd: priced.length === rows.length ? knownRange.maxUsd : null,
      knownPricedRange: knownRange,
      pricedRequests: priced.length,
      unpricedRequests: rows.length - priced.length,
    },
    switches: {
      moves: moves.length,
      reversals,
      reversalMoves: moves.filter((m) => m.paired).length,
      oneWay: moves.filter((m) => !m.paired).length,
      per100Turns: turns ? (reversals * 100) / turns : 0,
    },
    effortMix: Object.fromEntries(
      [...new Set(rows.map((r) => String(r.pair.effort ?? 'session')))].map((e) => [
        e,
        rows.filter((r) => String(r.pair.effort ?? 'session') === e).length,
      ]),
    ),
  };
}

function priceTable(record, rows) {
  let loop = structuredClone(record.events[0].loop);
  let config = record.events[0].config;
  const bySeq = new Map(rows.map((row) => [row.seq, row]));
  for (const [index, event] of record.events.entries()) {
    if (event.type === 'config') config = event.config;
    if (event.type === 'reset') loop = resetAt(loop, event, record.events, index);
    if (event.type === 'response') {
      const row = bySeq.get(event.requestSeq);
      const substituted = event.servedModel && !isSameModel(event.requestedModel, event.servedModel);
      row.external = substituted || event.stopReason === null;
      row.cost = substituted ? null : simulatedReply(config, loop, row.pair, event).range;
      loop = observeResponse(config, loop, {
        requestedModel: row.pair.model,
        effort: row.pair.effort,
        usage: event.usage && { ...event.usage, model: event.servedModel },
        now: event.at,
        stopReason: event.stopReason,
      });
    }
  }
}

function sessionReport(item, window) {
  const auto = replayAuto(item.record, item.table);
  priceTable(item.record, item.table);
  markSwitches(item.table, window);
  markSwitches(auto, window);
  const perMode = {};
  const tableRows = new Map(item.table.map((row) => [row.seq, row]));
  for (const mode of ['cost', 'balanced', 'quality']) {
    const table = item.table.filter((row) => row.mode === mode);
    const alternative = auto.filter((row) => row.mode === mode);
    if (!table.length) continue;
    const disagreements = {};
    for (const row of alternative) {
      const original = tableRows.get(row.seq);
      const key = `${row.demand}/${row.activity ?? 'none'}`;
      const bucket = disagreements[key] ?? { requests: 0, different: 0 };
      bucket.requests++;
      if (!samePair(row.pair, original.pair)) bucket.different++;
      disagreements[key] = bucket;
    }
    perMode[mode] = { table: summary(table), auto: summary(alternative), disagreementByDemandActivity: disagreements };
  }
  return {
    cohort: item.cohort,
    modes: perMode,
    unknownCapabilities: Object.values(item.record.events[0].configured.models).filter(
      (model) => !Object.keys(model.capability).length,
    ).length,
  };
}

function missingEvidence(op) {
  const progress = op.taskProgress;
  const index = (value) => Number.isInteger(value) && value >= -1;
  if (!progress || !['delegate', 'anyCheck', 'nonDocEdit', 'prompt', 'lastTool'].every((key) => index(progress[key])))
    return true;
  for (const key of ['check', 'edit', 'run'])
    if (progress[key] !== null && (!index(progress[key]?.index) || typeof progress[key]?.ok !== 'boolean')) return true;
  if (progress.result !== null && (!index(progress.result?.index) || typeof progress.result?.error !== 'boolean'))
    return true;
  if (typeof op.contextKnown !== 'boolean') return true;
  if (op.kind === 'continue') return typeof op.actualHasImages !== 'boolean' || typeof op.hasImages !== 'boolean';
  return (
    !op.facts ||
    !['hasImages', 'continuation', 'progress', 'midTurn'].every((key) => typeof op.facts[key] === 'boolean')
  );
}

function evidenceProblems(exports) {
  const problems = new Map();
  for (const value of exports)
    for (const [key, record] of Object.entries(value.sessions))
      for (const event of record.events)
        for (const op of event.operations ?? [])
          if (missingEvidence(op)) {
            const seqs = problems.get(key) ?? new Set();
            seqs.add(event.seq);
            problems.set(key, seqs);
          }
  return problems;
}

export function evaluateReplay(exports, { reversalWindow = 3 } = {}) {
  if (!Number.isSafeInteger(reversalWindow) || reversalWindow < 1) fail('reversal window must be a positive integer');
  const merged = mergeExports(exports);
  const records = Object.entries(merged.sessions);
  const usable = [];
  const explained = {};
  const mismatches = [];
  let capturedTurns = 0;
  let cappedTurns = 0;
  let cappedEvents = 0;
  for (const [index, [key, record]] of records.entries()) {
    capturedTurns += countTurns(record.events);
    cappedTurns += record.capped?.turns ?? 0;
    cappedEvents += record.capped?.events ?? 0;
    const problems = traceProblems(record);
    if (problems.length) {
      for (const reason of problems) explained[reason] = (explained[reason] ?? 0) + 1;
      continue;
    }
    const table = replayTable(record);
    mismatches.push(...table.mismatches.map((m) => ({ cohort: index + 1, ...m })));
    usable.push({ key, record, table: table.rows, cohort: index + 1 });
  }
  const usableTurns = usable.reduce((n, item) => n + countTurns(item.record.events), 0);
  const coverage = {
    exportCohort: {
      sessions: records.length,
      usableSessions: usable.length,
      capturedTurns,
      usableTurns,
      usableSessionRatio: records.length ? usable.length / records.length : null,
      usableTurnRatio: capturedTurns ? usableTurns / capturedTurns : null,
    },
    allSessions: {
      sessions: null,
      turns: null,
      usableSessionRatio: null,
      gate80Percent: 'unavailable',
      reason: 'Exports omit untraced and evicted sessions; captured/export cohort is a lower bound.',
    },
    capped: { turns: cappedTurns, events: cappedEvents },
    explainedExclusions: explained,
  };
  const fidelity = { checkedSessions: usable.length, mismatches, passed: mismatches.length === 0 };
  if (mismatches.length) return { status: 'blocked', fidelity, coverage };
  const problems = evidenceProblems(exports);
  const autoInputIncomplete = usable.flatMap((item) =>
    [...(problems.get(item.key) ?? [])].map((seq) => ({ cohort: item.cohort, seq, reason: 'auto-input-incomplete' })),
  );
  if (autoInputIncomplete.length) return { status: 'blocked', fidelity, coverage, autoInputIncomplete };
  const sessions = usable.map((item) => sessionReport(item, reversalWindow));
  const modes = {};
  for (const item of usable) {
    for (const mode of ['cost', 'balanced', 'quality']) {
      const turns = new Set(
        item.record.events
          .filter(
            (event) =>
              event.type === 'request' &&
              item.table.find((row) => row.seq === event.seq)?.mode === mode &&
              event.operations.some((op) => op.kind === 'choose' && !op.pin),
          )
          .map((event) => event.turn),
      ).size;
      if (!turns) continue;
      const exposure = modes[mode] ?? { sessions: 0, turns: 0 };
      exposure.sessions++;
      exposure.turns += turns;
      modes[mode] = exposure;
    }
  }
  return {
    status: 'ok',
    fidelity,
    coverage,
    reversalWindow,
    semantics:
      'Recorded mode history; independent stateful auto; frozen transcript conditional estimates, no savings or quality result.',
    exposureDiagnostic: {
      completeSessions: usable.filter(
        (item) =>
          !item.record.capped &&
          item.record.events.some(
            (event) => event.type === 'request' && event.operations.some((op) => op.kind === 'choose' && !op.pin),
          ),
      ).length,
      usablePrefixSessions: usable.length,
      capturedMainTurns: usableTurns,
      eligibleRoutedTurns: Object.values(modes).reduce((n, mode) => n + mode.turns, 0),
      modes,
      thresholds: { sessions: 30, turns: 1000, turnsPerMode: 200 },
      freshness: 'unverified',
      gate: 'not-established',
    },
    sessions,
  };
}
