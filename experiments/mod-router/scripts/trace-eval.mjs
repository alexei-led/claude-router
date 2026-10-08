// Sanitized shadow evaluation of the native cache-cost policy on the Team slice of decisions.jsonl.
// Aggregate output only: no prompts, session IDs, agent names, error text, headers, keys or paths are read into it.
// Everything here is a shadow estimate at list prices. It is never a measured saving or a counterfactual bill.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfig, rank, TIERS } from '../../../lib/config.mjs';
import * as nativeCosts from '../../../lib/cost.mjs';
import { decide, fitTier, initialState } from '../../../lib/policy.mjs';
import * as legacyCosts from '../lib/legacy-cost.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
const CLASSES = ['main', 'subagent', 'workflow', 'auxiliary', 'compaction'];
const SIDE_CLASSES = new Set(['auxiliary', 'compaction']);
// Reasons that reuse the route of the turn: no policy call, no state change.
const REUSED_ROUTE = new Set(['tool-continuation', 'retry']);
// Reasons whose cause is not in the trace (failure signature, pin, forced tier) or that rewrite the policy reason.
const UNREPLAYABLE = new Set(['escalation', 'pinned', 'forced', 'context-fit']);
const COMPACTION_SHRINK = 0.8;
const ROUND = 1e6;

export function teamSessionIds(names) {
  return new Set(names.map((name) => UUID.exec(name)?.[0]).filter(Boolean));
}

export function parseRows(text) {
  const rows = [];
  let malformed = 0;
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const row = JSON.parse(line);
      if (row && typeof row === 'object' && typeof row.session === 'string') rows.push(row);
      else malformed += 1;
    } catch {
      malformed += 1;
    }
  }
  return { rows, malformed };
}

export function kindOf(row) {
  if (row.observed) return 'observation';
  if (row.historyBreak) return 'historyBreak';
  if (row.cacheReset) return 'cacheReset';
  if (row.failed) return 'failed';
  if (typeof row.reason === 'string') return 'decision';
  return 'other';
}

export function classOf(row) {
  if (row.requestClass == null) return 'unclassified';
  return CLASSES.includes(row.requestClass) ? row.requestClass : 'other';
}

// Reasons are a closed vocabulary of the policy; anything else is bucketed so free text can never reach the output.
const safeReason = (reason) => (/^[a-z-]{1,24}$/.test(reason) ? reason : 'other');

const bump = (map, key, by = 1) => {
  map[key] = (map[key] ?? 0) + by;
};

const round = (value) => Math.round(value * ROUND) / ROUND;
const fraction = (num, den) => ({ num, den, ratio: den === 0 ? null : round(num / den) });

export function groupBySession(rows, teamIds) {
  const sessions = new Map();
  for (const row of rows) {
    if (!teamIds.has(row.session)) continue;
    if (!sessions.has(row.session)) sessions.set(row.session, []);
    sessions.get(row.session).push(row);
  }
  return sessions;
}

export function countRows(rows, teamIds) {
  const team = rows.filter((row) => teamIds.has(row.session));
  const kinds = {};
  const decisionsByClass = {};
  const advisedByClass = {};
  for (const row of team) {
    const kind = kindOf(row);
    bump(kinds, kind);
    if (kind !== 'decision') continue;
    const cls = classOf(row);
    bump(decisionsByClass, cls);
    if (row.advice) bump(advisedByClass, cls);
  }
  const sessionsSeen = new Set(team.map((row) => row.session));
  return {
    allRows: rows.length,
    teamRows: team.length,
    nonTeamRowsExcluded: rows.length - team.length,
    teamSessionsWithRows: sessionsSeen.size,
    teamRowKinds: kinds,
    observations: kinds.observation ?? 0,
    teamDecisionsByClass: decisionsByClass,
    teamDecisionsWithAdviceByClass: advisedByClass,
    mainDecisions: decisionsByClass.main ?? 0,
    mainDecisionsWithAdvice: advisedByClass.main ?? 0,
    subagentRowsExcluded: decisionsByClass.subagent ?? 0,
    subagentRowsWithAdviceExcluded: advisedByClass.subagent ?? 0,
  };
}

export function reasonHistogram(rows, teamIds) {
  const byClass = {};
  const mainAdvised = {};
  for (const row of rows) {
    if (!teamIds.has(row.session) || kindOf(row) !== 'decision') continue;
    const cls = classOf(row);
    byClass[cls] ??= {};
    bump(byClass[cls], safeReason(row.reason));
    if (cls === 'main' && row.advice) bump(mainAdvised, safeReason(row.reason));
  }
  return { byRequestClass: byClass, mainDecisionsWithAdvice: mainAdvised };
}

