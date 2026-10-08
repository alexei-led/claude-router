import assert from 'node:assert/strict';
import { test } from 'node:test';
import { changedLeaves, notSaved, restored, rewrittenConfig } from '../lib/config-file.mjs';

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

test('changedLeaves lists each leaf a write changed with its value before', () => {
  for (const { name, before, after, leaves } of WRITES) assert.deepEqual(changedLeaves(before, after), leaves, name);
});

test('restored puts every write back as the file had it', () => {
  for (const { name, before, after } of WRITES)
    assert.deepEqual(restored(after, changedLeaves(before, after)), before, name);
});

test('restored keeps edits made on disk since the write and leaves its input alone', () => {
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
    assert.deepEqual(restored(file, leaves), expected, name);
    assert.deepEqual(file, before, `${name}: input unchanged`);
  }
});

test('rewrittenConfig validates the changed file and serializes it with a trailing newline', () => {
  const { config, text } = rewrittenConfig('{"baselineTier":"low"}', (file) => ({ ...file, classifier: 'clef' }));
  assert.equal(config.classifier, 'clef');
  assert.equal(text, '{\n  "baselineTier": "low",\n  "classifier": "clef"\n}\n');
  assert.equal(rewrittenConfig(null, (file) => file).text, '{}\n');
});

test('rewrittenConfig throws and notSaved names the cause without quoting the file', () => {
  for (const [name, text, change, expected] of [
    ['invalid JSON', '{"key": "sk-secret', (file) => file, /^Not saved: router\.json is not valid JSON\. router/],
    [
      'invalid setting',
      null,
      () => ({ baselineTier: 'huge' }),
      /^Not saved: .*baselineTier.*router\.json is unchanged\.$/,
    ],
  ]) {
    let message = null;
    try {
      rewrittenConfig(text, change);
    } catch (error) {
      message = notSaved(error);
    }
    assert.match(message ?? '', expected, name);
    assert.doesNotMatch(message ?? '', /sk-secret/, name);
  }
});
