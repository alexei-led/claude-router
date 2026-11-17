import assert from 'node:assert/strict';
import test from 'node:test';
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
  const h = setup({ baselineTier: 'high' });
  h.model('claude-opus-5-5');
  await start(h);
  await drain(h.step({ ...step, model: 'claude-opus-5-5', effort: 'medium' }));
  const failure = [
    user('fix'),
    assistant('running', ['Bash']),
    toolResult('error: test_login failed', { isError: true }),
    assistant('edit', ['Edit']),
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

test('equal native target clears external origin; unavailable candidates remain no-route on reentry', async () => {
  for (const eligible of [true, false]) {
    const h = setup();
    answering(h, low);
    await start(h);
    h.settings({ availableModels: [] });
    await drain(h.step(step));
    assert.equal(h.loop().auto.incumbentOrigin, 'external-fallback');
    h.settings({ availableModels: eligible ? ['haiku'] : [] });
    await nextTurn(h, 'retry');
    assert.equal(h.loop().decision.reason, eligible ? 'same-route' : 'no-route-native');
    assert.equal(h.loop().auto.incumbentOrigin, eligible ? null : 'external-fallback');
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
  const h = setup({ baselineTier: 'high' });
  h.model('claude-opus-5-5');
  await start(h);
  await drain(h.step({ ...step, model: 'claude-opus-5-5', effort: 'medium' }));
  assert.equal(h.requests[0].effort, 'medium');
  const failure = [
    user('fix'),
    assistant('running', ['Bash']),
    toolResult('error: test_login failed', { isError: true }),
    assistant('editing', ['Edit']),
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
    toolResult('error: test_login failed', { isError: true }),
  ]);
  assert.ok(h.loop().auto.state.escalatedIndex > index);
  assert.equal(h.loop().decision.reason, 'escalation-exhausted');
  assert.equal(h.loop().auto.state.headroom, true);
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
