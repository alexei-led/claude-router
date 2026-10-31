import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { ACTIVITIES, loadConfig, ROUTING_MODES, resolveRoute, TIERS } from '../lib/config.mjs';
import { applyMode, modeRoute } from '../lib/modes.mjs';
import { classifiedAlias, typeRoute } from '../lib/subagents.mjs';
import { probeCases } from '../scripts/probe-provider-routes.mjs';
import { withMatrix } from '../scripts/provider-matrix.mjs';
import { drain, harness, press, start, step } from './harness.mjs';

const ENGINEERING = ['code', 'debug', 'plan', 'review'];
const READONLY = ['ops', 'explore', 'docs'];
const EVERY = [null, ...ACTIVITIES];
// [cost, balanced, quality]; explicit expectations, not snapshots generated from the implementation.
const GOLDEN = {
  minimax: {
    micro: [[EVERY, ['flash/low', 'flash/low', 'flash/low']]],
    low: [[EVERY, ['flash/low', 'flash/medium', 'flash/high']]],
    medium: [
      [ENGINEERING, ['flash/high', 'flash/max', 'flash/max']],
      [
        [null, ...READONLY],
        ['flash/medium', 'flash/high', 'flash/max'],
      ],
    ],
    high: [[EVERY, ['flash/high', 'flash/max', 'flash/max']]],
  },
  mimo: {
    micro: [[EVERY, ['flash/null', 'flash/null', 'flash/null']]],
    low: [
      [
        [null, ...ENGINEERING],
        ['flash/null', 'flash/null', 'pro/null'],
      ],
      [READONLY, ['flash/null', 'flash/null', 'flash/null']],
    ],
    medium: [
      [
        [null, ...ENGINEERING],
        ['flash/null', 'pro/null', 'pro/null'],
      ],
      [READONLY, ['flash/null', 'flash/null', 'pro/null']],
    ],
    high: [
      [
        [null, ...ENGINEERING],
        ['pro/null', 'pro/null', 'pro/null'],
      ],
      [READONLY, ['flash/null', 'pro/null', 'pro/null']],
    ],
  },
  kimi: {
    micro: [[EVERY, ['k3/low', 'k3/low', 'k3/low']]],
    low: [[EVERY, ['k3/low', 'k3/high', 'k3/max']]],
    medium: [
      [ENGINEERING, ['k3/high', 'k3/max', 'k3/max']],
      [
        [null, ...READONLY],
        ['k3/low', 'k3/high', 'k3/max'],
      ],
    ],
    high: [[EVERY, ['k3/high', 'k3/max', 'k3/max']]],
  },
};

for (const [provider, tiers] of Object.entries(GOLDEN)) {
  test(`${provider}: every tier, activity and mode has the intended route`, () => {
    const config = loadConfig({ provider });
    for (const tier of TIERS) {
      assert.deepEqual(tiers[tier].flatMap(([activities]) => activities).sort(), [...EVERY].sort());
      for (const [activities, pairs] of tiers[tier])
        for (const activity of activities) {
          const got = ROUTING_MODES.map((mode) => {
            const r = modeRoute(config, mode, tier, activity);
            assert.deepEqual(resolveRoute(applyMode(config, { mode }), tier, activity), r);
            return `${r.model}/${r.effort}`;
          });
          assert.deepEqual(got, pairs, `${tier} ${activity}`);
        }
    }
    assert.equal(
      probeCases(config).reduce((n, c) => n + c.cells.length, 0),
      ACTIVITIES.length * TIERS.length * ROUTING_MODES.length,
    );
  });

  test(`${provider}: pins send only its model and supported effort, and reset/undo stay in its file`, async () => {
    const config = loadConfig({ provider });
    const path = `/fixture/team/${provider}-router.json`;
    for (const mode of ROUTING_MODES) {
      const h = harness();
      h.env.set('CLAUDE_ROUTER_PROVIDER', provider);
      h.model(config.models[config.routes.low.model].id);
      h.files.set(path, JSON.stringify({ mode }));
      await start(h);
      for (const tier of TIERS) {
        await h.event('command.run', { command: 'router', args: `pin ${tier}` });
        await drain(h.step({ ...step, turnId: tier, model: config.models[config.routes.low.model].id }));
        const sent = h.requests.at(-1);
        assert.equal(sent.model, config.models[config.routes[tier].model].id);
        assert.equal(sent.effort ?? null, config.routes[tier].effort);
      }
      assert.equal(h.files.has('/fixture/team/router.json'), false);
    }
    const h = harness();
    h.env.set('CLAUDE_ROUTER_PROVIDER', provider);
    h.model(config.models[config.routes.low.model].id);
    const patch = { routes: { low: config.routes.high } };
    h.files.set(path, JSON.stringify(patch));
    await start(h);
    await press(h, 'tab-routes');
    await press(h, 'reset-routes');
    await press(h, 'save-routing');
    assert.deepEqual(JSON.parse(h.files.get(path)), {});
    await press(h, 'undo');
    assert.deepEqual(JSON.parse(h.files.get(path)), patch);
  });

  test(`${provider}: subagents select only provider catalog models`, () => {
    const config = loadConfig({ provider });
    assert.deepEqual(typeRoute(config, { subagentType: 'Explore', provider: { plugin: 'engine', tier: 'core' } }), {
      route: config.subagents.light,
    });
    for (const [choice, probabilities, expected] of [
      ['micro', { high: 0 }, config.subagents.light],
      ['medium', { high: 0.1 }, config.subagents.standard],
      ['high', { high: 0.99 }, config.subagents.heavy],
    ]) {
      const alias = classifiedAlias(config, { choice, probabilities });
      assert.equal(alias, expected);
      assert.ok(Object.hasOwn(config.models, alias));
    }
  });

  test(`${provider}: missing or invalid profile keeps the native model and effort`, async () => {
    for (const file of [null, '{', '{"routes":{"high":{"model":"opus"}}}']) {
      const h = harness();
      h.env.set('CLAUDE_ROUTER_PROVIDER', provider);
      if (file !== null) h.files.set(`/fixture/team/${provider}-router.json`, file);
      h.files.set('/fixture/team/router.json', '{}');
      await start(h);
      assert.equal(h.view().phase, 'unavailable');
      await drain(h.step(step));
      assert.equal(h.requests[0].model, step.model);
      assert.equal(h.requests[0].effort, step.effort);
    }
  });
}

test('MiMo never claims granular effort, and Kimi never crosses model histories', () => {
  const mimo = loadConfig({ provider: 'mimo' });
  assert.ok(Object.values(mimo.models).every((m) => m.efforts.length === 0));
  assert.throws(() => loadConfig({ provider: 'mimo', userFile: { routes: { low: { effort: 'high' } } } }), /effort/);
  const kimi = loadConfig({ provider: 'kimi' });
  assert.equal(Object.keys(kimi.models).length, 1);
  assert.deepEqual(new Set(Object.values(kimi.subagents).filter((x) => typeof x === 'string')), new Set(['k3']));
  for (const provider of ['kimi', 'minimax'])
    assert.throws(() => loadConfig({ provider, userFile: { routes: { high: { effort: 'xhigh' } } } }), /effort/);
});

test('provider mode tables in the docs are generated from configured routes', () => {
  const text = readFileSync(new URL('../docs/providers.md', import.meta.url), 'utf8');
  assert.equal(withMatrix(text), text);
});
