import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { compareRoutes } from '../lib/activity.mjs';
import { readMetrics } from '../lib/activity-stats.mjs';
import { loadConfig, resolveRoute } from '../lib/config.mjs';
import { cacheState, coldWriteUsd, inputBounds } from '../lib/cost.mjs';
import { unpricedLine } from '../lib/display.mjs';
import { isSameModel } from '../lib/route.mjs';
import { compareReply } from '../lib/savings.mjs';
import { drain, harness, press, start, step, texts } from './harness.mjs';

test('provider models match sourced rates, modalities and live-accepted efforts', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/provider-support.json', import.meta.url), 'utf8'));
  assert.match(fixture.checked, /^\d{4}-\d{2}-\d{2}$/);
  for (const provider of ['deepseek', 'zai', 'minimax', 'mimo', 'kimi'])
    for (const model of Object.values(loadConfig({ provider }).models)) {
      const { input, output, cacheRead, efforts, imageInput } = model;
      assert.deepEqual({ input, output, cacheRead, efforts, imageInput }, fixture.models[model.id.replace('[1m]', '')]);
      assert.ok(fixture.sources[provider].every((url) => url.startsWith('https://')));
    }
});

test('provider presets replace the Claude catalog, routes and subagent defaults', () => {
  for (const provider of ['deepseek', 'zai', 'minimax', 'mimo', 'kimi']) {
    const config = loadConfig({ provider });
    assert.equal(config.provider, provider);
    assert.ok(!Object.values(config.models).some((m) => m.id.startsWith('claude-')));
    assert.equal(config.cache.mode, 'automatic');
    for (const tier of ['micro', 'low', 'medium', 'high']) {
      const route = resolveRoute(config, tier);
      assert.ok(route.effort === null || config.models[route.model].efforts.includes(route.effort));
    }
    assert.ok(Object.hasOwn(config.models, config.subagents.light));
    assert.ok(Object.hasOwn(config.models, config.subagents.heavy));
    assert.equal(resolveRoute(config, 'high').effort, provider === 'mimo' ? null : 'max');
  }
  assert.equal(Object.keys(loadConfig({ provider: 'deepseek' }).models).length, 1);
});

test('capability rank, not a price increase, orders models that declare strength', () => {
  const config = loadConfig({ provider: 'zai' });
  config.models.glm.output = 0.01;
  assert.equal(compareRoutes(config, { model: 'glm', effort: 'high' }, { model: 'flash', effort: 'high' }), 1);
});

test('context suffix is not another served model, but real versions remain distinct', () => {
  assert.equal(isSameModel('deepseek-flash[1m]', 'deepseek-flash'), true);
  assert.equal(isSameModel('glm-5.3', 'glm-5.3[1m]'), true);
  assert.equal(isSameModel('glm-5.3', 'glm-5.2'), false);
});

test('automatic prefix caches use hit/miss bounds, no TTL guarantee or write premium', () => {
  const config = loadConfig({ provider: 'deepseek' });
  const route = resolveRoute(config, 'high');
  const spec = config.models[route.model];
  const facts = { effort: 'high', models: {}, contextTokens: 1000 };
  const bounds = inputBounds(config, route, 1000, facts, 1000);
  assert.equal(bounds.min, (spec.cacheRead * 1000) / 1e6);
  assert.equal(bounds.max, (spec.input * 1000) / 1e6);
  const afterMiss = inputBounds(
    config,
    route,
    1000,
    { ...facts, models: { 'deepseek-flash@max': { prefixTokens: 0, lastAt: 1000 } } },
    1001,
  );
  assert.equal(afterMiss.min, bounds.min);
  assert.equal(coldWriteUsd(config, route.model, 1000), bounds.max);
  assert.equal(cacheState({ prefixTokens: 1000, lastAt: 1000 }, 1000, config.cache), 'unknown');
});

test('automatic-cache comparisons do not fabricate another route cache hit rate', () => {
  const config = loadConfig({ provider: 'deepseek' });
  const model = config.models.flash.id;
  const usage = {
    model,
    input_tokens: 100,
    cache_read_input_tokens: 900,
    cache_creation_input_tokens: 0,
    output_tokens: 10,
  };
  const args = { usage, served: { model, effort: 'low' }, yours: { model, effort: 'max' }, ttl: '1h', now: 1000 };
  assert.equal(compareReply(config, null, args).reply, null);
  const same = compareReply(config, null, { ...args, yours: args.served }).reply;
  assert.ok(same);
  assert.equal(same.switchUsd, 0);
  assert.equal(
    same.routedUsd,
    (100 * config.models.flash.input + 900 * config.models.flash.cacheRead + 10 * config.models.flash.output) / 1e6,
  );
});

