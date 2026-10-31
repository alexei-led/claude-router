// Configured routes, not a replay or measured workload. Keep provider-mode docs checked against code.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ACTIVITIES, loadConfig, ROUTING_MODES, TIERS } from '../lib/config.mjs';
import { modeRoute } from '../lib/modes.mjs';

export const PROVIDERS = ['minimax', 'mimo', 'kimi'];
const DOC = new URL('../docs/providers.md', import.meta.url);
const START = '<!-- provider-matrix:start -->';
const END = '<!-- provider-matrix:end -->';

export function markdown() {
  const lines = [];
  for (const provider of PROVIDERS) {
    const config = loadConfig({ provider });
    lines.push(
      `**${provider}**`,
      '',
      '| Tier | Activities | cost | balanced | quality |',
      '| --- | --- | --- | --- | --- |',
    );
    for (const tier of TIERS) {
      const groups = new Map();
      for (const activity of [null, ...ACTIVITIES]) {
        const cells = ROUTING_MODES.map((mode) => {
          const route = modeRoute(config, mode, tier, activity);
          return `${route.model} · ${route.effort ?? 'no routed effort'}`;
        });
        const key = cells.join('|');
        if (!groups.has(key)) groups.set(key, { cells, activities: [] });
        groups.get(key).activities.push(activity ?? 'base/uncertain');
      }
      for (const { cells, activities } of groups.values())
        lines.push(`| ${tier} | ${activities.join(', ')} | ${cells.join(' | ')} |`);
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

export function withMatrix(text) {
  const [before, rest] = text.split(START);
  if (rest === undefined || !rest.includes(END)) throw new Error('Provider matrix markers are missing.');
  const after = rest.slice(rest.indexOf(END) + END.length);
  return `${before + START}\n${markdown()}\n${END}${after}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) writeFileSync(DOC, withMatrix(readFileSync(DOC, 'utf8')));
