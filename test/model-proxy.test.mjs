import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { loadConfig } from '../lib/config.mjs';
import { providerFile } from '../lib/providers.mjs';
import { answering, drain, harness, JEV_KEY, start, step } from './harness.mjs';
import { jevResponse } from './helpers.mjs';

const profile = JSON.parse(readFileSync(new URL('./fixtures/model-proxy-router.json', import.meta.url), 'utf8'));

test('model-proxy requires an explicit two-provider ladder without built-in defaults', () => {
  assert.equal(providerFile('model-proxy'), 'model-proxy-router.json');
  assert.throws(() => loadConfig({ provider: 'model-proxy' }), /routes/);
  assert.throws(() => loadConfig({ provider: 'model-proxy', userFile: {} }), /routes/);
  const config = loadConfig({ provider: 'model-proxy', userFile: profile });
  assert.deepEqual(Object.keys(config.models).sort(), ['claude', 'deepseek']);
  assert.equal(config.models.deepseek.id, 'deepseek-flash[1m]');
  assert.equal(config.models.claude.id, 'claude-opus-5-5');
  assert.deepEqual(config.routes, {
    micro: { model: 'deepseek', effort: 'low' },
    low: { model: 'deepseek', effort: 'low' },
    medium: { model: 'deepseek', effort: 'high' },
    high: { model: 'claude', effort: 'xhigh' },
  });
  assert.equal(config.activityRouting, 'off');
  assert.equal(config.subagentRouting, 'off');
  assert.equal(config.cache.mode, 'disabled');
});

test('model-proxy switches providers on one connection and saves only its selected file', async () => {
  const h = harness();
  const path = '/fixture/team/model-proxy-router.json';
  h.env.set('CLAUDE_ROUTER_PROVIDER', 'model-proxy');
  h.env.set('ANTHROPIC_BASE_URL', 'http://127.0.0.1:43172');
  h.files.set(path, JSON.stringify(profile));
  h.files.set('/fixture/team/router.json', '{"classifier":"ollama"}');
  h.model('deepseek-flash[1m]');
  await start(h);
  assert.equal(h.view().phase, 'ready');
  assert.equal(h.view().configPath, path);
  for (const [index, tier] of ['medium', 'high', 'low'].entries()) {
    const turnId = `mixed-${index}`;
    await h.event('command.run', { command: 'router', args: `pin ${tier}` });
    await h.event('turn.start', { turnId, text: 'Synthetic fixture.' });
    const route = profile.routes[tier];
    const model = profile.models[route.model].id;
    await drain(
      h.step(
        { ...step, turnId, model: 'deepseek-flash[1m]', effort: 'high', messageCount: 1 + index * 2 },
        {
          usage: {
            model: model.replace('[1m]', ''),
            input_tokens: 100,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
            output_tokens: 10,
          },
        },
      ),
    );
    assert.equal(h.requests.at(-1).model, model);
    assert.equal(h.requests.at(-1).effort, route.effort);
    assert.notEqual(h.loop().suspended, true);
    await h.event('turn.complete', { turnId });
  }
  await h.event('command.run', { command: 'router', args: 'activities on' });
  assert.equal(loadConfig({ provider: 'model-proxy', userFile: JSON.parse(h.files.get(path)) }).activityRouting, 'on');
  assert.equal(h.files.get('/fixture/team/router.json'), '{"classifier":"ollama"}');
  assert.equal(h.env.get('ANTHROPIC_BASE_URL'), 'http://127.0.0.1:43172');
});

test('a missing or malformed model-proxy profile never falls back to Anthropic defaults', async () => {
  for (const content of [null, '{', '{}']) {
    const h = harness();
    h.env.set('CLAUDE_ROUTER_PROVIDER', 'model-proxy');
    h.model('deepseek-flash[1m]');
    h.files.set('/fixture/team/router.json', '{}');
    if (content !== null) h.files.set('/fixture/team/model-proxy-router.json', content);
    await start(h);
    assert.equal(h.view().phase, 'unavailable');
    await drain(h.step({ ...step, model: 'deepseek-flash[1m]' }));
    assert.equal(h.requests[0].model, 'deepseek-flash[1m]');
  }
});

test('documented model-proxy profile matches the tested complete profile', () => {
  const guide = readFileSync(new URL('../docs/providers.md', import.meta.url), 'utf8');
  const section = guide.split('## Mix Anthropic and DeepSeek with model-proxy')[1];
  const json = /```json\n([\s\S]*?)\n```/.exec(section)?.[1];
  assert.ok(json);
  assert.deepEqual(JSON.parse(json), profile);
});

test('model-proxy automatic advice can move between DeepSeek and Opus', async () => {
  for (const [choice, native, expected] of [
    ['medium', 'claude-opus-5-5', 'deepseek-flash[1m]'],
    ['high', 'deepseek-flash[1m]', 'claude-opus-5-5'],
  ]) {
    const h = harness(JEV_KEY);
    h.env.set('CLAUDE_ROUTER_PROVIDER', 'model-proxy');
    h.env.set('ANTHROPIC_BASE_URL', 'http://127.0.0.1:43172');
    h.files.set('/fixture/team/model-proxy-router.json', JSON.stringify(profile));
    h.model(native);
    const advice = answering(h, jevResponse(choice, { [choice]: 1 }));
    await start(h);
    await drain(h.step({ ...step, model: native, effort: 'high' }));
    assert.equal(advice.length, 1);
    assert.equal(h.requests[0].model, expected);
  }
});