const direction = (from, to) => (rank(to) > rank(from) ? 'up' : rank(to) < rank(from) ? 'down' : 'stay');

// Observed route transitions between consecutive main-conversation rows of a session. `turnDecisions` leaves out
// tool continuations and retries, which reuse the route by construction.
export function routeTransitions(rows, teamIds) {
  const out = {
    allMainRows: { up: 0, down: 0, stay: 0, firstRowOfSession: 0 },
    turnDecisions: { up: 0, down: 0, stay: 0, firstRowOfSession: 0, byTierPair: {}, perDay: {} },
  };
  for (const sessionRows of groupBySession(rows, teamIds).values()) {
    let previous = null;
    for (const row of sessionRows) {
      if (kindOf(row) !== 'decision' || classOf(row) !== 'main' || !TIERS.includes(row.tier)) continue;
      const turn = !REUSED_ROUTE.has(row.reason);
      if (previous === null) {
        out.allMainRows.firstRowOfSession += 1;
        if (turn) out.turnDecisions.firstRowOfSession += 1;
      } else {
        const dir = direction(previous, row.tier);
        out.allMainRows[dir] += 1;
        if (turn) {
          out.turnDecisions[dir] += 1;
          bump(out.turnDecisions.byTierPair, `${previous}->${row.tier}`);
          const day = typeof row.at === 'string' ? row.at.slice(0, 10) : 'unknown';
          out.turnDecisions.perDay[day] ??= { up: 0, down: 0, stay: 0 };
          out.turnDecisions.perDay[day][dir] += 1;
        }
      }
      previous = row.tier;
    }
  }
  return out;
}

export function observationCoverage(rows, teamIds) {
  const observations = rows.filter((row) => teamIds.has(row.session) && row.observed).map((row) => row.observed);
  const total = observations.length;
  const count = (predicate) => observations.filter(predicate).length;
  const finite = (value) => Number.isFinite(value);
  return {
    observations: total,
    // The logger stored `tokens` (input + cache read + cache creation) and `cacheReadTokens` only.
    uncachedInputTokens: { status: 'unavailable', rowsLacking: total },
    cacheCreationTokens: { status: 'unavailable', rowsLacking: total },
    exactCachePrefix: { status: 'unavailable', rowsLacking: total },
    cacheReadTokens: { rowsLacking: total - count((o) => finite(o.cacheReadTokens)) },
    outputTokens: { rowsLacking: total - count((o) => finite(o.outputTokens)) },
    effort: { rowsLacking: count((o) => o.effort == null) },
    // The logger wrote '1h' only when 1h creation tokens were seen and '5m' otherwise, even with nothing created.
    ttl: {
      status: 'partial',
      evidence1h: count((o) => o.ttl === '1h'),
      default5mNotEvidence: count((o) => o.ttl === '5m'),
      rowsLacking: count((o) => o.ttl !== '1h' && o.ttl !== '5m'),
    },
  };
}

function freshSim(baseConfig) {
  return {
    state: initialState(),
    lastRoute: null,
    lastRequest: null,
    legacyModels: {},
    nativeModels: {},
    ids: {},
    userEffort: null,
    baseConfig,
  };
}

const aliasOf = (config, tier) => config.routes[tier].model;

function noteRoute(sim, tier, model, effort) {
  if (!TIERS.includes(tier)) return;
  if (typeof model === 'string') sim.ids[aliasOf(sim.baseConfig, tier)] = model;
  // The effort Claude Code sent survives only on routes without their own effort.
  const route = sim.baseConfig.routes[tier];
  if (!route.effort && sim.baseConfig.models[route.model].efforts.length > 0 && effort != null) sim.userEffort = effort;
}

function observe(sim, row) {
  const obs = row.observed;
  const at = Date.parse(row.at);
  if (![obs.tokens, obs.outputTokens, at].every(Number.isFinite) || obs.tokens === 0) return;
  if (sim.lastRequest && obs.tokens < sim.lastRequest.tokens * COMPACTION_SHRINK) {
    sim.legacyModels = {};
    sim.nativeModels = {};
  }
  const key = legacyCosts.cacheKey(obs.model, obs.effort ?? null);
  sim.lastRequest = { tokens: obs.tokens, outputTokens: obs.outputTokens, ttl: obs.ttl === '1h' ? '1h' : '5m' };
  // The legacy gateway stored the whole request plus its output as the cached prefix; the native controller stores
  // cache read + creation. Only cache read survives in the trace, so native prefixes are bounded, never replayed.
  sim.legacyModels[key] = { lastAt: at, prefixTokens: obs.tokens + obs.outputTokens, ttl: sim.lastRequest.ttl };
  sim.nativeModels[key] = {
    lastAt: at,
    low: Number.isFinite(obs.cacheReadTokens) ? obs.cacheReadTokens : 0,
    high: obs.tokens,
  };
  noteRoute(sim, obs.tier, obs.model, obs.effort);
}

