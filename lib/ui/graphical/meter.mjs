// The tier as signal-strength bars for a graphical surface: four rising bars drawn as an Svg.
import { TIERS } from '../../config.mjs';
import { GRAPHICAL_PENDING, GRAPHICAL_UNLIT, toneColor } from '../tokens.mjs';

const ALT = { lit: (tier) => `Tier: ${tier}`, pending: () => 'Tier: choosing', off: () => 'Tier: off' };

/**
 * @param {Record<string, Function>} elements
 * @param {import('../tokens.mjs').Tier | null} tier
 * @param {'lit' | 'pending' | 'off'} state
 */
export function tierMeter(elements, tier, state) {
  const lit = state === 'lit' ? TIERS.indexOf(tier) + 1 : state === 'pending' ? 4 : 0;
  const fill =
    state === 'pending' ? GRAPHICAL_PENDING : tier ? toneColor(`tier:${tier}`, 'graphical') : GRAPHICAL_UNLIT;
  const alt = ALT[state](tier);
  const bars = [0, 1, 2, 3]
    .map((i) => {
      const height = 3 * (i + 1);
      return `<rect x="${i * 4}" y="${12 - height}" width="3" height="${height}" rx="0.5" fill="${i < lit ? fill : GRAPHICAL_UNLIT}"/>`;
    })
    .join('');
  const source = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 12" width="16" height="12">${bars}</svg>`;
  return elements.Svg({ source, alt, width: 16, height: 12 });
}
