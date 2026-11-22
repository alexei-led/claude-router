import assert from 'node:assert/strict';
import test from 'node:test';
import { autoCatalogKey } from '../lib/auto-route.mjs';
import { loadConfig } from '../lib/config.mjs';
import { readDecisions } from '../lib/decisions.mjs';
import { answering, CONFIG, drain, harness, JEV_KEY, start, step } from './harness.mjs';
import { assistant, jevResponse, toolResult, user } from './helpers.mjs';

function setup(config = {}) {
  const h = harness(JEV_KEY);
  h.files.set(
    CONFIG,
    JSON.stringify({
      routingEngine: 'auto',
      models: {
        haiku: { capability: { low: 0, medium: 1, high: 1.5, xhigh: 2, max: 2 } },
        sonnet: { capability: { low: 1, medium: 2, high: 2.5, xhigh: 2.5, max: 2.5 } },
        opus: { capability: { low: 2, medium: 2.5, high: 2.5, xhigh: 3, max: 3 } },
        fable: { capability: { low: 3, medium: 3, high: 3, xhigh: 3, max: 3 } },
      },
      policy: { reviewEveryRequests: 0 },
      ...config,
    }),
  );
  answering(h, jevResponse('high', { high: 1 }, 0, { code: 1 }, 'produce'));
  return h;
}

test('fresh auto sessions start on for catalog-only models and off for models outside the catalog', async () => {
  for (const [model, expected] of [
    ['claude-fable-5-2', 'auto'],
    ['claude-unknown-99', 'manual'],
  ]) {
    const h = setup();
    h.model(model);
    await start(h);
    assert.equal(h.view().mode, expected);
  }
});

test('lazy turn.start loads validated profile and project mode before freezing automatic config', async () => {
  const h = setup({ mode: 'cost' });
  h.files.set('/fixture/project/.claude/router.json', JSON.stringify({ mode: 'quality' }));
  answering(h, jevResponse('medium', { medium: 1 }));
  await h.event('turn.start', { turnId: step.turnId, text: 'Synthetic task' });
  await drain(h.step(step));
  assert.deepEqual(h.view().routingMode, { mode: 'quality', source: 'project' });
  assert.equal(h.loop().activeEngine, 'auto');
  assert.equal(h.loop().decision.auto.requirement, 2.5);
  assert.equal(h.loop().decision.auto.demand, 2);
});

test('native custom catalog alias below requirement uses first-routed startup evidence', async () => {
  for (const strong of [true, false]) {
    const h = setup({
      models: {
        'modèle / local': {
          id: 'org/custom-model',
          input: 1,
          cacheRead: 0.1,
          output: 1,
          contextWindow: 1000000,
          billing: 'plan',
          efforts: ['low', 'high'],
          capability: { low: 0, high: 2 },
        },
      },
    });
    h.model('org/custom-model');
    h.settings({ availableModels: ['org/custom-model'] });
    answering(
      h,
      jevResponse('low', strong ? { micro: 0.2, low: 0.57, medium: 0.13, high: 0.1 } : { micro: 0.43, low: 0.57 }),
    );
    await start(h);
    await drain(h.step({ ...step, model: 'org/custom-model', effort: 'low' }));
    assert.equal(h.requests[0].effort, 'high');
    assert.equal(h.loop().auto.incumbent.model, 'modèle / local');
    assert.equal(h.loop().auto.state.demand, 1);
    assert.equal(h.loop().auto.state.routedDemand, 1);
    assert.equal(h.loop().decision.reason, 'startup');
  }
});

test('lazy initialization failure stays unavailable/native without resetting persisted auto to default table', async () => {
  const h = setup();
  await start(h);
  await drain(h.step(step));
  const previous = structuredClone(h.loop());
  for (const file of ['{', JSON.stringify({ routingEngine: 'invalid' }), null]) {
    const reloaded = harness(JEV_KEY, h.preferences, new Map(h.state));
    if (file === null) reloaded.env.set('CLAUDE_ROUTER_PROVIDER', 'deepseek');
    else reloaded.files.set(CONFIG, file);
    const native = { ...step, index: 1 };
    await drain(reloaded.step(native));
    assert.deepEqual(reloaded.requests[0], native);
    assert.equal(reloaded.view().phase, 'unavailable');
    assert.equal(
      reloaded.view().error,
      file === null ? 'selected provider router file is missing' : 'invalid router configuration',
    );
    assert.deepEqual(reloaded.loop(), previous);
  }
});

