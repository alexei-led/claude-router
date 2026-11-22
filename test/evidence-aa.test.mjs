import assert from 'node:assert/strict';
import test from 'node:test';
import { aaCapability, aaOverlay, capabilityFromIndex, parseAaName } from '../lib/evidence-aa.mjs';

test('a display name gives its base model and the effort it states', () => {
  const cases = [
    ['Claude Opus 5.5 (Max, Default Fallback)', 'claude-opus-5-5', 'max'],
    ['Claude Haiku 5.5 (High)', 'claude-haiku-5-5', 'high'],
    ['GLM-5.3 (Low)', 'glm-5-3', 'low'],
    ['DeepSeek V4.1 Flash 1017 (High)', 'deepseek-v4-1-flash-1017', 'high'],
    ['GLM-5.3-Flash', 'glm-5-3-flash', null],
    ['Kimi K3.1 Pro', 'kimi-k3-1-pro', null],
    ['MiMo-V2.6-Pro', 'mimo-v2-6-pro', null],
  ];
  for (const [name, base, effort] of cases) assert.deepEqual(parseAaName(name), { base, effort, assumption: null });
});

test('a non-reasoning row is not a capability row, and an empty name is not a model', () => {
  assert.equal(parseAaName('DeepSeek V4.1 Flash 1017 (Non-reasoning)'), null);
  assert.equal(parseAaName('Claude 3.5 Haiku (Non-reasoning)'), null);
  assert.equal(parseAaName(''), null);
  assert.equal(parseAaName(null), null);
});

test('an index becomes a half-step capability through the policy anchors', () => {
  const anchors = [
    [29.9, 1],
    [48.2, 2],
    [57.4, 3],
  ];
  const cases = [
    [29.9, 1],
    [48.2, 2],
    [57.4, 3],
    [64.6, 3],
    [18.6, 0.5],
    [36.5, 1.5],
    [10, 0],
  ];
  for (const [index, capability] of cases) assert.equal(capabilityFromIndex(anchors, index), capability);
  assert.equal(capabilityFromIndex([[1, 1]], Number.NaN), null);
  assert.equal(capabilityFromIndex([[1, 1]], null), null);
});

test('each activity reads its index: engineering for code work, intelligence elsewhere', () => {
  const capability = aaCapability({
    artificial_analysis_intelligence_index: 48.2,
    artificial_analysis_engineering_index: 36.5,
    artificial_analysis_strategy_and_ops_index: 59,
  });
  assert.deepEqual(capability, {
    default: 2,
    code: 1,
    debug: 1,
    ops: 1,
    explore: 2,
    plan: 2,
    review: 2,
    docs: 2,
  });
  assert.equal(aaCapability({}), null);
  assert.equal(aaCapability({ artificial_analysis_intelligence_index: null }), null);
});

test('an unsuffixed row seeds both its effort and the default column', () => {
  const evaluations = {
    artificial_analysis_intelligence_index: 48.2,
    artificial_analysis_engineering_index: 36.5,
  };
  const models = { 'test-model': ['test-model'] };
  const { entries } = aaOverlay([{ name: 'Test Model', evaluations }], { checked: '2026-11-22', models });
  const entry = entries['test-model'];
  assert.deepEqual(entry.capability.max, aaCapability(evaluations));
  assert.deepEqual(entry.capability.default, entry.capability.max);
  assert.equal(entry.confidence.max, 'low');
  assert.ok(entry.notes.some((note) => note.includes('no effort suffix')));
});

test('a row that names its effort seeds only that effort', () => {
  const evaluations = {
    artificial_analysis_intelligence_index: 48.2,
    artificial_analysis_engineering_index: 36.5,
  };
  const models = { 'test-model': ['test-model'] };
  const { entries } = aaOverlay([{ name: 'Test Model (High)', evaluations }], { checked: '2026-11-22', models });
  assert.deepEqual(entries['test-model'].capability.high, aaCapability(evaluations));
  assert.equal(entries['test-model'].capability.default, undefined);
  assert.equal(entries['test-model'].confidence.high, 'medium');
});
