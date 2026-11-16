// Narrow replay inputs, not transcripts. Host I/O belongs in hooks/native-router.mjs.
import { PHASE_VALUES } from './classifier-contract.mjs';
import { ACTIVITIES, EFFORTS, ROUTING_MODES, TIERS } from './config.mjs';

export const TRACE_PREFIX = 'trace:v1:';
export const TRACE_SESSION_BYTES = 128 * 1024;
export const TRACE_BUDGET_BYTES = 1024 * 1024;
export const TRACE_STORE_BYTES = 3 * 1024 * 1024;
export const TRACE_EXPORT_BYTES = 3 * 1024 * 1024;
export const TRACE_RETAIN_MS = 30 * 86400_000;
export const TRACE_ACTIVE_MS = 60 * 60 * 1000;
const REASONS = [
  'mid-session',
  'resume',
  'reload',
  'lost-write',
  'recorder-error',
  'store-guard',
  'gap',
  'conflict',
  'reset',
  'mode-gap',
  'aborted',
];
const number = (v) => (Number.isFinite(v) ? v : null);
const oneOf = (v, values) => (values.includes(v) ? v : null);
// Validated routing identifiers may contain spaces, Unicode and provider-specific punctuation.
const identifier = (v) => (typeof v === 'string' ? v : null);
const effort = (v) => (Number.isFinite(v) ? v : oneOf(v, EFFORTS));
const signature = (v) => (typeof v === 'string' && /^[a-f0-9]{1,16}$/.test(v) ? v : null);
const numbers = (object, keys) =>
  Object.fromEntries(keys.filter((key) => Number.isFinite(object?.[key])).map((key) => [key, object[key]]));
const strings = (values) => (Array.isArray(values) ? values.map(identifier).filter(Boolean) : []);
const mapOf = (object, project) =>
  Object.fromEntries(Object.entries(object ?? {}).map(([key, value]) => [key, project(value)]));
export const traceBytes = (value) => new TextEncoder().encode(JSON.stringify(value)).length;
const pair = (v) =>
  v && {
    ...(Object.hasOwn(v, 'model') ? { model: identifier(v.model) } : {}),
    ...(Object.hasOwn(v, 'effort') ? { effort: effort(v.effort) } : {}),
  };
const routingMode = (v) =>
  v && { mode: oneOf(v.mode, ROUTING_MODES), source: oneOf(v.source, ['session', 'project', 'profile', 'default']) };
const routeTable = (v) => Object.fromEntries(TIERS.filter((tier) => v?.[tier]).map((tier) => [tier, pair(v[tier])]));
const activities = (v) => Object.fromEntries(ACTIVITIES.filter((a) => v?.[a]).map((a) => [a, routeTable(v[a])]));
const policyKeys = [
  'upgradeVotes',
  'upgradeBase',
  'upgradeSlope',
  'upgradePivotUsd',
  'jumpConfidence',
  'downgradeVotes',
  'downgradeMass',
  'downgradeSlope',
  'downgradePivotUsd',
  'downgradeHorizonTurns',
  'continuationMass',
  'escalationHoldTurns',
  'reviewEveryRequests',
  'minDwellRequests',
  'cashCapUsd',
  'activityMass',
];

function model(v) {
  return {
    id: identifier(v?.id),
    ...numbers(v, ['strength', 'contextWindow', 'input', 'cacheRead', 'output']),
    billing: oneOf(v?.billing, ['plan', 'credits']),
    efforts: (v?.efforts ?? []).map((e) => oneOf(e, EFFORTS)).filter(Boolean),
    capability: Object.fromEntries(
      [...EFFORTS, 'default'].filter((e) => Number.isFinite(v?.capability?.[e])).map((e) => [e, v.capability[e]]),
    ),
    ...(typeof v?.imageInput === 'boolean' ? { imageInput: v.imageInput } : {}),
    ...(v?.longContext ? { longContext: numbers(v.longContext, ['above', 'multiplier']) } : {}),
    ...(v?.offPeak
      ? {
          offPeak: {
            ...numbers(v.offPeak, ['multiplier']),
            peakDays: (v.offPeak.peakDays ?? []).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6),
            peakHoursUtc: (v.offPeak.peakHoursUtc ?? [])
              .filter((p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite))
              .map((p) => [...p]),
          },
        }
      : {}),
  };
}