test('Mod reload without session.start loads the auto profile before continuation and next turn', async () => {
  const h = harness(JEV_KEY);
  h.env.set('CLAUDE_ROUTER_PROVIDER', 'deepseek');
  h.model('deepseek-flash[1m]');
  h.files.set(
    '/fixture/team/deepseek-router.json',
    JSON.stringify({
      routingEngine: 'auto',
      models: { flash: { capability: { low: 0, high: 2, max: 3 } } },
      policy: { reviewEveryRequests: 0 },
    }),
  );
  answering(h, jevResponse('low', { micro: 0.2, low: 0.57, medium: 0.13, high: 0.1 }));
  await start(h);
  const native = { ...step, model: 'deepseek-flash[1m]', effort: 'low' };
  await drain(h.step(native));
  assert.equal(h.requests[0].effort, 'high');
  const previous = structuredClone(h.loop().auto.state);
  const reloaded = harness(JEV_KEY, h.preferences, h.state);
  for (const [path, content] of h.files) reloaded.files.set(path, content);
  reloaded.env.set('CLAUDE_ROUTER_PROVIDER', 'deepseek');
  reloaded.model('deepseek-flash[1m]');
  answering(reloaded, jevResponse('low', { low: 1 }));
  await drain(reloaded.step({ ...native, index: 1 }));
  assert.deepEqual(reloaded.requests[0], { ...native, index: 1, effort: 'high' });
  assert.equal(reloaded.loop().activeEngine, 'auto');
  assert.deepEqual(reloaded.loop().auto.state, previous);
  await reloaded.event('turn.complete', { turnId: step.turnId });
  await reloaded.event('turn.start', { turnId: 'next', text: 'Next task' });
  await drain(reloaded.step({ ...native, turnId: 'next' }));
  await reloaded.event('turn.complete', { turnId: 'next' });
  assert.equal(reloaded.requests[1].effort, 'high');
  const rows = readDecisions(reloaded.preferences.get('decisions:v1:s1')).rows.filter((row) => row.kind !== 'end');
  assert.ok(rows.length);
  for (const row of rows) {
    assert.equal(row.engine, 'auto');
    assert.ok(row.auto);
  }
});

test('session reload fences an in-flight table answer before a new automatic decision', async () => {
  const h = setup({ routingEngine: 'table', routes: { high: { model: 'haiku', effort: 'low' } } });
  let release;
  h.http(
    () =>
      new Promise((resolve) => {
        release = () =>
          resolve({ ok: true, status: 200, headers: {}, text: JSON.stringify(jevResponse('high', { high: 1 })) });
      }),
  );
  await start(h);
  const stream = h.step(step);
  const pending = stream.next();
  await tick();
  assert.ok(release);
  patch(h, (c) => {
    c.routingEngine = 'auto';
  });
  await reload(h);
  release();
  await tick();
  await pending;
  await drain(stream);
  assert.deepEqual(h.requests[0], step);
  answering(h, jevResponse('high', { high: 1 }));
  await drain(h.step({ ...step, index: 1 }));
  assert.equal(h.requests[1].model, 'claude-opus-5-5');
  assert.equal(h.requests[1].effort, 'xhigh');
  await h.event('turn.complete', { turnId: step.turnId });
  const rows = readDecisions(h.preferences.get('decisions:v1:s1')).rows.filter((row) => row.kind !== 'end');
  assert.ok(rows.length);
  for (const row of rows) {
    assert.equal(row.engine, 'auto');
    assert.ok(row.auto);
  }
});

test('same-turn config reload into auto cannot retain a table route or table-shaped decision row', async () => {
  const h = setup({ routingEngine: 'table', routes: { high: { model: 'haiku', effort: 'low' } } });
  await start(h);
  await drain(h.step(step));
  assert.equal(h.requests[0].model, 'claude-haiku-5-5');
  patch(h, (c) => {
    c.routingEngine = 'auto';
  });
  await reload(h);
  await drain(h.step({ ...step, index: 1 }));
  assert.equal(h.requests[1].model, 'claude-opus-5-5');
  assert.equal(h.requests[1].effort, 'xhigh');
  assert.equal(h.loop().activeEngine, 'auto');
  assert.ok(h.loop().decision.auto);
  await h.event('turn.complete', { turnId: step.turnId });
  const rows = readDecisions(h.preferences.get('decisions:v1:s1')).rows;
  const after = rows.filter((row) => row.kind !== 'end');
  assert.ok(after.length);
  assert.equal(after.at(-1).engine, 'auto');
  assert.ok(after.at(-1).auto);
});

test('auto opt-in sends the catalog target model and effort, not the high route table', async () => {
  const h = setup({ routes: { high: { model: 'haiku', effort: 'low' } } });
  await start(h);
  await drain(h.step(step));
  assert.equal(h.view().phase, 'routed');
  assert.equal(h.requests[0].model, 'claude-opus-5-5');
  assert.equal(h.requests[0].effort, 'xhigh');
  assert.equal(h.loop().auto.state.demand, 3);
  assert.equal(h.loop().auto.state.routedDemand, 3);
  const rows = await h.event('command.run', { command: 'router', args: 'decisions' });
  assert.match(rows.text, /demand 3.*target.*move/);
});

// A catalog that declares no capability anywhere cannot rank candidates: every selection lands in the
// unknown-only pool, cheapest first (2026-11-22-auto-holds-design.md). The session says so once, not silently.
test('a catalog with no declared capability warns once that auto falls back to the cheapest', async () => {
  const h = setup({
    models: {
      haiku: { capability: {} },
      sonnet: { capability: {} },
      opus: { capability: {} },
      fable: { capability: {} },
    },
  });
  await start(h);
  await drain(h.step(step));
  assert.equal(h.loop().decision.auto.outcome, 'unknown-only');
  assert.deepEqual(h.toasts, [
    'Auto cannot rank models: declare models.<alias>.capability; selection falls back to cheapest.',
  ]);
  await h.event('turn.start', { turnId: 't2', text: 'Second task.' });
  await drain(h.step({ ...step, turnId: 't2' }));
  assert.equal(h.toasts.length, 1);
});

