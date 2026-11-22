import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canonicalModelId,
  configuredCoverage,
  configuredModels,
  effortCells,
  summarizeEntry,
  summarizeOverlay,
} from '../lib/evidence-report.mjs';

test('an effort reports the activities it fills and marks the rest unknown', () => {
  const [cell] = effortCells({ capability: { medium: { code: 1, debug: 2 } } });
  assert.deepEqual(cell?.activities, { code: 1, debug: 2 });
  assert.deepEqual(cell?.unknown, ['explore', 'plan', 'review', 'ops', 'docs']);
});

test('a missing activity takes the same effort default', () => {
  const [cell] = effortCells({ capability: { medium: { default: 1.5, code: 1 } } });
  assert.deepEqual(cell?.unknown, []);
  assert.equal(cell?.default, 1.5);
  assert.deepEqual(cell?.activities, {
    code: 1,
    debug: 1.5,
    explore: 1.5,
    plan: 1.5,
    review: 1.5,
    ops: 1.5,
    docs: 1.5,
  });
});

test('a numeric effort capability covers every activity', () => {
  const [cell] = effortCells({ capability: { high: 2 } });
  assert.deepEqual(cell?.unknown, []);
  assert.deepEqual(Object.values(cell?.activities ?? {}), [2, 2, 2, 2, 2, 2, 2]);
});

test('only efforts the capability names are reported', () => {
  const cells = effortCells({ capability: { max: { default: 1 }, low: { default: 0.5 } } });
  assert.deepEqual(
    cells.map((cell) => cell.effort),
    ['low', 'max'],
  );
});

test('an effort with no usable value has every activity unknown', () => {
  const [cell] = effortCells({ capability: { max: {} } });
  assert.deepEqual(cell?.activities, {});
  assert.equal(cell?.unknown.length, 7);
});

test('a non-numeric value stays unknown instead of becoming zero', () => {
  const [cell] = effortCells({ capability: { max: { code: 'high', default: Number.NaN } } });
  assert.deepEqual(cell?.unknown, ['code', 'debug', 'explore', 'plan', 'review', 'ops', 'docs']);
});

test('low confidence is reported per effort', () => {
  const entry = summarizeEntry('m', {
    capability: { max: { default: 1 }, high: { default: 2 } },
    confidence: { max: 'low', high: 'medium' },
  });
  assert.deepEqual(entry.lowConfidence, ['max']);
  assert.deepEqual(
    entry.efforts.map((cell) => cell.confidence),
    ['medium', 'low'],
  );
});

test('a model with an empty capability map has no capability', () => {
  assert.equal(summarizeEntry('m', { capability: {} }).noCapability, true);
  assert.equal(summarizeEntry('m', {}).noCapability, true);
  assert.equal(summarizeEntry('m', { capability: { max: {} } }).noCapability, true);
  assert.equal(summarizeEntry('m', { capability: { max: { default: 1 } } }).noCapability, false);
});

test('aliases are kept as strings only', () => {
  const entry = summarizeEntry('m', { aliases: ['a', 3, null, 'b'], capability: {} });
  assert.deepEqual(entry.aliases, ['a', 'b']);
});

test('the overlay summary flattens missing and low-confidence cells and no-capability models', () => {
  const summary = summarizeOverlay({
    checked: '2026-11-22',
    source: 'https://example.test/',
    tier: 'free',
    entries: {
      filled: { capability: { max: { default: 1 } }, confidence: { max: 'low' } },
      partial: { capability: { high: { code: 1 } } },
      empty: { capability: {} },
    },
  });
  assert.equal(summary.checked, '2026-11-22');
  assert.equal(summary.tier, 'free');
  assert.deepEqual(summary.lowConfidence, [{ model: 'filled', effort: 'max' }]);
  assert.deepEqual(summary.noCapability, ['empty']);
  assert.deepEqual(
    summary.missing.map((cell) => `${cell.model}/${cell.effort}/${cell.activity}`),
    [
      'partial/high/debug',
      'partial/high/explore',
      'partial/high/plan',
      'partial/high/review',
      'partial/high/ops',
      'partial/high/docs',
    ],
  );
});

test('a model id drops the long-context suffix the overlay aliases omit', () => {
  const ids = ['zai-org/GLM-5.3[1m]', 'claude-opus-5-5', ' kimi-k3.1-pro ', 7];
  assert.deepEqual(
    ids.map((id) => canonicalModelId(id)),
    ['zai-org/GLM-5.3', 'claude-opus-5-5', 'kimi-k3.1-pro', ''],
  );
});

test('a configured id matches an overlay key or alias after the suffix is stripped', () => {
  const overlay = {
    entries: {
      'glm-5.3': { aliases: ['glm-5.3', 'zai-org/GLM-5.3'], capability: {} },
      kimi: { aliases: [], capability: {} },
    },
  };
  const profiles = [
    {
      path: '~/.claude-team/a-router.json',
      json: {
        models: {
          glm: { id: 'zai-org/GLM-5.3[1m]' },
          other: { id: 'kimi' },
          missing: { id: 'deepseek-flash[1m]' },
          malformed: { cost: 1 },
        },
      },
    },
  ];
  const rows = configuredCoverage(overlay, profiles);
  assert.deepEqual(
    rows.map((row) => [row.alias, row.id, row.evidence, row.covered]),
    [
      ['glm', 'zai-org/GLM-5.3[1m]', 'glm-5.3', true],
      ['other', 'kimi', 'kimi', true],
      ['missing', 'deepseek-flash[1m]', null, false],
    ],
  );
});

test('profiles without a models list configure no ids', () => {
  const profiles = [
    { path: 'a-router.json', json: { routingEngine: 'zai' } },
    { path: 'b-router.json', json: { models: [] } },
    { path: 'c-router.json', json: null },
  ];
  assert.deepEqual(configuredModels(profiles), []);
});

test('a model entry may be a bare id string', () => {
  const models = configuredModels([
    { path: 'a-router.json', json: { models: { alias: 'zai-org/GLM-5.3', other: { id: 'kimi' } } } },
  ]);
  assert.deepEqual(models, [
    { profile: 'a-router.json', alias: 'alias', id: 'zai-org/GLM-5.3' },
    { profile: 'a-router.json', alias: 'other', id: 'kimi' },
  ]);
});
