import assert from 'node:assert/strict';
import test from 'node:test';
import { compareRoutes } from '../lib/activity.mjs';
import { ACTIVITIES, loadConfig, ROUTING_MODES, resolveRoute, TIERS } from '../lib/config.mjs';
import { applyMode, modeRoute } from '../lib/modes.mjs';
import { chooseRoute, continueRoute, emptyLoop, nativeFacts, resetHistory } from '../lib/route.mjs';
import { moveOf } from '../lib/subagents.mjs';
import { advice, user } from './helpers.mjs';

const r = (model, effort = 'high') => ({ model, effort });
const phase = (choice, mass = 0.99) => ({ choice, probabilities: { [choice]: mass, uncertain: 1 - mass } });
const answer = (tier, name, continuation = 0, mass = 0.99) => ({
  ...advice(tier, { [tier]: 0.99 }, { continuation }),
  activity: { choice: 'ops', probabilities: { ops: 0.99, uncertain: 0.01 } },
  ...(name ? { phase: phase(name, mass) } : {}),
});
function select(config, tier, name, { loop, continuation = 0, mass = 0.99, facts: overrides = {}, ...rest } = {}) {
  const nativeModel = config.models[config.routes[tier].model].id;
  loop ??= { ...emptyLoop(config, nativeModel), lastRoute: tier };
  const facts = nativeFacts(config, loop, {
    messages: [user('Complete the operational task.')],
    effort: 'high',
    turnId: 'next',
    contextTokens: 8000,
  });
  return chooseRoute(config, loop, {
    facts: { ...facts, ...overrides },
    advice: answer(tier, name, continuation, mass),
    nativeModel,
    contextKnown: true,
    now: 1000,
    ...rest,
  });
}

test('ops uses same-tier debug/code floors only on accepted reasoning/production phases, in every mode', () => {
  const configured = loadConfig();
  for (const mode of ROUTING_MODES)
    for (const tier of TIERS)
      for (const [name, activity] of [
        ['reason', 'debug'],
        ['produce', 'code'],
        ['verify', 'ops'],
        ['execute', 'ops'],
      ]) {
        const config = applyMode(configured, { mode });
        const d = select(config, tier, name).decision;
        assert.equal(d.goal, 'ops', `${mode} ${tier} ${name}`);
        assert.equal(d.taskPhase, name);
        assert.equal(d.activity, activity);
        assert.deepEqual(d.route, resolveRoute(config, tier, activity));
      }
});

test('ops reporting or uncertain phase cannot introduce a fresh ops discount', () => {
  const config = loadConfig();
  for (const [name, mass] of [
    [null, 0.99],
    ['uncertain', 0.99],
    ['report', 0.99],
    ['reason', 0.4],
    ['execute', 0.4],
    ['unknown', 0.99],
  ]) {
    const d = select(config, 'medium', name, { mass }).decision;
    assert.equal(d.activity, null, String(name));
    assert.deepEqual(d.route, config.routes.medium);
    assert.equal(d.goal, 'ops');
  }
});

test('ops reporting or uncertain phase retains an eligible continuation, without a cold base hop', () => {
  const config = loadConfig();
  const running = select(config, 'medium', 'execute');
  for (const name of [null, 'uncertain', 'report', 'unknown']) {
    const d = select(config, 'medium', name, { loop: running, continuation: 0.99 }).decision;
    assert.equal(d.activity, 'ops');
    assert.deepEqual(d.route, running.route);
    assert.equal(d.lateral, null);
  }
});