test('auto decision rows retain bounded catalog aliases with spaces, Unicode and slash, but reject controls', async () => {
  for (const alias of ['modèle / local', 'bad\nline', 'bad\u202eline', 'x'.repeat(65), '😀'.repeat(33)]) {
    const h = setup();
    patch(h, (c) => {
      for (const model of Object.values(c.models)) model.capability = {};
      c.models[alias] = {
        id: 'custom-model',
        input: 1,
        output: 1,
        cacheRead: 0.1,
        contextWindow: 1_000_000,
        billing: 'plan',
        efforts: ['high'],
        capability: { high: 3 },
      };
    });
    await start(h);
    await command(h, 'pin high');
    await drain(h.step(step));
    assert.equal(h.requests[0].model, 'custom-model');
    await h.event('turn.complete', { turnId: step.turnId });
    const stored = readDecisions(h.preferences.get('decisions:v1:s1'));
    assert.equal(stored.rows[0].auto.route, alias === 'modèle / local' ? `${alias}@high` : null);
    const output = await command(h, 'decisions');
    if (alias === 'modèle / local') assert.match(output.text, /target modèle \/ local@high/);
    assert.equal(output.text.includes('bad\nline'), false);
  }
});

test('auto no eligible route passes the original native request with explicit reason', async () => {
  const h = setup();
  h.settings({ availableModels: [] });
  await start(h);
  for (const effort of ['high', 17]) {
    const native = { ...step, effort, turnId: `native-${effort}` };
    await drain(h.step(native));
    assert.deepEqual(h.requests.at(-1), native);
    assert.equal(h.loop().decision.effort, effort);
  }
  assert.equal(h.view().reason, 'no-route-native');
  assert.equal(h.loop().decision.route, null);
});

test('real resolved warm cache bypasses cold-write cap; cold candidates never come back through pins', async () => {
  const h = setup();
  patch(h, (c) => {
    for (const spec of Object.values(c.models)) {
      spec.input = 1000;
      spec.billing = 'credits';
    }
    c.models.haiku.id = 'claude-haiku-4-5';
    c.models.haiku.efforts = [];
    c.models.haiku.capability = { default: 1 };
  });
  h.model('claude-haiku-4-5');
  await start(h);
  const native = { ...step, model: 'claude-haiku-4-5', effort: null };
  await drain(
    h.step(native, {
      usage: {
        model: 'claude-haiku-4-5-20251001',
        input_tokens: 100,
        cache_read_input_tokens: 8000,
        cache_creation_input_tokens: 1000,
        output_tokens: 10,
      },
    }),
  );
  assert.equal(h.view().reason, 'no-route-native');
  assert.ok(h.loop().models['claude-haiku-4-5-20251001']);
  await command(h, 'pin high');
  await h.event('turn.start', { turnId: 'warm', text: 'Next task.' });
  await drain(h.step({ ...native, turnId: 'warm' }));
  assert.equal(h.loop().decision.auto.outcome, 'declared-below-demand');
  assert.equal(h.loop().decision.model, 'claude-haiku-4-5');
  assert.equal(h.loop().decision.effort, null);
  assert.equal(h.loop().decision.auto.capability, 1);
  assert.ok(h.loop().decision.auto.maxUsd < 2);
});

test('native numeric effort and equal-cost canonical incumbent are not clamped', async () => {
  const h = setup();
  patch(h, (c) => {
    for (const spec of Object.values(c.models)) spec.capability = {};
  });
  await start(h);
  await drain(h.step({ ...step, effort: 17 }));
  assert.equal(h.requests[0].effort, 17);
  assert.equal(h.loop().decision.auto.capability, null);
  await drain(h.step({ ...step, index: 1, effort: 17 }));
  assert.equal(h.requests[1].effort, 17);
});

const command = (h, args) => h.event('command.run', { command: 'router', args });
const low = jevResponse('low', { low: 1 }, 0, { code: 1 }, 'produce');
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function nextTurn(h, turnId, messages = [user('Next task.')], response = {}) {
  await h.event('turn.start', { turnId, text: 'Next task.' });
  h.messages(async () => messages);
  await drain(h.step({ ...step, turnId, messageCount: messages.length }, response));
}
function patch(h, update) {
  const config = JSON.parse(h.files.get(CONFIG));
  update(config);
  h.files.set(CONFIG, JSON.stringify(config));
}
async function reload(h) {
  await h.event('session.start', { cwd: '/fixture' });
}

test('mode changes only auto requirement, never table routes or policy patches', async () => {
  const h = setup({ mode: 'cost' });
  answering(h, jevResponse('medium', { medium: 1 }, 0, { code: 1 }, 'produce'));
  await start(h);
  await drain(h.step(step));
  assert.equal(h.loop().decision.auto.requirement, 1.5);
  assert.equal(h.requests[0].effort, 'high');
  const demand = h.loop().auto.state.demand;
  await command(h, 'mode quality');
  await nextTurn(h, 't2');
  assert.equal(h.loop().decision.auto.requirement, 2.5);
  assert.equal(h.loop().auto.state.demand, demand);
  assert.equal(h.loop().decision.reason, 'explicit-up');
  assert.equal(h.loop().auto.state.routeCause, 'mode');
});

