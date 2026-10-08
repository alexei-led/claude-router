import assert from 'node:assert/strict';
import test from 'node:test';
import { bandSegments, fitSegments } from '../lib/band.mjs';
import { DEFAULTS } from '../lib/config.mjs';
import { GATEWAY_SETTINGS } from '../lib/display.mjs';

const ROUTER_BUTTON_COLUMNS = 8;
const SIXTY_COLUMNS = 60 - ROUTER_BUTTON_COLUMNS;
const actions = new Proxy({}, { get: () => () => {} });
const routes = [
  ['low', 'claude-sonnet-5-5', 'medium'],
  ['medium', 'claude-opus-5-5', 'medium'],
  ['high', 'claude-opus-5-5', 'xhigh'],
];

test('a 60-column band keeps the missing-credential warning and Set up beside the Router button for every classifier and route', () => {
  for (const id of Object.keys(DEFAULTS.classifiers)) {
    const config = { ...DEFAULTS, classifier: id };
    for (const error of ['missing-key', 'missing-account']) {
      for (const [tier, selectedModel, effort] of routes) {
        const view = { mode: 'auto', phase: 'routed', tier, selectedModel, effort, error };
        const parts = fitSegments(bandSegments(config, view, null, actions), SIXTY_COLUMNS).flatMap((s) => s.parts);
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

const line = (segments) =>
  segments
    .flatMap((s) => s.parts)
    .map((p) => p.text ?? `[${p.button.label}]`)
    .join('');
const plain = (priority, ...texts) => ({ priority, parts: texts.map((text) => ({ text, style: {} })) });

test('an unavailable router names the cause, or the gateway leftovers, beside Fix', () => {
  for (const [error, expected] of [
    ['bad router.json', '✕ Router unavailablebad router.json[Fix]'],
    [GATEWAY_SETTINGS, '✕ Router unavailablev0.8 gateway settings remain[Fix]'],
    [null, '✕ Router unavailableunknown error[Fix]'],
  ])
    assert.equal(line(bandSegments(DEFAULTS, { mode: 'auto', phase: 'unavailable', error }, null, actions)), expected);
});

test('a turn being classified shows a dim meter and the classifier deadline', () => {
  const segments = bandSegments(DEFAULTS, { mode: 'auto', phase: 'choosing', tier: 'medium' }, null, actions);
  assert.equal(line(segments), '▂▄▆█ choosing for this turn…Jev · 1.5 s deadline');
  assert.ok(segments[0].parts.slice(0, 4).every((p) => p.style.dimColor));
});

test('a narrow band drops the highest priority first, the later one on a tie', () => {
  const segments = [plain(0, 'main'), plain(2, 'two-a'), plain(1, 'one'), plain(2, 'two-b')];
  for (const [columns, expected] of [
    [100, ['main', 'two-a', 'one', 'two-b']],
    [27, ['main', 'two-a', 'one']],
    [20, ['main', 'one']],
    [4, ['main']],
  ])
    assert.deepEqual(
      fitSegments(segments, columns).map((s) => line([s])),
      expected,
      `${columns} columns`,
    );
});

test('a first segment wider than the band is cut with an ellipsis and the rest go', () => {
  const kept = fitSegments([plain(0, '⚠ ', 'Clef Flash: no account ID'), plain(0, 'Set up')], 12);
  assert.deepEqual(
    kept.map((s) => line([s])),
    ['⚠ Clef Flas…'],
  );
});

test('a cut keeps buttons whole and leaves a part too short to cut', () => {
  const segment = {
    priority: 0,
    parts: [
      { text: 'route kept here', style: {} },
      { button: { key: 'b', label: 'Details' } },
      { text: '!', style: {} },
    ],
  };
  assert.equal(line(fitSegments([segment], 20)), 'route k…[Details]!');
});