const model = (id, input, strength) => ({
  id,
  input,
  output: input * 5,
  cacheRead: input / 10,
  contextWindow: 1_000_000,
  billing: 'credits',
  efforts: ['low', 'medium', 'high', 'max'],
  strength,
});
const mixed = () =>
  loadConfig({
    provider: 'work-proxy',
    userFile: {
      mode: 'cost',
      models: {
        glm: model('org/glm-5.3-flash[1m]', 0.1, 1),
        deepseek: model('org/deepseek-flash[1m]', 0.2, 2),
        kimi: model('org/kimi-k3.1-pro[1m]', 0.5, 3),
        sonnet: model('claude-sonnet-5-5', 2, 4),
        opus: model('claude-opus-5-5', 4, 5),
      },
      routes: { micro: r('glm', 'low'), low: r('glm'), medium: r('glm'), high: r('opus', 'max') },
      activities: {
        ...Object.fromEntries(
          ['code', 'debug', 'plan'].map((a) => [
            a,
            {
              low: r('deepseek'),
              medium: r('kimi'),
              high: r('opus', 'max'),
            },
          ]),
        ),
        ops: { low: r('deepseek'), medium: r('kimi'), high: r('sonnet', 'high') },
      },
    },
  });

test('work-like cost ops reason never weakens medium DeepSeek to generic GLM and raises high Sonnet to Opus', () => {
  const config = applyMode(mixed(), { mode: 'cost' });
  assert.deepEqual(config.routes.medium, r('glm', 'medium'));
  for (const [tier, bounded, reasoning] of [
    ['medium', r('deepseek'), r('deepseek')],
    ['high', r('sonnet', 'medium'), r('opus')],
  ]) {
    const running = select(config, tier, 'execute');
    assert.deepEqual(running.route, bounded);
    const d = select(config, tier, 'reason', { loop: running, continuation: 0.99 }).decision;
    assert.equal(d.goal, 'ops');
    assert.deepEqual(d.route, reasoning);
  }
});

test('an inherited weaker generic cell is not an ops floor, but explicit use-tier cells remain authoritative in every mode', () => {
  for (const mode of ROUTING_MODES)
    for (const [name, activity] of [
      ['reason', 'debug'],
      ['produce', 'code'],
    ]) {
      const configured = mixed();
      delete configured.activities[activity].medium;
      const config = applyMode(configured, { mode });
      const ops = resolveRoute(config, 'medium', 'ops');
      const generic = resolveRoute(config, 'medium', activity);
      assert.equal(compareRoutes(config, generic, ops, 'high'), -1);
      const d = select(config, 'medium', name).decision;
      assert.deepEqual(d.route, ops, `${mode} ${name}`);
      assert.equal(d.activity, 'ops');
      assert.equal(d.goal, 'ops');
      const metered = { ...config, policy: { ...config.policy, cashCapUsd: 0 } };
      const current = {
        ...emptyLoop(config, config.models[generic.model].id),
        lastRoute: 'medium',
        lastActivity: activity,
        route: generic,
      };
      const capped = select(metered, 'medium', name, { loop: current, continuation: 0.99 });
      assert.deepEqual(capped.route, generic);
      assert.equal(capped.decision.activity, activity);
      assert.equal(capped.decision.reason, 'cash-gate');
      configured.activities[activity].medium = { ...configured.routes.medium };
      const explicit = applyMode(configured, { mode });
      const chosen = select(explicit, 'medium', name).decision;
      assert.deepEqual(chosen.route, resolveRoute(explicit, 'medium', activity));
      assert.equal(chosen.activity, activity);
      const nonOps = select(config, 'medium', name, {
        advice: { ...answer('medium', name), activity: { choice: activity, probabilities: { [activity]: 1 } } },
      }).decision;
      assert.deepEqual(nonOps.route, generic);
      delete config.models[ops.model].strength;
      const unknown = select(config, 'medium', name).decision;
      assert.deepEqual(unknown.route, generic);
    }
});