test('catalog identity reflects actual allowed native defaults but not allowlist spelling or order', () => {
  const config = loadConfig({ routingEngine: 'auto' });
  const nativeModel = config.models.haiku.id;
  const first = autoCatalogKey(config, { availableModels: ['haiku', 'opus'], nativeModel });
  assert.equal(autoCatalogKey(config, { availableModels: ['opus', 'haiku', 'haiku', 'unlisted'], nativeModel }), first);
  assert.notEqual(autoCatalogKey(config, { availableModels: ['haiku'], nativeModel }), first);
  assert.notEqual(
    autoCatalogKey(config, { availableModels: ['default'], nativeModel }),
    autoCatalogKey(config, { availableModels: ['default'], nativeModel: config.models.opus.id }),
  );
  const resolved = { ...config.models, haiku: { ...config.models.haiku, id: `${nativeModel}-20260101` } };
  assert.equal(autoCatalogKey(config, { availableModels: ['haiku', 'opus'], nativeModel, models: resolved }), first);
});

test('an explicit allowlist expansion supplies catalog evidence at unchanged routed demand', async () => {
  const h = setup();
  h.settings({ availableModels: ['haiku'] });
  await start(h);
  await drain(h.step(step));
  assert.equal(h.loop().decision.auto.outcome, 'declared-below-demand');
  assert.equal(h.loop().auto.state.demand, 3);
  assert.equal(h.loop().auto.state.routedDemand, 3);
  const previous = structuredClone(h.loop().auto.state);
  h.settings({ availableModels: ['haiku', 'opus'] });
  await nextTurn(h, 'expanded');
  assert.equal(h.loop().decision.reason, 'explicit-up');
  assert.equal(h.requests.at(-1).model, 'claude-opus-5-5');
  assert.equal(h.loop().auto.state.routeCause, 'catalog');
  assert.equal(h.loop().auto.state.demand, previous.demand);
  assert.equal(h.loop().auto.state.routedDemand, previous.routedDemand);
  assert.deepEqual(h.loop().auto.state.votes, [3, 3]);
  assert.equal(h.loop().auto.state.holdUntilTurn, previous.holdUntilTurn);
});

test('allowlist expansion cannot relabel a pending classifier upgrade as catalog evidence', async () => {
  const h = setup();
  h.settings({ availableModels: ['haiku', 'opus'] });
  h.usage({ context: { tokens: 600_000, breakdown: { totalTokens: 600_000 } }, rateLimits: [] });
  answering(h, jevResponse('high', { high: 0.8, uncertain: 0.2 }, 0, { code: 1 }, 'produce'));
  await start(h);
  await h.event('command.run', { command: 'router', args: 'pin low' });
  await drain(h.step(step));
  await nextTurn(h, 'vote');
  await nextTurn(h, 'first-unpinned');
  assert.equal(h.loop().decision.reason, 'upgrade-pending');
  const routed = h.loop().auto.state.routedDemand;
  assert.equal(h.loop().auto.state.demand, 3);
  assert.ok(routed < 3);
  h.settings({ availableModels: ['haiku', 'opus', 'fable'] });
  await nextTurn(h, 'expanded-but-held');
  assert.equal(h.loop().decision.reason, 'upgrade-pending');
  assert.equal(h.loop().auto.state.routedDemand, routed);
  assert.equal(h.loop().auto.state.routeCause, 'classifier');
  assert.equal(h.requests.at(-1).model, step.model);
});

test('each tier pin is exact demand without quality margin and restores the normal route/state/switch', async () => {
  for (const [tier, demand] of ['micro', 'low', 'medium', 'high'].map((tier, i) => [tier, i])) {
    const h = setup({ mode: 'quality' });
    answering(h, low);
    await start(h);
    await drain(h.step(step));
    const normal = structuredClone(h.loop().auto);
    const switchedAt = h.loop().switchedAt;
    const servedRoute = h.loop().servedRoute;
    await command(h, `pin ${tier}`);
    await nextTurn(h, 'pinned');
    assert.equal(h.loop().decision.auto.requirement, demand, tier);
    assert.equal(h.loop().decision.auto.demand, demand, tier);
    assert.equal(h.loop().decision.reason, 'pinned', tier);
    assert.deepEqual(h.loop().auto.state, normal.state, tier);
    assert.deepEqual(h.loop().switchedAt, switchedAt, tier);
    assert.equal(h.loop().servedRoute, servedRoute, tier);
    await drain(h.step({ ...step, turnId: 'pinned', index: 1 }));
    assert.deepEqual(h.loop().auto.state, normal.state, tier);
    await nextTurn(h, 'restored');
    assert.deepEqual(h.loop().auto.incumbent, normal.incumbent, tier);
    assert.deepEqual(h.loop().switchedAt, switchedAt, tier);
    assert.equal(h.loop().auto.savedPin, null);
  }
});

test('every continuation refits context, images and provider availability, including pins', async () => {
  for (const constraint of ['context', 'images', 'availability'])
    for (const pinned of [false, true]) {
      const h = setup();
      patch(h, (c) => {
        c.models.haiku.contextWindow = 20000;
        c.models.haiku.imageInput = false;
      });
      answering(h, low);
      h.usage({ context: { tokens: 1000, breakdown: { totalTokens: 1000 } }, rateLimits: [] });
      await start(h);
      if (pinned) await command(h, 'pin low');
      await drain(h.step(step));
      assert.equal(h.requests[0].model, step.model);
      const state = h.loop().auto.state;
      if (constraint === 'context')
        h.usage({ context: { tokens: 50000, breakdown: { totalTokens: 50000 } }, rateLimits: [] });
      if (constraint === 'images')
        h.messages(async () => [user('Look'), { role: 'user', content: [{ type: 'image' }] }]);
      if (constraint === 'availability') h.settings({ availableModels: ['sonnet'] });
      await drain(h.step({ ...step, index: 1, messageCount: constraint === 'images' ? 2 : 1 }));
      assert.equal(h.requests[1].model, 'claude-sonnet-5-5', `${constraint}/${pinned}`);
      assert.equal(h.loop().decision.reason, pinned ? 'pinned' : 'forced');
      assert.deepEqual(h.loop().auto.state.votes, state.votes);
      assert.equal(h.loop().auto.state.turn, state.turn);
    }
});

