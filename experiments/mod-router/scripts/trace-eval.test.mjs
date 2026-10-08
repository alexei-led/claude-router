import assert from 'node:assert/strict';
import test from 'node:test';
import {
  countRows,
  evaluate,
  observationCoverage,
  parseRows,
  reasonHistogram,
  replaySession,
  routeTransitions,
  summarizeReplay,
  TRACE_LADDER,
  teamSessionIds,
} from './trace-eval.mjs';

const TEAM = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const teamIds = teamSessionIds([`${TEAM}.jsonl`, TEAM, 'memory', 'sessions-index.json']);
const T0 = Date.parse('2026-10-01T12:00:00Z');
const at = (offsetMs) => new Date(T0 + offsetMs).toISOString();
const MINUTE = 60_000;

const decision = (offset, fields) => ({
  at: at(offset),
  session: TEAM,
  requestClass: 'main',
  tier: 'low',
  reason: 'tool-continuation',
  estimate: null,
  advice: null,
  ...fields,
});
const observed = (offset, fields) => ({
  at: at(offset),
  session: TEAM,
  observed: {
    model: 'claude-sonnet-5-5',
    tokens: 150_000,
    cacheReadTokens: 140_000,
    outputTokens: 1500,
    ttl: '5m',
    tier: 'low',
    effort: 'high',
    ...fields,
  },
});
const advice = (high) => ({
  choice: 'high',
  confidence: 0.8,
  probabilities: { micro: 0, low: 1 - high, medium: 0, high, uncertain: 0 },
  continuation: 0.1,
});

test('team session ids come from file and directory names only', () => {
  assert.deepEqual([...teamIds], [TEAM]);
});

test('malformed lines and rows without a session are counted out', () => {
  const { rows, malformed } = parseRows(`${JSON.stringify({ session: TEAM, reason: 'x' })}\nnot json\n{"a":1}\n`);
  assert.equal(rows.length, 1);
  assert.equal(malformed, 2);
});

test('row counts exclude other sessions and keep subagent rows out of the main counts', () => {
  const rows = [
    decision(0, { advice: advice(0.5) }),
    decision(1, { requestClass: 'subagent', advice: advice(0.5) }),
    decision(2, { requestClass: 'subagent' }),
    observed(3),
    { ...decision(4, {}), session: OTHER },
  ];
  const counts = countRows(rows, teamIds);
  assert.equal(counts.allRows, 5);
  assert.equal(counts.teamRows, 4);
  assert.equal(counts.nonTeamRowsExcluded, 1);
  assert.equal(counts.mainDecisions, 1);
  assert.equal(counts.mainDecisionsWithAdvice, 1);
  assert.equal(counts.subagentRowsExcluded, 2);
  assert.equal(counts.subagentRowsWithAdviceExcluded, 1);
  assert.equal(counts.observations, 1);
});

test('reason histogram buckets free text instead of passing it through', () => {
  const rows = [decision(0, { reason: 'hold' }), decision(1, { reason: 'Some prompt text here' })];
  assert.deepEqual(reasonHistogram(rows, teamIds).byRequestClass.main, { hold: 1, other: 1 });
});

test('route transitions classify up, down and stay and skip continuations in the turn view', () => {
  const rows = [
    decision(0, { tier: 'low', reason: 'no-advice' }),
    decision(1, { tier: 'low' }),
    decision(2, { tier: 'high', reason: 'upgrade' }),
    decision(3, { tier: 'low', reason: 'downgrade' }),
  ];
  const { allMainRows, turnDecisions } = routeTransitions(rows, teamIds);
  assert.deepEqual([allMainRows.up, allMainRows.down, allMainRows.stay], [1, 1, 1]);
  assert.deepEqual([turnDecisions.up, turnDecisions.down, turnDecisions.stay], [1, 1, 0]);
  assert.deepEqual(turnDecisions.byTierPair, { 'low->high': 1, 'high->low': 1 });
  assert.deepEqual(turnDecisions.perDay['2026-10-01'], { up: 1, down: 1, stay: 0 });
});

