import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { DEFAULTS, loadConfig } from '../lib/config.mjs';
import { agentCosts, billingOf, isEffortOnly, periodCost, planLimits, resetText } from '../lib/costs.mjs';
import { emptyUsage, recordUsage, replyEntry, summarize } from '../lib/usage.mjs';

const NOW = new Date(2026, 10, 3, 12).getTime();
const ALL = { from: null, to: null };
const PROXY = loadConfig({
  provider: 'model-proxy',
  userFile: JSON.parse(readFileSync(new URL('./fixtures/model-proxy-router.json', import.meta.url), 'utf8')),
});
const FIVE_HOUR = { kind: 'five_hour', percentUsed: 37, resetsAt: new Date(NOW + 3600e3).toISOString() };
const SEVEN_DAY = { kind: 'seven_day', percentUsed: 81 };
const SPEND = { kind: 'spend_limit', percentUsed: 12 };
const TOKENS = { input_tokens: 100, cache_read_input_tokens: 800, cache_creation_input_tokens: 200, output_tokens: 10 };
// One main-thread reply on Haiku, priced against Opus: `reply` null when no comparison was possible.
const entry = (reply, route = 'claude-haiku-5-5@high') =>
  replyEntry({
    at: NOW,
    mode: 'balanced',
    activity: 'code',
    tier: 'low',
    route,
    yours: 'claude-opus-5-5',
    reply,
    observedUsd: reply?.routedUsd ?? 0.5,
    replies: {},
    usage: TOKENS,
  });
const SAVED = { routedUsd: 1, yoursUsd: 3, cheaperUsd: -2.2, strongerUsd: 0, switchUsd: 0.2 };
const summaryOf = (entries) => summarize(recordUsage(emptyUsage(), entries, { now: NOW }), ALL);
// Subagents: an Explore agent the router moved to Haiku ($0.10, $0.60 on Claude Code's pick) and a workflow agent left
// on Claude Code's pick ($0.40).
const AGENTS = {
  routed: {
    Explore: { agents: 1, models: { 'claude-haiku-5-5': { agents: 1, moved: 1, usd: 0.1, coreUsd: 0.6 } } },
  },
  passed: { workflow: { agents: 1, models: { 'claude-opus-5-5': { agents: 1, usd: 0.4 } } } },
  undated: null,
};

test('plan limits list the windows Claude Code reported, in order, with their reset times', () => {
  assert.deepEqual(planLimits(null), []);
  assert.deepEqual(
    planLimits({ rateLimits: [SPEND, SEVEN_DAY, FIVE_HOUR, { kind: 'five_hour', percentUsed: null }] }),
    [
      { kind: 'five_hour', label: '5h', percent: 37, resetsAt: NOW + 3600e3 },
      { kind: 'seven_day', label: '7d', percent: 81, resetsAt: null },
      { kind: 'spend_limit', label: 'spend', percent: 12, resetsAt: null },
    ],
  );
  assert.equal(planLimits({ rateLimits: [{ ...FIVE_HOUR, resetsAt: 'soon' }] })[0].resetsAt, null);
});

test('billing is plan only with a plan model and a plan window; credits beside it make it mixed', () => {
  for (const [name, config, rateLimits, expected] of [
    ['Claude with no window, as on an API key', DEFAULTS, [], 'billed'],
    ['Claude with a 5h window', DEFAULTS, [FIVE_HOUR], 'plan'],
    ['Claude with a 7d window', DEFAULTS, [SEVEN_DAY], 'plan'],
    ['a gateway spend cap is not a plan', DEFAULTS, [SPEND], 'billed'],
    ['Claude and DeepSeek credits on a plan', PROXY, [FIVE_HOUR], 'mixed'],
    ['Claude and DeepSeek credits without a window', PROXY, [], 'billed'],
    ['a credits-only provider with a window', loadConfig({ provider: 'deepseek' }), [FIVE_HOUR], 'billed'],
  ])
    assert.equal(billingOf(config, { rateLimits }), expected, name);
});

test('a profile is effort-only when every route runs one model', () => {
  for (const [provider, expected] of [
    ['anthropic', false],
    ['deepseek', true],
    ['kimi', true],
    ['minimax', true],
    ['zai', false],
    ['mimo', false],
  ])
    assert.equal(isEffortOnly(loadConfig({ provider })), expected, provider);
});