test('pinned no-route consumes the pin once and suspends the rest of its turn', async () => {
  const h = setup();
  await start(h);
  await command(h, 'pin high');
  h.settings({ availableModels: [] });
  await drain(h.step(step));
  assert.deepEqual(h.requests[0], step);
  assert.equal(h.view().pendingPin, null);
  assert.equal(h.view().reason, 'no-route-native');
  h.settings({ availableModels: ['sonnet'] });
  await drain(h.step({ ...step, index: 1 }));
  assert.deepEqual(h.requests[1], { ...step, index: 1 });
  assert.equal(h.loop().auto.state.turn, 0);
  assert.equal(h.loop().auto.fallback.incumbentOrigin, 'external-fallback');
  await nextTurn(h, 'unpinned');
  assert.equal(h.requests.at(-1).model, 'claude-sonnet-5-5');
  assert.equal(h.loop().decision.reason, 'reentry');
});

test('no-route native response preserves demand and reenters immediately when eligibility returns', async () => {
  const h = setup();
  await start(h);
  await drain(h.step(step));
  assert.equal(h.loop().auto.incumbent.model, 'opus');
  const demand = structuredClone(h.loop().auto.state);
  h.settings({ availableModels: [] });
  await h.event('turn.start', { turnId: 'native-only', text: 'Continue.' });
  const native = { ...step, turnId: 'native-only', model: 'claude-sonnet-5-5', effort: 'medium' };
  await drain(h.step(native));
  assert.deepEqual(h.requests.at(-1), native);
  assert.equal(h.loop().decision.reason, 'no-route-native');
  assert.equal(h.loop().lastRequest.model, native.model);
  assert.equal(h.loop().servedRoute, 'claude-sonnet-5-5@medium');
  assert.equal(h.loop().models['claude-sonnet-5-5'].prefixTokens, 1000);
  assert.equal(h.loop().models['claude-opus-5-5'].prefixTokens, 1000);
  const fallbackDemand = structuredClone(h.loop().auto.state);
  for (const field of ['demand', 'routedDemand', 'routeCause', 'holdUntilTurn', 'headroom'])
    assert.equal(fallbackDemand[field], demand[field], field);
  assert.deepEqual(h.loop().auto.incumbent, { model: 'sonnet', effort: 'medium' });
  assert.equal(h.loop().auto.incumbentOrigin, 'external-fallback');
  h.settings({ availableModels: ['sonnet', 'opus'] });
  const continued = { ...native, index: 1 };
  await drain(h.step(continued));
  assert.deepEqual(h.requests.at(-1), continued);
  assert.equal(h.view().reason, 'native-fallback');
  await nextTurn(h, 'eligible-again');
  assert.deepEqual(h.loop().auto.incumbent, { model: 'opus', effort: 'xhigh' });
  assert.equal(h.requests.at(-1).model, 'claude-opus-5-5');
  assert.equal(h.loop().decision.reason, 'reentry');
  assert.equal(h.loop().auto.state.routeCause, 'reentry');
  assert.equal(h.loop().auto.incumbentOrigin, null);
  for (const field of ['demand', 'routedDemand', 'holdUntilTurn', 'headroom'])
    assert.equal(h.loop().auto.state[field], fallbackDemand[field], field);
  assert.deepEqual(h.loop().auto.state.votes, fallbackDemand.votes);
  assert.ok(h.loop().decision.auto.maxUsd > 0);
});

test('external reentry preserves escalation hold and does not count the fallback as a policy move', async () => {
  const h = setup({ baselineTier: 'medium' });
  answering(h, jevResponse('medium', { medium: 1 }, 0, { code: 1 }, 'produce'));
  h.model('claude-opus-5-5');
  await start(h);
  await drain(h.step({ ...step, model: 'claude-opus-5-5', effort: 'medium' }));
  const failure = [
    user('fix'),
    assistant('running', ['Bash']),
    toolResult('error: test_login failed', { isError: true }),
    assistant('edit', ['Edit']),
    toolResult('ok'),
    assistant('running again', ['Bash']),
    toolResult('error: test_login failed', { isError: true }),
  ];
  await nextTurn(h, 'failed', failure);
  const hold = h.loop().auto.state.holdUntilTurn;
  assert.ok(hold > h.loop().auto.state.turn);
  h.settings({ availableModels: [] });
  await nextTurn(h, 'external', failure);
  assert.equal(h.loop().auto.state.routeCause, 'escalation');
  assert.equal(h.loop().auto.incumbentOrigin, 'external-fallback');
  h.settings({ availableModels: ['opus'] });
  await nextTurn(h, 'reentry', failure);
  assert.equal(h.loop().decision.reason, 'reentry');
  assert.equal(h.loop().auto.state.holdUntilTurn, hold);
  assert.equal(h.loop().auto.state.routeCause, 'reentry');
  assert.equal(h.loop().auto.state.routedDemand, h.loop().decision.auto.demand);
});

