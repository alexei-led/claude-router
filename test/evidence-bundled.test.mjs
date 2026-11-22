import assert from 'node:assert/strict';
import test from 'node:test';
import { EVIDENCE, EVIDENCE_SOURCES } from '../lib/evidence.mjs';
import {
  buildEvidence,
  buildResolver,
  capabilityFromComposite,
  effortFromName,
  parseLiveBenchTable,
  parseLmarena,
  parseTerminalBench,
  percentile,
  renderEvidence,
} from '../scripts/check-evidence.mjs';

test('one canonical entry answers the configured, [1m] and namespaced ids', () => {
  const models = Object.entries(EVIDENCE).map(([key, entry]) => ({ key, aliases: entry.aliases }));
  const resolve = buildResolver(models);
  for (const [bare, namespaced] of [
    ['glm-5.3[1m]', 'zai-org/GLM-5.3[1m]'],
    ['deepseek-flash[1m]', 'deepseek-ai/DeepSeek-V4.1-Flash-1017[1m]'],
    ['kimi-k3.1-pro[1m]', 'moonshotai/Kimi-K3.1-Pro[1m]'],
    ['MiniMax-M3.1-Flash[1m]', 'minimax-m3.1-flash[1m]'],
  ]) {
    assert.ok(resolve(bare), bare);
    assert.equal(resolve(namespaced), resolve(bare), namespaced);
  }
  assert.equal(resolve('deepseek-flash'), 'deepseek-flash');
  assert.equal(resolve('openrouter/deepseek/deepseek-v4.1-flash-1017'), 'deepseek-flash');
  assert.equal(resolve('cli/claude-fable-5.2'), 'claude-fable-5-2');
  assert.equal(resolve('MiniMax-M3.1-Flash[1m]'), 'MiniMax-M3.1-Flash');
  assert.equal(resolve('not-a-catalogued-model'), null);
});

test('two entries cannot claim the same normalized id', () => {
  assert.throws(
    () =>
      buildResolver([
        { key: 'first', aliases: ['same/model-id'] },
        { key: 'second', aliases: ['same-model-id'] },
      ]),
    /maps to both first and second/,
  );
});

test('capability exists only for an effort a source measured', () => {
  assert.deepEqual(Object.keys(EVIDENCE['claude-opus-5-5'].capability).sort(), ['high', 'max']);
  assert.equal(EVIDENCE['claude-opus-5-5'].capability.medium, undefined);
  assert.equal(EVIDENCE['claude-opus-5-5'].capability.xhigh, undefined);
  assert.equal(EVIDENCE['claude-opus-5-5'].capability.low, undefined);

  assert.deepEqual(Object.keys(EVIDENCE['claude-haiku-5-5'].capability).sort(), ['high', 'max']);
  assert.equal(EVIDENCE['claude-haiku-5-5'].capability.medium, undefined);

  assert.deepEqual(Object.keys(EVIDENCE['claude-sonnet-5-5'].capability).sort(), ['high', 'max', 'xhigh']);
  assert.equal(EVIDENCE['claude-sonnet-5-5'].capability.low, undefined);

  // LiveBench is model-level: it fills only a model with `efforts: []`, and only its default cell.
  assert.deepEqual(Object.keys(EVIDENCE['mimo-v2.6-pro'].capability), ['default']);
  assert.deepEqual(EVIDENCE['mimo-v2.6-flash'].capability, {});

  // LMArena rows without an effort stay scores only.
  assert.deepEqual(EVIDENCE['MiniMax-M3.1-Flash'].capability, {});
  assert.ok(EVIDENCE['MiniMax-M3.1-Flash'].scores.lmarena.default);
});

test('generation is deterministic and the committed file is its output', () => {
  const first = buildEvidence();
  const second = buildEvidence();
  assert.deepEqual(first.sources, second.sources);
  assert.deepEqual(first.evidence, second.evidence);
  assert.equal(renderEvidence(first), renderEvidence(second));
  assert.deepEqual(first.sources, EVIDENCE_SOURCES);
  assert.deepEqual(first.evidence, EVIDENCE);
});

