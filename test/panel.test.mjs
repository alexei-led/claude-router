import assert from 'node:assert/strict';
import test from 'node:test';
import { bandSegments } from '../lib/band.mjs';
import { DEFAULTS } from '../lib/config.mjs';
import { TIER_COLOR } from '../lib/display.mjs';
import { renderPanel } from '../lib/panel.mjs';
import { isSameModel } from '../lib/route.mjs';
import { controls, ELEMENTS, texts } from './harness.mjs';

const actions = new Proxy({}, { get: () => () => {} });
const KEYS_SET = { jev: null, clef: null, 'clef-flash': null };
const view = (props = {}) => ({ mode: 'auto', phase: 'routed', credentials: KEYS_SET, tab: 'now', ...props });
const pane = (props, usage = null, paneActions = actions) =>
  renderPanel(ELEMENTS, DEFAULTS, view(props), usage, paneActions);

test('the band, the pane and the router agree on which served model is a fallback', () => {
  for (const [selectedModel, actualModel, fallback] of [
    ['claude-sonnet-5-5', 'claude-sonnet-5-5', false],
    ['claude-haiku-4-5', 'claude-haiku-4-5-20251001', false],
    ['claude-sonnet-5-5', 'claude-sonnet-5-5-20260101', true],
    ['claude-sonnet-5-5', 'claude-opus-5-5', true],
  ]) {
    const routed = { tier: 'low', selectedModel, actualModel, effort: 'medium' };
    const band = bandSegments(DEFAULTS, view(routed), null, actions).flatMap((s) => s.parts);
    const label = `${selectedModel} served as ${actualModel}`;
    assert.equal(!isSameModel(selectedModel, actualModel), fallback, label);
    assert.equal(
      band.some((p) => p.text === ' fallback'),
      fallback,
      label,
    );
    assert.equal(texts(pane(routed)).includes('Served '), fallback, label);
  }
});

test('a pending pin shows on the Now tab with unpin', () => {
  let unpinned = 0;
  const tree = pane({ tier: 'low', selectedModel: 'claude-sonnet-5-5', pendingPin: 'high' }, null, {
    ...actions,
    unpin: () => {
      unpinned += 1;
    },
  });
  const lines = texts(tree);
  const at = lines.indexOf('Pinned ');
  assert.deepEqual(lines.slice(at, at + 3), ['Pinned ', 'next turn → ', 'high']);
  controls(tree)
    .find((c) => c.key === 'unpin')
    .onPress();
  assert.equal(unpinned, 1);
  assert.ok(!texts(pane({ tier: 'low', selectedModel: 'claude-sonnet-5-5' })).includes('Pinned '));
});

test('help explains what the numbers are and that savings are not measured', () => {
  const lines = texts(pane({ help: true }));
  const at = lines.indexOf('ABOUT THESE NUMBERS');
  assert.deepEqual(lines.slice(at, at + 6), [
    'ABOUT THESE NUMBERS',
    'Cost, context and cache are Claude readings. $ estimates use the',
    'list prices in router.json; plan prices are equivalents, not cash.',
    'Routing savings are not measured. Cache benefit is before writes.',
    'The context bar uses the routed model’s window, 20% in reserve.',
    'A switch estimate prices 5m–1h cache writes; minus means cheaper.',
  ]);
  assert.ok(!texts(pane({ help: false })).includes('ABOUT THESE NUMBERS'));
});

test('the Usage tab compares the tiers of the last switch estimate', () => {
  for (const [paybackTurns, payback] of [
    [3, 'Payback               3 later turns'],
    [null, 'Payback               none projected'],
  ]) {
    const comparison = { incumbent: 'low', candidate: 'high', minUsd: -0.0123, maxUsd: 0.5, paybackTurns };
    const lines = texts(pane({ tab: 'usage', comparison }));
    const at = lines.indexOf('Compared tiers        low → high');
    assert.deepEqual(lines.slice(at, at + 3), [
      'Compared tiers        low → high',
      'Next-turn difference  −$0.012 to +$0.500',
      payback,
    ]);
  }
  assert.ok(!texts(pane({ tab: 'usage' })).some((line) => line.startsWith('Compared tiers')));
});

test('the Usage trend colors each reply by its tier and labels the range', () => {
  const nodes = [];
  (function walk(node) {
    if (node?.type === 'Text') nodes.push(node.props);
    if (Array.isArray(node?.props?.children)) node.props.children.forEach(walk);
  })(pane({ tab: 'usage', history: [1000, 5000], tiers: ['micro', 'low', 'high'] }));
  const at = nodes.findIndex((n) => n.children === '▁');
  assert.deepEqual(
    nodes.slice(at, at + 3).map((n) => [n.children, n.color ?? null]),
    [
      ['▁', TIER_COLOR.low],
      ['█', TIER_COLOR.high],
      ['  1.0K … 5.0K', null],
    ],
  );
});