test('equal native target adopts demand and clears external origin; no-route preserves both', async () => {
  for (const eligible of [true, false]) {
    const h = setup({ baselineTier: 'high' });
    patch(h, (c) => {
      c.models.haiku.efforts = ['medium'];
      c.models.haiku.capability = { medium: 3 };
    });
    answering(h, low);
    await start(h);
    h.settings({ availableModels: [] });
    await drain(h.step(step));
    assert.equal(h.loop().auto.incumbentOrigin, 'external-fallback');
    const previous = structuredClone(h.loop());
    assert.notEqual(previous.auto.state.routedDemand, previous.auto.state.demand);
    h.settings({ availableModels: eligible ? ['haiku'] : [] });
    await nextTurn(h, 'retry');
    assert.equal(h.loop().decision.reason, eligible ? 'same-route' : 'no-route-native');
    assert.equal(h.loop().auto.incumbentOrigin, eligible ? null : 'external-fallback');
    assert.equal(
      h.loop().auto.state.routedDemand,
      eligible ? h.loop().decision.auto.demand : previous.auto.state.routedDemand,
    );
    assert.equal(h.loop().auto.state.routeCause, previous.auto.state.routeCause);
    assert.equal(h.loop().auto.state.holdUntilTurn, previous.auto.state.holdUntilTurn);
    assert.deepEqual(h.loop().switchedAt, previous.switchedAt);
    assert.equal(h.requests.at(-1).model, step.model);
  }
});

test('substituted response rebases external model with unknown effort and suspends its turn', async () => {
  const h = setup();
  await start(h);
  await drain(
    h.step(step, {
      usage: {
        model: 'claude-sonnet-5-5',
        input_tokens: 100,
        cache_read_input_tokens: 800,
        cache_creation_input_tokens: 200,
        output_tokens: 10,
      },
    }),
  );
  assert.deepEqual(h.loop().auto.incumbent, { model: 'sonnet', effort: null });
  assert.equal(h.loop().auto.incumbentOrigin, 'external-fallback');
  assert.equal(h.loop().models['claude-sonnet-5-5'], undefined);
  const incoming = { ...step, index: 1, model: 'claude-sonnet-5-5', effort: 23 };
  await drain(h.step(incoming));
  assert.deepEqual(h.requests.at(-1), incoming);
  await nextTurn(h, 'next-turn');
  assert.equal(h.loop().decision.reason, 'reentry');
  assert.equal(h.requests.at(-1).model, 'claude-opus-5-5');
});

test('reentry never bypasses a cold cash cap', async () => {
  const h = setup();
  patch(h, (c) => {
    for (const model of Object.values(c.models)) {
      model.input = 1000;
      model.billing = 'credits';
    }
  });
  await start(h);
  await drain(h.step(step, { usage: null }));
  assert.equal(h.loop().decision.reason, 'no-route-native');
  await nextTurn(h, 'retry', [user('Continue.')], { usage: null });
  assert.equal(h.loop().decision.reason, 'no-route-native');
  assert.equal(h.loop().auto.incumbentOrigin, 'external-fallback');
});

test('in-flight auto fallback keeps its frozen engine and cache semantics across profile saves', async () => {
  const h = setup();
  await start(h);
  await drain(h.step(step));
  h.settings({ availableModels: [] });
  await h.event('turn.start', { turnId: 'paused-native', text: 'Continue.' });
  const native = { ...step, turnId: 'paused-native', model: 'claude-sonnet-5-5', effort: 'medium' };
  const stream = h.step(native);
  assert.equal((await stream.next()).done, false);
  patch(h, (c) => {
    c.routingEngine = 'table';
    c.cache = { effortScope: 'separate' };
  });
  await command(h, 'activities off');
  assert.equal((await stream.next()).done, true);
  assert.equal(h.loop().auto.incumbentOrigin, 'external-fallback');
  assert.deepEqual(h.loop().auto.incumbent, { model: 'sonnet', effort: 'medium' });
  assert.ok(h.loop().models['claude-sonnet-5-5']);
  assert.equal(h.loop().models['claude-sonnet-5-5@medium'], undefined);
  patch(h, (c) => {
    c.routingEngine = 'auto';
    delete c.cache;
  });
  await command(h, 'activities on');
  h.settings({ availableModels: ['sonnet', 'opus'] });
  await nextTurn(h, 'reentry-after-save');
  assert.equal(h.loop().decision.reason, 'reentry');
  assert.equal(h.requests.at(-1).model, 'claude-opus-5-5');
});

test('manual interval fences an in-flight frozen auto response after the profile switches to table', async () => {
  const h = setup();
  await start(h);
  await drain(h.step(step));
  h.settings({ availableModels: [] });
  await h.event('turn.start', { turnId: 'paused-off', text: 'Continue.' });
  const native = { ...step, turnId: 'paused-off' };
  const stream = h.step(native);
  assert.equal((await stream.next()).done, false);
  patch(h, (c) => {
    c.routingEngine = 'table';
  });
  await command(h, 'activities off');
  await command(h, 'off');
  assert.equal(h.loop().auto, null);
  assert.equal((await stream.next()).done, true);
  assert.equal(h.loop().auto, null);
  await command(h, 'auto');
  patch(h, (c) => {
    c.routingEngine = 'auto';
  });
  await command(h, 'activities on');
  h.settings({});
  answering(h, low);
  await nextTurn(h, 'fresh-after-off');
  assert.equal(h.loop().auto.state.turn, 1);
  assert.equal(h.loop().auto.state.demand, 1);
  assert.deepEqual(h.loop().auto.state.votes, [1]);
});

