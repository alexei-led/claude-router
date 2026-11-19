// Every colour the router draws lives in this file, each by the tone it means. Tone is the one vocabulary a renderer
// colours with: a terminal draws an ANSI name or a hex; a graphical surface (desktop, mobile, vscode) draws a Claude
// Code theme key, so the colour follows the user's theme, or a mid-lightness hex where no theme key reads as a tier;
// an Svg draws a hex.

/** @typedef {'micro' | 'low' | 'medium' | 'high'} Tier */
/** @typedef {'haiku' | 'sonnet' | 'opus' | 'fable'} Family A model family, which colours a subagent's squares. */
/** @typedef {'primary' | 'muted' | 'accent' | 'success' | 'warning' | 'danger' | 'activity' | `tier:${Tier}` | `model:${Family}`} Tone */
/** @typedef {'terminal' | 'desktop' | 'mobile' | 'vscode'} Surface */
// The theme keys each tone draws in, so a terminal and a graphical surface follow the user's theme; change them here and
// nowhere else. Activity has no theme key: it is Claude Code's orange as a hex, a darker one on a graphical surface.
const THEME_TONE = {
  primary: 'text',
  muted: 'subtle',
  accent: 'suggestion',
  success: 'success',
  warning: 'warning',
  danger: 'error',
};
const TERMINAL = { ...THEME_TONE, activity: '#d77757' };

// Cost order, cheapest first, so the colors read as a scale. Hex values: every surface draws them.
export const TIER_COLOR = { micro: '#5fd7af', low: '#5f9fe0', medium: '#d7af5f', high: '#e0708a' };
// A subagent's square by the model family it ran on, apart from the tier colors so a model never reads as a tier.
const MODEL_COLOR = { haiku: '#c3e88d', sonnet: '#f78c6c', opus: '#c792ea', fable: '#89ddff' };

// A mode chip's ground on the terminal; its text is a tone.
export const CHIP_BACKGROUND = '#2a3040';

export const GRAPHICAL_TONE = { ...THEME_TONE, activity: '#c4693f' };

// The quiet track behind a bar and the unlit bars of a meter: a grey that reads on a white and a dark ground.
export const GRAPHICAL_TRACK = 'rgba(127,127,127,0.18)';
export const GRAPHICAL_UNLIT = 'rgba(127,127,127,0.35)';

// Mid-lightness, so each reads at 3:1 or better on both a white and a #1f1f1f ground.
const GRAPHICAL_TIER = { micro: '#2a9d78', low: '#3b82c4', medium: '#a67c1a', high: '#c8506b' };

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
  const own = tone.startsWith('tier:')
    ? GRAPHICAL_TIER[tone.slice(5)]
    : tone.startsWith('model:')
      ? GRAPHICAL_MODEL[tone.slice(6)]
      : SVG_TONE[tone];
  return own ?? SVG_TONE.accent;
}

/**
 * A difference against no routing as a tone: a saving in the success tone, a cost above in the warning tone, zero plain.
 * @param {number} usd
 * @returns {Tone}
 */
export const savingTone = (usd) => (usd < 0 ? 'success' : usd > 0 ? 'warning' : 'primary');

// A plan window's tone by how much is used: success, then warning past 75%, danger past 90%.
/** @returns {Tone} */
export const limitTone = (percent) => (percent >= 90 ? 'danger' : percent >= 75 ? 'warning' : 'success');

/**
 * The tone of the family a model id belongs to; undefined for a model of no known family.
 * @param {string | null | undefined} id
 * @returns {Tone | undefined}
 */
export const modelTone = (id) => {
  const family = Object.keys(MODEL_COLOR).find((name) => String(id ?? '').includes(name));
  return family ? /** @type {Tone} */ (`model:${family}`) : undefined;
};

/**
 * Whether `value` is a usable number: Number.isFinite, as a guard so `columns` narrows from `number | null`.
 * @param {unknown} value
 * @returns {value is number}
 */
export const isFiniteNumber = (value) => Number.isFinite(value);

export const isGraphical = (surface) => surface !== undefined && surface !== 'terminal';

/**
 * @param {Tone} tone
 * @param {string} [surface]
 * @returns {string | undefined}
 */
export function toneColor(tone, surface) {
  const graphical = isGraphical(surface);
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