function configFor(sim) {
  const base = sim.baseConfig;
  const models = Object.fromEntries(
    Object.entries(base.models).map(([alias, model]) => [
      alias,
      sim.ids[alias] ? { ...model, id: sim.ids[alias] } : model,
    ]),
  );
  return { ...base, models };
}

function nativeFactsAt(sim, bound) {
  const models = Object.fromEntries(
    Object.entries(sim.nativeModels).map(([key, entry]) => [key, { lastAt: entry.lastAt, prefixTokens: entry[bound] }]),
  );
  return { ...baseFacts(sim), models };
}

function baseFacts(sim) {
  return {
    lastRoute: sim.lastRoute,
    lastRequest: sim.lastRequest,
    models: sim.legacyModels,
    effort: sim.userEffort,
    failure: null,
  };
}

function run(config, facts, advice, state, now, costs) {
  const result = decide({ config, facts, advice, state, baseline: config.baselineTier, now, costs });
  const tier = fitTier(config, result.tier, nativeCosts.nextContextTokens(facts));
  return {
    tier,
    reason: tier === result.tier ? result.reason : 'context-fit',
    state: result.state,
    estimate: result.estimate,
  };
}

function candidateCost(config, facts, candidate, incumbent, now, outputTokens) {
  const tokens = nativeCosts.nextContextTokens(facts);
  const proposed = nativeCosts.inputBounds(config, candidate, tokens, facts, now);
  const current = nativeCosts.inputBounds(config, incumbent, tokens, facts, now);
  const output =
    ((config.models[aliasOf(config, candidate)].output - config.models[aliasOf(config, incumbent)].output) *
      outputTokens) /
    1e6;
  return { minUsd: proposed.min - current.max + output, maxUsd: proposed.max - current.min + output };
}

const sameOutcome = (a, b) => a.tier === b.tier && a.reason === b.reason;

// Replays every main-conversation policy decision of one session in order. The state chain follows the legacy
// policy on the trace's own inputs; each advised main decision is then decided twice from the same state and facts,
// once with legacy costs and once with native conservative costs at the two bounds of the unknown cache prefix.
export function replaySession(rows, baseConfig) {
  const sim = freshSim(baseConfig);
  const records = [];
  const parity = { checked: 0, matched: 0, taxChecked: 0, taxMatched: 0 };
  const skipped = {};
  for (const row of rows) {
    const kind = kindOf(row);
    if (kind === 'observation') observe(sim, row);
    else if (kind === 'historyBreak') {
      sim.legacyModels = {};
      sim.nativeModels = {};
      sim.state = { ...sim.state, votes: [], holdUntilTurn: 0, escalatedSignature: null };
    } else if (kind === 'decision') {
      const cls = classOf(row);
      if (SIDE_CLASSES.has(cls) || row.reason === 'auxiliary' || row.reason === 'error') continue;
      if (REUSED_ROUTE.has(row.reason)) {
        sim.lastRoute = TIERS.includes(row.tier) ? row.tier : sim.lastRoute;
        noteRoute(sim, row.tier, row.model, row.effort);
        continue;
      }
      const now = Date.parse(row.at);
      if (!Number.isFinite(now) || !TIERS.includes(row.tier)) continue;
      noteRoute(sim, row.tier, row.model, row.effort);
      const config = configFor(sim);
      const advised = cls === 'main' && Boolean(row.advice);
      if (row.reason === 'escalation') {
        const next = { ...sim.state, turn: sim.state.turn + 1, votes: [] };
        next.holdUntilTurn = next.turn + config.policy.escalationHoldTurns;
        sim.state = next;
        if (advised) bump(skipped, 'failure-facts-unavailable');
        sim.lastRoute = row.tier;
        continue;
      }
      const facts = baseFacts(sim);
      const legacy = run(config, facts, row.advice ?? null, sim.state, now, legacyCosts);
      if (!UNREPLAYABLE.has(row.reason)) {
        parity.checked += 1;
        if (sameOutcome(legacy, row)) parity.matched += 1;
        if (Number.isFinite(row.estimate?.taxUsd) && Number.isFinite(legacy.estimate?.taxUsd)) {
          parity.taxChecked += 1;
          if (Math.abs(legacy.estimate.taxUsd - row.estimate.taxUsd) < 1e-6) parity.taxMatched += 1;
        }
      }
      if (advised) {
        const missing = missingFacts(sim, config, facts);
        if (UNREPLAYABLE.has(row.reason)) bump(skipped, 'failure-facts-unavailable');
        else if (missing) bump(skipped, missing);
        else records.push(compare(sim, config, row, legacy, now));
      }
      sim.state = legacy.state;
      sim.lastRoute = row.tier;
    }
  }
  return { records, parity, skipped };
}

