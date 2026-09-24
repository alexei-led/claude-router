import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../lib/config.mjs';
import { JEV_PAUSE_MS, Router } from '../lib/router.mjs';
import { assistant, body, jevResponse, toolResult, user } from './helpers.mjs';

function setup(env = {}, userFile = null) {
  const dataDir = mkdtempSync(join(tmpdir(), 'router-'));
  const calls = [];
  const fetchFn = async (_url, init) => {
    calls.push(JSON.parse(init.body));
    return { ok: true, status: 200, json: async () => jevResponse('high', { high: 0.97 }) };
  };
  const config = loadConfig({ env: { TYPESAFE_API_KEY: 'k', ...env }, userFile });
  return { router: new Router({ config, fetchFn, dataDir, now: () => 1_000_000 }), calls, dataDir };
}

test('passes through models other than the alias', () => {
  const { router } = setup();
  assert.equal(router.isRouted({ model: 'claude-opus-5' }), false);
  assert.equal(router.isRouted({ model: 'jev-router' }), true);
  assert.equal(router.isRouted({ model: 'router' }), true);
});

test('a new turn asks Jev once, rewrites the model and remembers the route', async () => {
  const { router, calls, dataDir } = setup();
  const out = await router.route(body([user('design the auth flow')]), { sessionId: 's1', requestClass: 'main' });
  assert.equal(out.tier, 'high');
  assert.equal(out.body.model, 'claude-opus-5-5');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].state.currentRequest.text, 'design the auth flow');
  const saved = JSON.parse(readFileSync(join(dataDir, 'sessions', 's1.json'), 'utf8'));
  assert.equal(saved.lastRoute, 'high');
  assert.equal(saved.lastEffort, 'xhigh');
  assert.ok(saved.lastReason);
});

test('tool continuations reuse the route without asking Jev', async () => {
  const { router, calls } = setup();
  await router.route(body([user('go')]), { sessionId: 's1', requestClass: 'main' });
  const out = await router.route(body([user('go'), assistant('a', ['Bash']), toolResult('ok')]), {
    sessionId: 's1',
    requestClass: 'main',
  });
  assert.equal(out.tier, 'high');
  assert.equal(out.reason, 'tool-continuation');
  assert.equal(calls.length, 1);
});

test('auxiliary requests take the auxiliary tier and leave memory alone', async () => {
  const { router, calls } = setup();
  const byHeader = await router.route(body([user('title?')]), { sessionId: 's1', requestClass: 'auxiliary' });
  assert.equal(byHeader.tier, 'low');
  const byShape = await router.route(body([user('title?')], { thinking: { type: 'disabled' } }), {
    sessionId: 's1',
    requestClass: null,
  });
  assert.equal(byShape.tier, 'low');
  assert.equal(calls.length, 0);
  assert.equal(router.memory('s1').lastRoute, null);
});

test('forced tier and missing key skip Jev', async () => {
  const forced = setup({ ROUTER_FORCE_TIER: 'medium' });
  const out = await forced.router.route(body([user('x')]), { sessionId: 's', requestClass: 'main' });
  assert.equal(out.tier, 'medium');
  assert.equal(forced.calls.length, 0);
  const noKey = setup({ TYPESAFE_API_KEY: '' });
  const base = await noKey.router.route(body([user('x')]), { sessionId: 's', requestClass: 'main' });
  assert.equal(base.tier, 'low');
  assert.equal(base.reason, 'no-advice');
});

test('recorded usage feeds warmth and compaction detection', async () => {
  const { router } = setup();
  router.recordResponse('s2', 'low', {
    model: 'claude-sonnet-5',
    tokens: 50_000,
    cacheReadTokens: 49_000,
    outputTokens: 100,
    ttl: '1h',
  });
  const m = router.memory('s2');
  assert.equal(m.models['claude-sonnet-5'].prefixTokens, 50_100);
  router.recordResponse('s2', 'low', {
    model: 'claude-sonnet-5',
    tokens: 10_000,
    cacheReadTokens: 0,
    outputTokens: 10,
    ttl: '1h',
  });
  assert.deepEqual(Object.keys(router.memory('s2').models), ['claude-sonnet-5']);
  assert.equal(router.memory('s2').models['claude-sonnet-5'].prefixTokens, 10_010);
});

