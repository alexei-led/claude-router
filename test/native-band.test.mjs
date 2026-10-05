import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULTS } from '../lib/config.mjs';
import { bandSegments, fitSegments } from '../lib/native-band.mjs';

// What a 60-column band keeps once the Router button has its 8 columns.
const NARROW = 52;
const actions = new Proxy({}, { get: () => () => {} });
const routes = [
  ['low', 'claude-sonnet-5-5', 'medium'],
  ['medium', 'claude-opus-5-5', 'medium'],
  ['high', 'claude-opus-5-5', 'xhigh'],
];

test('a narrow band keeps the missing-credential warning and Set up for every classifier and route', () => {
  for (const id of Object.keys(DEFAULTS.classifiers)) {
    const config = { ...DEFAULTS, classifier: id };
    for (const error of ['missing-key', 'missing-account']) {
      for (const [tier, selectedModel, effort] of routes) {
        const view = { mode: 'auto', phase: 'routed', tier, selectedModel, effort, error };
        const parts = fitSegments(bandSegments(config, view, null, actions), NARROW).flatMap((s) => s.parts);
        const label = `${id} ${error} on ${tier}`;
        assert.ok(
          parts.some((p) => p.text?.startsWith(`⚠ ${DEFAULTS.classifiers[id].label}: no `)),
          label,
        );
        assert.ok(
          parts.some((p) => p.button?.key === 'band-key'),
          label,
        );
      }
    }
  }
});

test('a wide band shows the warning, the route kept and the reason', () => {
  const config = { ...DEFAULTS, classifier: 'clef-flash' };
  const view = { mode: 'auto', phase: 'routed', tier: 'medium', selectedModel: 'claude-opus-5-5', effort: 'medium' };
  const text = (error) =>
    fitSegments(bandSegments(config, { ...view, error }, null, actions), 112)
      .flatMap((s) => s.parts)
      .map((p) => p.text ?? `[${p.button.label}]`)
      .join(' ');
  assert.match(text('missing-account'), /⚠ Clef Flash: no account ID \[Set up\].*Opus 5\.5 · medium.*keeping model/);
  assert.match(text('timeout'), /⚠ Clef Flash timed out \[Details\].*Opus 5\.5 · medium.*keeping model/);
});