test('subagents cost what they ran on; routed ones compare with Claude Code’s pick, pass-throughs with themselves', () => {
  assert.deepEqual(agentCosts(DEFAULTS, AGENTS), { agents: 2, moved: 1, usd: 0.5, baseUsd: 1, creditsUsd: 0 });
  const undated = { ...AGENTS, undated: { agents: 3, usd: 0.3 } };
  assert.deepEqual(agentCosts(DEFAULTS, undated), { agents: 5, moved: 1, usd: 0.8, baseUsd: 1.3, creditsUsd: 0 });
  const credits = { routed: { Explore: { agents: 1, models: { 'deepseek-flash[1m]': { usd: 0.2, coreUsd: 0.6 } } } } };
  assert.equal(agentCosts(PROXY, credits).creditsUsd, 0.2);
  assert.deepEqual(agentCosts(DEFAULTS, null), { agents: 0, moved: 0, usd: 0, baseUsd: 0, creditsUsd: 0 });
});

test('the period cost adds up: main plus agents is the total, and the total minus no routing is the difference', () => {
  const cost = periodCost(DEFAULTS, {
    summary: summaryOf([entry(SAVED)]),
    agents: AGENTS,
  });
  assert.equal(cost.billing, 'billed');
  assert.deepEqual([cost.mainUsd, cost.agentUsd, cost.totalUsd, cost.baseUsd, cost.diffUsd], [1, 0.5, 1.5, 4, -2.5]);
  assert.equal(cost.totalUsd, cost.mainUsd + cost.agentUsd);
  assert.equal(cost.diffUsd, cost.totalUsd - cost.baseUsd);
  assert.equal(cost.diffUsd, cost.mainDiff + cost.agentDiff);
  assert.equal(cost.share, -2.5 / 4);
  assert.equal(cost.early, true);
});

test('a period with a reply that has no comparison shows its cost but no difference', () => {
  const cost = periodCost(DEFAULTS, { summary: summaryOf([entry(SAVED), entry(null)]), agents: null });
  assert.equal(cost.comparable, false);
  assert.deepEqual([cost.replies, cost.uncomparedReplies], [2, 1]);
  assert.deepEqual([cost.baseUsd, cost.diffUsd, cost.share], [null, null, null]);
  assert.equal(cost.totalUsd, 1.5);
});

test('subagents alone compare with Claude Code’s picks, before any main reply', () => {
  const cost = periodCost(DEFAULTS, { summary: summaryOf([]), agents: AGENTS });
  assert.equal(cost.comparable, true);
  assert.deepEqual([cost.totalUsd, cost.baseUsd, cost.diffUsd], [0.5, 1, -0.5]);
});

test('an effort-only profile shows its effort mix instead of a saving', () => {
  const minimax = loadConfig({ provider: 'minimax' });
  const route = (effort) => `MiniMax-M3.1-Flash@${effort}`;
  const summary = summaryOf([entry(SAVED, route('low')), entry(SAVED, route('high')), entry(SAVED, route('low'))]);
  const cost = periodCost(minimax, { summary, agents: null });
  assert.equal(cost.effortOnly, true);
  assert.equal(cost.diffUsd, null);
  assert.deepEqual(cost.effortMix, [
    ['low', 2],
    ['high', 1],
  ]);
});

test('on a plan with credits models, the credits part is the replies and agents on credits', () => {
  const summary = summaryOf([entry(SAVED, 'deepseek-flash[1m]@low'), entry(SAVED, 'claude-opus-5-5@xhigh')]);
  const agents = { routed: { Explore: { agents: 1, models: { 'deepseek-flash[1m]': { usd: 0.2, coreUsd: 0.6 } } } } };
  const cost = periodCost(PROXY, { summary, agents, usage: { rateLimits: [FIVE_HOUR] } });
  assert.equal(cost.billing, 'mixed');
  assert.equal(cost.creditsUsd, 1.2);
  assert.deepEqual(
    cost.limits.map((l) => l.label),
    ['5h'],
  );
});

test('a reset reads as a time today, a weekday and time later, and nothing once it passed', () => {
  const time = (ms) => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const later = NOW + 3 * 86400e3;
  assert.equal(resetText(NOW + 3600e3, NOW), time(NOW + 3600e3));
  assert.equal(
    resetText(later, NOW),
    `${new Date(later).toLocaleDateString('en-US', { weekday: 'short' })} ${time(later)}`,
  );
  assert.equal(resetText(NOW - 1, NOW), null);
  assert.equal(resetText(null, NOW), null);
});
