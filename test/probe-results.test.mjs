import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { DEFAULTS, loadConfig } from '../lib/config.mjs';
import { probeText } from '../lib/display.mjs';
import { renderPanel } from '../lib/panel.mjs';
import { PROBE_RESULTS } from '../lib/probe-results.mjs';
import { isUsableProbe, probeModule, readProbeResults } from '../scripts/probe-results.mjs';
import { ELEMENTS, texts } from './harness.mjs';

test('lib/probe-results.mjs is what the script writes from the checked-in probe results', () => {
  const results = readProbeResults();
  assert.equal(readFileSync(new URL('../lib/probe-results.mjs', import.meta.url), 'utf8'), probeModule(results));
  for (const r of results)
    assert.deepEqual(
      PROBE_RESULTS[r.classifier],
      {
        model: r.model,
        correct: Math.round(r.accuracy * r.probes),
        probes: r.probes,
        p95Ms: r.latencyMs.p95,
        date: r.date.slice(0, 10),
      },
      r.classifier,
    );
  assert.equal(Object.keys(PROBE_RESULTS).length, results.length);
});

const probe = (extra = {}) => ({
  classifier: 'mine',
  model: 'm',
  date: '2026-10-10T12:00:00.000Z',
  probes: 70,
  answered: 70,
  accuracy: 1,
  latencyMs: { p50: 200, p95: 300, deadline: 1000 },
  ...extra,
});

test('the module keeps any id and model text as data, however long or quoted', async () => {
  const results = [
    probe({ classifier: "o'brien", model: "o'brien-7b" }),
    probe({ classifier: 'long-tag', model: `hf.co/${'x'.repeat(40)}/model-GGUF:Q4_K_M` }),
    probe({ classifier: 'quote"and\\back', model: '</script>\u2028' }),
  ];
  const text = probeModule(results);
  const { PROBE_RESULTS: loaded } = await import(`data:text/javascript,${encodeURIComponent(text)}`);
  assert.deepEqual(
    Object.entries(loaded).map(([id, row]) => [id, row.model]),
    results.map((r) => [r.classifier, r.model]),
  );
});

test('a run without a single answer or a p95 is refused, and never reaches the module', () => {
  for (const [name, result, usable] of [
    ['answered', probe(), true],
    ['no answer', probe({ answered: 0, accuracy: 0, latencyMs: { p50: null, p95: null, deadline: 1000 } }), false],
    ['no p95', probe({ latencyMs: { p50: 200, p95: null, deadline: 1000 } }), false],
  ]) {
    assert.equal(isUsableProbe(result), usable, name);
    if (!usable) assert.throws(() => probeModule([result]), /mine/, name);
  }
});

test('a classifier shows its probe only for the model that was probed', () => {
  const other = loadConfig({ userFile: { classifiers: { ollama: { model: 'llama9:1b' } } } });
  for (const [name, config, id, expected] of [
    ['jev', DEFAULTS, 'jev', 'activity probe 70/70 · p95 299 ms · Oct 10'],
    ['a run before midnight UTC', DEFAULTS, 'clef', 'activity probe 69/70 · p95 883 ms · Oct 9'],
    ['another model', other, 'ollama', null],
    [
      'no probe',
      { ...DEFAULTS, classifiers: { ...DEFAULTS.classifiers, mine: { ...DEFAULTS.classifiers.ollama, model: 'm' } } },
      'mine',
      null,
    ],
  ])
    assert.equal(probeText(config, id), expected, name);
});

test('the Classifier tab puts each probe under its classifier row', () => {
  const lines = texts(
    renderPanel(ELEMENTS, DEFAULTS, { mode: 'auto', phase: 'routed', credentials: {}, tab: 'classifier' }, null, {}),
  );
  const at = lines.indexOf('api.typesafe.ai');
  assert.ok(at > 0);
  assert.ok(lines.slice(at, at + 5).includes('    activity probe 70/70 · p95 299 ms · Oct 10'));
});
