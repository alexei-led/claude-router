import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig, resolveRoute } from '../lib/config.mjs';
import { modeRoute } from '../lib/modes.mjs';
import { applyRoutingEdits, applyRoutingPatch, routingEdits } from '../lib/project-routing.mjs';

const WRITES = [
  {
    name: 'a changed leaf keeps its old value',
    before: { policy: { cashCapUsd: 1, horizon: 4 } },
    after: { policy: { cashCapUsd: 2, horizon: 4 } },
    leaves: [{ path: ['policy', 'cashCapUsd'], value: 1 }],
  },
  {
    name: 'an added leaf had no value',
    before: { policy: { horizon: 4 } },
    after: { policy: { horizon: 4, cashCapUsd: 2 } },
    leaves: [{ path: ['policy', 'cashCapUsd'] }],
  },
  {
    name: 'a removed leaf keeps its old value',
    before: { classifier: 'clef', policy: { horizon: 4 } },
    after: { policy: { horizon: 4 } },
    leaves: [{ path: ['classifier'], value: 'clef' }],
  },
  {
    name: 'a created object yields only its leaves, its siblings stay out',
    before: { baselineTier: 'low' },
    after: { baselineTier: 'low', routes: { micro: { model: 'haiku', effort: 'low' } } },
    leaves: [{ path: ['routes', 'micro', 'model'] }, { path: ['routes', 'micro', 'effort'] }],
  },
  {
    name: 'a removed object yields each leaf it held',
    before: { routes: { micro: { model: 'haiku' } }, baselineTier: 'low' },
    after: { baselineTier: 'low' },
    leaves: [{ path: ['routes', 'micro', 'model'], value: 'haiku' }],
  },
  {
    name: 'an array is one leaf',
    before: { models: { haiku: { efforts: ['low'] } } },
    after: { models: { haiku: { efforts: ['low', 'high'] } } },
    leaves: [{ path: ['models', 'haiku', 'efforts'], value: ['low'] }],
  },
  {
    name: 'an unchanged file has no leaves',
    before: { routes: { low: { model: 'sonnet' } } },
    after: { routes: { low: { model: 'sonnet' } } },
    leaves: [],
  },
];

test('routingEdits lists only changed leaves and whether to write or remove them', () => {
  for (const { name, before, after, leaves } of WRITES) assert.deepEqual(routingEdits(after, before), leaves, name);
});

test('an edit list can also restore a prior patch', () => {
  for (const { name, before, after } of WRITES)
    assert.deepEqual(applyRoutingEdits(after, routingEdits(after, before)), before, name);
});

test('applying an edit list keeps unrelated changes and leaves its input alone', () => {
  for (const [name, file, leaves, expected] of [
    [
      'a sibling edited on disk stays',
      { policy: { cashCapUsd: 2, horizon: 9 } },
      [{ path: ['policy', 'cashCapUsd'], value: 1 }],
      { policy: { cashCapUsd: 1, horizon: 9 } },
    ],
    [
      'an object emptied by the delete goes, an edited sibling keeps it',
      { routes: { micro: { model: 'haiku' } }, policy: { horizon: 9 } },
      [{ path: ['routes', 'micro', 'model'] }],
      { policy: { horizon: 9 } },
    ],
    [
      'a parent left with another leaf stays',
      { routes: { micro: { model: 'haiku', effort: 'low' } } },
      [{ path: ['routes', 'micro', 'model'] }],
      { routes: { micro: { effort: 'low' } } },
    ],
    [
      'a leaf deleted on disk since stays deleted',
      { baselineTier: 'low' },
      [{ path: ['routes', 'micro', 'model'] }],
      { baselineTier: 'low' },
    ],
    [
      'a parent removed on disk is created again for its old value',
      {},
      [{ path: ['policy', 'cashCapUsd'], value: 1 }],
      { policy: { cashCapUsd: 1 } },
    ],
    [
      'a parent replaced by a scalar on disk becomes an object again',
      { policy: 3 },
      [{ path: ['policy', 'cashCapUsd'], value: 1 }],
      { policy: { cashCapUsd: 1 } },
    ],
  ]) {
    const before = structuredClone(file);
    assert.deepEqual(applyRoutingEdits(file, leaves), expected, name);
    assert.deepEqual(file, before, `${name}: input unchanged`);
  }
});