test('a context too large for the routed model moves the turn to a model that fits', async () => {
  const { router } = setup({ ROUTER_FORCE_TIER: 'micro' });
  const usage = (tokens) => ({ model: 'claude-haiku-4-5', tokens, cacheReadTokens: 0, outputTokens: 1_000, ttl: '1h' });
  router.recordResponse('big', 'micro', usage(100_000));
  const small = await router.route(body([user('x')]), { sessionId: 'big', requestClass: 'main' });
  assert.equal(small.tier, 'micro');
  router.recordResponse('big', 'micro', usage(190_000));
  const large = await router.route(body([user('y')]), { sessionId: 'big', requestClass: 'main' });
  assert.equal(large.tier, 'low');
  assert.equal(large.reason, 'context-fit');
  assert.equal(large.body.model, 'claude-sonnet-5');
});

test('compaction is sized by the main context; other side requests are not', async () => {
  const { router } = setup({}, { gateway: { auxiliaryTier: 'micro' } });
  router.recordResponse('c', 'low', {
    model: 'claude-sonnet-5',
    tokens: 400_000,
    cacheReadTokens: 0,
    outputTokens: 0,
    ttl: '1h',
  });
  const compaction = await router.route(body([user('summarize')]), { sessionId: 'c', requestClass: 'compaction' });
  assert.equal(compaction.tier, 'low');
  const title = await router.route(body([user('title?')]), { sessionId: 'c', requestClass: 'auxiliary' });
  assert.equal(title.tier, 'micro');
});

test('a resent request is the same turn: no second Jev call and no second vote', async () => {
  const calls = [];
  const fetchFn = async (_url, init) => {
    calls.push(init);
    return { ok: true, status: 200, json: async () => jevResponse('medium', { medium: 0.99 }) };
  };
  const config = loadConfig({ env: { TYPESAFE_API_KEY: 'k' } });
  const router = new Router({ config, fetchFn, dataDir: mkdtempSync(join(tmpdir(), 'router-')), now: () => 1_000_000 });
  const first = [user('refactor the parser')];
  const ask = (messages) => router.route(body(messages), { sessionId: 's', requestClass: 'main' });
  const turn = await ask(first);
  // Claude Code resends the identical request after a 429, a 529 or a dropped stream.
  const retry = await ask(first);
  assert.deepEqual([turn.tier, turn.reason], ['low', 'upgrade-pending']);
  assert.deepEqual([retry.tier, retry.reason], ['low', 'retry']);
  assert.equal(calls.length, 1);
  assert.equal(router.memory('s').lastReason, 'upgrade-pending');
  const next = await ask([...first, assistant('done'), user('now the lexer')]);
  assert.deepEqual([next.tier, next.reason], ['medium', 'upgrade']);
  assert.equal(calls.length, 2);
});

test('a data directory that cannot be written keeps the decision and reports the error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'router-'));
  const notADirectory = join(dir, 'file');
  writeFileSync(notADirectory, 'x');
  const errors = [];
  const router = new Router({
    config: loadConfig({ env: { TYPESAFE_API_KEY: 'k' } }),
    fetchFn: async () => ({ ok: true, status: 200, json: async () => jevResponse('high', { high: 0.97 }) }),
    dataDir: notADirectory,
    onError: (e) => errors.push(e.message),
  });
  const out = await router.route(body([user('design the auth flow')]), { sessionId: 's', requestClass: 'main' });
  assert.equal(out.tier, 'high');
  assert.equal(router.memory('s').lastRoute, 'high');
  assert.equal(errors.length, 2); // session memory and decision log
});

test('Jev failing three times in a row is paused, then tried once per pause', async () => {
  let t = 1_000_000;
  let healthy = false;
  let calls = 0;
  const fetchFn = async () => {
    calls += 1;
    if (healthy) return { ok: true, status: 200, json: async () => jevResponse('high', { high: 0.97 }) };
    return { ok: false, status: 401, json: async () => ({}) };
  };
  const errors = [];
  const router = new Router({
    config: loadConfig({ env: { TYPESAFE_API_KEY: 'k' } }),
    fetchFn,
    dataDir: mkdtempSync(join(tmpdir(), 'router-')),
    now: () => t,
    onError: (e) => errors.push(e.message),
  });
  let n = 0;
  const newTurn = () => router.route(body([user(`task ${n}`)]), { sessionId: `s${n++}`, requestClass: 'main' });
  for (let i = 0; i < 3; i += 1) await newTurn();
  assert.equal(calls, 3);
  const paused = await newTurn();
  assert.equal(calls, 3);
  assert.equal(paused.tier, 'low');
  assert.equal(errors.filter((m) => /3 times in a row \(jev http 401\)/.test(m)).length, 1);
  t += JEV_PAUSE_MS + 1;
  await newTurn(); // one try, still failing: paused again
  await newTurn();
  assert.equal(calls, 4);
  t += JEV_PAUSE_MS + 1;
  healthy = true;
  const back = await newTurn();
  assert.equal(calls, 5);
  assert.equal(back.tier, 'high');
  assert.ok(errors.some((m) => /routing resumed/.test(m)));
  assert.equal(errors.filter((m) => /in a row/.test(m)).length, 1);
});