function missingFacts(sim, config, facts) {
  if (!facts.lastRequest) return 'no-prior-observation';
  const incumbent = TIERS.includes(facts.lastRoute) ? facts.lastRoute : config.baselineTier;
  // A candidate the session never used has no cache state under any ID, so the configured ID is exact enough.
  if (!sim.ids[aliasOf(config, incumbent)]) return 'incumbent-model-id-unknown';
  return null;
}

function compare(sim, config, row, legacy, now) {
  const incumbent = TIERS.includes(sim.lastRoute) ? sim.lastRoute : config.baselineTier;
  const candidate = row.advice.choice;
  const arms = {};
  for (const bound of ['low', 'high']) {
    const facts = nativeFactsAt(sim, bound);
    arms[bound] = { facts, outcome: run(config, facts, row.advice, sim.state, now, nativeCosts) };
  }
  const keyOf = (tier) => nativeCosts.routeCacheKey(config, tier, sim.userEffort);
  const stateOf = (tier) => sim.nativeModels[keyOf(tier)];
  const warm = (tier, bound) => {
    const entry = stateOf(tier);
    return Boolean(
      entry && nativeCosts.isWarm({ lastAt: entry.lastAt, prefixTokens: entry[bound] }, now, config.cache),
    );
  };
  const record = {
    incumbent,
    legacy: { tier: legacy.tier, reason: legacy.reason },
    native: {
      low: { tier: arms.low.outcome.tier, reason: arms.low.outcome.reason },
      high: { tier: arms.high.outcome.tier, reason: arms.high.outcome.reason },
    },
    incumbentCacheStateFound: Boolean(stateOf(incumbent)),
    candidateCacheStateFound: TIERS.includes(candidate) ? Boolean(stateOf(candidate)) : null,
    incumbentFreshAtBound: { low: warm(incumbent, 'low'), high: warm(incumbent, 'high') },
    costs: [],
  };
  record.prefixSensitive = !sameOutcome(record.native.low, record.native.high);
  if (Number.isFinite(legacy.estimate?.threshold)) {
    const estimates = [legacy, arms.low.outcome, arms.high.outcome].map((arm) => arm.estimate);
    record.thresholdStep = {
      taxUsd: { legacy: estimates[0].taxUsd, native: estimates.slice(1).map((e) => e?.taxUsd) },
      threshold: { legacy: estimates[0].threshold, native: estimates.slice(1).map((e) => e?.threshold) },
    };
  }
  if (!record.prefixSensitive && !sameOutcome(record.native.low, legacy)) {
    // The switch that differs is whichever arm leaves the incumbent; both when they pick different new tiers.
    const switched = new Set([legacy.tier, record.native.low.tier].filter((tier) => tier !== incumbent));
    for (const tier of switched) {
      const lows = ['low', 'high'].map((bound) =>
        candidateCost(config, arms[bound].facts, tier, incumbent, now, sim.lastRequest.outputTokens),
      );
      record.costs.push({
        candidate: tier,
        minUsd: Math.min(...lows.map((cost) => cost.minUsd)),
        maxUsd: Math.max(...lows.map((cost) => cost.maxUsd)),
      });
    }
  }
  return record;
}