test('explicit unknown-order ops floors can be nominated on continuations, but confidence, hold and cash gates still decide', () => {
  for (const [name, activity] of [
    ['reason', 'debug'],
    ['produce', 'code'],
  ]) {
    const configured = mixed();
    delete configured.models.opus.strength;
    const config = applyMode(configured, { mode: 'cost' });
    const bounded = select(config, 'high', 'execute');
    const chosen = select(config, 'high', name, { loop: bounded, continuation: 0.99 });
    assert.deepEqual(chosen.route, r('opus'));
    assert.equal(chosen.decision.activity, activity);
    assert.equal(chosen.decision.goal, 'ops');
    assert.equal(compareRoutes(config, chosen.route, bounded.route, 'high'), null);
    const pending = select(config, 'high', name, { loop: bounded, continuation: 0.99, mass: 0.65 });
    assert.deepEqual(pending.route, bounded.route);
    assert.equal(pending.decision.reason, 'activity-pending');
    const held = select(config, 'high', name, {
      loop: { ...bounded, state: { ...bounded.state, holdUntilTurn: 99 } },
      continuation: 0.99,
    });
    assert.deepEqual(held.route, bounded.route);
    assert.equal(held.decision.reason, 'hold');
    const capped = select({ ...config, policy: { ...config.policy, cashCapUsd: 0 } }, 'high', name, {
      loop: bounded,
      continuation: 0.99,
    });
    assert.deepEqual(capped.route, bounded.route);
    assert.equal(capped.decision.reason, 'cash-gate');
    delete configured.activities[activity].high;
    const inherited = applyMode(configured, { mode: 'cost' });
    const kept = select(inherited, 'high', name, { loop: bounded, continuation: 0.99 });
    assert.deepEqual(kept.route, bounded.route);
    assert.equal(kept.decision.activity, 'ops');
  }
});

test('equal medium ops pairs retain the accepted semantic work preference before a high-tier upgrade', () => {
  for (const mode of ROUTING_MODES)
    for (const [name, activity] of [
      ['reason', 'debug'],
      ['produce', 'code'],
    ]) {
      const config = applyMode(mixed(), { mode });
      const bounded = select(config, 'medium', 'execute');
      assert.deepEqual(resolveRoute(config, 'medium', activity), bounded.route);
      const work = select(config, 'medium', name, { loop: bounded, continuation: 0.99 });
      assert.deepEqual(work.route, bounded.route);
      assert.equal(work.decision.activity, activity, `${mode} ${name}`);
      assert.equal(work.decision.lateral, null);
      let loop = { ...work, historyMeasured: true };
      for (let i = 0; i < config.policy.upgradeVotes; i += 1) {
        loop = select(config, 'high', name, { loop, continuation: 0.99 });
        if (i < config.policy.upgradeVotes - 1) {
          assert.equal(loop.decision.tier, 'medium');
          assert.deepEqual(loop.decision.route, bounded.route);
        }
      }
      assert.deepEqual(loop.decision.route, resolveRoute(config, 'high', activity));
      assert.notEqual(loop.decision.model, config.models.sonnet.id);
      assert.equal(loop.decision.goal, 'ops');
    }
});

test('a protected inherited work floor survives later tool-context refitting, not a history reset or new uncertainty', () => {
  for (const mode of ROUTING_MODES)
    for (const [name, activity] of [
      ['reason', 'debug'],
      ['produce', 'code'],
    ]) {
      const configured = mixed();
      delete configured.activities[activity].medium;
      for (const alias of ['glm', 'deepseek', 'kimi']) configured.models[alias].contextWindow = 10_000;
      const config = applyMode(configured, { mode });
      const running = select(config, 'medium', name);
      const context = {
        nativeModel: running.decision.model,
        contextTokens: 20_000,
        contextKnown: true,
        effort: 'high',
      };
      const fitted = continueRoute(config, running, context);
      assert.deepEqual(fitted.decision.route, resolveRoute(config, 'high', activity), `${mode} ${name}`);
      assert.equal(fitted.decision.activity, activity);
      assert.equal(fitted.decision.goal, 'ops');
      assert.equal(fitted.decision.taskPhase, name);
      assert.equal(running.decision.floorActivity, activity);
      assert.deepEqual(
        continueRoute(config, running, { ...context, contextKnown: false }).decision.route,
        running.decision.route,
      );
      const unavailable = continueRoute(config, running, { ...context, availableModels: [running.decision.model] });
      assert.equal(unavailable.decision.reason, 'model-unavailable');
      assert.equal(unavailable.decision.floorActivity, null);
      const textOnly = { ...config, models: { ...config.models, opus: { ...config.models.opus, imageInput: false } } };
      const image = continueRoute(textOnly, running, { ...context, hasImages: true });
      assert.notEqual(image.decision.model, config.models.opus.id);
      assert.equal(image.decision.floorActivity, null);
      const reset = resetHistory(running);
      assert.equal(reset.decision.floorActivity, null);
      const uncertain = select(config, 'medium', null, { loop: running, continuation: 0.99 });
      assert.equal(uncertain.decision.floorActivity, null);
    }
});