test('usage-read failure retains the measured context lower bound for listed and unlisted native models', async () => {
  for (const unlisted of [false, true]) {
    const h = setup();
    const native = unlisted ? { ...step, model: 'claude-unknown-99', effort: 17 } : step;
    if (unlisted) {
      h.model(native.model);
      patch(h, (c) => {
        for (const model of Object.values(c.models)) model.contextWindow = 200_000;
      });
    }
    await start(h);
    await drain(
      h.step(native, {
        usage: {
          model: unlisted ? native.model : 'claude-opus-5-5',
          input_tokens: 1000,
          cache_read_input_tokens: 899_000,
          cache_creation_input_tokens: 0,
          output_tokens: 1000,
        },
      }),
    );
    assert.equal(h.loop().lastRequest.tokens, 900_000);
    h.$.session.usage = async () => {
      throw new Error('usage unavailable');
    };
    if (unlisted) await command(h, 'auto');
    await h.event('turn.start', { turnId: 'oversized', text: 'Continue.' });
    const incoming = { ...native, turnId: 'oversized' };
    await drain(h.step(incoming));
    assert.deepEqual(h.requests.at(-1), incoming);
    assert.equal(h.loop().decision.reason, 'no-route-native');
    assert.equal(h.loop().decision.route, null);
  }
});

test('context-window failure excludes the served model and refits the next continuation', async () => {
  const h = setup();
  await start(h);
  await drain(h.step(step, { usage: null, stopReason: 'model_context_window_exceeded' }));
  assert.ok(h.loop().ineligible.includes('claude-opus-5-5'));
  await drain(h.step({ ...step, index: 1 }));
  assert.notEqual(h.requests[1].model, 'claude-opus-5-5');
  assert.equal(h.loop().decision.reason, 'forced');
});

test('native fallback and manual exact model/effort remain outside auto selection', async () => {
  const h = setup();
  await start(h);
  await drain(h.step(step, { usage: null, stopReason: null }));
  const fallback = { ...step, index: 1, model: 'claude-sonnet-5-5', effort: 17 };
  await drain(h.step(fallback));
  assert.deepEqual(h.requests[1], fallback);
  assert.equal(h.view().reason, 'native-fallback');
  await h.event('command.run', { command: 'model', origin: { kind: 'user' }, args: 'sonnet' });
  const manual = { ...fallback, turnId: 'manual', index: 0 };
  await drain(h.step(manual));
  assert.deepEqual(h.requests[2], manual);
  assert.equal(h.loop().auto, null);
});

test('failure occurrences escalate strictly stronger and do not repeat for the same index', async () => {
  const h = setup({ baselineTier: 'medium' });
  answering(h, jevResponse('medium', { medium: 1 }, 0, { code: 1 }, 'produce'));
  h.model('claude-opus-5-5');
  h.settings({ availableModels: ['opus'] });
  await start(h);
  await drain(h.step({ ...step, model: 'claude-opus-5-5', effort: 'medium' }));
  assert.equal(h.requests[0].effort, 'medium');
  const failure = [
    user('fix'),
    assistant('running', ['Bash']),
    toolResult('error: test_login failed', { isError: true }),
    assistant('editing', ['Edit']),
    toolResult('ok'),
    assistant('running again', ['Bash']),
    toolResult('error: test_login failed', { isError: true }),
  ];
  await nextTurn(h, 'failed', failure);
  assert.equal(h.requests.at(-1).model, 'claude-opus-5-5');
  assert.equal(h.requests.at(-1).effort, 'xhigh');
  assert.equal(h.loop().decision.reason, 'escalation');
  const index = h.loop().auto.state.escalatedIndex;
  await nextTurn(h, 'same-failure', failure);
  assert.equal(h.loop().auto.state.escalatedIndex, index);
  assert.equal(h.loop().decision.escalated, false);
  await nextTurn(h, 'new-failure', [
    ...failure,
    assistant('edit', ['Edit']),
    toolResult('ok'),
    assistant('running again', ['Bash']),
    toolResult('error: test_login failed', { isError: true }),
  ]);
  assert.ok(h.loop().auto.state.escalatedIndex > index);
  assert.equal(h.loop().decision.reason, 'escalation-exhausted');
  assert.equal(h.loop().auto.state.headroom, true);
});

test('exhausted headroom counts only a fresh failure or a later actual escalation', async () => {
  const h = setup({ baselineTier: 'high' });
  patch(h, (c) => {
    c.models.opus.capability.xhigh = 2.5;
    c.models.opus.capability.max = 2.5;
  });
  h.model('claude-opus-5-5');
  h.settings({ availableModels: ['opus'] });
  await start(h);
  await drain(h.step({ ...step, model: 'claude-opus-5-5', effort: 'xhigh' }));
  const failure = [
    user('fix'),
    assistant('running', ['Bash']),
    toolResult('error: test_login failed', { isError: true }),
    assistant('editing', ['Edit']),
    toolResult('ok'),
    assistant('running again', ['Bash']),
    toolResult('error: test_login failed', { isError: true }),
  ];
  await nextTurn(h, 'first-failure', failure);
  assert.equal(h.loop().decision.reason, 'escalation-exhausted');
  assert.equal(h.loop().decision.escalated, true);
  const index = h.loop().auto.state.escalatedIndex;
  for (const turnId of ['same-failure-1', 'same-failure-2']) {
    await nextTurn(h, turnId, failure);
    assert.equal(h.loop().auto.state.escalatedIndex, index);
    assert.equal(h.loop().auto.state.headroom, true);
    assert.equal(h.loop().decision.reason, 'escalation-exhausted');
    assert.equal(h.loop().decision.escalated, false);
  }
  h.settings({ availableModels: ['opus', 'fable'] });
  await nextTurn(h, 'delayed-escalation', failure);
  assert.equal(h.loop().auto.state.escalatedIndex, index);
  assert.equal(h.loop().decision.reason, 'escalation');
  assert.equal(h.loop().decision.escalated, true);
  assert.equal(h.loop().auto.state.headroom, false);
  assert.equal(h.requests.at(-1).model, 'claude-fable-5-2');
});