test('observation coverage marks the missing split and treats a logged 5m ttl as a default', () => {
  const rows = [observed(0, { ttl: '1h' }), observed(1, { effort: undefined }), observed(2, { ttl: undefined })];
  const coverage = observationCoverage(rows, teamIds);
  assert.deepEqual(coverage.cacheCreationTokens, { status: 'unavailable', rowsLacking: 3 });
  assert.equal(coverage.uncachedInputTokens.rowsLacking, 3);
  assert.equal(coverage.effort.rowsLacking, 1);
  assert.deepEqual(coverage.ttl, { status: 'partial', evidence1h: 1, default5mNotEvidence: 1, rowsLacking: 1 });
});

const upgradeSession = () => [
  observed(-40 * MINUTE, { model: 'claude-opus-5-5', tier: 'high', effort: 'xhigh' }),
  observed(-10 * MINUTE, { tokens: 150_000 }),
  decision(0, { reason: 'upgrade-pending', advice: advice(0.83) }),
  decision(MINUTE, { reason: 'upgrade', tier: 'high', advice: advice(0.83), model: 'claude-opus-5-5' }),
];

test('replay finds the decision where native conservative costs withhold an upgrade legacy takes: a 0.83 vote clears the legacy bar, not the native one', () => {
  const [result] = [replaySession(upgradeSession(), TRACE_LADDER)];
  assert.equal(result.parity.checked, 2);
  assert.equal(result.parity.matched, 2);
  assert.equal(result.records.length, 2);
  const [pending, flipped] = result.records;
  assert.equal(pending.legacy.reason, 'upgrade-pending');
  assert.equal(pending.native.low.reason, 'upgrade-pending');
  assert.deepEqual(flipped.legacy, { tier: 'high', reason: 'upgrade' });
  assert.deepEqual(flipped.native.low, { tier: 'low', reason: 'upgrade-pending' });
  assert.equal(flipped.prefixSensitive, false);
  const [cost] = flipped.costs;
  assert.equal(cost.candidate, 'high');
  assert.ok(cost.minUsd <= cost.maxUsd);
  assert.ok(cost.maxUsd > 0);
});

test('summary counts differing decisions, gate reason changes and cost ranges', () => {
  const summary = summarizeReplay([replaySession(upgradeSession(), TRACE_LADDER)], 2);
  assert.equal(summary.replayEligible, 2);
  assert.equal(summary.decisionsDiffering.byTier, 1);
  assert.deepEqual(summary.gateReasonChanges, { 'upgrade->upgrade-pending': 1 });
  assert.deepEqual(summary.switchesRobust, { legacy: 1, native: 0 });
  assert.equal(summary.differingSwitchCost.switches, 1);
  assert.ok(summary.differingSwitchCost.rangeAcrossSwitchesUsd.max > 0);
  assert.equal(summary.thresholdStepReached.decisions, 2);
});

test('advised decisions without a prior observation are skipped, not replayed', () => {
  const rows = [decision(0, { reason: 'upgrade-pending', advice: advice(0.83), model: 'claude-sonnet-5-5' })];
  const result = replaySession(rows, TRACE_LADDER);
  assert.equal(result.records.length, 0);
  assert.deepEqual(result.skipped, { 'no-prior-observation': 1 });
});

test('recorded escalations enter the state chain but are never compared', () => {
  const rows = [
    observed(-MINUTE),
    decision(0, { reason: 'escalation', tier: 'medium', advice: advice(0.5), model: 'claude-sonnet-5-5' }),
  ];
  const result = replaySession(rows, TRACE_LADDER);
  assert.equal(result.records.length, 0);
  assert.deepEqual(result.skipped, { 'failure-facts-unavailable': 1 });
});

test('evaluate reports an unavailable exact replay and never carries session ids', () => {
  const report = evaluate([...upgradeSession(), { ...decision(0, {}), session: OTHER }], teamIds);
  assert.equal(report.coverage.exactNativePrefixReplay.status, 'unavailable');
  assert.equal(report.coverage.exactNativePrefixReplay.replayed, 0);
  assert.deepEqual(report.coverage.boundedReplay, { num: 2, den: 2, ratio: 1 });
  assert.ok(report.limitations.length > 0);
  const text = JSON.stringify(report);
  assert.ok(!text.includes(TEAM) && !text.includes(OTHER));
  assert.match(report.label, /shadow estimate/);
});