test('refused phase work restores actual incumbent intent in both directions, with and without a prior floor', () => {
  for (const [oldPhase, oldActivity, newPhase, newActivity] of [
    ['reason', 'debug', 'produce', 'code'],
    ['produce', 'code', 'reason', 'debug'],
  ])
    for (const prior of [false, true])
      for (const refusal of ['confidence', 'cash', 'hold', 'dwell', 'inherited-unknown']) {
        const config = mixed();
        config.activities[oldActivity].medium = r('deepseek');
        config.activities[newActivity].medium = r('kimi');
        config.activities[oldActivity].high = r('opus', 'max');
        config.activities[newActivity].high = r('sonnet');
        for (const alias of ['glm', 'deepseek', 'kimi']) config.models[alias].contextWindow = 10_000;
        if (refusal === 'hold') delete config.models.kimi.strength;
        if (refusal === 'dwell') config.models.kimi.strength = 1.5;
        if (refusal === 'inherited-unknown') {
          delete config.activities[newActivity].medium;
          delete config.models.glm.strength;
        }
        const running = select(
          config,
          'medium',
          oldPhase,
          prior
            ? {}
            : {
                advice: {
                  ...answer('medium', oldPhase),
                  activity: { choice: oldActivity, probabilities: { [oldActivity]: 1 } },
                },
              },
        );
        assert.equal(running.decision.floorActivity, prior ? oldActivity : null);
        const from = refusal === 'hold' ? { ...running, state: { ...running.state, holdUntilTurn: 99 } } : running;
        const policy = refusal === 'cash' ? { ...config, policy: { ...config.policy, cashCapUsd: 0 } } : config;
        const kept = select(policy, 'medium', newPhase, {
          loop: from,
          continuation: 0.99,
          mass: refusal === 'confidence' ? 0.65 : 0.99,
        });
        const name = `${oldPhase} -> ${newPhase}, prior=${prior}, ${refusal}`;
        assert.deepEqual(kept.decision.route, running.decision.route, name);
        assert.equal(kept.decision.activity, oldActivity, name);
        assert.equal(kept.decision.floorActivity, prior ? oldActivity : null, name);
        const fitted = continueRoute(policy, kept, {
          nativeModel: running.decision.model,
          contextTokens: 20_000,
          contextKnown: true,
          effort: 'high',
        });
        assert.deepEqual(fitted.decision.route, config.activities[oldActivity].high, name);
      }
});

test('a protected incumbent floor also owns mandatory refits in the request that refuses a new phase', () => {
  for (const [oldPhase, oldActivity, newPhase, newActivity] of [
    ['reason', 'debug', 'produce', 'code'],
    ['produce', 'code', 'reason', 'debug'],
  ]) {
    const config = mixed();
    delete config.activities[oldActivity].medium;
    config.activities[newActivity].medium = r('opus');
    config.activities[oldActivity].high = r('opus', 'max');
    config.activities[newActivity].high = r('sonnet');
    for (const alias of ['glm', 'deepseek', 'kimi']) config.models[alias].contextWindow = 10_000;
    const running = select(config, 'medium', oldPhase);
    assert.equal(running.decision.activity, 'ops');
    const fitted = select(config, 'medium', newPhase, {
      loop: running,
      continuation: 0.99,
      mass: 0.65,
      facts: { contextTokens: 20_000 },
    });
    assert.equal(fitted.decision.reason, 'context-fit');
    assert.deepEqual(fitted.decision.route, config.activities[oldActivity].high);
    assert.equal(fitted.decision.activity, oldActivity);
    assert.equal(fitted.decision.floorActivity, oldActivity);
  }
});

