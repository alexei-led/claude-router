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