export function summarizeReplay(results, advisedMain) {
  const records = results.flatMap((result) => result.records);
  const parity = { checked: 0, matched: 0, taxChecked: 0, taxMatched: 0 };
  const skipped = {};
  for (const result of results) {
    for (const key of Object.keys(parity)) parity[key] += result.parity[key];
    for (const [reason, n] of Object.entries(result.skipped)) bump(skipped, reason, n);
  }
  const robust = records.filter((r) => !r.prefixSensitive);
  const differing = robust.filter((r) => !sameOutcome(r.native.low, r.legacy));
  const tierDiffers = differing.filter((r) => r.native.low.tier !== r.legacy.tier);
  const reasonChanges = {};
  const legacyReasons = {};
  const nativeReasons = {};
  for (const r of robust) {
    bump(legacyReasons, r.legacy.reason);
    bump(nativeReasons, r.native.low.reason);
  }
  for (const r of differing) bump(reasonChanges, `${r.legacy.reason}->${r.native.low.reason}`);
  const costs = differing.flatMap((r) => r.costs);
  const stepped = records.filter((r) => r.thresholdStep);
  const spread = (values) => {
    const finite = values.filter(Number.isFinite);
    return finite.length ? { min: round(Math.min(...finite)), max: round(Math.max(...finite)) } : null;
  };
  const total = { minUsd: round(sum(costs, 'minUsd')), maxUsd: round(sum(costs, 'maxUsd')) };
  const switches = (pick) => robust.filter((r) => pick(r) !== r.incumbent).length;
  return {
    label: 'shadow estimate; list-price equivalents; not measured savings and not a counterfactual bill',
    advisedMainDecisions: advisedMain,
    replayEligible: records.length,
    skippedAdvisedMainDecisions: skipped,
    prefixRobust: robust.length,
    prefixSensitive: records.length - robust.length,
    decisionsDiffering: {
      byTierOrReason: differing.length,
      byTier: tierDiffers.length,
      ofPrefixRobust: robust.length,
    },
    switchesRobust: {
      legacy: switches((r) => r.legacy.tier),
      native: switches((r) => r.native.low.tier),
    },
    legacyReasons,
    nativeReasons,
    gateReasonChanges: reasonChanges,
    differingSwitchCost: {
      note: 'next-request cost of the differing switch, candidate minus incumbent, native bounds at both prefix bounds; positive means the candidate costs more; sums are not additive across turns',
      switches: costs.length,
      perSwitchMinUsd: costs.map((c) => round(c.minUsd)).sort((a, b) => a - b),
      perSwitchMaxUsd: costs.map((c) => round(c.maxUsd)).sort((a, b) => a - b),
      rangeAcrossSwitchesUsd: costs.length
        ? { min: round(Math.min(...costs.map((c) => c.minUsd))), max: round(Math.max(...costs.map((c) => c.maxUsd))) }
        : null,
      sumOfBoundsUsd: costs.length ? total : null,
    },
    thresholdStepReached: {
      note: 'advised decisions whose policy path priced the switch (upgrade-pending or downgrade-pending); spreads of tax and threshold per arm',
      decisions: stepped.length,
      taxUsd: {
        legacy: spread(stepped.map((r) => r.thresholdStep.taxUsd.legacy)),
        native: spread(stepped.flatMap((r) => r.thresholdStep.taxUsd.native)),
      },
      threshold: {
        legacy: spread(stepped.map((r) => r.thresholdStep.threshold.legacy)),
        native: spread(stepped.flatMap((r) => r.thresholdStep.threshold.native)),
      },
    },
    cacheKeyCoverage: {
      incumbentStateFound: fraction(records.filter((r) => r.incumbentCacheStateFound).length, records.length),
      candidateStateFound: fraction(
        records.filter((r) => r.candidateCacheStateFound).length,
        records.filter((r) => r.candidateCacheStateFound !== null).length,
      ),
      incumbentFreshAtLowPrefixBound: fraction(
        records.filter((r) => r.incumbentFreshAtBound.low).length,
        records.length,
      ),
      incumbentFreshAtHighPrefixBound: fraction(
        records.filter((r) => r.incumbentFreshAtBound.high).length,
        records.length,
      ),
    },
    legacyParity: {
      note: 'legacy replay against recorded tier+reason on all replayable main/subagent/workflow turn decisions',
      outcome: fraction(parity.matched, parity.checked),
      recordedTaxReproducedWithin1e6: fraction(parity.taxMatched, parity.taxChecked),
    },
  };
}

const sum = (items, key) => items.reduce((total, item) => total + item[key], 0);

// The routes the recorded trace ran under (1.3): replaying it on later defaults would price its tiers wrongly.
export const TRACE_LADDER = loadConfig({
  userFile: { routes: { low: { model: 'sonnet', effort: null }, micro: { model: 'haiku', effort: 'low' } } },
});