// Configuration paths, classifier URLs/options/keys and source notes are deliberately not copied.
// Prices are frozen on each model, including configured overrides and time/context-dependent rates.
export function traceConfig(v) {
  return {
    provider: identifier(v?.provider) ?? 'anthropic',
    routingEngine: oneOf(v?.routingEngine, ['table', 'shadow', 'auto']),
    baselineTier: oneOf(v?.baselineTier, TIERS),
    routes: routeTable(v?.routes),
    activities: activities(v?.activities),
    configuredActivities: activities(v?.configuredActivities ?? v?.activities),
    activityRouting: oneOf(v?.activityRouting, ['off', 'on']),
    mode: oneOf(v?.mode, ROUTING_MODES),
    routingMode: routingMode(v?.routingMode),
    modes: Object.fromEntries(
      ROUTING_MODES.filter((m) => v?.modes?.[m]).map((m) => [m, { policy: numbers(v.modes[m].policy, policyKeys) }]),
    ),
    policy: numbers(v?.policy, policyKeys),
    models: mapOf(v?.models, model),
    effortSplitsCache: Boolean(v?.effortSplitsCache),
    cache: {
      mode: oneOf(v?.cache?.mode, ['explicit', 'automatic', 'disabled']),
      effortScope: oneOf(v?.cache?.effortScope, ['auto', 'shared', 'separate', 'unknown']),
      writeMultiplier: numbers(v?.cache?.writeMultiplier, Object.keys(v?.cache?.writeMultiplier ?? {})),
      ttlMs: numbers(v?.cache?.ttlMs, Object.keys(v?.cache?.ttlMs ?? {})),
      ...numbers(v?.cache, ['warmMarginMs']),
    },
    context: numbers(v?.context, ['recentTurns', 'maxTextChars']),
  };
}