test('subagent and workflow requests are routed turns; auxiliary and compaction are side requests', async () => {
  const cases = [
    ['main', false],
    ['subagent', false],
    ['workflow', false],
    ['auxiliary', true],
    ['compaction', true],
  ];
  for (const [requestClass, auxiliary] of cases) {
    const { router, calls } = setup();
    const out = await router.route(body([user('design the auth flow')]), { sessionId: 's1', requestClass });
    assert.equal(out.auxiliary, auxiliary, requestClass);
    assert.equal(calls.length, auxiliary ? 0 : 1, requestClass);
  }
});

test('the first request after a compaction drops the cached prefixes', async () => {
  const { router } = setup();
  router.recordResponse('s1', 'low', {
    model: 'claude-sonnet-5',
    tokens: 50_000,
    cacheReadTokens: 0,
    outputTokens: 1,
    ttl: '1h',
  });
  await router.route(body([user('go on')]), { sessionId: 's1', requestClass: 'main', contextCompacted: 'auto' });
  assert.deepEqual(router.memory('s1').models, {});
  assert.equal(router.memory('s1').lastRequest, null);
});

// M1: the context size before a compaction must not decide the window of the first turn after it.
test('after a compaction, the old context size no longer forces a bigger window', async () => {
  const { router } = setup({ ROUTER_FORCE_TIER: 'micro' });
  const usage = { model: 'claude-sonnet-5', tokens: 190_000, cacheReadTokens: 0, outputTokens: 1, ttl: '1h' };
  router.recordResponse('s1', 'low', usage);
  const before = await router.route(body([user('a'), assistant('b'), user('c')]), {
    sessionId: 's1',
    requestClass: 'main',
  });
  assert.equal(before.reason, 'context-fit');
  const after = await router.route(body([user('summary'), assistant('ok'), user('go on')]), {
    sessionId: 's1',
    requestClass: 'main',
    contextCompacted: 'auto',
  });
  assert.deepEqual([after.tier, after.reason], ['micro', 'forced']);
});

test('the decision log records the agent type', async () => {
  const { router, dataDir } = setup();
  await router.route(body([user('find the parser')]), {
    sessionId: 's1',
    requestClass: 'subagent',
    agentType: 'Explore',
  });
  const entry = JSON.parse(readFileSync(join(dataDir, 'decisions.jsonl'), 'utf8').trim().split('\n').at(-1));
  assert.equal(entry.agentType, 'Explore');
});