test('selected provider file is isolated, normalizes response IDs and stays selected for saves', async () => {
  const h = harness();
  h.env.set('CLAUDE_ROUTER_PROVIDER', 'deepseek');
  h.model('deepseek-flash[1m]');
  h.files.set('/fixture/team/deepseek-router.json', '{}');
  h.files.set('/fixture/team/router.json', '{"classifier":"ollama"}');
  await start(h);
  assert.equal(h.view().phase, 'ready');
  assert.equal(h.view().configPath, '/fixture/team/deepseek-router.json');
  h.env.set('CLAUDE_ROUTER_PROVIDER', 'zai');
  await h.event('command.run', { command: 'router', args: 'pin high' });
  await drain(
    h.step(
      { ...step, model: 'deepseek-flash[1m]' },
      {
        usage: {
          model: 'deepseek-flash',
          input_tokens: 100,
          cache_read_input_tokens: 800,
          cache_creation_input_tokens: 0,
          output_tokens: 10,
        },
      },
    ),
  );
  assert.equal(h.requests[0].model, 'deepseek-flash[1m]');
  assert.equal(h.requests[0].effort, 'max');
  assert.notEqual(h.loop().suspended, true);
  await h.event('command.run', { command: 'router', args: 'activities off' });
  assert.equal(JSON.parse(h.files.get('/fixture/team/deepseek-router.json')).activityRouting, 'off');
  assert.equal(h.files.get('/fixture/team/router.json'), '{"classifier":"ollama"}');
  assert.equal(h.files.has('/fixture/team/zai-router.json'), false);
});

test('missing, invalid or unsafe provider selections never fall back to router.json', async () => {
  for (const [provider, text] of [
    ['deepseek', null],
    ['deepseek', '{'],
    ['deepseek', '{"routes":{"low":{"model":"opus"}}}'],
    ['../outside', '{}'],
  ]) {
    const h = harness();
    h.env.set('CLAUDE_ROUTER_PROVIDER', provider);
    if (text !== null) h.files.set('/fixture/team/deepseek-router.json', text);
    await start(h);
    assert.equal(h.view().phase, 'unavailable', provider + text);
    await drain(h.step(step));
    assert.equal(h.requests[0].model, step.model);
    assert.equal(h.requests[0].effort, step.effort);
  }
});

test('known automatic-cache costs are not labelled unpriced when only the comparison is unavailable', async () => {
  const h = harness();
  h.env.set('CLAUDE_ROUTER_PROVIDER', 'deepseek');
  h.model('deepseek-flash[1m]');
  h.files.set('/fixture/team/deepseek-router.json', '{}');
  await start(h);
  await h.event('command.run', { command: 'router', args: 'pin high' });
  await drain(h.step({ ...step, model: 'deepseek-flash[1m]', effort: 'low' }));
  await h.event('turn.complete', { turnId: 't1' });
  const metrics = readMetrics(h.view().activityMetrics);
  assert.equal(metrics.unpriced.comparison, 1);
  assert.equal(metrics.unpriced.ttl, 0);
  assert.match(unpricedLine(metrics), /^Comparison unavailable:/);
  assert.ok(!unpricedLine(metrics).includes('Unpriced'));
  const end = (await h.event('command.run', { command: 'router', args: 'decisions' })).text;
  assert.match(end, /1 priced.*comparison unavailable 1/);
  assert.ok(!end.includes('unpriced comparison'));
});

test('provider pane reset uses provider defaults and identifies its selected file', async () => {
  const h = harness();
  h.env.set('CLAUDE_ROUTER_PROVIDER', 'zai');
  h.model('glm-5.3-flash[1m]');
  h.files.set('/fixture/team/zai-router.json', '{"routes":{"low":{"model":"glm","effort":"max"}}}');
  await start(h);
  assert.equal(h.view().phase, 'ready');
  const tree = await h.render();
  assert.ok(texts(tree).join('\n').includes('zai-router.json'));
  await press(h, 'tab-routes');
  await press(h, 'reset-routes');
  await press(h, 'save-routing');
  assert.deepEqual(JSON.parse(h.files.get('/fixture/team/zai-router.json')), {});
  await press(h, 'undo');
  assert.equal(JSON.parse(h.files.get('/fixture/team/zai-router.json')).routes.low.model, 'glm');
});