const lastRequest = (v) =>
  v && {
    model: identifier(v.model),
    ...numbers(v, ['tokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'at']),
  };
const cache = (v) => mapOf(v, (entry) => numbers(entry, ['lastAt', 'prefixTokens']));
const state = (v) => ({
  ...numbers(v, ['turn', 'holdUntilTurn']),
  votes: (v?.votes ?? []).map((vote) => ({ tier: oneOf(vote.tier, TIERS), turn: number(vote.turn) })),
  escalatedSignature: signature(v?.escalatedSignature),
});

export function traceDecision(v) {
  return (
    v && {
      tier: oneOf(v.tier, TIERS),
      activity: oneOf(v.activity, ACTIVITIES),
      floorActivity: oneOf(v.floorActivity, ACTIVITIES),
      goal: oneOf(v.goal, [...ACTIVITIES, 'uncertain']),
      taskPhase: oneOf(v.taskPhase, PHASE_VALUES),
      model: identifier(v.model),
      effort: effort(v.effort),
      route: pair(v.route),
      pinned: Boolean(v.pinned),
      reason: identifier(v.reason),
    }
  );
}

export function traceLoop(v) {
  return {
    lastRoute: oneOf(v?.lastRoute, TIERS),
    lastActivity: oneOf(v?.lastActivity, ACTIVITIES),
    route: pair(v?.route),
    state: state(v?.state),
    models: cache(v?.models),
    resolutions: mapOf(v?.resolutions, identifier),
    lastRequest: lastRequest(v?.lastRequest),
    historyMeasured: Boolean(v?.historyMeasured),
    ...numbers(v, ['lastMessageCount', 'generation', 'requests', 'reviewedAt', 'observedFrom']),
    switchedAt: v?.switchedAt ? numbers(v.switchedAt, ['requests', 'messageCount']) : null,
    ineligible: strings(v?.ineligible),
    suspended: Boolean(v?.suspended),
    engineModel: identifier(v?.engineModel),
    servedRoute: identifier(v?.servedRoute),
    decision: traceDecision(v?.decision),
  };
}

const vector = (v, labels) =>
  v && {
    choice: oneOf(v.choice, labels),
    probabilities: numbers(v.probabilities, labels),
  };
export const traceAdvice = (v) =>
  v && {
    ...vector(v, [...TIERS, 'uncertain']),
    confidence: number(v.confidence),
    continuation: number(v.continuation),
    activity: vector(v.activity, [...ACTIVITIES, 'uncertain']),
    phase: vector(v.phase, PHASE_VALUES),
  };

export function traceFacts(v) {
  return {
    hasImages: Boolean(v?.hasImages),
    continuation: Boolean(v?.continuation),
    downAllowed: Boolean(v?.downAllowed),
    progress: Boolean(v?.progress),
    midTurn: Boolean(v?.midTurn),
    effort: effort(v?.effort),
    contextTokens: number(v?.contextTokens),
    failure: v?.failure ? { signature: signature(v.failure.signature), index: number(v.failure.index) } : null,
  };
}

const checkpoint = (v) => v && { index: number(v.index), ok: Boolean(v.ok) };
export function traceProgress(v) {
  return (
    v && {
      check: checkpoint(v.check),
      edit: checkpoint(v.edit),
      run: checkpoint(v.run),
      ...numbers(v, ['delegate', 'anyCheck', 'nonDocEdit', 'prompt', 'lastTool']),
      result: v.result ? { index: number(v.result.index), error: Boolean(v.result.error) } : null,
    }
  );
}

// Same priority as routingBucket(observedActivity), evaluated against the caller's own cursor.
export function observedFromTrace(v, from) {
  if (v.nonDocEdit > from) return 'code';
  if (v.edit?.index > from) return 'docs';
  if (v.run?.index > from || v.anyCheck > from) return 'ops';
  return v.lastTool > from ? 'read' : 'talk';
}

export function completedFromTrace(v, from, activity) {
  const since = Math.max(0, from);
  if (v?.check && v.check.index >= since && v.check.ok) return true;
  if (!v || v.delegate >= since || v.anyCheck >= since) return false;
  const edited = v.edit && v.edit.index >= since;
  const ran = v.run && v.run.index >= since;
  if (activity === 'ops') return !edited && Boolean(ran && v.run.ok);
  if (activity === 'docs') return !ran && Boolean(edited && v.edit.ok && v.nonDocEdit < since);
  if (['explore', 'plan', 'review'].includes(activity))
    return !edited && !ran && v.prompt >= from && from >= 0 && !(v.result?.index >= since && v.result.error);
  return false;
}

export function traceOperation(kind, at, input, result) {
  return {
    kind: oneOf(kind, ['choose', 'observed', 'continue']),
    at,
    taskProgress: traceProgress(input.taskProgress),
    facts: input.facts ? traceFacts(input.facts) : null,
    advice: traceAdvice(input.advice),
    pin: oneOf(input.pin, TIERS),
    nativeModel: identifier(input.nativeModel),
    ...(input.availableModels !== undefined
      ? { availableModels: Array.isArray(input.availableModels) ? strings(input.availableModels) : null }
      : {}),
    contextKnown: Boolean(input.contextKnown),
    contextTokens: number(input.contextTokens),
    hasImages: Boolean(input.hasImages),
    ...(Object.hasOwn(input, 'actualHasImages')
      ? { actualHasImages: typeof input.actualHasImages === 'boolean' ? input.actualHasImages : null }
      : {}),
    effort: effort(input.effort),
    observed: oneOf(input.observed, [...ACTIVITIES, 'read', 'talk']),
    expected: traceDecision(result?.decision),
  };
}

export function traceResponse(at, request, response, ttl) {
  return {
    type: 'response',
    at,
    requestedModel: identifier(request.model),
    effort: effort(request.effort),
    servedModel: identifier(response.usage?.model),
    usage: response.usage
      ? numbers(response.usage, [
          'input_tokens',
          'cache_read_input_tokens',
          'cache_creation_input_tokens',
          'output_tokens',
        ])
      : null,
    stopReason:
      response.stopReason === null
        ? null
        : (oneOf(response.stopReason, [
            'end_turn',
            'tool_use',
            'max_tokens',
            'stop_sequence',
            'model_context_window_exceeded',
            'refusal',
            'pause_turn',
          ]) ?? 'other'),
    ttl: oneOf(ttl, ['5m', '1h']),
  };
}

export function traceEvent(v) {
  const common = {
    type: v.type,
    at: number(v.at),
    ...numbers(v, ['seq', 'turn', 'index', 'messageCount', 'generation', 'requestSeq']),
  };
  switch (v.type) {
    case 'initial':
      return {
        ...common,
        configured: traceConfig(v.configured),
        config: traceConfig(v.config),
        loop: traceLoop(v.loop),
      };
    case 'config':
      return { ...common, configured: traceConfig(v.configured), config: traceConfig(v.config) };
    case 'request':
      return {
        ...common,
        model: identifier(v.model),
        effort: effort(v.effort),
        mode: oneOf(v.mode, ['auto', 'manual']),
        engineModel: identifier(v.engineModel),
        engineEffort: effort(v.engineEffort),
        ...numbers(v, ['reviewedAt', 'observedFrom']),
        operations: (v.operations ?? []).map((op) => traceOperation(op.kind, op.at, op, { decision: op.expected })),
      };
    case 'response':
      return {
        ...common,
        ...traceResponse(
          v.at,
          { model: v.requestedModel, effort: v.effort },
          { usage: v.usage && { ...v.usage, model: v.servedModel }, stopReason: v.stopReason },
          v.ttl,
        ),
      };
    case 'reset':
      return {
        ...common,
        cause: oneOf(v.cause, ['clear', 'compact', 'rewind', 'history', 'delete-history']),
        loop: traceLoop(v.loop),
      };
    case 'control':
      return { ...common, mode: routingMode(v.mode), pin: oneOf(v.pin, TIERS), enabled: Boolean(v.enabled) };
    case 'end':
      return common;
    default:
      throw new Error('unknown trace event');
  }
}

export function readTrace(v) {
  if (v?.version !== 1 || !Array.isArray(v.events) || !Number.isFinite(v.startedAt) || !Number.isFinite(v.updatedAt))
    return null;
  try {
    const record = {
      version: 1,
      startedAt: v.startedAt,
      updatedAt: v.updatedAt,
      active: v.active === true,
      incomplete: Array.isArray(v.incomplete) ? v.incomplete.map((r) => oneOf(r, REASONS) ?? 'gap') : ['gap'],
      lostWrites: Number.isSafeInteger(v.lostWrites) && v.lostWrites >= 0 ? v.lostWrites : 1,
      capped: v.capped ? numbers(v.capped, ['at', 'turns', 'events']) : null,
      events: v.events.map(traceEvent),
    };
    const problems = traceProblems(record);
    return { ...record, incomplete: [...new Set([...record.incomplete, ...problems])] };
  } catch {
    return null;
  }
}

export function newTrace(at, snapshot, incomplete = []) {
  return {
    version: 1,
    startedAt: at,
    updatedAt: at,
    active: true,
    incomplete: incomplete.filter((r) => REASONS.includes(r)),
    lostWrites: 0,
    capped: null,
    events: [traceEvent({ type: 'initial', seq: 1, at, ...snapshot })],
  };
}

export function bufferTrace(buffer, event, maxBytes = TRACE_SESSION_BYTES) {
  const held = buffer ?? { events: [], bytes: 2, excludedEvents: 0 };
  if (held.excludedEvents) return { ...held, excludedEvents: held.excludedEvents + 1 };
  const projected = traceEvent(event);
  const bytes = held.bytes + traceBytes(projected) + 1;
  if (bytes > maxBytes) return { events: [], bytes: 2, excludedEvents: held.events.length + 1 };
  return { events: [...held.events, projected], bytes, excludedEvents: 0 };
}

// Append complete turn batches. A cap keeps the prior, usable prefix, never half a turn.
export function appendTrace(
  record,
  events,
  at,
  { lostWrites = 0, reasons = [], maxBytes = TRACE_SESSION_BYTES, excludedEvents = 0 } = {},
) {
  const next = {
    ...record,
    updatedAt: at,
    lostWrites: record.lostWrites + lostWrites,
    incomplete: [
      ...new Set([
        ...record.incomplete,
        ...reasons.filter((r) => REASONS.includes(r)),
        ...(lostWrites ? ['lost-write'] : []),
      ]),
    ],
  };
  const capped = () => ({
    ...next,
    capped: {
      at: next.capped?.at ?? at,
      turns: (next.capped?.turns ?? 0) + 1,
      events: (next.capped?.events ?? 0) + events.length + excludedEvents,
    },
  });
  if (excludedEvents) return capped();
  if (!events.length) return next;
  if (record.capped) return capped();
  const added = events.map((event, i) => ({ ...traceEvent(event), seq: record.events.length + i + 1 }));
  const all = [...record.events];
  for (const event of added) {
    if (event.type === 'response') {
      const request = all.findLast((e) => e.type === 'request' && e.turn === event.turn && e.index === event.index);
      if (request) event.requestSeq = request.seq;
      else next.incomplete = [...new Set([...next.incomplete, 'gap'])];
    }
    all.push(event);
  }
  const appended = { ...next, events: all };
  appended.incomplete = [...new Set([...appended.incomplete, ...traceProblems(appended)])];
  return traceBytes(appended) > maxBytes ? capped() : appended;
}

export function traceProblems(record) {
  if (
    record?.version !== 1 ||
    !Array.isArray(record.events) ||
    record.events[0]?.type !== 'initial' ||
    !record.events[0]?.configured ||
    !record.events[0]?.config ||
    !record.events[0]?.loop ||
    !Number.isFinite(record.events[0]?.loop?.state?.turn) ||
    ![record.events[0]?.configured, record.events[0]?.config].every(
      (config) =>
        config &&
        TIERS.includes(config.baselineTier) &&
        TIERS.every((tier) => config.routes?.[tier]?.model && config.models?.[config.routes[tier].model]?.id),
    )
  )
    return ['mid-session'];
  return [
    ...new Set([
      ...(Array.isArray(record.incomplete) ? record.incomplete : ['gap']),
      ...(record.lostWrites > 0 ? ['lost-write'] : []),
      ...(record.events.every((event, i) => event.seq === i + 1 && Number.isFinite(event.at)) ? [] : ['gap']),
      ...(record.events.every(
        (event) =>
          event.type !== 'request' ||
          record.events.some((response) => response.type === 'response' && response.requestSeq === event.seq),
      )
        ? []
        : ['gap']),
      ...(record.events.every(
        (event) =>
          event.type !== 'response' ||
          record.events.some(
            (request) =>
              request.type === 'request' &&
              request.seq === event.requestSeq &&
              request.seq < event.seq &&
              request.turn === event.turn &&
              request.index === event.index,
          ),
      )
        ? []
        : ['gap']),
    ]),
  ];
}

export const usableTrace = (record) => traceProblems(record).length === 0;

// No record-count limit. Whole inactive records leave by age or oldest first for the byte budget.
// A recent active lease protects writers; stale activity never defeats day retention.
export function traceVictims(entries, at, ownKey, candidate, active = new Set()) {
  const others = entries.filter(([key, v]) => key !== ownKey && v?.version === 1 && Number.isFinite(v.updatedAt));
  const expired = others.filter(([, v]) => at - v.updatedAt > TRACE_RETAIN_MS);
  const victims = new Set(expired.map(([key]) => key));
  let bytes =
    traceBytes(ownKey) +
    traceBytes(candidate) +
    2 +
    entries
      .filter(([key]) => key !== ownKey && !victims.has(key))
      .reduce((sum, [key, v]) => sum + traceBytes(key) + traceBytes(v) + 2, 0);
  for (const [key, v] of others
    .filter(([key, v]) => !victims.has(key) && !(at - v.updatedAt <= TRACE_ACTIVE_MS && (active.has(key) || v.active)))
    .sort((a, b) => a[1].updatedAt - b[1].updatedAt)) {
    if (bytes <= TRACE_BUDGET_BYTES) break;
    victims.add(key);
    bytes -= traceBytes(key) + traceBytes(v) + 2;
  }
  return [...victims];
}

export function traceAdmission(entries, key, candidate) {
  const total = traceBytes(Object.fromEntries(entries));
  const projected = traceBytes({ ...Object.fromEntries(entries), [key]: candidate });
  const traces = entries.filter(([name]) => name.startsWith(TRACE_PREFIX) && name !== key);
  const traceTotal =
    traceBytes(candidate) +
    traceBytes(key) +
    2 +
    traces.reduce((n, [name, value]) => n + traceBytes(name) + traceBytes(value) + 2, 0);
  return total <= TRACE_STORE_BYTES && projected <= TRACE_STORE_BYTES && traceTotal <= TRACE_BUDGET_BYTES;
}

export function mergeTraceExport(previous, entries) {
  if (
    previous !== null &&
    (previous?.version !== 1 || typeof previous.sessions !== 'object' || Array.isArray(previous.sessions))
  )
    throw new Error('invalid trace export');
  const sessions = {};
  for (const [key, value] of [...Object.entries(previous?.sessions ?? {}), ...entries]) {
    if (!key.startsWith(TRACE_PREFIX)) throw new Error('invalid trace key');
    const projected = readTrace(value);
    if (!projected) throw new Error('invalid trace record');
    const old = sessions[key];
    if (!old) {
      sessions[key] = projected;
      continue;
    }
    const selected =
      projected.events.length > old.events.length || projected.updatedAt > old.updatedAt ? projected : old;
    const conflict = old.events
      .slice(0, Math.min(old.events.length, projected.events.length))
      .some((event, index) => JSON.stringify(event) !== JSON.stringify(projected.events[index]));
    const caps = [old.capped, projected.capped].filter(Boolean);
    sessions[key] = {
      ...selected,
      updatedAt: Math.max(old.updatedAt, projected.updatedAt),
      incomplete: [...new Set([...old.incomplete, ...projected.incomplete, ...(conflict ? ['conflict'] : [])])],
      lostWrites: Math.max(old.lostWrites, projected.lostWrites),
      capped: caps.length
        ? {
            at: Math.min(...caps.map((cap) => cap.at)),
            turns: Math.max(...caps.map((cap) => cap.turns)),
            events: Math.max(...caps.map((cap) => cap.events)),
          }
        : null,
    };
  }
  return { version: 1, sessions };
}
