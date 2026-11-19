// Prompt keywords: a word at the very start of a typed prompt that moves this one turn up or down. Made-up compound
// words, so ordinary prose never starts with one, and none is a word Claude Code reads itself (it reserves
// `ultrathink`). A keyword is not a pin: the classifier still answers, so the routing mode and the turn's activity
// choose the route of the tier the keyword lands on. Pure.
import { TIERS } from './config.mjs';
import { steppedEffort } from './modes.mjs';

// `tier`: tiers to move from the router's own pick, or 'top' / 'bottom'. `effort`: levels to move the route's effort.
export const KEYWORDS = {
  morethink: { tier: 0, effort: 1, text: 'one effort level up' },
  highthink: { tier: 1, effort: 0, text: 'one tier up' },
  maxthink: { tier: 'top', effort: 0, text: 'the top tier' },
  lessthink: { tier: 0, effort: -1, text: 'one effort level down' },
  lowthink: { tier: -1, effort: 0, text: 'one tier down' },
  nothink: { tier: 'bottom', effort: 0, text: 'the bottom tier' },
};

// Whether `keyword` moves the turn to a stronger route.
export const keywordRaises = (keyword) => {
  const { tier, effort } = KEYWORDS[keyword];
  return tier === 'top' || (typeof tier === 'number' && tier > 0) || effort > 0;
};

// The keyword the prompt opens with, or null. Only the first word counts, in any case, followed by the end, a space or
// punctuation: `maxthink: fix the race` matches, `maxthinking` and `please maxthink` do not.
export function promptKeyword(text) {
  const word = /^\s*([a-z]+)(?![\w-])/i.exec(typeof text === 'string' ? text : '')?.[1]?.toLowerCase();
  return word && Object.hasOwn(KEYWORDS, word) ? word : null;
}

// The tier `keyword` moves `tier` to, kept inside the tier list.
export function keywordTier(keyword, tier) {
  const { tier: move } = KEYWORDS[keyword];
  if (move === 'top') return TIERS[TIERS.length - 1];
  if (move === 'bottom') return TIERS[0];
  const at = Math.max(0, TIERS.indexOf(tier));
  return TIERS[Math.min(TIERS.length - 1, Math.max(0, at + move))];
}

// The effort `keyword` sends on models key `model`, moved from `effort` (the one the route sends): the next level the
// model lists in that direction, or `effort` unchanged when there is none, or it is the session's or numeric.
export function keywordEffort(config, keyword, model, effort) {
  const step = KEYWORDS[keyword].effort;
  if (!step || typeof effort !== 'string' || !Object.hasOwn(config.models, model)) return effort;
  return steppedEffort(config, { model, effort }, step) ?? effort;
}