test('unmeasured-window restoration resolves every fallback through its own floor, preserving native-base controls', () => {
  for (const [oldPhase, oldActivity, newPhase, newActivity] of [
    ['reason', 'debug', 'produce', 'code'],
    ['produce', 'code', 'reason', 'debug'],
  ])
    for (const constraint of ['images', 'availability'])
      for (const contextKnown of [false, true])
        for (const nativeBase of [false, true]) {
          const config = mixed();
          config.models.luna = { ...model('luna-fixture', 0.05, 0.5), contextWindow: 2000 };
          config.models.glm = { ...config.models.glm, contextWindow: 1_000_000, imageInput: true };
          config.models.kimi = { ...config.models.kimi, contextWindow: 10_000, imageInput: true };
          config.models.sonnet = { ...config.models.sonnet, contextWindow: 5000, imageInput: true };
          config.models.opus = { ...config.models.opus, contextWindow: 1_000_000, imageInput: true };
          config.routes = { micro: r('luna', 'low'), low: r('luna'), medium: r('glm'), high: r('opus', 'max') };
          config.activities = {
            [oldActivity]: { high: r('opus', 'max') },
            [newActivity]: { medium: r('sonnet'), high: r('sonnet') },
            ops: { medium: r('kimi'), high: r('sonnet') },
          };
          const nativeModel = config.models[nativeBase ? 'glm' : 'kimi'].id;
          const running = select(config, 'medium', oldPhase, {
            nativeModel,
            loop: { ...emptyLoop(config, nativeModel), historyMeasured: true, lastRoute: 'medium' },
          });
          assert.deepEqual(running.decision.route, r('kimi'));
          assert.equal(running.decision.activity, 'ops');
          assert.equal(running.decision.floorActivity, oldActivity);
          const from = contextKnown ? { ...running, historyMeasured: false } : running;
          const restored = select(config, 'medium', newPhase, {
            loop: from,
            nativeModel,
            continuation: 0.99,
            contextKnown,
          });
          assert.equal(restored.decision.reason, 'context-unknown');
          assert.deepEqual(restored.decision.route, r('kimi'));
          assert.equal(restored.decision.floorActivity, oldActivity);
          if (constraint === 'images') config.models.kimi.imageInput = false;
          const availableModels =
            constraint === 'availability' ? [config.models.glm.id, config.models.opus.id] : undefined;
          const fitted = select(config, 'medium', newPhase, {
            loop: from,
            nativeModel,
            continuation: 0.99,
            contextKnown,
            availableModels,
            facts: { hasImages: constraint === 'images' },
          });
          const name = `${oldPhase} -> ${newPhase}, ${constraint}, contextKnown=${contextKnown}, nativeBase=${nativeBase}`;
          assert.deepEqual(fitted.decision.route, nativeBase ? r('glm') : r('opus', 'max'), name);
          assert.equal(fitted.decision.activity, nativeBase ? null : oldActivity, name);
          assert.equal(fitted.decision.floorActivity, nativeBase ? null : oldActivity, name);
          assert.equal(fitted.decision.goal, 'ops');
          assert.equal(fitted.decision.reason, 'model-unavailable');
        }
});

test('classifier failure still keeps the actual request when a floor expires and configuration changes', () => {
  for (const [phase, activity] of [
    ['reason', 'debug'],
    ['produce', 'code'],
  ]) {
    const config = mixed();
    delete config.activities[activity].medium;
    const running = select(config, 'medium', phase);
    const edited = {
      ...config,
      activities: { ...config.activities, ops: { ...config.activities.ops, medium: r('opus') } },
    };
    const kept = select(edited, 'medium', null, { loop: running, advice: null });
    assert.equal(kept.decision.reason, 'no-advice');
    assert.deepEqual(kept.decision.route, running.decision.route);
  }
});