test('a sparse project patch inherits route, activity and mode-policy fields from the next lower layer', () => {
  const profile = loadConfig({
    userFile: {
      routes: { low: { model: 'opus', effort: 'max' } },
      activities: { code: { low: { model: 'sonnet', effort: 'xhigh' } } },
      policy: { downgradeVotes: 4 },
      modes: { cost: { policy: { downgradeVotes: 3 } } },
    },
  });
  const local = applyRoutingPatch(profile, {
    routes: { low: { effort: 'high' } },
    activities: { code: { low: { effort: 'medium' } } },
    policy: { cashCapUsd: 5 },
    modes: { cost: { policy: { minDwellRequests: 6 } } },
  });
  const pane = applyRoutingPatch(local, { policy: { downgradeVotes: 2 }, activities: { code: { low: null } } }, true);
  assert.deepEqual(resolveRoute(pane, 'low'), { model: 'opus', effort: 'high' });
  assert.deepEqual(resolveRoute(local, 'low', 'code'), { model: 'sonnet', effort: 'medium' });
  assert.deepEqual(resolveRoute(pane, 'low', 'code'), resolveRoute(pane, 'low'));
  assert.deepEqual(modeRoute(pane, 'quality', 'low', 'code'), modeRoute(pane, 'quality', 'low'));
  assert.equal(pane.policy.downgradeVotes, 2);
  assert.equal(pane.policy.cashCapUsd, 5);
  assert.equal(pane.modes.cost.policy.downgradeVotes, 3);
  assert.equal(pane.modes.cost.policy.minDwellRequests, 6);
  assert.equal(pane.models, profile.models);
  assert.equal(pane.subagents, profile.subagents);
  assert.throws(() => loadConfig({ userFile: { activities: { code: { low: null } } } }), /must be an object/);
});

for (const [field, patch] of [
  ['classifier identity', { classifier: 'ollama' }],
  ['model catalogue', { models: { anything: { id: 'untrusted' } } }],
  ['provider', { provider: 'custom' }],
  ['key binding', { classifiers: { jev: { keyOption: null } } }],
  ['network endpoint', { classifiers: { jev: { endpoint: 'https://untrusted.invalid' } } }],
  ['protocol', { classifiers: { jev: { api: 'ollama' } } }],
  ['new classifier', { classifiers: { untrusted: { timeoutMs: 100 } } }],
  ['invalid deadline', { classifiers: { jev: { timeoutMs: 0 } } }],
  ['untrusted model alias', { routes: { low: { model: 'untrusted' } } }],
  ['invalid effort on a custom provider', { routes: { low: { effort: 'xhigh' } } }],
  ['prototype property', JSON.parse('{"routes":{"__proto__":{"model":"untrusted"}}}')],
]) {
  test(`manual routing patches refuse ${field}`, () => {
    assert.throws(() => applyRoutingPatch(loadConfig({ provider: 'deepseek' }), patch));
  });
}

test('only the store can select a known classifier without altering its definition', () => {
  const profile = loadConfig();
  assert.throws(() => applyRoutingPatch(profile, { classifier: 'new' }, true));
  const patched = applyRoutingPatch(profile, { classifier: 'ollama', classifiers: { jev: { timeoutMs: 600 } } }, true);
  assert.equal(patched.classifier, 'ollama');
  assert.equal(patched.classifiers.ollama, profile.classifiers.ollama);
  assert.deepEqual(patched.classifiers.jev, { ...profile.classifiers.jev, timeoutMs: 600 });
});
