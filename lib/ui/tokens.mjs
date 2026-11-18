// Tone is the one vocabulary a painter colours with. A terminal draws a hex; a graphical surface (desktop, mobile,
// vscode) draws a Claude Code theme key, so the colour follows the user's theme, or a mid-lightness hex where no theme
// key reads as a tier.
import { MODEL_COLOR, TIER_COLOR } from '../display.mjs';

/** @typedef {'micro' | 'low' | 'medium' | 'high'} Tier */
/** @typedef {'haiku' | 'sonnet' | 'opus' | 'fable'} Family A model family, which colours a subagent's squares. */
/** @typedef {'primary' | 'muted' | 'accent' | 'success' | 'warning' | 'danger' | 'activity' | `tier:${Tier}` | `model:${Family}`} Tone */
/** @typedef {'terminal' | 'desktop' | 'mobile' | 'vscode'} Surface */
/**
 * Which terminal shades a reading's tones draw in. The terminal has always drawn the same meaning in a few shades by
 * where it appears; a graphical surface ignores the scale. `band` is the band's own warning and activity colours,
 * `fill` the context and cache gauges' ANSI names, `limit` a plan window, `saving` a difference against no routing.
 * Step 6 of the UI refactor folds them into the theme's keys.
 * @typedef {'band' | 'fill' | 'limit' | 'saving'} Scale
 */

// What the pane writes today, so a tab moved onto a painter draws the same: ANSI names for the three signal tones, the
// pane's own orange for activity. The band writes hex for the same meanings (its COLOR: warn #f0b429, activity #d77757)
// and does not use the painter, so band and pane differ here on purpose, for terminal parity.
export const ACTIVITY_COLOR = '#d7875f';
const TERMINAL = {
  primary: 'white',
  muted: '#8b93a7',
  accent: '#7c9cff',
  success: 'green',
  warning: 'yellow',
  danger: 'red',
  activity: ACTIVITY_COLOR,
};

// The terminal's shades where a scale differs from the pane's. `band` falls back to the pane's colours; the others
// name every tone they colour, and a tone left out draws in the terminal's own text colour.
/** @type {Record<Scale, Partial<Record<Tone, string>>>} */
const TERMINAL_SCALE = {
  band: { ...TERMINAL, warning: '#f0b429', activity: '#d77757' },
  fill: { success: 'green', warning: 'yellow', danger: 'red', muted: 'gray' },
  limit: { success: 'green', warning: '#f0b429', danger: 'red' },
  saving: { success: '#6fcf97', warning: '#f0b429' },
};
export const TERMINAL_COLOR = { pane: TERMINAL, ...TERMINAL_SCALE };

// A mode chip's ground on the terminal; its text is the muted tone on the band and a lighter grey on the pane.
export const CHIP_BACKGROUND = '#2a3040';

// The theme keys each tone draws in on a graphical surface, as approved on desktop; change them here and nowhere else.
export const GRAPHICAL_TONE = {
  primary: 'text',
  muted: 'subtle',
  accent: 'suggestion',
  success: 'success',
  warning: 'warning',
  danger: 'error',
  activity: '#c4693f',
};

// Mid-lightness, so each reads at 3:1 or better on both a white and a #1f1f1f ground.
export const GRAPHICAL_TIER = { micro: '#2a9d78', low: '#3b82c4', medium: '#a67c1a', high: '#c8506b' };

// The classifier-working colour of the tier meter: an Svg cannot take a theme key, so it is a hex, held to the same 3:1.
export const GRAPHICAL_PENDING = '#5b7fd9';

// Each model family's colour on a graphical surface, held to the same 3:1; the terminal's MODEL_COLOR is for a dark
// ground.
export const GRAPHICAL_MODEL = { haiku: '#4f9a3a', sonnet: '#c8643c', opus: '#9161c9', fable: '#2f8bb8' };

// The tones an Svg draws in, as hex: an Svg cannot take a theme key.
const SVG_TONE = { accent: GRAPHICAL_PENDING, muted: '#8b93a7', success: '#2a9d78', warning: '#a67c1a' };

/**
 * A tone as the hex an Svg draws it in; accent for a tone without one.
 * @param {Tone} tone
 * @returns {string}
 */
export function svgColor(tone) {
  if (tone.startsWith('tier:')) return GRAPHICAL_TIER[tone.slice(5)];
  if (tone.startsWith('model:')) return GRAPHICAL_MODEL[tone.slice(6)];
  return SVG_TONE[tone] ?? SVG_TONE.accent;
}

/**
 * A difference against no routing as a tone: a saving in the success tone, a cost above in the warning tone, zero plain.
 * @param {number} usd
 * @returns {Tone}
 */
export const savingTone = (usd) => (usd < 0 ? 'success' : usd > 0 ? 'warning' : 'primary');

export const isGraphical = (surface) => surface !== undefined && surface !== 'terminal';

/**
 * @param {Tone} tone
 * @param {string} [surface]
 * @param {Scale} [scale] the terminal's shades for a reading; a graphical surface ignores it
 * @returns {string | undefined}
 */
export function toneColor(tone, surface, scale) {
  const graphical = isGraphical(surface);
  if (!graphical && scale && !tone.startsWith('tier:') && !tone.startsWith('model:'))
    return TERMINAL_SCALE[scale][tone];
  if (tone.startsWith('tier:')) {
    const tier = tone.slice(5);
    return (graphical ? GRAPHICAL_TIER : TIER_COLOR)[tier];
  }
  if (tone.startsWith('model:')) {
    const family = tone.slice(6);
    return (graphical ? GRAPHICAL_MODEL : MODEL_COLOR)[family];
  }
  return (graphical ? GRAPHICAL_TONE : TERMINAL)[tone];
}