test('a malformed terminal-bench row is skipped, not scored', () => {
  const parsed = parseTerminalBench({
    fields: ['model_id', 'm_accuracy'],
    rows: [
      { model_id: 'anthropic/claude-opus-5-5', m_accuracy: 64.85, reasoning_effort: 'max', role: 'router' },
      { model_id: '', m_accuracy: 50, reasoning_effort: 'max', role: 'router' },
      { model_id: 'ghost', m_accuracy: 'high', reasoning_effort: 'max', role: 'router' },
      { model_id: 'ghost-2', m_accuracy: 50, reasoning_effort: 'max' },
    ],
  });
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].id, 'anthropic/claude-opus-5-5');
  assert.equal(parsed.warnings.length, 3);
});

test('a malformed LiveBench row loses only the unreadable cells', () => {
  const parsed = parseLiveBenchTable('model,coding,reasoning\ngood,70,80\nshort,70\nbad,n/a,80\nempty,,\n');
  assert.deepEqual(parsed.rows, [
    { id: 'good', scores: { 'livebench.coding': 70, 'livebench.reasoning': 80 } },
    { id: 'bad', scores: { 'livebench.reasoning': 80 } },
  ]);
  assert.ok(parsed.warnings.length >= 3);
  assert.throws(() => parseLiveBenchTable('model\nx\n'), /no metric columns/);
});

test('a malformed LMArena row is skipped, not turned into a benchmark', () => {
  const parsed = parseLmarena({
    models: [
      {
        router_ids: ['glm-5.3[1m]'],
        benchmarks: [{ config: 'text', category: 'coding', model_name: 'GLM-5.3 (Max)', score: 1500 }],
      },
      { router_ids: ['ghost'], benchmarks: [{ config: 'text', category: 'coding', score: null }] },
      { router_ids: [], benchmarks: [] },
    ],
  });
  assert.equal(parsed.groups.length, 1);
  assert.equal(parsed.groups[0].cells.max['lmarena.text.coding'], 1500);
  assert.equal(parsed.warnings.length, 2);
});

test('a display name states an effort only when it carries one', () => {
  for (const [name, effort] of [
    ['Claude Opus 5.5 (High)', 'high'],
    ['Claude Fable 5.2 (xHigh)', 'xhigh'],
    ['Claude Fable 5.2 (Max, Default Fallback)', 'max'],
    ['DeepSeek-V4-Flash', null],
    ['', null],
    [null, null],
  ])
    assert.equal(effortFromName(name), effort, String(name));
});

test('percentiles and the unanchored fallback stay on the half-step scale', () => {
  assert.equal(percentile([], 5), null);
  assert.equal(percentile([1, 2, 3], 2), 0.5);
  assert.equal(capabilityFromComposite([], 0), 0);
  assert.equal(capabilityFromComposite([], 1), 3);
  assert.equal(capabilityFromComposite([[0.5, 2]], 0.5), 2);
  assert.equal(
    capabilityFromComposite(
      [
        [0.2, 1],
        [0.8, 3],
      ],
      0.5,
    ),
    2,
  );
});

test('every source names its url, checked date, snapshot file and license', () => {
  for (const [name, source] of Object.entries(EVIDENCE_SOURCES)) {
    assert.match(source.checked, /^\d{4}-\d{2}-\d{2}$/, name);
    for (const field of ['url', 'snapshot', 'license'])
      assert.equal(typeof source[field], 'string', `${name}.${field}`);
  }
});

test('every capability is a half-step from 0 to 3 with a confidence', () => {
  const levels = new Set(['low', 'medium', 'high']);
  for (const [key, entry] of Object.entries(EVIDENCE)) {
    for (const [effort, activities] of Object.entries(entry.capability)) {
      assert.ok(levels.has(entry.confidence[effort]), `${key}.${effort} confidence`);
      assert.ok(Object.keys(activities).length > 0, `${key}.${effort} activities`);
      for (const [activity, value] of Object.entries(activities))
        assert.ok(
          Number.isFinite(value) && value >= 0 && value <= 3 && Number.isInteger(value * 2),
          `${key}.${effort}.${activity} is ${value}`,
        );
    }
  }
});
