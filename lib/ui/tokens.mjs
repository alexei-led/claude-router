// Tone is the one vocabulary a painter colours with. A terminal draws a hex; a graphical surface (desktop, mobile,
// vscode) draws a Claude Code theme key, so the colour follows the user's theme, or a mid-lightness hex where no theme
// key reads as a tier.
import { TIER_COLOR } from '../display.mjs';

/** @typedef {'micro' | 'low' | 'medium' | 'high'} Tier */
/** @typedef {'primary' | 'muted' | 'accent' | 'success' | 'warning' | 'danger' | 'activity' | `tier:${Tier}`} Tone */
/** @typedef {'terminal' | 'desktop' | 'mobile' | 'vscode'} Surface */

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

// Provisional: the desktop spike picks the theme keys that look right; change them here and nowhere else.
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

export const isGraphical = (surface) => surface !== undefined && surface !== 'terminal';

/**
 * @param {Tone} tone
 * @param {string} [surface]
 * @returns {string}
 */
export function toneColor(tone, surface) {
  const graphical = isGraphical(surface);
  if (tone.startsWith('tier:')) {
    const tier = tone.slice(5);
    return (graphical ? GRAPHICAL_TIER : TIER_COLOR)[tier];
  }
  return (graphical ? GRAPHICAL_TONE : TERMINAL)[tone];
}