export function evaluate(rows, teamIds, malformed = 0) {
  const config = TRACE_LADDER;
  const counts = { ...countRows(rows, teamIds), malformedLinesIgnored: malformed };
  const days = rows.filter((r) => teamIds.has(r.session) && typeof r.at === 'string').map((r) => r.at.slice(0, 10));
  const results = [...groupBySession(rows, teamIds).values()].map((sessionRows) => replaySession(sessionRows, config));
  const shadow = summarizeReplay(results, counts.mainDecisionsWithAdvice);
  const obs = observationCoverage(rows, teamIds);
  const replayExact = { replayed: 0, ofAdvisedMainDecisions: counts.mainDecisionsWithAdvice };
  return {
    schema: 'trace-evaluation/1',
    label: 'shadow estimate; not measured savings',
    window: {
      firstDayUtc: days.length ? days.reduce((a, b) => (a < b ? a : b)) : null,
      lastDayUtc: days.length ? days.reduce((a, b) => (a > b ? a : b)) : null,
    },
    counts,
    routeTransitions: routeTransitions(rows, teamIds),
    recordedReasons: reasonHistogram(rows, teamIds),
    shadowScenario: shadow,
    coverage: {
      observationFields: obs,
      exactNativePrefixReplay: { ...replayExact, status: 'unavailable' },
      boundedReplay: fraction(shadow.replayEligible, counts.mainDecisionsWithAdvice),
      boundedReplayPrefixRobust: fraction(shadow.prefixRobust, counts.mainDecisionsWithAdvice),
      ttlForNativeArm: 'unavailable: native policy treats TTL as unknown by contract and uses the 5m minimum',
      unclassifiedPreHeaderRowsWithAdviceExcluded: counts.teamDecisionsWithAdviceByClass.unclassified ?? 0,
    },
    limitations: [
      'All figures are shadow estimates at configured list prices (all default models bill as plan). Nothing here is a charge, a measured saving or a counterfactual saving.',
      'decisions.jsonl lacks uncached and cache-creation token counts, so the native cache prefix (cache read + creation) cannot be replayed exactly. Native decisions run at both bounds of the prefix (cache read only, and the full request); only decisions identical at both bounds count as prefix-robust.',
      'The logged ttl is 1h only when 1h creation tokens were seen and 5m otherwise, so 5m is a default, not evidence. The legacy arm uses it as logged; the native arm ignores TTL by contract.',
      'Both arms run on one current default config with recorded model IDs substituted per tier, so config drift over the trace window (prices, routes, efforts) cancels between arms but not against the recorded decisions. Legacy parity is reported to show how far the reconstruction holds.',
      'Escalation, hold-after-escalation and pinned decisions depend on failure signatures and pins that are not in the trace. Recorded escalations are applied to the state chain and excluded from comparison.',
      'The state chain follows the legacy policy on the trace inputs and is shared by both arms; it is not re-run per arm, so state divergence after a differing decision is not modeled.',
      'Subagent, workflow, auxiliary, compaction and unclassified rows are excluded from comparison. Subagent and workflow rows still advance the shared session state, as in the gateway.',
      'The trace is a small sample of advised decisions (most main rows are tool continuations or have no advice); counts, not rates, carry the meaning.',
      'Costs cover the next request only (input bounds plus the output-price difference on the last output size) and ignore effort-dependent output length.',
    ],
  };
}

function loadTeamSessionIds(home) {
  const root = join(home, '.claude-team', 'projects');
  const names = [];
  for (const project of readdirSync(root)) {
    try {
      names.push(...readdirSync(join(root, project)));
    } catch {
      // Not a directory (an index file).
    }
  }
  return teamSessionIds(names);
}

function main(argv) {
  const home = homedir();
  const outIndex = argv.indexOf('--out');
  const out =
    outIndex >= 0 ? argv[outIndex + 1] : fileURLToPath(new URL('../results/trace-evaluation.json', import.meta.url));
  const teamIds = loadTeamSessionIds(home);
  const log = join(home, '.claude-team', 'plugins', 'data', 'router-alexei-led-claude-router', 'decisions.jsonl');
  const { rows, malformed } = parseRows(readFileSync(log, 'utf8'));
  const result = evaluate(rows, teamIds, malformed);
  writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  const { counts, shadowScenario: shadow } = result;
  console.log(
    `rows ${counts.allRows}, team ${counts.teamRows}, advised main ${counts.mainDecisionsWithAdvice}, replay-eligible ${shadow.replayEligible}, differing ${shadow.decisionsDiffering.byTierOrReason}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