test('same-label phase-derived physical changes use min goal/phase support, not operator mass one', () => {
  for (const [name, activity] of [
    ['reason', 'debug'],
    ['produce', 'code'],
  ]) {
    const config = mixed();
    delete config.activities[activity].medium;
    const running = select(config, 'medium', null, {
      advice: { ...answer('medium', null), activity: { choice: activity, probabilities: { [activity]: 1 } } },
    });
    assert.deepEqual(running.decision.route, config.routes.medium);
    for (const [goalMass, phaseMass] of [
      [0.99, 0.65],
      [0.65, 0.99],
    ]) {
      const proposed = {
        ...answer('medium', name, 0.99, phaseMass),
        activity: { choice: 'ops', probabilities: { ops: goalMass } },
      };
      const held = select(config, 'medium', name, { loop: running, advice: proposed });
      assert.deepEqual(held.decision.route, running.decision.route, `${name} ${goalMass}/${phaseMass}`);
      assert.equal(held.decision.activity, activity);
      assert.equal(held.decision.floorActivity, null);
      assert.equal(held.decision.reason, 'activity-pending');
      assert.equal(held.decision.estimate.upgradeMass, 0.65);
    }
    const strong = select(config, 'medium', name, { loop: running, continuation: 0.99 });
    assert.deepEqual(strong.decision.route, config.activities.ops.medium);
    assert.equal(strong.decision.floorActivity, activity);
    const edited = { ...config, routes: { ...config.routes, medium: r('kimi') } };
    const operator = select(edited, 'medium', null, {
      loop: running,
      advice: { ...answer('medium', null, 0.99), activity: { choice: activity, probabilities: { [activity]: 0.65 } } },
    });
    assert.deepEqual(operator.decision.route, r('kimi'));
    assert.equal(operator.decision.estimate.upgradeMass, 1);
    const acceptedEdit = {
      ...config,
      activities: { ...config.activities, ops: { ...config.activities.ops, medium: r('opus') } },
    };
    const changed = select(acceptedEdit, 'medium', name, { loop: strong, continuation: 0.99, mass: 0.65 });
    assert.deepEqual(changed.decision.route, r('opus'));
    assert.equal(changed.decision.floorActivity, activity);
    assert.equal(changed.decision.estimate.upgradeMass, 1);
    const quality = applyMode(config, { mode: 'quality' });
    const modeChanged = select(quality, 'medium', name, { loop: strong, continuation: 0.99, mass: 0.65 });
    assert.deepEqual(modeChanged.decision.route, resolveRoute(quality, 'medium', 'ops'));
    assert.equal(modeChanged.decision.estimate.upgradeMass, 1);
  }
});

test('phase floors retain cash, confidence, pin, model availability, context and same-task downgrade guards', () => {
  const config = loadConfig();
  const running = select(config, 'medium', 'reason');
  const bounded = select(config, 'medium', 'execute');
  const pending = select(config, 'medium', 'reason', { loop: bounded, continuation: 0.99, mass: 0.65 });
  assert.equal(pending.decision.taskPhase, 'reason');
  assert.deepEqual(pending.route, bounded.route);
  assert.equal(pending.decision.reason, 'activity-pending');
  assert.equal(pending.decision.estimate.upgradeMass, 0.65);
  const held = select(config, 'medium', 'verify', { loop: running, continuation: 0.99 });
  assert.deepEqual(held.route, running.route);
  const pinned = select(config, 'medium', 'verify', { pin: 'medium' });
  assert.deepEqual(pinned.decision.route, config.routes.medium);
  assert.equal(pinned.decision.goal, null);
  assert.equal(pinned.decision.floorActivity, null);
  const unavailable = select(config, 'medium', 'reason', { availableModels: [config.models.haiku.id] });
  assert.notEqual(unavailable.decision.model, config.models.opus.id);
  const metered = loadConfig({ userFile: { models: { opus: { billing: 'credits' } }, policy: { cashCapUsd: 0 } } });
  const fromOps = select(metered, 'medium', 'execute');
  const capped = select(metered, 'medium', 'reason', { loop: fromOps, continuation: 0.99 });
  assert.deepEqual(capped.route, fromOps.route);
  assert.equal(capped.decision.reason, 'cash-gate');
  const small = loadConfig({ userFile: { models: { haiku: { contextWindow: 1000 } } } });
  assert.notEqual(select(small, 'medium', 'verify').decision.model, small.models.haiku.id);
  const off = loadConfig({ userFile: { activityRouting: 'off' } });
  assert.equal(select(off, 'medium', 'reason').decision.activity, null);
});

