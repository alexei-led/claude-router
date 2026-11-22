import assert from 'node:assert/strict';
import test from 'node:test';
import {
  aggregateProbe,
  gradeAnswer,
  mergeProbe,
  probeCapability,
  validateProbeManifest,
} from '../lib/evidence-probe.mjs';

const task = (check) => ({ check });

test('an answer is graded by the task check', () => {
  assert.equal(gradeAnswer(task({ kind: 'exact', expected: '42' }), ' 42 '), true);
  assert.equal(gradeAnswer(task({ kind: 'exact', expected: '42' }), '41'), false);
  assert.equal(gradeAnswer(task({ kind: 'json-equal', expected: { a: 1 } }), '{"a":1}'), true);
  assert.equal(gradeAnswer(task({ kind: 'json-equal', expected: { a: 1 } }), '{"a":2}'), false);
  assert.equal(gradeAnswer(task({ kind: 'json-equal', expected: { a: 1 } }), 'not json'), false);
  assert.equal(gradeAnswer(task({ kind: 'contains', expected: 'fix' }), 'the fix is in'), true);
  assert.equal(gradeAnswer(task({ kind: 'regex', expected: '^ok$' }), 'ok'), true);
  assert.equal(gradeAnswer(task({ kind: 'regex', expected: '[' }), 'anything'), false);
  assert.equal(gradeAnswer(task({ kind: 'exact', expected: '42' }), ''), false);
});

test('capability is the highest tier that clears the bar, with a half-step for a partly adequate next tier', () => {
  const tiers = (passed, attempts) => ({ passed, attempts });
  assert.equal(probeCapability({ micro: tiers(3, 3), low: tiers(3, 3), medium: tiers(3, 3), high: tiers(3, 3) }), 3);
  assert.equal(probeCapability({ micro: tiers(3, 3), low: tiers(3, 3), medium: tiers(3, 3) }), 2);
  assert.equal(probeCapability({ micro: tiers(3, 3), low: tiers(3, 3), medium: tiers(2, 3) }), 1.5);
  assert.equal(probeCapability({ micro: tiers(1, 3), low: tiers(3, 3) }), 0);
  assert.equal(probeCapability({ micro: tiers(3, 3), low: tiers(1, 3) }), 0);
  assert.equal(probeCapability({ micro: tiers(2, 2) }), null);
  assert.equal(probeCapability({}), null);
});

test('a probe manifest is validated before any model runs', () => {
  const manifest = {
    version: 1,
    tasks: [
      {
        id: 'code-micro-1',
        activity: 'code',
        tier: 'micro',
        prompt: 'Sum 2 and 3. Return JSON {"sum": n}.',
        check: { kind: 'json-equal', expected: { sum: 5 } },
        estimateUsd: 0.01,
      },
    ],
  };
  assert.equal(validateProbeManifest(manifest), manifest);
  assert.throws(() => validateProbeManifest({ version: 2, tasks: manifest.tasks }), /version 1/);
  assert.throws(() => validateProbeManifest({ version: 1, tasks: [] }), /non-empty/);
  assert.throws(
    () => validateProbeManifest({ ...manifest, tasks: [{ ...manifest.tasks[0], activity: 'chat' }] }),
    /unknown activity/,
  );
  assert.throws(
    () => validateProbeManifest({ ...manifest, tasks: [{ ...manifest.tasks[0], tier: 'extreme' }] }),
    /tier/,
  );
});

test('graded rows aggregate per activity, effort and tier, and merge over a benchmark prior', () => {
  const rows = [
    { model: 'glm-5.3', effort: 'max', activity: 'code', tier: 'micro', passed: true },
    { model: 'glm-5.3', effort: 'max', activity: 'code', tier: 'micro', passed: true },
    { model: 'glm-5.3', effort: 'max', activity: 'code', tier: 'micro', passed: true },
    { model: 'glm-5.3', effort: 'max', activity: 'code', tier: 'low', passed: true },
    { model: 'glm-5.3', effort: 'max', activity: 'code', tier: 'low', passed: true },
    { model: 'glm-5.3', effort: 'max', activity: 'code', tier: 'low', passed: false },
    { model: 'glm-5.3', effort: 'max', activity: 'code', tier: 'medium', passed: false },
    { model: 'glm-5.3', effort: 'max', activity: 'code', tier: 'medium', passed: false },
    { model: 'glm-5.3', effort: 'max', activity: 'code', tier: 'medium', passed: false },
    { model: 'glm-5.3', effort: 'max', activity: 'docs', tier: 'micro', passed: true },
    { model: 'glm-5.3', effort: 'max', activity: 'docs', tier: 'micro', passed: true },
    { model: 'glm-5.3', effort: 'max', activity: 'docs', tier: 'micro', passed: true },
  ];
  const probe = aggregateProbe(rows, { checked: '2026-11-22', aliases: { 'glm-5.3': ['glm-5.3', 'zai-org/GLM-5.3'] } });
  assert.equal(probe['glm-5.3'].capability.max.code, 0.5);
  assert.equal(probe['glm-5.3'].capability.max.docs, 0);
  assert.equal(probe['glm-5.3'].probe.max.activities.code.attempts, 9);
  assert.deepEqual(probe['glm-5.3'].aliases, ['glm-5.3', 'zai-org/GLM-5.3']);

  const prior = {
    'glm-5.3': {
      aliases: ['glm-5.3'],
      capability: { max: { default: 1, code: 1, docs: 1 }, low: { default: 0.5 } },
      scores: { max: { intelligence: 31.7 } },
      confidence: { max: 'low', low: 'low' },
      sources: ['artificial_analysis'],
    },
  };
  mergeProbe(prior, probe);
  assert.deepEqual(prior['glm-5.3'].capability.max, { default: 0.5, code: 0.5, docs: 0 });
  assert.deepEqual(prior['glm-5.3'].capability.low, { default: 0.5 });
  assert.deepEqual(prior['glm-5.3'].sources, ['artificial_analysis', 'probe']);
  assert.equal(prior['glm-5.3'].confidence.max, 'high');
});