// Jev asks for medium at 0.8 every turn: one vote is pending, two consecutive votes upgrade.
function votingRouter() {
  const dataDir = mkdtempSync(join(tmpdir(), 'router-'));
  const fetchFn = async () => ({
    ok: true,
    status: 200,
    json: async () => jevResponse('medium', { medium: 0.8, low: 0.2 }),
  });
  const config = loadConfig({ env: { TYPESAFE_API_KEY: 'k' } });
  const router = new Router({ config, fetchFn, dataDir, now: () => 1_000_000 });
  const ask = (messages, hints = {}) =>
    router.route(body(messages), { sessionId: 's', requestClass: 'main', ...hints });
  const usage = (tokens) => ({ model: 'claude-sonnet-5', tokens, cacheReadTokens: 0, outputTokens: 10, ttl: '1h' });
  const log = () => readFileSync(join(dataDir, 'decisions.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  return { router, ask, usage, log };
}

const history = [user('plan the parser'), assistant('plan'), user('write it')];

test('a growing history keeps its votes: the second vote upgrades', async () => {
  const { ask } = votingRouter();
  assert.equal((await ask(history)).reason, 'upgrade-pending');
  assert.equal((await ask([...history, assistant('done'), user('now the lexer')])).reason, 'upgrade');
});

test('a shorter history (a rewind) drops the votes and the cached prefixes', async () => {
  const { router, ask, usage, log } = votingRouter();
  await ask(history);
  router.recordResponse('s', 'low', usage(50_000), 'high');
  assert.ok(router.memory('s').models['claude-sonnet-5@high']);
  const rewound = await ask([user('plan the lexer instead')]);
  assert.equal(rewound.reason, 'upgrade-pending');
  assert.equal(router.memory('s').state.votes.length, 1);
  assert.deepEqual(router.memory('s').models, {});
  assert.equal(router.memory('s').lastRequest, null);
  assert.ok(log().some((e) => e.historyBreak === 'shorter-history'));
});

test('the compaction header drops the votes and the escalation hold', async () => {
  const { router, ask } = votingRouter();
  await ask(history);
  router.memory('s').state = { ...router.memory('s').state, holdUntilTurn: 9, escalatedSignature: 'error: x' };
  const out = await ask([...history, assistant('ok'), user('go on')], { contextCompacted: 'auto' });
  assert.equal(out.reason, 'upgrade-pending');
  const { state } = router.memory('s');
  assert.deepEqual([state.votes.length, state.holdUntilTurn, state.escalatedSignature], [1, 0, null]);
});

test('context editing shrinks the context but keeps the messages: only the cached prefixes go', async () => {
  const { router, ask, usage, log } = votingRouter();
  await ask(history);
  router.recordResponse('s', 'low', usage(100_000), 'high');
  router.recordResponse('s', 'low', usage(10_000), 'high');
  assert.equal(router.memory('s').models['claude-sonnet-5@high'].prefixTokens, 10_010);
  assert.ok(log().some((e) => e.cacheReset === 'context-shrink'));
  assert.equal((await ask([...history, assistant('done'), user('next')])).reason, 'upgrade');
});

test('a turn logs the shadow economics of following Jev and keeps its estimate for the status', async () => {
  const { router, ask, usage, log } = votingRouter();
  await ask(history);
  router.recordResponse('s', 'low', usage(10_000), 'high');
  await ask([...history, assistant('done'), user('next')]);
  const turn = log()
    .filter((e) => e.shadow)
    .at(-1);
  // Medium (Opus) costs more per turn than Sonnet: an upgrade never repays in dollars.
  assert.ok(turn.shadow.laterTurnUsd > 0);
  assert.equal(turn.shadow.paybackTurns, null);
  assert.equal(router.memory('s').lastReason, 'upgrade');
  assert.ok(router.memory('s').lastEstimate.upgradeMass >= 0.8);
});

// M8/M9: the decision log shows the model and the effort that ran, and the turns that failed; never prompt text.
const readLog = (dataDir) =>
  readFileSync(join(dataDir, 'decisions.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));

test('a decision line names the model and the effort sent; an observed line the effort', async () => {
  const { router, dataDir } = setup();
  await router.route(body([user('design the auth flow')]), { sessionId: 's1', requestClass: 'main' });
  const usage = { model: 'claude-opus-5-5', tokens: 1000, cacheReadTokens: 0, outputTokens: 1, ttl: '1h' };
  router.recordResponse('s1', 'high', usage, 'xhigh');
  const [decision, observed] = readLog(dataDir);
  assert.deepEqual([decision.model, decision.effort], ['claude-opus-5-5', 'xhigh']);
  assert.equal(observed.observed.effort, 'xhigh');
});

test('a decision for a model without effort logs effort null', async () => {
  const { router, dataDir } = setup({ ROUTER_FORCE_TIER: 'micro' });
  await router.route(body([user('rename x')]), { sessionId: 's1', requestClass: 'main' });
  const [decision] = readLog(dataDir);
  assert.deepEqual([decision.model, decision.effort], ['claude-haiku-4-5', null]);
});

test('a routing error logs a decision with reason error and no message text', () => {
  const { router, dataDir } = setup();
  const out = router.fallback(body([user('CANARY-PROMPT secret text')]), 's1', { requestClass: 'main' });
  assert.equal(out.reason, 'error');
  const [line] = readLog(dataDir);
  assert.deepEqual([line.session, line.reason, line.tier, line.model], ['s1', 'error', 'low', 'claude-sonnet-5']);
  assert.doesNotMatch(readFileSync(join(dataDir, 'decisions.jsonl'), 'utf8'), /CANARY/);
});

test('a failed upstream response logs a failed line', () => {
  const { router, dataDir } = setup();
  router.recordFailure('s1', { tier: 'high', effort: 'xhigh', body: { model: 'claude-opus-5-5' } }, 529);
  const [line] = readLog(dataDir);
  assert.equal(line.session, 's1');
  assert.deepEqual(line.failed, { status: 529, tier: 'high', model: 'claude-opus-5-5', effort: 'xhigh' });
});
