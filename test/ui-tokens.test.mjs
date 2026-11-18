import assert from 'node:assert/strict';
import test from 'node:test';
import { kit } from '../lib/ui/terminal/kit.mjs';
import {
  GRAPHICAL_MODEL,
  GRAPHICAL_PENDING,
  GRAPHICAL_TONE,
  isGraphical,
  svgColor,
  TIER_COLOR,
  toneColor,
} from '../lib/ui/tokens.mjs';
import { ELEMENTS } from './harness.mjs';

// WCAG 2.x relative luminance and contrast ratio.
const luminance = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = (v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

test('a terminal tier tone is the tier colour the band draws today', () => {
  for (const tier of Object.keys(TIER_COLOR)) assert.equal(toneColor(`tier:${tier}`, 'terminal'), TIER_COLOR[tier]);
});

test('a graphical tier tone reads at 3:1 on a white and a dark ground', () => {
  for (const tier of Object.keys(TIER_COLOR)) {
    const color = toneColor(`tier:${tier}`, 'graphical');
    assert.ok(contrast(color, '#ffffff') >= 3, `${tier} ${color} on white`);
    assert.ok(contrast(color, '#1f1f1f') >= 3, `${tier} ${color} on dark`);
  }
});

test('the activity tone reads at 3:1 on both grounds, and every graphical tone is a colour', () => {
  assert.ok(contrast(GRAPHICAL_TONE.activity, '#ffffff') >= 3);
  assert.ok(contrast(GRAPHICAL_TONE.activity, '#1f1f1f') >= 3);
  for (const tone of Object.keys(GRAPHICAL_TONE)) assert.ok(toneColor(tone, 'desktop'));
  for (const tone of Object.keys(GRAPHICAL_TONE)) assert.ok(toneColor(tone, 'terminal'));
});

test('the pending meter hex reads at 3:1 on both grounds', () => {
  assert.ok(contrast(GRAPHICAL_PENDING, '#ffffff') >= 3, 'on white');
  assert.ok(contrast(GRAPHICAL_PENDING, '#1f1f1f') >= 3, 'on dark');
});

test('every model family colour reads at 3:1 on both grounds', () => {
  for (const [family, color] of Object.entries(GRAPHICAL_MODEL)) {
    assert.equal(toneColor(`model:${family}`, 'desktop'), color);
    assert.ok(contrast(color, '#ffffff') >= 3, `${family} ${color} on white`);
    assert.ok(contrast(color, '#1f1f1f') >= 3, `${family} ${color} on dark`);
  }
});

test('every hex an Svg draws in reads at 3:1 on both grounds', () => {
  const tones = ['primary', 'muted', 'accent', 'success', 'warning', 'danger', 'activity'];
  const all = [
    ...tones,
    ...Object.keys(TIER_COLOR).map((tier) => `tier:${tier}`),
    ...Object.keys(GRAPHICAL_MODEL).map((family) => `model:${family}`),
  ];
  for (const tone of all) {
    const color = svgColor(/** @type {any} */ (tone));
    assert.match(color, /^#[0-9a-f]{6}$/i, tone);
    assert.ok(contrast(color, '#ffffff') >= 3, `${tone} ${color} on white`);
    assert.ok(contrast(color, '#1f1f1f') >= 3, `${tone} ${color} on dark`);
  }
});

test('only a surface that is not the terminal is graphical', () => {
  for (const surface of ['desktop', 'mobile', 'vscode']) assert.equal(isGraphical(surface), true);
  assert.equal(isGraphical('terminal'), false);
  assert.equal(isGraphical(), false);
});

test('a terminal tone is the theme key that means it, so the router follows the user’s theme', () => {
  const ui = kit(ELEMENTS);
  for (const [tone, key] of Object.entries({
    primary: 'text',
    muted: 'subtle',
    accent: 'suggestion',
    success: 'success',
    warning: 'warning',
    danger: 'error',
  }))
    assert.equal(toneColor(tone, 'terminal'), key, tone);
  assert.equal(toneColor('activity', 'terminal'), ui.activity('x').props.color);
  assert.match(toneColor('activity', 'terminal'), /^#/);
});