test('automatic Haiku 5.5 quality prefers high except medium bounded ops, without changing supported efforts', () => {
  const config = loadConfig();
  for (const tier of ['low', 'medium', 'high'])
    for (const activity of [null, ...ACTIVITIES]) {
      const haiku = loadConfig({
        userFile: {
          routes: { [tier]: r('haiku') },
          activities: Object.fromEntries(ACTIVITIES.map((a) => [a, { [tier]: r('haiku') }])),
        },
      });
      assert.deepEqual(
        modeRoute(haiku, 'quality', tier, activity),
        r('haiku', tier === 'medium' && activity === 'ops' ? 'xhigh' : 'high'),
      );
    }
  assert.ok(config.models.haiku.efforts.includes('xhigh'));
  const alias = loadConfig({
    userFile: {
      models: { worker: { ...config.models.haiku, id: 'claude-haiku-5-5[1m]' } },
      routes: { low: r('worker') },
    },
  });
  assert.deepEqual(modeRoute(alias, 'quality', 'low'), r('worker'));
  const other = loadConfig({ userFile: { models: { haiku: { id: 'not-haiku-5-5' } } } });
  assert.deepEqual(modeRoute(other, 'quality', 'low'), r('haiku', 'xhigh'));
  for (const effort of ['xhigh', 'max']) {
    const explicit = loadConfig({ userFile: { routes: { low: r('haiku', effort) } } });
    assert.deepEqual(modeRoute(explicit, 'balanced', 'low'), r('haiku', effort));
    assert.deepEqual(modeRoute(explicit, 'quality', 'low'), r('haiku', effort));
  }
  for (const provider of ['deepseek', 'kimi', 'minimax', 'mimo', 'zai']) {
    const profile = loadConfig({ provider });
    const d = modeRoute(profile, 'quality', 'low');
    assert.notEqual(profile.models[d.model].id, config.models.haiku.id);
  }
});

test('capability comparisons use declared ranks, not tariffs; unknown models stay unordered', () => {
  const config = loadConfig();
  const a = r('opus', 'low');
  const b = r('sonnet', 'max');
  assert.equal(compareRoutes(config, a, b, 'high'), 1);
  const reversed = loadConfig({ userFile: { models: { opus: { output: 0.001 }, sonnet: { output: 1000 } } } });
  assert.equal(compareRoutes(reversed, a, b, 'high'), 1);
  assert.equal(moveOf(reversed, reversed.models.opus.id, reversed.models.sonnet.id), 'up');
  const repurposed = loadConfig({ userFile: { models: { opus: { id: 'different-model' } } } });
  assert.equal(repurposed.models.opus.strength, undefined);
  assert.equal(compareRoutes(repurposed, a, b, 'high'), null);
  assert.equal(moveOf(repurposed, 'different-model', repurposed.models.sonnet.id), 'moved');
  const custom = mixed();
  assert.equal(compareRoutes(custom, r('opus'), r('deepseek'), 'high'), 1);
  delete custom.models.deepseek.strength;
  assert.equal(compareRoutes(custom, r('opus'), r('deepseek'), 'high'), null);
});
