import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../lib/config.mjs';
import { cacheState, downgradeTaxUsd, inputBounds, switchingTaxUsd } from '../lib/cost.mjs';
import { hasImages } from '../lib/facts.mjs';
import { continueRoute, emptyLoop, isModelAllowed, isSameModel } from '../lib/route.mjs';
import { compareReply, modelSpec, observedReplyUsd } from '../lib/savings.mjs';
import { drain, harness, start, step } from './harness.mjs';

test('provider presets are not mutable state shared by sessions', () => {
  const a = loadConfig({ provider: 'zai' });
  a.models.glm.output = 99;
  a.activities.ops.high.effort = 'low';
  const b = loadConfig({ provider: 'zai' });
  assert.equal(b.models.glm.output, 4.4);
  assert.equal(b.activities.ops.high.effort, 'max');
});

test('provider identities reject paths, prototype keys and ambiguous names', () => {
  for (const provider of ['../zai', '/tmp/zai', 'ZAI', '__proto__', 'a/b', 'a'.repeat(65)]) {
    assert.throws(() => loadConfig({ provider }));
  }
  for (const cache of [{ mode: 'invalid' }, { effortScope: 'guessed' }]) {
    assert.throws(() => loadConfig({ userFile: { cache } }));
  }
});

test('an unknown provider can configure a complete ladder without inheriting Claude models', () => {
  const model = {
    id: 'custom-model',
    input: 1,
    output: 2,
    cacheRead: 0.1,
    contextWindow: 100000,
    billing: 'credits',
    efforts: [],
  };
  const routes = Object.fromEntries(
    ['micro', 'low', 'medium', 'high'].map((t) => [t, { model: 'custom', effort: null }]),
  );
  const config = loadConfig({ provider: 'custom', userFile: { models: { custom: model }, routes } });
  assert.deepEqual(Object.keys(config.models), ['custom']);
  assert.equal(config.subagentRouting, 'off');
  assert.throws(
    () =>
      loadConfig({
        provider: 'custom',
        userFile: { models: { custom: model }, routes: { ...routes, high: { model: 'custom', effort: 'high' } } },
      }),
    /effort/,
  );
  assert.throws(() => loadConfig({ provider: 'custom' }), /routes/);
});

test('model availability canonicalizes only the known context hint and never grants a different model', () => {
  assert.equal(isModelAllowed('glm-5.3[1m]', ['glm-5.3'], 'glm-5.3'), true);
  assert.equal(isModelAllowed('glm-5.2[1m]', ['glm-5.3'], 'glm-5.3'), false);
  assert.equal(isModelAllowed('glm-5.3-flash[1m]', ['glm-5.3'], 'glm-5.3'), false);
  const config = loadConfig({ provider: 'zai' });
  assert.equal(modelSpec(config, 'glm-5.3[preview]'), null);
  assert.equal(modelSpec(config, 'glm-5.3-20261001'), null);
  assert.equal(isSameModel('glm-5.3', undefined), false);
});

test('nested tool-result images prevent switching to a text-only model', async () => {
  const messages = [{ role: 'user', content: [{ type: 'tool_result', content: [{ type: 'image', source: {} }] }] }];
  assert.equal(hasImages(messages), true);
  const config = loadConfig({ provider: 'zai' });
  const h = harness();
  h.env.set('CLAUDE_ROUTER_PROVIDER', 'zai');
  h.files.set('/fixture/team/zai-router.json', '{}');
  h.model(config.models.flash.id);
  h.messages(async () => messages);
  await start(h);
  await h.event('command.run', { command: 'router', args: 'pin high' });
  await drain(h.step({ ...step, model: config.models.flash.id }));
  assert.equal(h.requests[0].model, config.models.flash.id);
  const loop = emptyLoop(config, config.models.glm.id);
  loop.decision = {
    tier: 'high',
    route: config.routes.high,
    model: config.models.glm.id,
    effort: 'max',
    activity: null,
  };
  const kept = continueRoute(config, loop, {
    nativeModel: config.models.flash.id,
    contextTokens: 1000,
    contextKnown: true,
    hasImages: true,
    effort: 'high',
  });
  assert.equal(kept.decision.model, config.models.flash.id);
  const unknown = continueRoute(config, loop, {
    nativeModel: config.models.glm.id,
    contextTokens: 0,
    contextKnown: false,
    hasImages: true,
    effort: 'high',
  });
  assert.equal(unknown.decision.model, config.models.flash.id);
});

test('deleting or symlinking a selected file prevents pane writes and never creates the default file', async () => {
  for (const kind of ['deleted', 'symlink']) {
    const h = harness();
    const path = '/fixture/team/deepseek-router.json';
    h.env.set('CLAUDE_ROUTER_PROVIDER', 'deepseek');
    h.files.set(path, '{}');
    h.model('deepseek-flash');
    await start(h);
    if (kind === 'deleted') h.files.delete(path);
    else h.links.add(path);
    await h.event('command.run', { command: 'router', args: 'activities off' });
    assert.match(h.view().notice, /Not saved/);
    assert.equal(h.files.has('/fixture/team/router.json'), false);
  }
});

test('effort-only automatic routing keeps cache uncertainty without an impossible fixed-token payback gate', () => {
  const config = loadConfig({ provider: 'deepseek' });
  const facts = {
    effort: 'max',
    models: { 'deepseek-flash@max': { prefixTokens: 900, lastAt: 1000 } },
    contextTokens: 1000,
  };
  assert.ok(switchingTaxUsd(config, config.routes.micro, config.routes.high, facts, 1000) > 0);
  assert.equal(downgradeTaxUsd(config, config.routes.micro, config.routes.high, facts, 1000, 5), 0);
});

test('provider efforts reject aliases with different server mappings and preserve missing usage as unknown', () => {
  assert.throws(() => loadConfig({ provider: 'zai', userFile: { routes: { high: { effort: 'xhigh' } } } }), /effort/);
  const config = loadConfig({ provider: 'deepseek' });
  assert.equal(observedReplyUsd(config, { model: 'deepseek-flash', input_tokens: 100, output_tokens: 1 }, null), null);
  const usage = {
    model: 'deepseek-flash',
    input_tokens: 100,
    output_tokens: 10,
    cache_read_input_tokens: 900,
    cache_creation_input_tokens: 0,
  };
  assert.ok(observedReplyUsd(config, usage, null) > 0);
});

test('disabled caches neither discount input nor infer warm prefixes or write premiums', () => {
  const config = loadConfig({ userFile: { cache: { mode: 'disabled' } } });
  const route = config.routes.high;
  const spec = config.models[route.model];
  const bounds = inputBounds(config, route, 1000, { models: {} }, 1000);
  assert.deepEqual(bounds, { min: (spec.input * 1000) / 1e6, max: (spec.input * 1000) / 1e6 });
  assert.equal(cacheState({ prefixTokens: 1000, lastAt: 1000 }, 1000, config.cache), 'unknown');
  const usage = {
    model: spec.id,
    input_tokens: 100,
    cache_read_input_tokens: 900,
    cache_creation_input_tokens: 0,
    output_tokens: 10,
  };
  const args = {
    usage,
    served: { model: spec.id, effort: 'max' },
    yours: { model: spec.id, effort: 'max' },
    now: 1000,
    ttl: null,
  };
  assert.equal(compareReply(config, null, args).reply.routedUsd, (1000 * spec.input + 10 * spec.output) / 1e6);
});