test('auto → table → auto discards incompatible decisions/votes but retains real cache observations', async () => {
  const h = setup();
  await start(h);
  await drain(h.step(step));
  const first = h.loop();
  assert.equal(first.auto.state.demand, 3);
  patch(h, (c) => {
    c.routingEngine = 'table';
  });
  await reload(h);
  answering(h, low);
  await nextTurn(h, 'table');
  assert.equal(h.loop().auto, null);
  assert.equal(h.loop().activeEngine, 'table');
  const table = h.loop();
  assert.ok(table.models['claude-opus-5-5']);
  patch(h, (c) => {
    c.routingEngine = 'auto';
  });
  await reload(h);
  await nextTurn(h, 'auto-again');
  assert.equal(h.loop().auto.state.demand, 1);
  assert.equal(h.loop().auto.state.turn, 1);
  assert.equal(h.loop().decision.model, step.model);
  assert.ok(h.loop().models['claude-opus-5-5']);
  assert.ok(h.loop().generation > first.generation);
  assert.ok(h.loop().requests > table.requests);
});

test('known persisted auto state resumes; unknown version cannot reuse votes or pending route', async () => {
  for (const version of [1, 99]) {
    const h = setup();
    await start(h);
    await drain(h.step(step));
    const stored = structuredClone(h.state.get('loops:main'));
    stored.value.auto.version = version;
    h.state.set('loops:main', stored);
    await reload(h);
    answering(h, low);
    await nextTurn(h, 'resumed');
    assert.equal(h.loop().auto.version, 1);
    assert.equal(h.loop().auto.state.turn, version === 1 ? 2 : 1);
    assert.equal(h.loop().auto.state.demand, version === 1 ? 3 : 1);
  }
});

test('malformed persisted pin metadata resets safely on a continuation', async () => {
  for (const metadata of [
    { savedPin: { pin: 'bogus' } },
    { savedPin: { pin: 'low', switchedAt: 'invalid', servedRoute: null } },
    { savedPin: { pin: 'low', switchedAt: null, servedRoute: {} } },
    { fallback: { incumbent: {}, incumbentOrigin: 'external-fallback' } },
  ]) {
    const h = setup();
    await start(h);
    await drain(h.step(step));
    const stored = structuredClone(h.state.get('loops:main'));
    Object.assign(stored.value.auto, metadata);
    h.state.set('loops:main', stored);
    await drain(h.step({ ...step, index: 1 }));
    assert.equal(h.loop().auto.savedPin, null);
    assert.deepEqual(h.loop().auto.state.votes, []);
    assert.equal(h.loop().auto.state.turn, 0);
    assert.ok(h.requests.at(-1).model);
  }
});

test('new session and history reset cannot keep auto failure markers, votes or holds', async () => {
  const h = setup();
  await start(h);
  await drain(h.step(step));
  const generation = h.loop().generation;
  await h.event('session.compact', { trigger: 'manual' });
  answering(h, low);
  await nextTurn(h, 'after-reset');
  assert.ok(h.loop().generation > generation);
  assert.equal(h.loop().auto.state.turn, 1);
  assert.equal(h.loop().auto.state.demand, 1);
  assert.equal(h.loop().auto.state.escalatedIndex, null);
  await h.event('session.end', { reason: 'clear' });
  h.clear();
  await reload(h);
  await nextTurn(h, 'new-session');
  assert.equal(h.loop().auto.state.turn, 1);
  assert.equal(h.loop().auto.state.demand, 1);
});

test('review advances auto demand without routing tables and stale async answer is fenced after reset', async () => {
  for (const reset of [false, true]) {
    const h = setup({ policy: { reviewEveryRequests: 1 } });
    let release;
    let calls = 0;
    h.http(async () => {
      calls++;
      if (calls > 1)
        await new Promise((resolve) => {
          release = resolve;
        });
      return {
        ok: true,
        status: 200,
        headers: {},
        text: JSON.stringify(calls === 1 ? low : jevResponse('high', { high: 1 }, 0, { code: 1 }, 'produce')),
      };
    });
    await start(h);
    await drain(h.step(step));
    await drain(h.step({ ...step, index: 1 }));
    assert.ok(release);
    if (reset) await h.event('session.compact', { trigger: 'manual' });
    release();
    await tick();
    await drain(h.step({ ...step, index: 2 }));
    assert.equal(h.loop().auto.state.demand, reset ? 1 : 3);
    assert.equal(h.requests.at(-1).model, reset ? step.model : 'claude-opus-5-5');
  }
});
