import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../lib/config.mjs';
import { Router } from '../lib/router.mjs';
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
  assert.equal(router.isRouted({ model: 'router' }), true);
});

test('a new turn asks Jev once, rewrites the model and remembers the route', async () => {
  const { router, calls, dataDir } = setup();
  const out = await router.route(body([user('design the auth flow')]), { sessionId: 's1', requestClass: 'main' });
  assert.equal(out.tier, 'high');
  assert.equal(out.body.model, 'claude-fable-5-1');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].state.currentRequest.text, 'design the auth flow');
  const saved = JSON.parse(readFileSync(join(dataDir, 'sessions', 's1.json'), 'utf8'));
  assert.equal(saved.lastRoute, 'high');
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
    model: 'claude-sonnet-4-6',
    tokens: 50_000,
    cacheReadTokens: 49_000,
    outputTokens: 100,
    ttl: '1h',
  });
  const m = router.memory('s2');
  assert.equal(m.models['claude-sonnet-4-6'].prefixTokens, 50_100);
  router.recordResponse('s2', 'low', {
    model: 'claude-sonnet-4-6',
    tokens: 10_000,
    cacheReadTokens: 0,
    outputTokens: 10,
    ttl: '1h',
  });
  assert.deepEqual(Object.keys(router.memory('s2').models), ['claude-sonnet-4-6']);
  assert.equal(router.memory('s2').models['claude-sonnet-4-6'].prefixTokens, 10_010);
});
